/** dsh-agent-checkpoint · 纯逻辑层（无 IO、时间注入）。
 *
 * 从 `index.ts` 的 apply 闭包抽出——**行为完全不变**，只是把「决策」与「IO」分开：
 * 决策（路径解析/补档判定/恢复计划/清理选择/存档结构校验）在这里，落盘与子进程留在接线层。
 * 目的见技能 `dsh-plugin-testability`：决策逻辑可离线单测，S6「失败路径覆盖」由此可机器验证。
 */
import { join, resolve } from 'node:path'

/** 配置里与路径/调度相关的子集（纯函数只依赖这些）。 */
export interface PathConfig {
  checkpointDir: string
  storagesDir: string
  soulFile: string
}

/** 解析后的三处落点（全部为绝对路径）。 */
export interface ResolvedPaths {
  checkpointDir: string
  storagesDir: string
  soulFile: string
}

/**
 * 路径解析：空串 = 走默认（<DSH_HOME>/checkpoints、<DSH_HOME>/storages、<cwd>/AGENTS.md）。
 * `dshHome` 由调用方传入（`process.env.DSH_HOME || cwd`）——环境读取留在接线层，本函数纯。
 */
export function resolvePaths(config: PathConfig, env: { dshHome: string; cwd: string }): ResolvedPaths {
  const dshHome = env.dshHome || env.cwd
  return {
    checkpointDir: resolve(env.cwd, config.checkpointDir || join(dshHome, 'checkpoints')),
    storagesDir: resolve(env.cwd, config.storagesDir || join(dshHome, 'storages')),
    soulFile: resolve(env.cwd, config.soulFile || join(env.cwd, 'AGENTS.md')),
  }
}

/** 存档点 id 时间戳：本地时间 `YYYYMMDD-HHMMSS`（与既有存档目录名兼容，勿改格式）。 */
export function formatStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * storage-json unit 结构校验（对齐 storage-json/src/format.ts 的 parse 检查：
 * valid JSON / object / unit header / tables）。返回 `null` 表示合法，否则返回问题描述。
 */
export function validateStorageUnit(text: string): string | null {
  try {
    const doc = JSON.parse(text) as unknown
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'not a JSON object'
    const d = doc as Record<string, unknown>
    if (typeof d.unit !== 'object' || d.unit === null) return 'missing unit header'
    if (typeof d.tables !== 'object' || d.tables === null) return 'tables is not an object'
    return null
  } catch (err) {
    return `invalid JSON: ${(err as Error).message}`
  }
}

/**
 * 启动补档判定（2026-09-05 修「纯内存 interval 随重启归零」）：
 * 无任何存档记录（lastMs<=0）或距最近存档已达/超过周期 → 应立即补一档。
 */
export function shouldAutoBackfill(lastMs: number, nowMs: number, intervalMs: number): boolean {
  if (!(intervalMs > 0)) return false
  if (!(lastMs > 0)) return true
  return nowMs - lastMs >= intervalMs
}

/** 恢复计划：显式 id / 自动挑最近健康点 / 无可用。 */
export type RestorePlan =
  | { kind: 'by-id'; id: string }
  | { kind: 'first-healthy'; candidates: string[] }
  | { kind: 'missing'; message: string }

/**
 * 恢复目标决策（IO 之外的部分）：给了 id 就只认这个 id（找不到即报错，**不静默改投别的档**——
 * 回滚是破坏性动作，改投等于恢复到用户没指定的状态）；没给 id 才按 createdAt 降序逐个验健康。
 */
export function planRestore(listIds: readonly string[], id: string | null | undefined): RestorePlan {
  if (id) {
    return listIds.includes(id) ? { kind: 'by-id', id } : { kind: 'missing', message: `无可用存档点（id=${id}）` }
  }
  if (listIds.length === 0) return { kind: 'missing', message: '无可用存档点（无健康存档）' }
  return { kind: 'first-healthy', candidates: [...listIds] }
}

/**
 * 恢复落点映射：`storages/<name>` → <storagesDir>/<name>；`AGENTS.md` → <soulFile>；
 * 其它 rel **拒绝**（返回 null = 跳过）——存档里的未知条目绝不落到工作区任意路径。
 *
 * 白名单守卫（2026-09-14 修缺陷）：`name` 必须是**纯文件名**（不含路径分隔符、非空、
 * 非 `.`/`..`）。修前 `storages/../AGENTS.md.bak` 归一化后落在 storagesDir **之外**
 * （实测 `\AGENTS.md.bak` = 盘根）——恢复是破坏性动作，损坏/手工编辑的 manifest 可借此写到工作区任意路径。
 * 正常 manifest 由 `snapshotTargets()` 用 `readdir` 的裸文件名拼出，永远不含分隔符 ⇒ 本守卫对正常路径零影响。
 */
export function restoreDest(rel: string, paths: ResolvedPaths): string | null {
  if (rel === 'AGENTS.md') return join(paths.soulFile)
  if (!rel.startsWith('storages/')) return null
  const name = rel.slice('storages/'.length)
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) return null
  return join(paths.storagesDir, name)
}

/**
 * 清理选择：`list` 为 createdAt 降序，保留前 `keep` 个，其余（更旧的）待删。
 * `keep` 非正数 = 一个都不留；超过列表长度 = 不删任何（当前语义，勿改）。
 */
export function selectStaleCheckpoints<T>(list: readonly T[], keep: number): T[] {
  return [...list].slice(keep)
}

/** 备份文件名：rel 里的 `/` 换成 `__`（备份目录是平铺的，不能再有层级）。 */
export function backupFileName(rel: string): string {
  return rel.replaceAll('/', '__')
}
