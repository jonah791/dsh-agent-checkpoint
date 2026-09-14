# dsh-agent-checkpoint · 语义文档（存档点管理器）

> 存档点 = 经过验证的健康数据快照（记忆库 + 灵魂 + SHA-256）。本文件是该能力的唯一语义主副本。

| 项 | 值 |
|----|----|
| 能力名 | `checkpoint`（插件导出 `name = 'agent-checkpoint'`；profile 挂载 id `agent-agent-checkpoint`） |
| 主副本路径 | `self-plugins/dsh-agent-checkpoint/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-agent-checkpoint/src/index.ts`（唯一源文件，365 行）；产物 `lib/index.js`；挂载 `.dsh/profiles/web/cordis.patch.yml:203` |
| 版本 | 0.1.1（取 `package.json` 的 version） |
| 状态 | draft |
| 作者 | 爱丽丝 |
| 日期 | 2026-09-14 |

## 1 · 定位与反定位

**定位**：把「记忆库（storages 顶层 `*.json`）+ 灵魂（`AGENTS.md`）+ 每文件 SHA-256 + 元数据」打包为**健康存档点**，并提供创建 / 清单 / 校验 / 恢复 / 清理五个原语；是保活最后防线与试错回滚工具（改 AGENTS.md、改插件、跑不可逆实验前先存档）。

**反定位**：

- 不是上下文治理或压缩（那是 `dsh-agent-compact` / `dsh-agent-context`）：本插件只打包文件快照，不裁剪上下文。
- 不是 git 版本管理（那是 `scripts/git-vault-commit.sh` + `E:\alice` 保险库）：本插件只是**可选触发**它。
- 不做损坏修复：恢复 = 回到健康点，不尝试修补坏存档（游戏存档思路，源码头注释 `src/index.ts:8`）。
- 不含会话级快照：不动 `sessions/*.jsonl.zstd`，不重启服务、不碰进程生命周期。

## 2 · 术语表

| 术语 | 含义（实现事实） |
|------|------------------|
| 存档点 | 目录 `<checkpointDir>/<id>/`，内含 `manifest.json` + `files/` 子树 |
| id | `YYYYMMDD-HHmmss-<uuid 前 6 位>`（`stamp()` + `randomUUID().slice(0, 6)`） |
| manifest | `{ version:1, id, createdAt(ISO), reason, files:{ rel: {sha256, size} } }`；原子写：`manifest.json.tmp` → `rename` |
| rel 键 | 固定为 `storages/<文件名>.json` 与 `AGENTS.md`（与源文件在磁盘上的名字无关） |
| 健康 | 全部文件存在 + SHA-256 一致 + 每个 `*.json` 通过 `validateStorageUnit`（JSON object / `unit` 头 / `tables`） |
| 恢复 | 把 `files/` 内容写回 `storagesDir` 与 `soulFile`；被覆盖的现存文件先备份 |
| `.pre-restore-<stamp>` | 恢复前备份目录（位于 checkpointDir 内），备份文件名 = rel 的 `/` 替换为 `__` |
| git 保险库 | 配置的可选 argv 命令，存档成功后追加执行（best-effort） |

## 3 · 概念模型

```text
触发（手动工具 / 压缩前 / 定时 6h / 启动补档）
  → snapshotTargets()：storages 顶层 *.json + soulFile
  → 逐文件复制进 files/ 并记 sha256/size
  → 原子写 manifest.json
  → verifyCheckpoint()（自证健康）→ 日志标注 healthy=?
  → cleanupOld()（保留最近 keepCount 个）
  → 可选 runGitVault()
```

不变量（可检验）：

1. **落盘即自证**：manifest 落盘后立刻 `verifyCheckpoint(id)`，结果进日志与返回值 `{id, fileCount, healthy}`——但**不会因 unhealthy 而拒收**（与 README 表述不符，见 §10 U1）。
2. **清理只删清单内目录**：`cleanupOld` 基于 `listCheckpoints()`（只认含可解析 `manifest.json` 的目录），故 `.pre-restore-*` 永不会被清理误删。
3. **快照范围固定**：`readdir` 非递归，只取 storages 顶层 `*.json`；子目录（如 `session_projcache/sessions/`）不入档。

## 4 · 契约

- **插件导出**：`name = 'agent-checkpoint'`；`inject = ['tools']`（唯一依赖的 inject 服务）。
- **提供的服务**：`ctx.provide('checkpoint', { create(reason) })` → `{ id, fileCount, healthy }`（`src/index.ts:245`）。
- **事件**：本插件**不发布、不订阅任何 cordis 事件**（源文件无 `ctx.emit` / `ctx.on`；定时走 `ctx.effect`）。
- **配置字段**（schemastery，`src/index.ts:43-56`）：`checkpointDir`（默认 `''`）、`storagesDir`（`''`）、`soulFile`（`''`）、`keepCount`（`10`）、`autoIntervalMs`（`6 * 3600 * 1000`）、`gitVaultCommand`（`[]`）。
- **缺省解析**：`checkpointDir → <DSH_HOME>/checkpoints`，`storagesDir → <DSH_HOME>/storages`，`soulFile → <cwd>/AGENTS.md`；其中 `dshHome = process.env.DSH_HOME || process.cwd()`。
- **落盘路径**：`<DSH_HOME>/checkpoints/<id>/manifest.json`、`.../files/storages/*.json`、`.../files/AGENTS.md`；恢复备份落 `<checkpointDir>/.pre-restore-<stamp>/`。
- **工具（5 个）**：`checkpoint_create`(reason) / `checkpoint_list`() / `checkpoint_verify`(id?) / `checkpoint_restore`(id?) / `checkpoint_cleanup`(keep?)。

