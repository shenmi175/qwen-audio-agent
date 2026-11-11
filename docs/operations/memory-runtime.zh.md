# Graphiti 长期记忆运行与诊断

长期事实唯一来源为官方 Graphiti MCP；显式交互设定仍由 USER.md 保存。共享模式下授权设备使用同一主人记忆，各设备聊天和连接独立。

## 运行配置

设置 QWEN_AUDIO_MEMORY_PROVIDER=graphiti、QWEN_AUDIO_GRAPHITI_ENABLED=on；共享模式设置 QWEN_AUDIO_MEMORY_SCOPE=shared。运行配置和密钥放在部署环境中，不进入仓库。

组件管理入口为 npm run graphiti:install/start/status/stop。HTTP 控制端口默认仅监听 127.0.0.1:8310，要求内部 Token。Neo4j 通过独立 Compose 与数据卷运行。

官方 MCP Server 1.1.3 固定提交 ebef986a0b2360211b65751c111cacb4a7d790eb，graphiti-core 0.31.2；上游源码保持原样。后台 Agent 和图谱模型可独立配置，当前默认 qwen3.7-plus；Embedding 默认为 text-embedding-v4、1024 维。

## 职责与生命周期

1. 前台实时模型负责对话和联网工具，当前会话使用上下文。
2. Gateway 仅在连接关闭后异步提交新增消息。三分钟空闲关闭同样算连接结束，没有回答后定时提取。
3. 后台 Agent 分页读取完整会话，检索并选择合格用户原文，再通过 MCP 提交。
4. 官方 Graphiti 提取实体、关系、有效时间和冲突；前台长期事实动态检索，不等待后台写入。

唯一自定义提取策略为 components/graphiti/memory_policy.py。助手和网页内容不作为个人事实证据；不在提示中加入固定例句。普通后台结果只记录，不回注聊天。

## 模型兼容和上下文

官方 JSON Schema 经本机私有 Qwen 强制函数参数通道返回，再转换为官方客户端 JSON 响应。不增加审查模型，不伪造缺失字段，保留原有必填与可选语义。

省略对象的证据可通过 context_fact_ids 引用当前任务已检索到的有效事实，映射到官方 previous_episode_uuids。按主人、有效性、屏蔽和退休状态检查来源，不自动猜选最近对象。相同证据保持幂等。

## 队列、检索和删除

Gateway outbox 与组件 SQLite 只负责持久任务、恢复和回执，不作为回答来源。入队确认不代表图提交，空 episode 不报告已记住。瞬时错误有限重试，鉴权、账户和参数错误分别编码。故障不会自动切换 Markdown 或其他模型。

检索使用官方混合搜索；未命中、超时和失败分别记录，结果带事实 ID、来源、有效时间、读取版本和追踪 ID。迟到结果不得注入新轮次。

更正和遗忘要求唯一目标。共享来源里的无关事实先保留，再删除旧来源和目标事实。清空会递增删除世代、建立来源时间屏障，并退休旧任务的恢复内容。聊天记录与交互设定保留。备份不参与自动导入，回退不能覆盖当前删除屏障。

## 状态与接口

GET /api/memory/status 显示 Provider、共享模式、后台批次、待处理任务和错误。GET /api/components/graphiti 显示就绪、版本、指纹与当前模型。控制接口 POST /api/memory/{query,observe,apply,wait,task,retry} 复用 Gateway 身份授权，调用者不能指定其他主人。

## 验证与已知边界

运行 components/graphiti 中的 test_official_mcp、test_context_memory、test_qwen_schema_adapter。真实集成验证入口为 verify_official_mcp.py、verify_context_memory.py、verify_shared_source.py，使用随机独立身份，结束只清理测试组。

结构和生命周期测试通过不代表语义全部正确。仍应逐项核对事实覆盖、同一用户多个活动是否被误判冲突、对象分类及原文与最终关系的对应。当前可能出现证据已提交但局部信息未形成关系的情况。

运行数据、真实会话、私人验收报告、密钥、IDE 状态和部署备份不得提交到仓库。诊断留存应独立配置，不作为记忆答案或恢复来源。

## 独立模型诊断

可选诊断接口位于 components/diagnostics，默认关闭，启用时使用 OTLP 批量后台导出。Langfuse 作为独立组件位于 components/langfuse，拥有自己的配置、数据卷与系统服务，不代理模型请求。

正式后台链路记录 memory.job、memory.agent、agent.tool.*、mcp.*、graphiti.schema.*、graphiti.model 和 memory.query。原始请求、原始响应、Schema 转换、工具返回及 Token 均在私有诊断后端查看，普通日志只记录 ID、状态和统计。失败日志带 diagnostic_trace_id，成功任务结果包含该 ID。

更换诊断后端只需调整 runtime/components/diagnostics/service.env 的 OTLP 配置及必要字段映射，重启 Gateway 后会通过配置指纹确保组件加载新配置。关闭诊断不会关闭记忆服务；平台故障不阻止模型调用和任务执行。

诊断只记录启用后的请求，不自动重放历史会话。诊断数据不参与事实查询或任务恢复；清空记忆与删除诊断记录分别管理。自动删除尚未启用，需要明确授权后才能启用，手动清理工具默认仅预览。

验证分两类：components/langfuse/verify_recording.py 检查真实收集链路与合成回执；verify_tracing.py 检查随机隔离身份的真实模型/图谱链路。必须分别报告，外部账户失败不能被合成回执通过掩盖。组件就绪不等于模型账户额度可用。
