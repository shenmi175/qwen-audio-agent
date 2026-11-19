# Graphiti 官方 MCP 记忆组件

长期事实由官方 Graphiti MCP 保存和检索。项目保留 HTTP Provider 兼容层、连接结束的持久任务队列；普通会话直接交给官方提取，不经过额外模型筛选。

固定上游：getzep/graphiti，MCP Server 1.1.3，提交 ebef986a0b2360211b65751c111cacb4a7d790eb。
上游源码原样位于 runtime/components/graphiti/upstream；Python 环境为 mcp-venv，依赖固定于 requirements.lock。Neo4j 原有命名卷保留。

## 职责

1. 前台实时模型负责对话和联网工具；当前会话依靠上下文。
2. 连接关闭后，Gateway 封存会话并异步提交，前台无需等待。批次记录该段会话实际使用的语音系列，记忆组件在接收任务时固定档位。
3. 后台将当前批次的用户与助手完整对话按顺序一次提交给官方 `add_memory`，保留后续确认和纠正。不先调用模型挑选用户片段；程序仅处理凭据/不保存请求等排除项。`runtime/prompts/memory/{light,medium,advanced}.md` 定义记忆范围，和 `graph-extraction.md` 一起传给官方提取。
4. 官方 MCP 提取实体、关系、冲突和有效时间，前台长期事实同样经 MCP 检索。两个系列共用原有 Neo4j、身份、任务账本和 `text-embedding-v4` 的 1024 维图内索引。

| 档位 | Qwen 显式维护请求解析 | OpenAI 建图及维护 |
| --- | --- | --- |
| 轻度 | `qwen-flash` | `gpt-6-luna` |
| 中等（默认） | `qwen-plus` | `gpt-6.1-terra` |
| 高级 | `qwen-max` | `gpt-6.1-sol` |

Qwen 建图默认使用 `qwen3.7-plus`，可由 `QWEN_AUDIO_GRAPHITI_LLM_MODEL` 配置。OpenAI 通过官方 Responses API 建图。普通观察不调用维护请求解析模型；显式更正/遗忘仍沿用有目标校验的后台维护路径。

助手回复作为理解指代、确认和纠正的上下文，不能把助手单方面的推荐、猜测或知识回答当成用户事实。原始对话和消息 ID 保留用于追溯。所有 group_id 由服务端根据已认证主人身份注入。

## 写入与恢复

SQLite 仅保存任务、Agent 执行游标和操作回执，不作为回答来源。add_memory 的 queued 返回不代表成功；只有可核验的已提交 episode 和 get_episode_entities 结果才能完成任务。没有事实的 episode 标记 empty。
丢失确认时保留 unconfirmed，重启后先核对图回执，再决定是否恢复。显式维护请求解析限时 35 秒，单个后台任务限时 300 秒。同一用户按版本顺序处理，最多同时推进四个用户。完整会话提交计划在首次入图前保存，重试复用原计划和回执。官方内部可多次提取、去重，不代表只有一次模型 API 请求。
失败重试仅针对明确瞬时错误。官方队列没有任务状态工具，适配器仅根据从入队时点开始的、明确带本用户 group_id 的官方队列失败记录提前报告失败；不明确时仍保留 unconfirmed。账户欠费/状态、鉴权、限流及服务端错误分别编码。鉴权/参数错误直接失败。后台状态不回注聊天。

更正/遗忘先屏蔽目标，使用 MCP 重建共享来源里的无关事实，再删除旧来源及目标边。删除记录、来源消息退休标记和历史任务世代阻止旧恢复任务重新导入。存在未确认写入时先关闭旧 MCP 进程，阻止删除后的迟到提交。保留聊天记录和迁移备份，不从备份自动恢复。

## 管理

正常启动命令和 npm run graphiti:start/status/stop/install 沿用。组件内部 HTTP 端口 8310，官方 MCP 通过私有 stdio 子进程通信；没有新增外网端口。
本机组件默认复用 `QWEN_AUDIO_REALTIME_PROFILE_GPT_LIVE_API_KEY`。需要专用 OpenAI 项目时，在同一个 `config.env` 设置 `QWEN_AUDIO_GRAPHITI_OPENAI_API_KEY`。
配置模板 mcp-config.yaml 只包含环境变量引用；service.env 和所有包含原文的私有诊断日志权限 600。
readyz 和记忆状态包含 official-mcp、上游版本/提交、模型、策略哈希、待处理任务、操作阶段和错误码。普通日志不包含用户原文或密钥。

