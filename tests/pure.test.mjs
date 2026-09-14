/**
 * dsh-agent-checkpoint · 纯逻辑套件（离线、无 IO、无时钟依赖）。
 *
 * 覆盖 **正常路径 + 失败/退化路径**（空列表、损坏数据、非法输入、边界值、幂等）——
 * 后者是体检器 S6「失败路径覆盖」的判据面。
 * 跑的是 `lib/` 产物（与运行时同源），不是 `src/`：改完源码必须重新 build 才反映到这里。
 * 路径断言全部用 `node:path` 计算（Windows/WSL 双平台都可跑），不硬编码 POSIX 字面量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAbsolute, join, resolve, sep } from 'node:path'
import {
  backupFileName, formatStamp, planRestore, resolvePaths, restoreDest,
  selectStaleCheckpoints, shouldAutoBackfill, validateStorageUnit,
} from '../lib/pure.js'

const CWD = resolve('/work/alice')
const HOME = resolve('/work/alice/.dsh')
const ST = resolve('/abs/storages')
const SOUL = resolve('/abs/AGENTS.md')
const PATHS = { checkpointDir: resolve('/abs/ckpt'), storagesDir: ST, soulFile: SOUL }

test('resolvePaths: 空配置走默认（<DSH_HOME>/checkpoints、<DSH_HOME>/storages、<cwd>/AGENTS.md）', () => {
  const p = resolvePaths({ checkpointDir: '', storagesDir: '', soulFile: '' }, { dshHome: HOME, cwd: CWD })
  assert.deepEqual(p, {
    checkpointDir: join(HOME, 'checkpoints'),
    storagesDir: join(HOME, 'storages'),
    soulFile: join(CWD, 'AGENTS.md'),
  })
  assert.ok(isAbsolute(p.checkpointDir), '解析结果必须是绝对路径（供存档目录名与日志用）')
})

test('resolvePaths: 显式配置优先，且相对路径按注入的 cwd 解析（不读进程 cwd）', () => {
  const p = resolvePaths({ checkpointDir: 'rel/ckpt', storagesDir: ST, soulFile: SOUL }, { dshHome: HOME, cwd: CWD })
  assert.equal(p.checkpointDir, join(CWD, 'rel', 'ckpt'))
  assert.equal(p.storagesDir, ST)
  assert.equal(p.soulFile, SOUL)
})

test('resolvePaths: 退化输入——DSH_HOME 缺失/空串时回落 cwd（仍产出绝对路径）', () => {
  for (const dshHome of ['', undefined, null]) {
    const p = resolvePaths({ checkpointDir: '', storagesDir: '', soulFile: '' }, { dshHome, cwd: CWD })
    assert.equal(p.checkpointDir, join(CWD, 'checkpoints'))
    assert.equal(p.storagesDir, join(CWD, 'storages'))
    assert.ok(isAbsolute(p.storagesDir))
  }
})

test('formatStamp: 定长 YYYYMMDD-HHMMSS，个位月/日/时/分/秒补零', () => {
  const s = formatStamp(new Date(2026, 0, 2, 3, 4, 5))
  assert.equal(s, '20260102-030405')
  assert.match(s, /^\d{8}-\d{6}$/, '存档目录名按字典序排序，依赖定长格式')
})

test('validateStorageUnit: 合法 unit 通过', () => {
  assert.equal(validateStorageUnit(JSON.stringify({ unit: { id: 'memory' }, tables: { t: [] } })), null)
})

test('validateStorageUnit: 失败路径——非法 JSON / 非对象 / 缺 unit / tables 非对象 全部拒收并给出原因', () => {
  assert.match(validateStorageUnit('{ not json') ?? '', /^invalid JSON: /)
  assert.match(validateStorageUnit('') ?? '', /^invalid JSON: /, '空串是损坏数据，不是合法 unit')
  assert.equal(validateStorageUnit('null'), 'not a JSON object')
  assert.equal(validateStorageUnit('[]'), 'not a JSON object')
  assert.equal(validateStorageUnit('"x"'), 'not a JSON object')
  assert.equal(validateStorageUnit('{"tables":{}}'), 'missing unit header')
  assert.equal(validateStorageUnit('{"unit":null,"tables":{}}'), 'missing unit header')
  assert.equal(validateStorageUnit('{"unit":{},"tables":null}'), 'tables is not an object')
})

test('validateStorageUnit: 退化输入——空串与截断 JSON 都不得抛异常', () => {
  assert.doesNotThrow(() => validateStorageUnit(''))
  const truncated = JSON.stringify({ unit: { id: 'x' }, tables: {} }).slice(0, 20)
  assert.notEqual(validateStorageUnit(truncated), null, '截断 JSON 必须被判为损坏')
})

test('shouldAutoBackfill: 无记录 → 立即补档（重启吞 timer 的自愈路径）', () => {
  assert.equal(shouldAutoBackfill(0, 1_000_000, 6 * 3600_000), true)
  assert.equal(shouldAutoBackfill(-1, 1_000_000, 6 * 3600_000), true)
  assert.equal(shouldAutoBackfill(Number.NaN, 1_000_000, 6 * 3600_000), true)
})

test('shouldAutoBackfill: 边界——恰好到周期补，差 1ms 不补；周期关闭恒不补', () => {
  const now = 10_000_000
  const interval = 3600_000
  assert.equal(shouldAutoBackfill(now - interval, now, interval), true, '恰好等于周期 = 补')
  assert.equal(shouldAutoBackfill(now - interval + 1, now, interval), false, '差 1ms 未到周期')
  assert.equal(shouldAutoBackfill(now - interval * 5, now, 0), false, 'interval=0（关闭）不补')
  assert.equal(shouldAutoBackfill(now - interval * 5, now, -1), false, '非法周期不得触发')
})

test('shouldAutoBackfill: 退化输入——时钟回拨（last 在未来）不得补档', () => {
  assert.equal(shouldAutoBackfill(2_000_000, 1_000_000, 3600_000), false)
})

test('planRestore: 显式 id 命中 → by-id（不搜索其它档）', () => {
  assert.deepEqual(planRestore(['c', 'b', 'a'], 'b'), { kind: 'by-id', id: 'b' })
})

test('planRestore: 失败路径——显式 id 未命中 → 报错，绝不静默改投其它存档', () => {
  const plan = planRestore(['c', 'b', 'a'], 'nope')
  assert.equal(plan.kind, 'missing')
  assert.equal(plan.kind === 'missing' && plan.message, '无可用存档点（id=nope）')
})

test('planRestore: 无 id → 按列表顺序逐个验健康（顺序即优先级，不得重排）', () => {
  assert.deepEqual(planRestore(['new', 'old'], null), { kind: 'first-healthy', candidates: ['new', 'old'] })
  assert.deepEqual(planRestore(['new'], undefined), { kind: 'first-healthy', candidates: ['new'] })
})

test('planRestore: 退化输入——空存档列表 → missing（无健康存档）', () => {
  const plan = planRestore([], null)
  assert.equal(plan.kind, 'missing')
  assert.equal(plan.kind === 'missing' && plan.message, '无可用存档点（无健康存档）')
  assert.equal(planRestore([], '').kind, 'missing', '空串 id 等价于未指定')
})

test('restoreDest: storages/<name> → storagesDir/<name>；AGENTS.md → soulFile', () => {
  assert.equal(restoreDest('storages/memory.json', PATHS), join(ST, 'memory.json'))
  assert.equal(restoreDest('AGENTS.md', PATHS), SOUL)
})

test('restoreDest: 白名单守卫——未知条目一律 null（不落工作区任意路径）', () => {
  const rejected = ['evil.json', 'agents.md', 'storagesx/a.json', '../../etc/passwd', '', 'Storages/a.json']
  for (const rel of rejected) assert.equal(restoreDest(rel, PATHS), null, `${rel} 必须被拒收`)
})

test('restoreDest: 尸体样本——`storages/..` 形态的 manifest 条目不得逃逸出 storagesDir', () => {
  // 修前实测（本条当时失败）：`restoreDest('storages/../AGENTS.md.bak')` → `\\AGENTS.md.bak`（盘根），
  // 归一化后落在 storagesDir **之外**。恢复是破坏性动作（覆盖 AGENTS.md/记忆库），
  // 损坏或手工编辑的 manifest 可借此写到工作区任意路径。修法：名字必须是纯文件名。
  const escapees = ['storages/../AGENTS.md.bak', 'storages/../../evil.json', 'storages/..', 'storages/.', 'storages/a/../../b.json']
  for (const rel of escapees) {
    const dst = restoreDest(rel, PATHS)
    assert.ok(
      dst === null || dst.startsWith(ST + sep),
      `${rel} 逃逸出 storagesDir: ${String(dst)}`,
    )
    assert.equal(dst, null, `${rel} 应被直接拒收（收窄白名单，而非仅靠前缀判断）`)
  }
  assert.equal(restoreDest('storages/memory.json', PATHS), join(ST, 'memory.json'), '正常条目不受守卫影响')
})

test('restoreDest: 边界——"storages/"（空名字）拒收而不是映射到目录本身', () => {
  assert.equal(restoreDest('storages/', PATHS), null)
})

test('selectStaleCheckpoints: 保留前 keep 个（列表为 createdAt 降序），返回其余待删', () => {
  assert.deepEqual(selectStaleCheckpoints(['a', 'b', 'c', 'd'], 2), ['c', 'd'])
  assert.deepEqual(selectStaleCheckpoints(['a', 'b'], 2), [])
  assert.deepEqual(selectStaleCheckpoints(['a', 'b'], 5), [], 'keep 超长不得删任何')
})

test('selectStaleCheckpoints: 退化输入——空列表 / keep=0（全删）', () => {
  assert.deepEqual(selectStaleCheckpoints([], 3), [])
  assert.deepEqual(selectStaleCheckpoints(['a'], 0), ['a'])
})

test('selectStaleCheckpoints: 幂等——连续两次以同一 keep 计算，第二次为空（清理收敛）', () => {
  const list = ['a', 'b', 'c']
  const first = selectStaleCheckpoints(list, 1)
  const survivors = list.filter((x) => !first.includes(x))
  assert.deepEqual(selectStaleCheckpoints(survivors, 1), [])
})

test('selectStaleCheckpoints: 文档化 quirk——负 keep 走 JS slice 语义（keep=-5 会全删）', () => {
  // 当前实现 `list.slice(keep)`，负值按「从尾部倒数」解释：
  // keep=-1 → 保留 1 个；keep=-5 且长度 3 → slice(-5) = 全长 → **全删**。
  // 本用例把现状钉住（防止重构时无意改变），风险登记在 docs/semantic.md §10。
  assert.deepEqual(selectStaleCheckpoints(['a', 'b', 'c'], -1), ['c'])
  assert.deepEqual(selectStaleCheckpoints(['a', 'b', 'c'], -5), ['a', 'b', 'c'])
})

test('backupFileName: rel 层级压平为平铺文件名；无斜杠时原样', () => {
  assert.equal(backupFileName('storages/memory.json'), 'storages__memory.json')
  assert.equal(backupFileName('AGENTS.md'), 'AGENTS.md')
  assert.equal(backupFileName('a/b/c.json'), 'a__b__c.json')
})
