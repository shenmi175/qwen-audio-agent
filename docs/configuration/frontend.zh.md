# 语音前台

语音前台负责实时交流；后台 Agent 负责执行工作。二者可独立选择。

供应商选择、凭据、服务地址和当前模型仍写入 `qwenaudio config` 显示的 `config.env`。桌面版“语音前台”设置修改这些连接信息，并从框架支持的模型中下拉选择。模型定义和适配参数由代码维护。

## 选择服务

| 服务 | Provider 值 | 必填或首次使用配置 | 使用说明 |
| --- | --- | --- | --- |
| Qwen Audio / Omni 3.5 / Omni 3.8 | `dashscope`（默认） | DashScope API Key；Omni 3.8 还需业务空间专属地址 | [Audio 语音](../voice-frontends/qwen-audio-realtime.zh.md) / [Omni 视觉](../voice-frontends/qwen-omni-realtime.zh.md) |
| StepAudio 3 | `stepfun` | StepFun API Key | [StepFun](../voice-frontends/stepfun.zh.md) |
| OpenAI Realtime | `gpt-live` | OpenAI API Key | [GPT-Live](../voice-frontends/gpt-live.zh.md) |
| Gemini Live | `google-live` | Google API Key | [Google Live](../voice-frontends/google-live.zh.md) |
| 豆包 Seeduplex | `doubao-seeduplex` | 豆包 API Key | 模型、音色与服务地址配置见下表 |
| Hugging Face speech-to-speech | `speech-to-speech` | 先启动服务；默认 `ws://127.0.0.1:8765/v1/realtime` | [本地模型链路](../voice-frontends/speech-to-speech.zh.md) |
| MiniCPM-o 4.5 | `minicpm-o` | 先启动服务；默认 `ws://127.0.0.1:8006/v1/realtime?mode=audio` | [音频 / 视频模式及限制](../voice-frontends/minicpm-o.zh.md) |

例如，使用默认前台：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=dashscope
QWEN_AUDIO_REALTIME_API_KEY=your-key
QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.1-realtime-plus
QWEN_AUDIO_REALTIME_URL=
QWEN_AUDIO_REALTIME_VOICE=
```

切换到 StepFun 时，改选服务并填写它自己的凭据：

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=stepfun
QWEN_AUDIO_REALTIME_API_KEY=your-stepfun-key
QWEN_AUDIO_REALTIME_MODEL=stepaudio-3-realtime-preview
QWEN_AUDIO_REALTIME_URL=
QWEN_AUDIO_REALTIME_VOICE=
```

单供应商模式使用相同的五个字段描述当前连接。切换供应商时，同时替换 Key 和模型，清空或替换地址、音色。前台凭据与后台、搜索、记忆服务的凭据独立。

### 在网页切换 Qwen 和 OpenAI

可在同一份服务端 `config.env` 中启用两套语音配置。先设置默认供应商，再分别填入各自的模型和密钥。

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=gpt-live
QWEN_AUDIO_REALTIME_PROFILES=dashscope,gpt-live
QWEN_AUDIO_REALTIME_PROFILE_DASHSCOPE_API_KEY=
QWEN_AUDIO_REALTIME_PROFILE_DASHSCOPE_MODEL=qwen-audio-3.1-realtime-plus
QWEN_AUDIO_REALTIME_PROFILE_GPT_LIVE_API_KEY=
QWEN_AUDIO_REALTIME_PROFILE_GPT_LIVE_MODEL=gpt-realtime-2.1
```

各配置还支持同前缀的 `URL` 和 `VOICE`，留空使用该供应商默认值。网页设置的供应商和模型选择在新语音连接中生效。支持两个系列的 Graphiti 组件按会话实际使用的系列筛选和建图，跨系列仍访问同一张图。参见 [Graphiti 模型档位与迁移](../../components/graphiti/README.zh.md)。

## 连接配置

| 字段 | 含义 |
| --- | --- |
| `QWEN_AUDIO_REALTIME_PROVIDER` | 供应商，默认 `dashscope` |
| `QWEN_AUDIO_REALTIME_MODEL` | 模型 ID；留空使用供应商默认模型 |
| `QWEN_AUDIO_REALTIME_API_KEY` | 当前服务的凭据 |
| `QWEN_AUDIO_REALTIME_URL` | WebSocket 服务地址；留空使用供应商默认值 |
| `QWEN_AUDIO_REALTIME_VOICE` | 指定音色；留空使用模型或服务默认值 |

各供应商的默认值：

| Provider | 默认模型 | 默认地址 |
| --- | --- | --- |
| `dashscope` | `qwen-audio-3.1-realtime-plus` | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` |
| `stepfun` | `stepaudio-3-realtime-preview` | `wss://api.stepfun.com/v1/realtime` |
| `gpt-live` | `gpt-realtime-2.1` | `wss://api.openai.com/v1/realtime` |
| `google-live` | `gemini-3.8-live` | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` |
| `doubao-seeduplex` | `1.2.6.1` | `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue` |
| `speech-to-speech` | 上游配置 | `ws://127.0.0.1:8765/v1/realtime` |
| `minicpm-o` | 上游配置 | `ws://127.0.0.1:8006/v1/realtime?mode=audio` |