### 4.1 调用点清单

| 调用方 | 调用点（文件:符号） | 时机 |
|--------|---------------------|------|
| cordis loader（web profile） | `.dsh/profiles/web/cordis.patch.yml:203` → `dsh-agent-checkpoint` → `src/index.ts:apply` | 进程启动装配（HMR 开启时 lib 变更亦重载） |
| 爱丽丝（主会话） | 工具 `checkpoint_create`（`src/index.ts:247`） | 试错 / 改 AGENTS.md / 重大修改前手动 |
| 爱丽丝（主会话） | 工具 `checkpoint_list` / `checkpoint_verify` / `checkpoint_restore` / `checkpoint_cleanup`（`src/index.ts:261` / `:280` / `:299` / `:313`） | 抽查健康 / 回滚 / 清理 |
| dsh-compact-provider | `session_compact.execute` → `ctx.checkpoint.create(...)`（`self-plugins/dsh-compact-provider/src/index.ts:56-58`；其 inject 声明见同文件 `:24`） | 每次自主压缩**之前**（best-effort，失败不阻塞压缩） |
| 本插件自身（定时） | `src/index.ts:ctx.effect → doAuto → createCheckpoint('auto')` | 每 `autoIntervalMs`（默认 6h）+ **启动补档**（距最近存档 ≥ 周期即立即补） |
| 本插件自身（收口） | `createCheckpoint` → `cleanupOld()`（`src/index.ts:165`） | 每次存档成功后 |
| 本插件自身（可选外呼） | `createCheckpoint` → `runGitVault()` → `execFile('wsl.exe', […])`（`src/index.ts:167-196`） | 每次存档成功后（`gitVaultCommand` 非空时） |

## 5 · 边界与信任

- **信任域**：只信任自己写的 manifest 与文件内容；存档目录被外部篡改/截断 → SHA-256 或 JSON 结构不匹配 → `checkpoint_verify` 报 unhealthy。
- **恢复的信任缺口**：显式传 id 时 `restoreCheckpoint(id)` 只做 `list.find`、**不做健康校验**；只有「id 缺省」路径才逐个 `verifyCheckpoint` 挑最近的健康点（`src/index.ts:211-217`）。即传一个坏 id 可以从坏存档恢复——**回退动作本身无守卫**（见 §10 U2）。
- **默认覆盖面**：恢复只覆盖 `storagesDir` 顶层同名 json 与 `soulFile`；存档里没有的现存文件保持不动，也不删任何文件。
- **git 保险库的 note 不生效**：`runGitVault(note)` 的 note 只进 logger，**不进入 argv**；脚本 `scripts/git-vault-commit.sh` 用默认提交消息 `保险库 <时间>`（见 §10 U3）。
- **观测落点**：日志走 `ctx.logger('checkpoint')`——宿主 logger **不落盘**（AGENTS §5.22）。因此「自动存档是否真的发生」只能由**存档目录/清单产物**证明，不能只看日志。

## 6 · 与既有机制的关系

