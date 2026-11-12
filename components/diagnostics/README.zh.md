# 独立诊断模块

业务组件只调用 qwaudio_diagnostics 的 span / completion / carrier 接口，不引用 Langfuse SDK。模块默认关闭；启用标准 OTLP 后，后台批量发送至配置的接收端。接收端可以单独停止或更换，记忆数据继续由 Graphiti 管理。

安装：在目标 Python 环境执行 pip install -e 'components/diagnostics[otlp]'。私有配置放 runtime/components/diagnostics/service.env：

- QWEN_AUDIO_DIAGNOSTICS_PROVIDER=otlp（off 为关闭）
- OTEL_EXPORTER_OTLP_TRACES_ENDPOINT 为接收端完整 traces 地址
- OTEL_EXPORTER_OTLP_TRACES_HEADERS 为鉴权头；不要提交真实值

当前适配器记录原始模型请求和响应、Schema、工具参数与结果、Token、错误类型、事实和来源 ID，以及会话和后台任务关联。导出使用有界后台队列，接收端故障不等待前台或改变模型结果。停机时有限时间 flush；异常崩溃或持续故障可能损失尚未导出的诊断，不能将其当成持久记忆队列。

OTLP 字段映射集中在 qwaudio_diagnostics/otlp.py，同时提供 GenAI/OpenInference 字段；更换平台时修改配置和必要映射，业务逻辑保留。

当前接入覆盖后台记忆 Agent、MCP/Graphiti、Node 实时模型收发、工具及其结果、任务交付与播放回执。实时生成保存会话配置与有界上下文快照；超过 2 MiB 的快照明确标注省略数量，实际收发事件分别记录并按会话关联。原始媒体不归档，仅记录元信息。外部 Agent 内部未上报的模型调用仍不可见。

官方 MCP 仍使用固定原始源码。组件自己的 mcp_tracing.py 在启动时为 QueueService 安装运行时诊断插件：提交时捕获上下文，每条队列任务执行时恢复；仅向本机模型适配器注入追踪头。追踪信息在进官方图前从来源描述移除。更换 MCP 固定版本时必须重新验证此插件。

秘密字段、环境中已知凭据和常见 API Key 格式在导出前脱敏；不会采集 HTTP 鉴权头。会话内容只进入受控诊断后端，不写普通日志或代码仓库。诊断记录不用于事实检索或历史恢复；记忆清空与诊断保留策略分别管理。

验证：python -m unittest discover -s components/diagnostics -p 'test_*.py'。需要已安装 OTLP 可选依赖。

Node 使用官方 LangfuseSpanProcessor 与 OpenTelemetry SDK，通过现有私有 OTLP 配置导出。业务层只依赖本目录接口。队列上限 2048 条，故障记录 errorCode/dropped，不重试业务或等待导出。关闭时最多刷新 3 秒。

供应商原始 usage 完整保存在生成输出；统计只在 generation 累计一次总用量。已核实的北京地域模型可提供人民币费用估算元数据，缓存、图片、未核实模型和地域标记未知。Langfuse 原生美元费用不混入人民币；未配置可靠美元价格时不伪造美元成本。测试验证费用时同时检查细分字段和定价来源。

GET /api/diagnostics/status 增加 runtime（启用、最近导出成功、错误码、待导出、丢弃数）和分链路覆盖情况。控制台访问继续使用独立登录，不公开采集凭据。诊断故障时无需改变业务 Provider。
