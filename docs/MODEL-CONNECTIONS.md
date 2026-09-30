# 模型连接参数与 500 排查

## 区分失败位置

HTTP 500 表示服务或网关返回了服务器错误。JSON 解析、引用校验发生在收到正文之后，修改提取规则不会消除上游 500。`Internal Server Error` 错误包没有说明具体内部原因，不能单凭它判定温度、内容限制或超时。

作者输出记录包含实际请求快照和连接诊断。快照在发送前保存；无 HTTP 响应、空响应体、错误 JSON、流式中断都会留档，不触发自动重试。连接失败、应用超时、主动取消、接收中断与 HTTP 错误码分别记录。

诊断含完整请求正文及参数，可能包含作者秘密，仅在作者接口显示。密钥、鉴权头、敏感查询参数会脱敏，响应头只留白名单。作品备份含诊断，不含模型密钥。旧记录没有当时的快照，不用当前配置伪造。

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

可选参数缺省时省略，数值 `0` 会发送。旧配置继续默认非流式、180 秒。切换协议后，其他协议专属设置保留，但不随当前协议发送。

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

思考可能占用输出预算。实际输出上限会受到任务剩余用量约束；Claude 手动思考预算必须小于当次实际上限，否则发出请求前报错。连接测试使用保存的输出上限和协议映射，仅提示词缩短，不再暗中降到1024。

## 依据与验证范围

- [OpenAI Chat 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[推理参数](https://developers.openai.com/api/docs/guides/reasoning)。
- [Gemini GenerationConfig](https://ai.google.dev/api/generate-content#v1beta.GenerationConfig)、[思考配置](https://ai.google.dev/gemini-api/docs/thinking)。
- [Claude 思考](https://platform.claude.com/docs/en/build-with-claude/thinking)、[长请求](https://platform.claude.com/docs/en/api/errors#long-requests)。

程序与浏览器测试使用独立数据库和本地 HTTP/SSE 模拟服务。2026-10-01 另外使用用户授权的测试密钥进行了三次真实接口调用及一次真实后台任务，均成功；具体输入范围和结果见 [验收记录](VALIDATION.md)。中性文本成功不代表原失败章节已恢复，也不作为真实模型成功率统计；真实服务器原因仍以其出站路由及错误日志为准。
