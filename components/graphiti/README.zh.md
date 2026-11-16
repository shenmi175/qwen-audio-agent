# Graphiti 官方 MCP 记忆组件

长期事实由官方 Graphiti MCP 保存和检索。项目保留 HTTP Provider 兼容层、连接结束的持久任务队列和一次结构化筛选。

固定上游：getzep/graphiti，MCP Server 1.1.3，提交 ebef986a0b2360211b65751c111cacb4a7d790eb。
上游源码原样位于 runtime/components/graphiti/upstream；Python 环境为 mcp-venv，依赖固定于 requirements.lock。Neo4j 原有命名卷保留。

## 职责

1. 前台实时模型负责对话和联网工具；当前会话依靠上下文。
2. 连接关闭（手动结束、新会话、3 分钟空闲或断网）后，Gateway 封存会话并异步提交。前台不等待保存结果。
3. 后台按用户选择的 flash / plus / max 档位（默认 plus）读取本批会话，一次筛选并返回结构化候选。程序校验用户原文、排除明确不应保存的内容、检查重复和歧义，随后调用官方 `add_memory`。服务主机的 `runtime/prompts/memory/{light,medium,advanced}.md` 提供筛选范围和隐私策略。
4. 官方 MCP 使用 qwen3.7-plus 提取实体、关系、冲突和有效时间，text-embedding-v4 1024 维向量检索。前台长期事实同样经 MCP 动态检索。

助手、搜索结果和一般知识不能充当个人事实证据。原文工具参数必须是所引用用户消息的逐字片段。所有 group_id 由服务端根据已认证主人身份注入。

## 写入与恢复

SQLite 仅保存任务、Agent 执行游标和操作回执，不作为回答来源。add_memory 的 queued 返回不代表成功；只有可核验的已提交 episode 和 get_episode_entities 结果才能完成任务。没有事实的 episode 标记 empty。
丢失确认时保留 unconfirmed，重启后先核对图回执，再决定是否恢复。筛选限时 35 秒，单个后台任务限时 300 秒。同一用户按版本顺序处理，最多同时推进四个用户。筛选结果在首次入图前保存，重试复用该结果。
失败重试仅针对明确瞬时错误。官方队列没有任务状态工具，适配器仅根据从入队时点开始的、明确带本用户 group_id 的官方队列失败记录提前报告失败；不明确时仍保留 unconfirmed。账户欠费/状态、鉴权、限流及服务端错误分别编码。鉴权/参数错误直接失败。后台状态不回注聊天。

更正/遗忘先屏蔽目标，使用 MCP 重建共享来源里的无关事实，再删除旧来源及目标边。删除记录、来源消息退休标记和历史任务世代阻止旧恢复任务重新导入。存在未确认写入时先关闭旧 MCP 进程，阻止删除后的迟到提交。保留聊天记录和迁移备份，不从备份自动恢复。

## 管理

正常启动命令和 npm run graphiti:start/status/stop/install 沿用。组件内部 HTTP 端口 8310，官方 MCP 通过私有 stdio 子进程通信；没有新增外网端口。
模型配置：QWEN_AUDIO_GRAPHITI_AGENT_MODEL 与 QWEN_AUDIO_GRAPHITI_LLM_MODEL，默认均为 qwen3.7-plus。
配置模板 mcp-config.yaml 只包含环境变量引用；service.env 和所有包含原文的私有诊断日志权限 600。
readyz 和记忆状态包含 official-mcp、上游版本/提交、模型、策略哈希、待处理任务、操作阶段和错误码。普通日志不包含用户原文或密钥。

单元验证在 `components/graphiti` 中使用正式 mcp-venv 环境执行 `python -m unittest discover -p 'test_*.py'`。
verify_official_mcp.py 真实验收必须使用正式环境加载器；它创建随机独立身份，验证提取、关系、来源、更正、遗忘、重启与防重放，最后只清理该测试组。

切换前将代码和配置备份到部署主机私有 runtime/backups 目录。回退必须显式恢复代码和模型配置；保留当前队列删除世代与 retired_sources，不恢复历史图数据或旧任务。服务故障不会切换到 SDK 或 Markdown。

当前集成版本 6。Graphiti 的官方 Schema 经私有 Qwen 强制函数参数通道返回，再转换为官方客户端的 JSON 响应；不增加审查模型、不填造缺失字段，说明字段保持原有可选性。后台写入可选取本任务已检索到的有效事实来源，传给官方 previous_episode_uuids；重试保留同一上下文，不猜选最近作品。空 episode 不标记为已记住。

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
