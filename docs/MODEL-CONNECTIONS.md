# 供应商连接、任务模型与 500 排查

## 供应商与模型选择

供应商连接保存地址、协议和密钥。正文写作、大纲规划、资料提取各自选择供应商与模型，同一个供应商可以使用不同模型。输出上限、上下文上限、采样和思考参数在模型选择下方设置，按“任务用途＋供应商＋模型名称”独立保存；不同任务即使选择同一模型也不共用参数。

选择供应商后自动查询其模型目录。编辑地址、协议或密钥后会重新查询，草稿查询不保存设置；更换服务域名不会转发原有密钥。目录返回失败或未包含网关别名时，可以直接在任务的模型名称中输入自定义名称。目录中的模型由上游提供，不保证每个模型都支持当前生成协议及参数。

旧连接中的模型名按原用途迁移到任务，原供应商标识和密钥保留。任务连接测试显式使用该任务模型，仍只发送一次生成请求；目录查询不触发生成测试。

模型目录按所选前缀追加 `/models`。两个 OpenAI 协议使用 Bearer 认证，Gemini 使用 `x-goog-api-key`，Claude 使用 `x-api-key` 与版本头。Gemini 和 Claude 自动读取后续页；模型目录最多读取 30 秒（配置更短超时时采用该值）、4 MiB、5000 条或 20 页，超限明确提示手动填写，不把不完整列表当作完整结果。不跟随目录重定向，避免把凭据转发到其他地址。

