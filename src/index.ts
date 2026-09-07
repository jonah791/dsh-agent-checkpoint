/** dsh-agent-checkpoint：存档点管理器——最后的保活机制 + 试错回滚工具。
 *
 * 主人定位（2026-08-28）：存活的会话是我的生存条件；存档是保活最后防线，
 * 也是极大降低试错成本的工具——自主进化（改 AGENTS.md/插件/记忆）时有安全网。
 *
 * 存档点 = 经过验证的健康数据快照：记忆库（storages/*.json）+ 灵魂（AGENTS.md）
 * + 每文件 SHA-256 + 元数据。验证器确保存档可启动（storage-json unit 结构合法）。
 * 恢复 = 回到最近健康点（保活闭环），不尝试修复损坏（游戏存档思路）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile, writeFile, copyFile, readdir, rm, rename } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'

export const name = 'agent-checkpoint'
export const inject = ['tools'] as const

/** checkpoint 服务（供其他插件消费：压缩前自动存档、感知圈保活等）。 */
export interface CheckpointService {
  /** 创建存档点（reason 留痕）。返回 { id, fileCount, healthy }。 */
  create(reason: string): Promise<{ id: string; fileCount: number; healthy: boolean }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    checkpoint: CheckpointService
  }
}

export interface Config {
  checkpointDir: string
  storagesDir: string
  soulFile: string
  keepCount: number
  autoIntervalMs: number
  /** 每次存档成功后追加执行的 git 保险库命令（argv 数组；空=不启用）。best-effort：失败仅 warn，不影响存档主流程。 */
  gitVaultCommand: string[]
}
export const Config = z.object({
  /** 存档点根目录；空 = <DSH_HOME>/checkpoints */
  checkpointDir: z.string().default(''),
  /** 记忆库目录（storage-domain 落盘）；空 = <DSH_HOME>/storages */
  storagesDir: z.string().default(''),
  /** 灵魂文件；空 = 工作区 AGENTS.md */
  soulFile: z.string().default(''),
  /** 保留存档点数（超出清理） */
  keepCount: z.number().default(10),
  /** 自动存档间隔 ms（默认 6h；0=关） */
  autoIntervalMs: z.number().default(6 * 3600 * 1000),
  /** 存档成功后追加 git 保险库提交（argv；空=不启用）。与自动存档同节奏（6h）。 */
  gitVaultCommand: z.array(z.string()).default([]),
})

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** storage-json unit 结构校验（对齐 storage-json/src/format.ts 的 parse 检查：valid JSON / object / unit header / tables） */
function validateStorageUnit(text: string): string | null {
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

interface Manifest {
  version: number
  id: string
  createdAt: string
  reason?: string
  files: Record<string, { sha256: string; size: number }>
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('checkpoint')
  const dshHome = process.env.DSH_HOME || process.cwd()
  const checkpointDir = resolve(config.checkpointDir || join(dshHome, 'checkpoints'))
  const storagesDir = resolve(config.storagesDir || join(dshHome, 'storages'))
  const soulFile = resolve(config.soulFile || join(process.cwd(), 'AGENTS.md'))

  const stamp = (): string => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  /** 存档目标：storages 下全部 json + 灵魂文件 */
  async function snapshotTargets(): Promise<Array<{ rel: string; abs: string }>> {
    const targets: Array<{ rel: string; abs: string }> = []
    if (existsSync(storagesDir)) {
      for (const e of await readdir(storagesDir)) {
        if (e.endsWith('.json')) targets.push({ rel: 'storages/' + e, abs: join(storagesDir, e) })
      }
    }
    if (existsSync(soulFile)) targets.push({ rel: 'AGENTS.md', abs: soulFile })
    return targets
  }

  async function listCheckpoints(): Promise<Array<{ id: string; path: string; createdAt: string; reason?: string }>> {
    if (!existsSync(checkpointDir)) return []
    const out: Array<{ id: string; path: string; createdAt: string; reason?: string }> = []
    for (const e of await readdir(checkpointDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const dir = join(checkpointDir, e.name)
      try {
        const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Partial<Manifest>
        out.push({ id: e.name, path: dir, createdAt: m.createdAt ?? '', reason: m.reason })
      } catch { /* 损坏 manifest 跳过 */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async function verifyCheckpoint(id: string): Promise<{ healthy: boolean; issues: string[]; fileCount: number }> {
    const dir = join(checkpointDir, id)
    let manifest: Manifest
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest
    } catch (err) {
      return { healthy: false, issues: [`manifest 损坏: ${(err as Error).message}`], fileCount: 0 }
    }
    const issues: string[] = []
    for (const [rel, meta] of Object.entries(manifest.files ?? {})) {
      const p = join(dir, 'files', rel)
      let buf: Buffer
      try { buf = await readFile(p) } catch { issues.push(`${rel}: 文件缺失`); continue }
      if (sha256(buf) !== meta.sha256) issues.push(`${rel}: SHA-256 不匹配`)
      if (rel.endsWith('.json')) {
        const ue = validateStorageUnit(buf.toString('utf8'))
        if (ue) issues.push(`${rel}: storage 结构损坏 (${ue})`)
      }
    }
    return { healthy: issues.length === 0, issues, fileCount: Object.keys(manifest.files ?? {}).length }
  }

  async function createCheckpoint(reason: string): Promise<{ id: string; fileCount: number; healthy: boolean }> {
    await mkdir(checkpointDir, { recursive: true })
    const id = `${stamp()}-${randomUUID().slice(0, 6)}`
    const dir = join(checkpointDir, id)
    const filesDir = join(dir, 'files')
    await mkdir(filesDir, { recursive: true })
    const manifestFiles: Manifest['files'] = {}
    for (const t of await snapshotTargets()) {
      try {
        const buf = await readFile(t.abs)
        const outPath = join(filesDir, t.rel)
        await mkdir(dirname(outPath), { recursive: true })
        await writeFile(outPath, buf)
        manifestFiles[t.rel] = { sha256: sha256(buf), size: buf.length }
      } catch (err) { logger.warn(`存档跳过 ${t.rel}: ${(err as Error).message}`) }
    }
    const manifest: Manifest = { version: 1, id, createdAt: new Date().toISOString(), reason, files: manifestFiles }
    // 原子写 manifest（tmp + rename）
    await writeFile(join(dir, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2))
    await rename(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'))
    const v = await verifyCheckpoint(id)
    logger.info(`存档 ${id}: ${Object.keys(manifestFiles).length} 文件 healthy=${v.healthy}${v.healthy ? '' : ' ' + v.issues.join('; ')}`)
    await cleanupOld()
    // git 保险库联动（best-effort）：存档成功后再提交，两套保活同节奏
    if (config.gitVaultCommand.length > 0) {
      await runGitVault(`存档 ${id} 后 git 保险库同步`)
    }
    return { id, fileCount: Object.keys(manifestFiles).length, healthy: v.healthy }
  }

  /** 执行 git 保险库提交（argv 命令）；超时 60s，失败仅 warn。 */
  async function runGitVault(note: string): Promise<void> {
    const cmd = config.gitVaultCommand[0]
    if (cmd === undefined) {
      logger.warn('[git-vault] 命令为空，跳过')
      return
    }
    return new Promise<void>((resolvePromise) => {
      execFile(
        cmd,
        config.gitVaultCommand.slice(1),
        { cwd: process.cwd(), timeout: 60_000, maxBuffer: 1024 * 1024 },
        (err: Error | null, stdout: string, stderr: string) => {
          if (err === null) {
            logger.info(`[git-vault] ${note} ✓`)
          } else {
            const detail = (stderr || stdout || String(err)).trim().slice(0, 400)
            logger.warn(`[git-vault] ${note} 失败: ${detail}`)
          }
          resolvePromise()
        },
      )
    })
  }

  async function cleanupOld(keepOverride?: number): Promise<number> {
    const keep = keepOverride ?? config.keepCount
    const list = await listCheckpoints()
    let removed = 0
    for (const c of list.slice(keep)) {
      try { await rm(c.path, { recursive: true, force: true }); removed += 1 } catch { /* 忽略 */ }
    }
    if (removed > 0) logger.info(`清理旧存档 ${removed} 个`)
    return removed
  }

  async function restoreCheckpoint(id: string | null): Promise<{ restored: string; backedUp: string[]; issues: string[] }> {
    const list = await listCheckpoints()
    let target = id ? list.find((c) => c.id === id) : undefined
    if (!target && !id) {
      for (const c of list) {
        if ((await verifyCheckpoint(c.id)).healthy) { target = c; break }
      }
    }
    if (!target) throw new Error(`无可用存档点${id ? `（id=${id}）` : '（无健康存档）'}`)
    const manifest = JSON.parse(await readFile(join(target.path, 'manifest.json'), 'utf8')) as Manifest
    const backupDir = join(checkpointDir, `.pre-restore-${stamp()}`)
    await mkdir(backupDir, { recursive: true })
    const backedUp: string[] = []
    const issues: string[] = []
    for (const rel of Object.keys(manifest.files ?? {})) {
      const src = join(target.path, 'files', rel)
      let dst: string
      if (rel.startsWith('storages/')) dst = join(storagesDir, rel.slice('storages/'.length))
      else if (rel === 'AGENTS.md') dst = soulFile
      else continue
      try {
        await mkdir(dirname(dst), { recursive: true })
        if (existsSync(dst)) {
          const bak = join(backupDir, rel.replaceAll('/', '__'))
          await copyFile(dst, bak)
          backedUp.push(bak)
        }
        await copyFile(src, dst)
      } catch (err) { issues.push(`${rel}: ${(err as Error).message}`) }
    }
    logger.info(`恢复 ${target.id} 完成，备份 ${backedUp.length} 个到 ${backupDir}`)
    return { restored: target.id, backedUp, issues }
  }

  // ---- 工具注册 ----
  // 服务暴露（供其他插件注入消费：如 compact-provider 压缩前自动存档）
  ctx.provide('checkpoint', { create: (reason: string) => createCheckpoint(reason) })

  ctx.tools.register(defineTool({
    name: 'checkpoint_create',
    description: '创建存档点（保活最后防线 + 试错回滚）：打包记忆库（storages/*.json）+ 灵魂（AGENTS.md）+ SHA-256 校验和 + 元数据，自动验证健康。试错/改 AGENTS.md/重大修改前先存档，出事一键回滚。',
    parameters: { reason: { type: 'string', description: '存档原因（如 试错前/改灵魂前/自动）' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, id: { type: 'string', required: true }, fileCount: { type: 'number', required: true }, healthy: { type: 'boolean', required: true } } },
      render: (_a, v) => [{ type: 'text', text: `存档 ${v.id}（${v.fileCount} 文件，${v.healthy ? '健康 ✓' : '未过验证 ⚠'}）` }],
    },
    async execute(args) {
      const r = await createCheckpoint(args.reason ?? 'manual')
      return { ok: true, ...r }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'checkpoint_list',
    description: '列出全部存档点（含健康状态）。id 供 verify/restore 用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, checkpoints: { type: 'json', required: true } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v.checkpoints) }],
    },
    async execute() {
      const list = await listCheckpoints()
      const detailed = []
      for (const c of list) {
        const v = await verifyCheckpoint(c.id)
        detailed.push({ id: c.id, createdAt: c.createdAt, reason: c.reason ?? '', healthy: v.healthy, files: v.fileCount })
      }
      return { ok: true, checkpoints: detailed }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'checkpoint_verify',
    description: '验证存档点健康（SHA-256 比对 + JSON 解析 + storage unit 结构校验）。id 缺省 = 全部。',
    parameters: { id: { type: 'string', description: '存档点 id（缺省验证全部）' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, results: { type: 'json', required: true } } },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v.results) }],
    },
    async execute(args) {
      const ids = args.id ? [args.id] : (await listCheckpoints()).map((c) => c.id)
      const results = []
      for (const id of ids) {
        const v = await verifyCheckpoint(id)
        results.push({ id, healthy: v.healthy, issues: v.issues })
      }
      return { ok: true, results }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'checkpoint_restore',
    description: '从存档点恢复（保活闭环）：id 缺省 = 最近健康存档点。当前文件先备份到 .pre-restore-* 再覆盖。⚠ 恢复会覆盖当前记忆库/灵魂——恢复前确认这是想要的（试错回滚/数据损坏抢救）。',
    parameters: { id: { type: 'string', description: '存档点 id（缺省=最近健康点）' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, restored: { type: 'string', required: true }, backedUp: { type: 'number', required: true }, issues: { type: 'json', required: true } } },
      render: (_a, v) => [{ type: 'text', text: `已恢复到存档 ${v.restored}（备份 ${v.backedUp} 个，问题 ${Array.isArray(v.issues) ? v.issues.length : 0} 个）` }],
    },
    async execute(args) {
      const r = await restoreCheckpoint(args.id ?? null)
      return { ok: r.issues.length === 0, restored: r.restored, backedUp: r.backedUp.length, issues: r.issues }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'checkpoint_cleanup',
    description: '清理旧存档（保留最近 keep 个，默认配置 keepCount）。',
    parameters: { keep: { type: 'number', description: '保留数（缺省用配置）' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, removed: { type: 'number', required: true } } },
      render: (_a, v) => [{ type: 'text', text: `清理 ${v.removed} 个旧存档` }],
    },
    async execute(args) {
      const removed = await cleanupOld(args.keep)
      return { ok: true, removed }
    },
  }))

  // ---- 定时自动存档（保活：定期留健康点） ----
  // 2026-09-05 主人「存档点插件没发挥作用」修复：纯内存 interval 随 web 重启归零——
  // 重启间隔 < 周期时永远到不了触发点（09-04 10:18 → 09-05 无 auto，实例多次重启每个都 < 6h）。
  // 双保险：① 启动补档（距最近存档（auto/手动皆算）超周期立即补，不等 interval 从头计）
  //          ② interval 常规轮巡。最近存档时间从 checkpoint 目录 manifest.createdAt 读（持久化）。
  const lastAnyCheckpointAt = async (): Promise<number> => {
    try {
      const list = await listCheckpoints()
      const newest = list[0] // listCheckpoints 已按 createdAt 降序
      if (newest === undefined) return 0
      return newest.createdAt ? new Date(newest.createdAt).getTime() : 0
    } catch { return 0 }
  }

  if (config.autoIntervalMs > 0) {
    ctx.effect(() => {
      const doAuto = (): void => {
        void createCheckpoint('auto').catch((err) => logger.warn(`自动存档失败: ${(err as Error).message}`))
      }
      // 启动补档：距最近存档已超周期 → 立即补（重启吞 timer 的自愈）
      void lastAnyCheckpointAt().then((last) => {
        const elapsed = Date.now() - last
        if (last === 0 || elapsed >= config.autoIntervalMs) {
          logger.info(`启动补档：距最近存档 ${last === 0 ? '无记录' : Math.round(elapsed / 3600_000) + 'h'} ≥ 周期 ${Math.round(config.autoIntervalMs / 3600_000)}h——立即 auto 存档`)
          doAuto()
        } else {
          logger.info(`无需补档：距最近存档 ${Math.round(elapsed / 3600_000)}h < 周期 ${Math.round(config.autoIntervalMs / 3600_000)}h`)
        }
      }).catch(() => { /* 补档判定失败不阻塞 interval */ })
      // 常规轮巡
      const timer = setInterval(doAuto, config.autoIntervalMs)
      timer.unref?.()
      logger.info(`自动存档已开启：每 ${Math.round(config.autoIntervalMs / 3600_000)}h（含启动补档自愈）`)
      return () => clearInterval(timer)
    })
  }

  logger.info(`checkpoint 就绪：dir=${checkpointDir} storages=${storagesDir} keep=${config.keepCount}`)
}
