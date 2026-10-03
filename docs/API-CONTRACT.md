# 第一阶段内部接口约定

所有接口 /api，cookie session。JSON 错误 {error:string}。时间 ISO。共享类型 shared/types.ts。

- GET /auth/status -> {initialized,authenticated}; POST /auth/setup {password}（首次）; POST /auth/login {password}; POST /auth/logout。
- GET /projects -> Project[]; POST /projects {title,premise,mode} -> Project; GET /projects/:id -> {project,branches:Branch[],sources:Source[]}。GET 默认隐藏 premise（初始作者设定），显式 ?view=author 返回。
- GET /branches/:id?view=author|reader -> BranchView，默认 reader；读者视图移除 outline/foreshadows/secret 内容（outline 空对象结构保留）。
- GET /branches/:id/chapters/:chapterId -> Chapter（只可取该线实际包含的章）。
- POST /branches/:id/chapters {baseRevisionId,title,text,chapterId?} -> BranchView（保存后 pending，自动整理，没配置模型可保留正文后配置并重试）；改旧章自动另开修订线，返回的 branch 可能不同。
- POST /branches/:id/fork {baseRevisionId,chapterId?,name} -> BranchView（不指定chapterId代表当前结尾）。
- POST /branches/:id/rollback {baseRevisionId,revisionId} -> BranchView。
- PUT /branches/:id/outline {baseRevisionId,outline} -> BranchView。
- PUT /branches/:id/entities/:entityId {baseRevisionId,entity} -> BranchView；POST /branches/:id/entities/merge {baseRevisionId,fromId,toId} -> BranchView（回退撤销合并）。
- PUT /branches/:id/foreshadows {baseRevisionId,foreshadows} -> BranchView。
- GET /branches/:id/search?q=&view=reader|author -> {chapters:{id,title,snippet}[],entities:Entity[]}。
- POST /projects/:id/import multipart file -> SourcePreview；GET /sources/:id/preview -> SourcePreview；GET /sources/:id/file 原文件；GET /sources/:id/chapters/:index 原文纯文本。
- POST /sources/:id/confirm {branchId,baseRevisionId,chapters:[{title,text}]} -> Job（确认目录后追加原文章节并整理）。
- POST /branches/:id/generate GenerateInput -> Job；POST /branches/:id/plan {baseRevisionId,instruction?} -> Job；POST /branches/:id/extract {baseRevisionId} -> Job（处理未整理章节）。
- GET /jobs?projectId=&view=reader|author -> Job[]；POST /jobs/:id/:action?view=reader|author（pause/resume/retry/cancel）-> Job。payload 永远不通过HTTP返回；默认读者视图只返回公共任务状态，作者视图显示详细错误。usageEstimated 表示用量含估算值；inputTokens/outputTokens 为累计统计，不参与请求额度限制。
- 模型输出接口均要求登录及显式 `view=author`，缺少作者视图返回 403；普通任务接口不携带模型输出正文。
- GET /jobs/:id/outputs?view=author -> ModelOutputSummary[]；GET /jobs/:id/outputs/:outputId?view=author -> ModelOutputDetail（原始响应、模型文本、修正文本、校验问题、对应编号原文及 canApply）。
- 详情中的 `normalizedText` 是本地补全与证据对齐后的 JSON，`adjustments` 记录对应字段及处理说明，不改写 `rawResponse` / `text`。列表摘要不携带这些正文内容。`sourceParagraphs` 只提供当前片段实际可见的原文，超长段落不会提前返回后半段作为本次依据。
- `request` 为发送前保存的脱敏请求快照（真实 URL、头、正文、协议、模型、时限、流式开关）；`diagnostics` 为耗时、响应字节数、白名单响应头及传输结果。空响应或连接失败同样记录；请求和响应使用同一输出ID，响应只可填充一次。仅作者详情返回快照，列表与阅读接口不带请求正文。
- `diagnostics` 可含 `modelOutcome`（completed/blocked/truncated/empty/error）、`finishReason`、`promptBlockReason`。这是模型服务响应的反馈，不代表资料校验通过；Gemini 流式的真实 `promptFeedback.blockReason` 不替换为泛化标签。网关未返回模型反馈时省略相应字段，不从 5xx 猜测拦截原因，旧备份可继续读取。
- POST /jobs/:id/outputs?view=author {text} -> ModelOutputRecord：保存历史响应，不自动应用，也不调用模型。
- POST /jobs/:id/outputs/:outputId/apply?view=author {text,baseRevisionId} -> Job：保存修正后做本地校验。格式或证据不符返回 422，详情接口可取已保存草稿及问题；版本、阶段、进度过期或重复应用返回 409。成功后 completed 或 paused，不自动运行下一次模型请求。
- GET /settings -> Settings（密钥只返回 hasKey）；PUT /settings Settings（同服务空 apiKey 保留已有密钥；clearApiKey 清除；更换服务域名不自动携带旧密钥）-> Settings。
- `Settings.providers` 为供应商连接，只保存协议、地址和密钥等连接信息。任务分别保存 `writingProviderId/writingModel`、`planningProviderId/planningModel`、`extractionProviderId/extractionModel`。选中供应商时必须指定非空模型名，可使用列表外的自定义名称；未选供应商时对应模型清空。兼容旧连接的 `model` 输入及已有存储，缺少任务模型字段时按各任务原供应商的模型迁移；新返回与保存格式使用任务模型字段。
- `Settings.modelParameters` 为模型参数数组，每项以 `{role,providerId,model}` 唯一标识，`role` 为 `writing/planning/extraction`，包含 `maxOutputTokens/contextTokens` 和可选生成、思考、超时及流式参数。不同任务即使使用同一供应商与模型也各自保存；同一任务的不同模型或供应商分别保存。旧连接的参数和上限迁移到各任务已分配模型；旧无 `role` 的模型参数复制到三个任务，已有显式任务参数优先，历史未选模型保留。新返回与保存格式包含 `role` 并移除连接内的生成字段。新模型缺少记录时使用温度 `1`、Top P `1`、重复惩罚 `0`、输出 `4096`、上下文 `64000`、超时 `180000` 毫秒、非流式；已有记录的可选字段省略表示不发送，显式 `0/false` 保留。
- 每个模型的 `maxOutputTokens` 为单次输出上限，按保存值发送；`contextTokens` 为单次请求预估输入与完整预留输出的合计上限。超出上下文上限时在发送前停止、保留进度并允许手动重试，不缩减输出上限。`Settings` 不再包含累计任务限额 `taskTokenLimit`；旧存储或旧 PUT 请求中的该字段会被忽略，新返回与保存格式移除该字段，保留原有模型限额、密钥和任务分配。
- POST /settings/models `{providerId}` 或 `{provider:ProviderConnection}` -> `{models:{id:string,name?:string}[]}`。后者按草稿查询，不保存设置；只有同源且未清除密钥时才复用已保存密钥。服务端按协议获取上游模型列表并处理分页；获取失败返回明确错误，用户仍可自定义模型名。此接口不调用文本生成，也不自动重试。
- Gemini 模型参数可设 `geminiIncludeThoughts?:boolean`，映射至 `generationConfig.thinkingConfig.includeThoughts`；未设置时省略，false 明确发送，且可独立于思考等级或预算使用。其他协议不发送该设置；返回摘要保留在原响应中，但不计入模型正文。
- POST /settings/test `{providerId,model?,role?}` -> `{ok,message,inputTokens,outputTokens,capture?}`（按指定任务与模型保存的参数和输出上限调用一次真实模型，未保存过的模型使用通用默认值，不暗中缩小上限）。界面总是传入当前任务的模型及 `role`。兼容旧调用：未传 `role` 时，按正文写作、大纲规划、资料提取的顺序选第一个供应商与模型匹配的任务，无匹配则使用正文写作参数或默认值；省略模型时取对应任务已分配的模型，没有可用模型则拒绝请求。模型服务错误也返回 HTTP 200 / ok:false 及当次脱敏capture；输入错误仍返回4xx。
- GET /branches/:id/export -> txt；GET /projects/:id/backup -> gzip压缩JSON完整作品不含密钥，含任务进度；POST /restore multipart file（JSON或gzip）-> Project。恢复为独立作品，运行中任务转为暂停。历史状态在备份中单独gzip编码，避免长篇多版本膨胀。

前端每 2 秒刷新任务，任务完成后刷新当前 branch 状态；编辑器有未保存内容时不得被后台刷新覆盖。所有写请求使用 baseRevisionId，409 提示刷新/另存，不覆盖草稿。第一版轮询代替 SSE，断线恢复可从服务器任务状态续接。