| 机制 | 关系 |
|------|------|
| dsh-agent-memory / storage-domain | 被快照对象：实测入档 `storages/agent_memory.json`、`storages/session_projcache.json`、`storages/workspace.json` |
| dsh-compact-provider / dsh-agent-compact | 消费方：压缩前自动存档，压缩失败或碎片可回滚（服务消费，非工具消费） |
| `scripts/git-vault-commit.sh` + `E:\alice` 保险库 | 同节奏互补：checkpoint 管「数据快照」，git 管「灵魂/源码可回滚历史」 |
| dsh-agent-guardian / dsh-agent-sentinel | 层次不同：它们管**进程**存活，本插件管**数据**存活 |
| 语义文档系统（dsh-semantic-docs） | 本文件为主副本；注册表条目待登记（本批任务禁改 `registry.json`） |

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/落盘产物） | 状态 |
|---|------------|-------------------------------------|------|
| A1 | 工具面注册 5 个工具，名称逐字为 `checkpoint_create/list/verify/restore/cleanup` | 本会话工具面存在这 5 个工具 | 已验收 |
| A2 | 存档结构 = `manifest.json` + `files/`（含 `storages/*.json` 与 `AGENTS.md`） | `E:\alice\.dsh\checkpoints\20260914-093844-d8db5c\manifest.json`：files 键 4 个（`agent_memory.json` 2,185,549B 等），各带 sha256+size | 已验收 |
| A3 | id 形如 `YYYYMMDD-HHmmss-uuid6` | 实测目录名 `20260914-093844-d8db5c` | 已验收 |
| A4 | 只快照 storages 顶层 `*.json`，不含子目录 | 同一 manifest 无 `storages/session_projcache/sessions/*` 键 | 已验收 |
| A5 | 清理生效：存档目录数 ≤ `keepCount`(10) | 目录列举恰为 10 个 | 已验收（间接） |
| A6 | 无自动化回归：插件无单测 | 插件目录无 `tests/`（glob 无命中） | 已验收 |
| A7 | 恢复可逆：覆盖前备份到 `.pre-restore-<stamp>/` | 跑 `checkpoint_restore` → 列 `<checkpointDir>/.pre-restore-*` + 工具返回的 backedUp 计数 | 待验收 |
| A8 | 显式 id 恢复不做健康校验（可从坏存档恢复） | 手工损坏副本内一个文件 → `checkpoint_restore(id=该点)` → 观察是否仍恢复 | 待验收 |
| A9 | 启动补档：距最近存档 ≥6h 时进程启动即产出 `reason:"auto"` 存档 | 存档清单新增 `reason` 为 `auto` 且 createdAt ≈ 启动时刻 | 待验收 |
| A10 | git 保险库联动 best-effort：外呼失败不影响存档 | 改坏 `gitVaultCommand` → `checkpoint_create` 仍返回 ok 且存档落盘 | 待验收 |
| A11 | 定时器不阻进程退出（`timer.unref?.()`） | 源码 `src/index.ts:358`；无独立运行时测量 | 待验收 |

## 8 · 与实现的关系

- 实现 = 唯一源文件 `src/index.ts`（365 行）→ `pnpm build`（tsc）→ 产物 `lib/index.js`；profile 以 `"dsh-agent-checkpoint": "link:E:/alice/self-plugins/dsh-agent-checkpoint"` 挂载（`.dsh/profiles/web/package.json:8`），运行时入口 `lib/index.js`。
- **生效判据**（改了代码后怎么证明真的生效）：① 产物 mtime **晚于** `src/index.ts` mtime（证明构建过）；② **进程启动时间 vs `lib/index.js` mtime**——产物更新而进程更早启动即「构建了但没在跑」（web profile HMR root 指向 `E:/alice/self-plugins`，见 `cordis.patch.yml:31-39`，lib 变更会重载该行；否则走 `preflight_check` → `daemon_restart`）；③ 行为判据 = 工具可答（`checkpoint_list` 返回真清单）+ **落盘产物**（新 `<id>/manifest.json` 的 createdAt 与 sha256 与源文件重算值一致）。
- **回退**：① 代码级——`git -C E:\alice\self-plugins\dsh-agent-checkpoint log --oneline`（当前 HEAD `8b29d0f`，工作树干净）→ `git revert` / `git checkout`；② 数据级——`checkpoint_restore`（id 缺省 = 最近健康点，覆盖前自动写 `.pre-restore-*` 备份，故恢复可逆）；③ 机制级——`plugin_stop dsh-agent-checkpoint`（或 patch 里 `disabled: true`）停用，不影响其它插件与数据。
- 观测面（`ctx.logger('checkpoint')`）：`checkpoint 就绪：dir=… storages=… keep=…`、`存档 <id>: N 文件 healthy=…`、`清理旧存档 N 个`、`[git-vault] … ✓ / 失败: …`；注意宿主 logger **不落盘**。

## 9 · 实践修订记录

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
- 2026-09-14 补课期间发现三处「文档/注释与实现不符」：README「无效存档不落库」（实现是照落盘、只在日志与返回值标注 healthy）、配置注释「`gitVaultCommand` 与自动存档同节奏」（实现是**每次** create 都触发，含手动与压缩前）、`runGitVault` 的 note 不传 argv——全部记入 §10，本次不改代码。

## 10 · 未决问题

- U1 README「无效存档不落库」与实现不符：`createCheckpoint` 验证后不删除 unhealthy 存档。是改文档还是加拒收？（语义取舍：保活场景宁可有坏存档也不能无存档，需定调）
- U2 显式 id 恢复无健康校验：是否改为「显式 id 也先 verify，不健康则需 force 才继续」？
- U3 git 保险库联动语义：note 不传给脚本（提交消息恒为默认时间戳），且每次 create 都触发（压缩前存档亦触发一次 commit）——是否改为「仅 auto 触发」或「note 进 argv」？
- U4 无任何自动化回归（无 `tests/`）：恢复 / 清理 / 补档三条路径全部只在线上跑，是否补纯函数级单测（把选择目标、备份计划、清理切片抽成决策函数）？
- U5 不发布任何事件：外部（守护、面板）无法订阅「存档完成」。是否按 AGENTS §5.22 落一份侧车轨迹（`<DSH_HOME>/checkpoint-trace.jsonl`）自证？
- U6 保留策略：`keepCount`=10 且按 `createdAt` 字符串降序切片删除，而 `.pre-restore-*` 备份目录**不在**清理范围内 → 备份会无限累积，是否纳入清理？