单元验证在 `components/graphiti` 中使用正式 mcp-venv 环境执行 `python -m unittest discover -p 'test_*.py'`。
verify_official_mcp.py 真实验收必须使用正式环境加载器；它创建随机独立身份，验证提取、关系、来源、更正、遗忘、重启与防重放，最后只清理该测试组。

切换前将代码和配置备份到部署主机私有 runtime/backups 目录。回退必须显式恢复代码和模型配置；保留当前队列删除世代与 retired_sources，不恢复历史图数据或旧任务。服务故障不会切换到 SDK 或 Markdown。

当前集成版本 6。`/readyz` 的 `model_families` 列出可接收任务的系列。旧版组件仍接收 Qwen 批次。OpenAI 批次等待支持 OpenAI 的组件，并在批处理状态报告 `GRAPHITI_MODEL_FAMILY_UNSUPPORTED`。完整对话写入可带同一会话最近三条、未屏蔽的 episode 作为 `previous_episode_uuids`，不会混入其他会话；重试使用同一上下文。空 episode 不标记为已记住。

部署与验收边界见 [运行文档](../../docs/operations/memory-runtime.zh.md)。语义正确性须逐项检查，不能仅凭成功状态判断。

## 远程部署

Gateway 的 runtime/components/graphiti/remote.env 支持 QWEN_AUDIO_GRAPHITI_MODE=remote、
QWEN_AUDIO_GRAPHITI_URL=http://127.0.0.1:18310 和 QWEN_AUDIO_GRAPHITI_TOKEN_FILE（私有 Token 文件绝对路径）。
远程模式只调用 API，不管理本机进程；连接失败不会回退本机或 Markdown。
HTTP 仅允许回环地址，公网必须使用 HTTPS 或 SSH 隧道。

当前采用专用账户经服务器 IP 转发 127.0.0.1:18310 到服务器 127.0.0.1:8310。
隧道应固定主机公钥、使用受限专用密钥、ExitOnForwardFailure 和保活，并由系统服务重连。
普通语音客户端不需要隧道；移动 Gateway 时迁移远程地址、Token 和隧道配置。

云端根目录 /opt/qwaudio-graphiti，独立 Python 环境，官方 MCP 和 Neo4j 保持固定版本。
compose.cloud.yaml 与 compose.yaml 一起使用。人格与行为提示词在 Gateway，三档记忆提示词在云端 runtime/prompts/memory。
迁移需停写后冷备图数据库，并一致迁移任务账本、幂等记录与遗忘屏障。
旧备份不参与自动恢复；云端发生新写入或遗忘后，回退必须迁回云端最新一致数据。

服务管理：云端使用 qwaudio-graphiti.service 和 qwaudio-neo4j.service；Gateway 主机使用用户服务 qwaudio-graphiti-tunnel.service。
迁移前冷备仅保留在 Gateway 的 runtime/backups/graphiti-cloud-migration，
迁移时配置 qwaudio-migration-backup-expiry.timer，七天后删除冷备；实际到期时间以部署主机的 timer 为准。
云端图和任务账本是迁移后的权威数据，切勿用旧冷备覆盖新写入或遗忘。

## Mac 处理记忆，腾讯云保存图数据

在 Mac 运行记忆组件和官方 MCP，通过只监听本机的 SSH 转发访问现有 Neo4j。在原私有 `config.env` 中设置以下连接选项。

```dotenv
QWEN_AUDIO_GRAPHITI_MODE=local
QWEN_AUDIO_GRAPHITI_NEO4J_URI=bolt://127.0.0.1:17688
```

URI 需为回环 Bolt 地址并带端口。将本机转发端口接到云端 Neo4j 已有的回环监听。启动时通过进程环境传入 `QWEN_AUDIO_GRAPHITI_NEO4J_PASSWORD`，可由已有的安全凭据存储在启动时注入。Mac 上的记忆组件继续使用现有文本模型和嵌入配置。设置外部 URI 后，`graphiti:start` 和 `graphiti:stop` 只管理本机记忆进程，数据库由原部署管理。就绪检查包含数据库管理方式和 URI 指纹。

切换前用隔离身份验证写入、跨会话召回和遗忘；正式切换需保留原任务账本、幂等记录和遗忘屏障，并避免两个记忆进程同时为同一身份写图。保留原嵌入模型和维度可继续检索已有图数据。
