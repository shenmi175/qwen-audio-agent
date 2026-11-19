# Mac 模型系列与提示词验收 · 2026-11-16

3101 使用 gpt-realtime-2.1；Qwen 配置保留。记忆处理与官方 MCP 在 Mac，腾讯继续提供已有 Neo4j。
语音系列决定后台筛选和建图系列；模型 API/协议适配与记忆策略分离。未来 HF 工具应通过既有 ToolSource 接口接入。

## 已验证

- 152 项 Node 回归通过：提示词快照、编辑版本冲突、输入校验、工具反馈、Qwen/OpenAI 协议档案。
- 41 项 Python 记忆/MCP 回归通过；新增图谱提示词热读取及空内容拒绝测试另行通过。
- Web 生产构建通过；浏览器验证设置入口、五个用途 Tab、草稿保留、保存、刷新后持久化。
- 使用隔离身份自然陈述“我叫甄彤岚。”：OpenAI 后台写入并查询到原名，14.96 秒。
- Qwen 更正为“甄桐岚”：新会话只查询到新名，18.87 秒。
- OpenAI 遗忘：新会话查询为空，4.72 秒。三步总测试 41.30 秒。
- 新版提示词真实语音：同一批中文 PCM，普通陈述“我养的猫叫银杏布丁。”，关闭会话后一次筛选自动写入；新会话询问宠物名字，真实 memory read 命中，口播“你之前说它叫银杏布丁……”，收到 506400 字节输出音频。
- 两组隔离测试数据已清理；3102 测试网关退出；3101 health 的 connected / activeClients / realtime.connected 均为 0。

这些耗时是后台维护耗时，不是语音首音延迟；本次不构成多样本 A/B 延迟基线或扬声器声学测量。
现存真实会话历史发送至 OpenAI 的恢复测试被自动审批拒绝，未重试；协议恢复相关修改由合成数据回归覆盖。

## 本机复测

Node 可执行文件：`/Users/lucas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。
私有运行目录：`/Users/lucas/projets/conversation/.local-runtime/qwen-audio`。

- 重启：用上述 Node 执行私有运行目录下 `switch-voice.mjs openai`（或 `qwen`）。
- 记忆系列实测：执行 `verification/run-local-memory.mjs verify_model_families.py`。
- 语音实测：依次执行 `verification/start-family-gateway.mjs` 与 `verification/run-family-voice.mjs`。
- 提示词编辑：`http://127.0.0.1:3101/prompts`。

原提示词备份：私有运行目录下 `migration-backups/prompts-20261116-210044`。
