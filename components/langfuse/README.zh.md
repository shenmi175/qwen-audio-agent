# Langfuse 独立组件

本组件仅负责自托管 Langfuse 服务，不代理业务模型，不改变模型选择和提示词。业务诊断接口位于 ../diagnostics，使用标准 OTLP，替换平台无需重写记忆流程。

固定应用版本 4.78.0。镜像来源和配置哈希位于 images.lock.json，启动前核验，缺失时按来源摘要下载。独立 Compose 项目 qwaudio-langfuse，使用自己的 PostgreSQL、ClickHouse、Redis 和对象存储卷；停止或更新此组件不停止 Graphiti/Neo4j。禁止通过 down -v 管理常规升级。

## 初始化与运行

先准备目标主机的 HTTPS 证书，然后执行：

node components/langfuse/cli.mjs init --url https://your-host:8444 --bind your-host --certificate /private/path/server.crt --key /private/path/server.key

初始化生成独立随机凭据，不覆盖已有配置。service.env、login.txt 位于 runtime/components/langfuse，权限 600；OTLP 配置另存 runtime/components/diagnostics/service.env。运行数据与密钥不进入仓库。

- npm run langfuse:serve 启动容器并运行 HTTPS 管理入口，适合独立系统服务。
- npm run langfuse:start 仅启动容器。
- npm run langfuse:status 查询状态。
- npm run langfuse:stop 停止容器，保留数据。

Web 与存储端口仅绑定 loopback。HTTPS 代理暴露管理入口和签名存储路径，管理界面要求登录；禁止公开分享包含用户原文的 trace。初始账号密码从目标主机私有 login.txt 读取，不在普通日志显示。

## 查看诊断

进入初始化项目的 Observations / Sessions，按会话 ID 或 metadata.task_id 查找 memory.job。展开可查看 memory.agent、agent.tool.*、mcp.*、graphiti.schema.*、graphiti.model。

graphiti.schema.* 保存官方 Schema 请求与标准化结果；其 graphiti.model 子项保存真实发送给 Qwen 的强制函数请求、原始返回与 Token。工具项保留输入与输出，job 结果关联事实 ID。诊断从接入后开始留存，不自动回放旧会话。

## 留存与维护

尚未启用自动删除诊断数据。cli.mjs retention 只预览超过七天的 trace；--apply 会真正删除，必须先得到操作者明确授权。自动定时执行同样需要另行授权，当前部署没有安装或启用清理定时器。清空长期记忆不会自动删除独立诊断记录，后者不参与回答或恢复。

更换后端时先调整 diagnostics/service.env 的 OTLP 地址和鉴权，验证后停止本组件。凭据和数据卷分别备份；不要将私有环境文件加入提交。平台故障时业务仍继续，诊断导出可能丢失，不能把诊断后端用作任务队列。

验收：verify_recording.py 使用明确标注的合成 SDK 回执检验真实 HTTP/MCP/OTLP 留存，不消耗外部模型；verify_tracing.py 使用随机隔离身份检验真实模型与图谱，结束清理测试组，需要模型服务账户可用。
