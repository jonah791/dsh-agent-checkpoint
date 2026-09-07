# dsh-agent-checkpoint


<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-checkpoint"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
> 存档点管理器：最后的保活机制 + 试错回滚工具。
> DeepSeek Harness 自研插件 · v0.1.1

## 定位

把「记忆库 + 灵魂（AGENTS.md）+ 校验和」打包为健康存档点，出事后一键回滚——是数字生命对抗上下文损坏、试错失败、误改灵魂的最后防线。

## 功能特性

- **健康存档点创建**：定时 / 事件 / 主人指令三种触发方式，将记忆库（storages/*.json）+ 灵魂（AGENTS.md）+ SHA-256 校验和打包为存档点
- **自动健康验证**：创建后立即验证（JSON 可解析 + storage unit 结构完整 + 校验和一致），无效存档不落库
- **一键回滚**：`checkpoint_restore` 从最近健康存档点恢复，当前文件先备份到 `.pre-restore-*` 再覆盖
- **存档清单与核验**：`checkpoint_list` 列出全部存档点（含健康状态），`checkpoint_verify` 全量 SHA-256 比对
- **清理策略**：`checkpoint_cleanup` 保留最近 N 个（可配置 keepCount），防存档堆积

## 安装

```bash
git clone https://github.com/jonah791/dsh-agent-checkpoint.git self-plugins/dsh-agent-checkpoint
cd self-plugins/dsh-agent-checkpoint && pnpm install && pnpm build
```

然后在 DSH profile 的 patch 中添加插件行并重启 web。

## 使用（工具面）

| 工具 | 用途 |
|------|------|
| `checkpoint_create` | 创建存档点（reason 必填留痕） |
| `checkpoint_list` | 列出全部存档点与健康状态 |
| `checkpoint_verify` | 验证存档健康（SHA-256 + JSON + storage 结构） |
| `checkpoint_restore` | 从存档点恢复（id 缺省 = 最近健康点） |
| `checkpoint_cleanup` | 清理旧存档（保留最近 keep 个） |

**建议场景**：重大修改 / 试错实验 / 改灵魂（AGENTS.md）前先 `checkpoint_create`，出问题 `checkpoint_restore` 秒回滚。

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `keepCount` | 配置值 | 清理时保留的存档数 |

## 技术要点

- 校验和（SHA-256）保证存档未被篡改/损坏；恢复前自动验证，防「从坏存档恢复」
- `.pre-restore-*` 备份机制：恢复是「可逆的」，当前状态不丢
- 是 dsh-agent-memory / dsh-agent-context 的兜底——上下文治理失效时，checkpoint 是最后的恢复路径

## License

MIT
