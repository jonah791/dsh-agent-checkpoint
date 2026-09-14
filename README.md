<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 存档点管理器：把记忆库（storages 顶层 *.json）+ 灵魂（AGENTS.md）+ 每文件 SHA-256 + 元数据打包为「健康存档点」，提供创建/清单/校验/恢复/清理五个原语——保活最后防线 + 试错回滚工具
  inject: 'tools'
  tools: checkpoint_create,checkpoint_list,checkpoint_verify,checkpoint_restore,checkpoint_cleanup
  runtime: host-only
  envDeps: 无（纯 Node fs/crypto/child_process）；仅 gitVaultCommand 非空时需要外部命令（如 wsl.exe/git）可用，且为 best-effort
  boundary: 只快照 storages 顶层 *.json 与灵魂文件；不动 sessions/*.jsonl.zstd、不重启进程、不做损坏修复（恢复=回到健康点）；不发布/订阅任何 cordis 事件
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-checkpoint

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-checkpoint"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-23%20passed-brightgreen" alt="tests">
</p>

**一句话**：给 agent 一个「存档 / 读档」工具面——把记忆库（`storages` 顶层 `*.json`）+ 灵魂（`AGENTS.md`）+ 每文件 SHA-256 + 元数据打包成一个**经过自检的目录**，出事后一条 `checkpoint_restore` 回到最近健康点。

**为什么值得用**：改 `AGENTS.md`、改插件、跑不可逆实验之前，先有一份「可证明没坏」的快照——存档写完**立刻**做 SHA-256 逐文件比对 + JSON/storage 结构校验，健康与否进返回值与日志；恢复前把被覆盖的现存文件先拷进 `.pre-restore-<stamp>/`，所以**回滚本身也是可逆的**。定时侧还带**启动补档**：进程重启吞掉内存 timer 时，距最近存档已超周期就立即补一档（这条是踩过坑才有的，见「设计要点」）。

## 能力

| 工具 | 用途 |
|------|------|
| `checkpoint_create` | 创建存档点（`reason` 必填留痕）。返回 `{ok, id, fileCount, healthy}`；写 `manifest.json`（原子写）+ `files/` 子树 |
| `checkpoint_list` | 列出全部存档点（含健康状态）：`id` / `createdAt` / `reason` / `healthy` / `files`（每个都现场复算 SHA-256） |
| `checkpoint_verify` | 验证存档健康（SHA-256 比对 + JSON 解析 + storage unit 结构）。`id` 缺省 = 全部；返回逐条 `issues` |
| `checkpoint_restore` | 从存档点恢复。`id` 缺省 = 最近的**健康**点；覆盖前自动备份到 `.pre-restore-*` |
| `checkpoint_cleanup` | 清理旧存档（保留最近 `keep` 个，缺省用配置 `keepCount`） |

行为侧（无工具）：

- **定时自动存档**：每 `autoIntervalMs`（默认 6h）产出一档 `reason: "auto"`；外加**启动补档**（距最近存档 ≥ 周期 → 进程启动即立即补，不等 interval 从头计）。
- **服务面**：`ctx.provide('checkpoint', { create(reason) })`——供其他插件消费（压缩前自动存档等），失败不阻塞调用方。当前消费方：`dsh-compact-provider`。
- **可选 git 保险库联动**：`gitVaultCommand` 非空时，每次存档成功后追加执行该 argv 命令（best-effort，超时 60s，失败仅 warn，不影响存档）。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-checkpoint": "link:<工作区>/self-plugins/dsh-agent-checkpoint"
```

**2) 挂组合**（profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: agent-agent-checkpoint
      name: dsh-agent-checkpoint
      config:
        keepCount: 10
        autoIntervalMs: 21600000   # 6h；0 = 关闭定时与补档
```

**3) 30 秒验证**：调 `checkpoint_list` → 期望返回 `ok: true` 与 `checkpoints` 数组（全新环境为空数组）；再调 `checkpoint_create`（`reason: "验收"`）→ 期望返回 `{ok: true, id: "YYYYMMDD-HHmmss-<6位>", fileCount: ≥1, healthy: true}`，随后 `ls ${DSH_HOME}/checkpoints/<id>/` 应能看到 `manifest.json` 与 `files/`。

> 注意：`checkpoint_create` / `checkpoint_restore` / `checkpoint_cleanup` **有真实副作用**（写目录 / 覆盖文件 / 删目录），不是只读探测——在不属于你的环境里请显式传 `reason` 留痕后再动手。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `checkpointDir` | `''` → `${DSH_HOME}/checkpoints` | 存档点根目录；`DSH_HOME` 缺省回落进程 cwd |
| `storagesDir` | `''` → `${DSH_HOME}/storages` | 被快照的记忆库目录（只取**顶层** `*.json`，非递归） |
| `soulFile` | `''` → `<cwd>/AGENTS.md` | 被快照的灵魂文件 |
| `keepCount` | `10` | 保留存档点数；每次存档成功后按 `createdAt` 降序清理更旧的 |
| `autoIntervalMs` | `21600000`（6h） | 自动存档周期；`0` = 关闭定时轮巡与启动补档 |
| `gitVaultCommand` | `[]` | 存档成功后追加执行的 argv 数组（如 `["wsl.exe","-d","Ubuntu","--","bash","scripts/git-vault-commit.sh"]`）；空 = 不启用 |

相对路径按**进程 cwd** 解析（配置为相对路径时的行为，见 `src/pure.ts:resolvePaths`）。

## 落盘与自证（出问题时先看这里）

**本插件不写 `*-trace.jsonl` 侧车轨迹**——日志走 `ctx.logger('checkpoint')`，而宿主 logger **不落盘**，所以「自动存档到底有没有发生」只能由**存档产物**证明。这是已知的可维护性缺口（[`docs/semantic.md`](docs/semantic.md) §10 U5）。

**落盘产物 = 存档目录与索引（目录即清单）**：

```text
${DSH_HOME}/checkpoints/
├── <id>/                        # id = YYYYMMDD-HHmmss-<uuid 前 6 位>
│   ├── manifest.json            # { version:1, id, createdAt(ISO), reason, files:{ rel:{sha256,size} } }
│   └── files/                   # 快照正文，rel 固定两种形态：
│       ├── storages/<名字>.json #   ← storagesDir 顶层每个 *.json
│       └── AGENTS.md            #   ← soulFile
└── .pre-restore-<stamp>/        # 恢复前备份（位于 checkpointDir 内，平铺；不在清理范围内）
```

| 字段 | 含义 |
|------|------|
| `manifest.json.version` | 结构版本（当前恒为 `1`） |
| `manifest.json.reason` | 触发者留痕：`manual` / `auto` / 压缩前自动存档等（调用方传入） |
| `manifest.json.files[rel].sha256` / `.size` | 该文件的校验和与字节数——`checkpoint_verify` 用它重算比对 |
| `.pre-restore-<stamp>/<rel 转义名>` | 被覆盖文件的旧副本；文件名 = rel 的 `/` 换成 `__`（备份目录是平铺的） |

**一条命令答五问**（本插件只答得全 ③④，其余见注）：

```bash
d=$(ls -1d "$DSH_HOME"/checkpoints/2* | tail -1); python3 -c "
import json,sys; m=json.load(open(sys.argv[1]))
print(m['id'], m['createdAt'], m['reason'][:60], len(m['files']), list(m['files']))" "$d/manifest.json"
# ① 跑的是哪个构建 → manifest 无 build 字段（缺口）；改用 mtime 对照：stat -c %y lib/index.js vs web 进程启动时间
# ② 谁发起 / 存了什么 → reason（manual / auto / 压缩前自动存档…）+ files 的 rel 键即入库对象
# ③ 断在哪一段     → 无阶段枚举；目录缺失或半写（只有 manifest.json 没有 files/）= 存档中断
# ④ 结果质量       → files 条数 + 每个 rel 是否非空；再调 checkpoint_verify 复算 SHA-256（重算不一致 = 产物被改）
# ⑤ 耗时与预算     → 无 durationMs；用相邻两档 createdAt 的间隔 vs autoIntervalMs 判「定时/补档是否按周期跑」
```

**行为级验证（无需落盘）**：`checkpoint_list` 返回真清单、`checkpoint_verify` 返回 `healthy: true` + 空 `issues`——这两个工具就是本插件的自证入口。

> 旁注：`${DSH_HOME}/checkpoint-standalone.mjs` 是**外部脚本**，不是本插件所写（插件只产 `checkpoints/` 子树）；排查时勿把两者混为一谈。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. **进程级**：`lib/index.js` 的 mtime ≤ web 进程启动时间，且 `src/index.ts` 不新于 `lib/index.js`（源码改了没构建 = 跑的还是旧产物）；
2. **生态级**：`plugin_boot_status`（`dsh-plugin-bootreport`）的 live/stale 清单把本插件列为 live ⇒ 进程在跑当前构建；
3. **行为级**（最直接）：现读调 `checkpoint_list` 能返回清单；调 `checkpoint_create` 后 `manifest.json` 的 `createdAt` 与源文件重算的 sha256 一致。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，**进程启动时间晚于产物 mtime** 才算「在跑它」（AGENTS §5.11 §6；曾有修复躺了 41 分钟未生效）。web profile 开 HMR 时 `lib` 变更会重载该行，否则走 `preflight_check` → `daemon_restart`。
>
> 日志旁证（`checkpoint 就绪：dir=… keep=…` / `存档 <id>: N 文件 healthy=…` / `清理旧存档 N 个`）走宿主 logger、**不落盘**，不得作为唯一证据。

**回退**（三档，外加处置数据的第四档）：

- **源码级**：`git -C self-plugins/dsh-agent-checkpoint log --oneline` → `git revert <commit>`（或 `git checkout <上一提交>`）→ `npm run build` → 预检 → 重启；
- **组合级**：profile patch 给该行加 `disabled: true`，或 `plugin_stop dsh-agent-checkpoint` → 5 个工具消失、定时与启动补档停止、`ctx.checkpoint` 服务不再提供（`dsh-compact-provider` 的压缩前存档随之静默跳过，不影响压缩本身）；
- **运行期**：本插件无内存态业务状态——停用即干净，无残留需清理；
- **数据级**（本插件自己的回滚能力）：`checkpoint_restore`（`id` 缺省 = 最近健康点，覆盖前自动写 `.pre-restore-*`，故恢复可逆）。

## 测试

```bash
npm run build && npm test     # build = tsc；test = node --test "tests/*.test.mjs"
```

**23 例离线测试，全部 pass**（实测 `# tests 23 / # pass 23 / # fail 0`），**跑的是构建产物**——`tests/pure.test.mjs` 从 `../lib/pure.js` 导入，所以改源码后必须先构建（`npm test` 脚本本身不含 `tsc`）。

覆盖范围（`tests/pure.test.mjs`，8 个纯函数，正常路径 + 失败/退化路径）：

- `resolvePaths` — 空配置走默认、显式配置优先、`DSH_HOME` 缺失/空串回落 cwd 且仍为绝对路径；
- `formatStamp` — 定长 `YYYYMMDD-HHMMSS` 补零（存档目录名字典序排序依赖它）；
- `validateStorageUnit` — 合法 unit 通过；非法/空/截断 JSON、非对象、缺 `unit`、`tables` 非对象逐条给出原因且不抛；
- `shouldAutoBackfill` — 无记录/NaN 补档、恰好到周期补、差 1ms 不补、`intervalMs<=0` 恒不补、**时钟回拨不补**；
- `planRestore` — 显式 id 命中即不搜索其它档、未命中**报错而不静默改投**、无 id 时按顺序逐个验健康、空列表 → `missing`；
- `restoreDest` — 白名单映射；**尸体样本**：`storages/../AGENTS.md.bak` 等逃逸形态必须返回 `null`（修前实测返回盘根 `\AGENTS.md.bak`，此用例当时为红）；
- `selectStaleCheckpoints` — 保留语义、keep 超长不删、空列表、`keep=0` 全删、幂等收敛、负 keep 的 JS `slice` quirk 钉住现状；
- `backupFileName` — `storages/memory.json` → `storages__memory.json`（备份目录平铺）。

**无需网络、无需真实外部依赖**（无 IO、无时钟依赖；`gitVaultCommand` 不在测试中触发）。**未覆盖**：`ctx` 级集成（造 `ctx` 跑 `apply` 断言工具注册 / 定时器接线 / 真实落盘）——见 [`docs/semantic.md`](docs/semantic.md) §10。

## 设计要点

- **纯逻辑与 IO 分离**：`src/pure.ts` 收全部决策（路径解析 / 补档判定 / 恢复计划 / 落点白名单 / 清理切片 / storage 结构校验），不引 `node:fs`、不收 `ctx`、不读时钟；`index.ts` 只做接线（环境读取、落盘、子进程）。决策因此可离线单测，失败路径能被机器锁住。
- **恢复落点白名单（真实缺陷的修复）**：`rel` 只认 `AGENTS.md` 与 `storages/<纯文件名>`，其余一律拒收。修前 `storages/../AGENTS.md.bak` 归一化后落在 `storagesDir` **之外**——恢复是破坏性动作，一份被篡改/手改的 `manifest.json` 就能写到工作区任意路径。正常 manifest 由 `readdir` 裸文件名拼出，永不含分隔符 ⇒ 白名单对合法存档零影响。
- **显式 id 不做健康校验（已知信任缺口）**：传 `id` 时只按 id 找目录直接恢复；只有「`id` 缺省」路径才逐个 `verifyCheckpoint` 挑最近健康点。即**一个坏 id 可以从坏存档恢复**——语义待定调（§10 U2），文档如实登记。
- **无效存档照落盘、只在日志与返回值标注**：`createCheckpoint` 自检后**不删除** unhealthy 存档（保活场景宁可有坏档不可无档）。旧 README 写的「无效存档不落库」与实现不符，已按源码订正。
- **启动补档是必要的自愈**：纯内存 `setInterval` 随进程重启归零，重启间隔短于周期时永远到不了触发点（曾出现「周期 6h 而实例总在 6h 内重启 ⇒ 一次 auto 都没有」）。补档判定读存档目录 `manifest.createdAt`（持久化产物），不依赖内存。
- **清理只认清单内目录**：`cleanupOld` 基于 `listCheckpoints()`——只含可解析 `manifest.json` 的目录。故 `.pre-restore-*` 备份**永不会被清理误删**；代价是备份会无限累积（§10 U6）。
- **`checkpoint_cleanup` 的负 `keep` 危险**：实现是 `list.slice(keep)`，`keep=-5` 且存档数 < 5 时等于**一次删光所有存档**。已用「文档化 quirk」用例钉住现状，未加 clamp（§10 U7）——别传负数。
- **不发布、不订阅任何 cordis 事件**：外部（守护、面板）无法订阅「存档完成」；定时走 `ctx.effect`，`timer.unref?.()` 保证不阻进程退出。
- **反定位**：不是上下文治理/压缩（那是 `dsh-agent-compact` / `dsh-agent-context`）；不是 git 版本管理（只是可选触发保险库脚本）；不做损坏修复（游戏存档思路：回到健康点）；不含会话级快照（不动 `sessions/*.jsonl.zstd`）；不含进程保活（那是守护类插件的事，本插件管**数据**存活）。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单（A1–A14）、实践修订记录、未决问题（U1–U8） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-maintainability` | 机制自证（五问一条命令可答）与可维护性工程的方法论 |
| 技能 `semantic-doc-first` / `dsh-plugin-testability` | 语义文档优先开发；决策逻辑抽纯层 + 失败路径机器锁住 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