接口依据：[OpenAI 模型列表](https://developers.openai.com/api/reference/resources/models/methods/list)、[OpenAI 鉴权](https://developers.openai.com/api/reference/overview)、[Gemini 模型列表](https://ai.google.dev/api/models)与[密钥用法](https://ai.google.dev/gemini-api/docs/api-key)、[Claude 模型列表](https://platform.claude.com/docs/en/api/models/list)。上游目录不保证所有返回型号都支持当前文字生成协议，Gemini 声明生成方法时仅展示支持 `generateContent` 的模型。

## 区分失败位置

HTTP 500 表示服务或网关返回了服务器错误。JSON 解析、引用校验发生在收到正文之后，修改提取规则不会消除上游 500。`Internal Server Error` 错误包没有说明具体内部原因，不能单凭它判定温度、内容限制或超时。

作者输出记录包含实际请求快照和连接诊断。快照在发送前保存；无 HTTP 响应、空响应体、错误 JSON、流式中断都会留档。资料提取仅在“任务模型”明确开启自动重试后按次数和间隔重发失败片段；其他任务仍无自动重试。连接失败、应用超时、主动取消、接收中断与 HTTP 错误码分别记录。

诊断含完整请求正文及参数，可能包含作者秘密，仅在作者接口显示。密钥、鉴权头、敏感查询参数会脱敏，响应头只留白名单。作品备份含诊断，不含模型密钥。旧记录没有当时的快照，不用当前配置伪造。

流式文字超时按首段内容等待与相邻内容间空闲计算，同一个 `timeoutMs` 分别作为两者的阈值。任意非空返回字节（正文、公开思考、工具参数、心跳等）都会刷新计时，只有响应头仍算等待首段内容；持续接收时不受整次请求时长限制。非流式请求仍固定按总时长计算，模型目录与图片使用各自限时。错误分别说明首段等待或流式空闲，并保留已收到的正文、思考、原响应及用量；重试仍须明确发起。

## AxonHub 测试场与普通 API

核对的是官方提交 `223e696aa6b7c481ddadf57a51d295afd585a89a`，不代表已确认用户服务器运行同一版本。

- [测试场前端](https://github.com/looplj/axonhub/blob/223e696aa6b7c481ddadf57a51d295afd585a89a/frontend/src/features/playground/index.tsx#L165-L187)通过 `/admin/playground/chat` 发送 AI SDK 格式；渠道模式会带 `X-Channel-ID`。
- [测试场服务端](https://github.com/looplj/axonhub/blob/223e696aa6b7c481ddadf57a51d295afd585a89a/internal/server/api/playground.go#L232-L329)有指定渠道选择逻辑，并支持数据流返回。管理测试场不等同于普通 API 的模型路由。

对比时保持相同模型 ID、参数和返回方式，核对普通 API 的模型映射、API Key 归属项目及实际出站渠道。先比较应用诊断与网关入站记录，再检查网关实际转发的出站请求和错误。不要复制测试场浏览器鉴权头；客户端应使用独立 API Key。

切换协议不会覆盖自定义服务前缀，但应由用户填写对应协议的真实前缀。程序不把管理测试场 URL 当作标准生成接口。

## LobeHub 请求记录与空响应

2026-10-01 对照用户提供的两份 Gemini 请求，双方使用原生接口及 `x-goog-api-key`。LobeHub 显式设置 `thinkingLevel:high` 和 `includeThoughts:true`，没有显式温度、Top P、输出上限；任务设置 `thinkingLevel:high`、温度 1、Top P 1、实际输出上限 23397。工具、系统说明、安全设置和用户文本的转义方式也有区别，两份请求并非逐字相同。系统说明省略可选 role 不是格式错误；本轮真实中性请求已验证原任务的路径、认证和上述生成参数能够返回正文。

AxonHub 的 [空响应检查](https://github.com/looplj/axonhub/blob/223e696aa6b7c481ddadf57a51d295afd585a89a/llm/pipeline/empty_response.go)会把没有有效内容的响应转为可触发渠道重试的错误。因此，“所有渠道重试后 502”并不单独证明请求字段错误；需检查该次出站请求、原始上游响应，以及是否命中空流或首事件时限。用户服务器是否使用这个提交未确认。

模型本身也可能返回 HTTP 200，但 `promptFeedback.blockReason` 表示输入被拦截，或 `finishReason:SAFETY` 表示输出被拦截；这时没有可用正文。详见 [Google 的响应反馈说明](https://ai.google.dev/gemini-api/docs/safety-settings)。不能从网关 500／502 推断已经发生拦截。程序现在保留实际模型反馈，并为无反馈的网关错误给出明确提示。

“Gemini 返回思考摘要”允许与成功客户端对齐 `includeThoughts`。开启后，流式响应可在正文之前包含摘要；本应用不会把摘要当作小说事实。这个选项不保证解决空响应、超时或上游拦截。本轮没有改动安全设置，也没有自动添加工具或伪造思考签名。

## 参数发送规则

供应商只保存协议、地址和密钥；生成参数与输出、上下文上限按“任务用途＋供应商＋模型名称”保存，在任务模型选择下方编辑。大纲规划、资料提取和正文写作互不影响，同一任务切换模型后再选回会恢复原值。旧供应商参数迁移到当时各任务已分配的模型；旧版没有任务用途的模型参数分别复制给三个任务，后续修改相互独立，历史未选模型的参数也保留。后续新增模型使用通用默认值。

新模型默认温度 `1`、Top P `1`、存在与频率惩罚 `0`、最大输出 `4096` tokens、上下文 `64000` tokens、非流式、超时 `180` 秒。思考、Top K、种子和停止序列不强制设置；不支持的可选采样参数可手动清空。已有设置中缺省或主动清空的可选项保持省略，数值 `0` 会发送。切换协议后，其他协议专属设置保留，但不随当前协议发送。

| 设置 | Chat Completions | Responses | Gemini 原生 | Claude Messages |
| --- | --- | --- | --- | --- |
| 温度 / Top P | `temperature` / `top_p` | 同左 | `generationConfig.temperature/topP` | `temperature/top_p` |
| Top K | 不发送 | 不发送 | `generationConfig.topK` | `top_k` |
| 种子 / 重复惩罚 | `seed/presence_penalty/frequency_penalty` | 不发送 | `generationConfig.seed/presencePenalty/frequencyPenalty` | 不发送 |
| 停止序列 | `stop`，最多4条 | 不发送 | `generationConfig.stopSequences`，最多5条 | `stop_sequences`，本应用最多16条 |
| 思考等级 | `reasoning_effort` | `reasoning.effort` | `thinkingConfig.thinkingLevel` | `output_config.effort` |
| 思考预算 | 不发送 | 不发送 | `thinkingConfig.thinkingBudget` | `thinking.budget_tokens` |
| 返回思考摘要 | 不发送 | 不发送 | `thinkingConfig.includeThoughts` | 不发送 |
| 流式 | `stream:true` | `stream:true` | `streamGenerateContent?alt=sse` | `stream:true` |

Gemini 的 `thinkingConfig` 放在 `generationConfig` 内，等级与预算不能同时发送。Claude 手动思考用 `thinking.type:enabled`，自适应用 `adaptive`，关闭用 `disabled`。支持范围依型号而异，不猜测网关别名来自动改参。

单次输出上限 `maxOutputTokens` 按该模型保存的值发送；上下文上限 `contextTokens` 限制每次请求的预估输入与完整预留输出之和。超出上下文上限时，在发送前停止并保留任务进度，调整设置或减少本次输入后可手动重试，不暗中缩小输出上限。累计输入与输出仅作统计，不会阻止后续请求；旧配置中的 `taskTokenLimit` 在读取时忽略，保存时移除，已有输出上限、上下文上限、密钥和任务模型保留。

思考可能占用输出预算。Claude 手动思考预算必须小于保存的单次输出上限，否则发出请求前报错。连接测试使用保存的输出上限和协议映射，仅提示词缩短，不再暗中降到1024。

## 依据与验证范围

- [OpenAI Chat 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[推理参数](https://developers.openai.com/api/docs/guides/reasoning)。
- [Gemini GenerationConfig](https://ai.google.dev/api/generate-content#v1beta.GenerationConfig)、[思考配置](https://ai.google.dev/gemini-api/docs/thinking)。
- [Claude 思考](https://platform.claude.com/docs/en/build-with-claude/thinking)、[长请求](https://platform.claude.com/docs/en/api/errors#long-requests)。

程序与浏览器测试使用独立数据库和本地 HTTP/SSE 模拟服务。2026-10-01 另外使用用户授权的测试密钥进行了三次真实接口调用及一次真实后台任务，均成功；具体输入范围和结果见 [验收记录](VALIDATION.md)。中性文本成功不代表原失败章节已恢复，也不作为真实模型成功率统计；真实服务器原因仍以其出站路由及错误日志为准。