speech-to-speech 与 MiniCPM-o 的模型、音色由上游服务管理，应留空；服务启用 Bearer 认证时才需填写 API Key。Qwen3.8 Omni 必须填写[业务空间专属地址](../voice-frontends/qwen-omni-realtime.zh.md#配置)，不能使用 DashScope 公共默认地址。统一配置不改变各服务的协议和能力限制，这些差异仍由 Provider adapter 处理。

DashScope 当前内置以下模型档案：

| 模型 ID | 实时输入 |
| --- | --- |
| `qwen-audio-3.1-realtime-plus`（默认） | 文字、语音 |
| `qwen-audio-3.1-realtime-flash` | 文字、语音 |
| `qwen-audio-3.0-realtime-plus` | 文字、语音 |
| `qwen-audio-3.0-realtime-flash` | 文字、语音 |
| `qwen3.5-omni-flash-realtime` | 文字、语音、实时视觉帧 |
| `qwen3.5-omni-plus-realtime` | 文字、语音、实时视觉帧 |
| `qwen3.8-omni-flash-realtime` | 文字、语音、实时视觉帧 |

这些档案均支持工具调用。模型能否接收视觉帧，还取决于客户端和传输通道，见[视觉输入](../guides/vision.zh.md)。

Audio 3.1 Plus / Flash 复用现有 `dashscope` Provider，默认音色为 `longanqian_v3.1`；
Audio 3.0 Plus / Flash 保持 `longanqian`。显式配置 `QWEN_AUDIO_REALTIME_VOICE`
时，须选择与模型匹配的音色。Audio 模型不支持视觉输入。模型切换和工作区端点覆盖见
[Audio 使用说明](../voice-frontends/qwen-audio-realtime.zh.md)。

## 选择受支持模型

模型列表由框架维护，桌面版和 `qwenaudio config show` 使用同一份列表。在桌面版为当前供应商选择模型，或设置 `QWEN_AUDIO_REALTIME_MODEL`；留空使用供应商默认模型。例如，当前供应商为 `dashscope` 时，填写 `qwen-audio-3.1-realtime-flash` 即可切换到内置的 3.1 Flash，默认模型仍为 3.1 Plus。

未支持的模型 ID 会报配置错误。用户配置不能新增模型、重定义已有模型，也不能修改其 API 绑定、能力、话轮检测或接入约束；这些参数由框架的模型适配固定。现有 `QWEN_AUDIO_REALTIME_VOICE` 和会话级音色覆盖仍然有效，但须选择与当前模型兼容的音色。

列表表示代码已实现的支持，不代表线上服务可用性或账号授权。请确认所选模型的账号、地域、服务地址和音色，再按下文应用并验证连接。speech-to-speech 与 MiniCPM-o 的模型继续在外部服务中配置。

## 应用并验证

1. 桌面版修改后点击“应用”。终端 Gateway 退出后重新启动；已安装的后台服务执行 `qwenaudio gateway restart`。
2. 连接客户端，确认“语音前台”已连接。
3. 说一句话，确认能听到回答。需要工具时，再测试搜索或一个简单后台请求。

CLI 可查看当前配置及受支持模型列表：

```bash
qwenaudio config show
qwenaudio config set --realtime-model qwen-audio-3.1-realtime-flash
```

`config set` 修改当前 Provider 的模型，不切换 Provider，也不自动重启 Gateway。远程客户端沿用远端配置；不能通过本机配置切换远端模型。

## 服务差异

- **MiniCPM-o** 当前适配不支持文字输入、结构化工具调用、主动播报或会话上下文恢复；适合语音 / 视觉聊天，不用于后台编排。
- **speech-to-speech** 的语言识别、音色、工具调用质量取决于你配置的 STT、LLM 与 TTS。
- **Google Live** 当前不向重连后的上游会话恢复历史上下文；界面保留记录不等于模型已收到历史。
- 其他服务的已支持能力和限制，以各自接入页面为准。

前台扩展工具另行配置：[搜索](../guides/web-search.zh.md)、[MCP](../reference/frontend-mcp.zh.md)、[OpenAPI](../reference/frontend-openapi.zh.md)。

## 旧配置排查

供应商专属的旧前台变量仅兼容读取，上述五个统一字段优先，包括显式留空。旧文件若同时含有统一的模型/音色字段和其他供应商的模型/音色字段，需将当前所选供应商需要的值写入统一字段。Omni 原有的 `QWEN_OMNI_REALTIME_VOICE` 应移至 `QWEN_AUDIO_REALTIME_VOICE`。

桌面版保存当前连接。需要在网页按会话选择独立供应商时，使用上面的服务端配置。旧变量不会自动删除，因为后台 Agent、搜索或其他模块可能仍在使用。更多优先级规则见[配置总览](../configuration.zh.md#配置优先级)。

## 提示词编辑

Mac 本机网页“设置 → 提示词”打开独立的 `/prompts` 页面，不建立语音连接。
五个 Tab 分别管理对话行为、人格与表达、记忆交互、记忆筛选、图谱提取；记忆筛选另有轻量、标准、深入三个档位。
Qwen 与 OpenAI 共用这些表达与筛选策略，模型、凭据及协议适配继续按系列独立管理。

编辑器直接读写 `QWAUDIO_PROMPTS_DIR`（默认 `runtime/prompts`），没有新增模型配置入口。
默认模板位于 `config/prompts`。前台三份提示词保存后刷新快照，在当前回复结束后应用；
后台筛选在新任务开始时读取对应档位，图谱提取在下一次入图时读取。
切换 Tab 保留未保存草稿；离开时提醒；版本冲突返回 409，避免覆盖另一页面的修改。
该配置影响整个本地部署，管理接口只接受本机身份，并复用 Gateway 的认证与同源检查。
工具参数、确认授权、证据校验、队列隔离及 JSON 输出结构仍由程序维护。

设计参考：

- [OpenAI Realtime 提示词指南](https://developers.openai.com/api/docs/guides/voice-prompting)：从简短提示开始，按具体触发条件定义行为，用实测发现需要补充的规则。
- [dsh-fish 大肥鱼](https://github.com/ssamurias/dsh-fish)：参考简短常驻提示、真实经历与当前情境分离、减少清单式催促的思路。其成长循环、主动联网和不可删除历史属于该插件的产品选择，本次保留本项目现有的用户控制与遗忘机制。
- [社区鲸鱼娘人格插件](https://github.com/Kaalia0912/dsh-whale-musume-persona)：参考人格与能力边界分离、性格及表达的组织方式；不是 DeepSeek 官方角色，也没有安装该插件。
- [SillyTavern 角色设计](https://docs.sillytavern.app/usage/characters/)：分离角色描述、人格和对话示例。本项目使用原创简短示例，未复制他人的角色内容。

人格不参与后台记忆筛选。记忆策略仅描述保留范围、证据归属和隐私；旧的循环读写工具流程已删除。

### 搜索随语音系列路由

默认搜索为 Bing；每个 `gpt-live` 连接固定使用 OpenAI Responses 的官方 `web_search`，不会失败后回落到其他厂商。
使用 GPT 语音配置的密钥，模型可在同一个 `config.env` 设置 `QWEN_AUDIO_OPENAI_SEARCH_MODEL`，默认 `gpt-6.1-terra`。
`QWEN_AUDIO_WEB_SEARCH_PROVIDER=bing` 负责其他系列的默认搜索。
OpenAI 路径检查真实 `web_search_call` 已完成和 URL 引用，结果复用原页面的引用展示。
搜索按需调用，不在普通聊天中额外请求；OpenAI 搜索等待上限 25 秒，其他路径保留 8 秒，关闭会话会取消请求。

GPT 当前直接接收 24 kHz 音频，输入转写配置为 `gpt-transcribe`，实时对话模型为 `gpt-realtime-2.1`。
转写用于文字展示、历史和记忆；它不是实时模型理解音频的必经文本链路。
