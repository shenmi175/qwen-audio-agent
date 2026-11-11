# 独立诊断模块

业务组件只调用 qwaudio_diagnostics 的 span / completion / carrier 接口，不引用 Langfuse SDK。模块默认关闭；启用标准 OTLP 后，后台批量发送至配置的接收端。接收端可以单独停止或更换，记忆数据继续由 Graphiti 管理。

安装：在目标 Python 环境执行 pip install -e 'components/diagnostics[otlp]'。私有配置放 runtime/components/diagnostics/service.env：

- QWEN_AUDIO_DIAGNOSTICS_PROVIDER=otlp（off 为关闭）
- OTEL_EXPORTER_OTLP_TRACES_ENDPOINT 为接收端完整 traces 地址
- OTEL_EXPORTER_OTLP_TRACES_HEADERS 为鉴权头；不要提交真实值

当前适配器记录原始模型请求和响应、Schema、工具参数与结果、Token、错误类型、事实和来源 ID，以及会话和后台任务关联。导出使用有界后台队列，接收端故障不等待前台或改变模型结果。停机时有限时间 flush；异常崩溃或持续故障可能损失尚未导出的诊断，不能将其当成持久记忆队列。

OTLP 字段映射集中在 qwaudio_diagnostics/otlp.py，同时提供 GenAI/OpenInference 字段；更换平台时修改配置和必要映射，业务逻辑保留。

当前正式接入覆盖后台记忆 Agent、MCP 工具与 Graphiti 模型。前台实时语音的完整 WebSocket 请求、音频和搜索调用未在此版本接入，不能据此宣称已有全系统追踪。

官方 MCP 仍使用固定原始源码。组件自己的 mcp_tracing.py 在启动时为 QueueService 安装运行时诊断插件：提交时捕获上下文，每条队列任务执行时恢复；仅向本机模型适配器注入追踪头。追踪信息在进官方图前从来源描述移除。更换 MCP 固定版本时必须重新验证此插件。

秘密字段、环境中已知凭据和常见 API Key 格式在导出前脱敏；不会采集 HTTP 鉴权头。会话内容只进入受控诊断后端，不写普通日志或代码仓库。诊断记录不用于事实检索或历史恢复；记忆清空与诊断保留策略分别管理。

验证：python -m unittest discover -s components/diagnostics -p 'test_*.py'。需要已安装 OTLP 可选依赖。
