# 对话诊断

打开网页「设置 → 记忆与诊断」，进入 Langfuse 控制台或当前会话。控制台使用独立账号登录。

## 查找一轮对话

按会话查找 qwaudio.turn，展开 model.generate 和 tool.*。model.send/receive 保存实际 WebSocket 非媒体消息；生成详情保存发送配置、上下文快照、原始完成事件和 usage。快照超过 2 MiB 时明确记录省略数量，较早事件仍按会话关联。恢复重放和发送失败单独记录，不等同于供应商已经接收。

文字、首音频及播放回执提供时间点。客户端 elapsedSinceFirstAudioMs 使用同一浏览器时钟；服务端时间线包含网络回执延迟，二者不要混为模型生成耗时。旧客户端无回执时不能推断播放成功。原始音视频不保存，外部 Agent 未上报的内部模型调用不可见。

## 后台记忆

前台记忆查询与 Python/MCP 沿 traceparent 关联。连接关闭后，memory.batch 独立提交，memory.job 按会话、批次和来源追踪 ID 关联；持久任务恢复后仍保留关联。诊断内容不用于记忆回答或恢复事实。

## 用量与费用

只有 model.generate 累计供应商返回的总用量；细分音频、文本、缓存数据保留在原始 usage。缺失字段标记未知。已核实价格的北京地域模型提供人民币估算元数据，缓存或未核实情况不估算。不把人民币写进 Langfuse 的美元成本列；实际优惠和余额由供应商结算。

价格依据：https://help.aliyun.com/zh/model-studio/model-pricing 。估算不是账单，模型和地域匹配失败时保持未知。

## 状态、故障与关闭

受保护接口 GET /api/diagnostics/status 返回配置和运行状态。enabled 表示采集器初始化成功；lastSuccess 表示最近一批已导出，不能据此推断所有任务成功。errorCode、pending、dropped 用于定位导出故障。

私有配置 runtime/components/diagnostics/service.env 中 QWEN_AUDIO_DIAGNOSTICS_PROVIDER=off 可显式关闭，重启网关后生效。队列有界，故障不阻塞对话；长期故障、异常退出可能损失诊断。停机刷新最多等待 3 秒。不自动删除历史诊断。

## 本次验收

专用真实测试完成 3 次模型生成，覆盖文本回复和时间工具续接，Langfuse API 核对输入输出及用量入库。隔离空用户图的只读查询确认 Node → Python → MCP 同一追踪。未回放私人历史、未写入生产长期事实。

扩大回归发现的 3 项既有提示词断言，在当前提交的干净副本上同样失败；本次保留用户提示词，不为诊断接入更改它们。


## 会话页与原始详情

使用 Langfuse 原版 Sessions 页面查看逐轮对话。会话首页使用模型生成记录中的标准 messages 和 assistant 输出；连接准备等事件归入独立连接追踪，不再冒充用户消息。

点击消息的 Open observation 查看生成输入输出；点击完整追踪进入 Tree / Timeline，查看工具节点及 model.request、model.response 原始报文。标准聊天内容是用于阅读的协议投影，完整字段以原始节点为准；没有删除提示词、工具定义或检索结果。

修正仅影响后续采集，旧记录保留原有 JSON 格式。验收使用合成对话，不重新调用模型或回放私人历史。
