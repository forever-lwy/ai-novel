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
- GET /jobs?projectId=&view=reader|author -> Job[]；POST /jobs/:id/:action?view=reader|author（pause/resume/retry/cancel）-> Job。payload 永远不通过HTTP返回；默认读者视图只返回公共任务状态，作者视图显示详细错误。usageEstimated 表示用量含估算值。
- 模型输出接口均要求登录及显式 `view=author`，缺少作者视图返回 403；普通任务接口不携带模型输出正文。
- GET /jobs/:id/outputs?view=author -> ModelOutputSummary[]；GET /jobs/:id/outputs/:outputId?view=author -> ModelOutputDetail（原始响应、模型文本、修正文本、校验问题、对应编号原文及 canApply）。
- 详情中的 `normalizedText` 是本地补全与证据对齐后的 JSON，`adjustments` 记录对应字段及处理说明，不改写 `rawResponse` / `text`。列表摘要不携带这些正文内容。`sourceParagraphs` 只提供当前片段实际可见的原文，超长段落不会提前返回后半段作为本次依据。
- `request` 为发送前保存的脱敏请求快照（真实 URL、头、正文、协议、模型、时限、流式开关）；`diagnostics` 为耗时、响应字节数、白名单响应头及传输结果。空响应或连接失败同样记录；请求和响应使用同一输出ID，响应只可填充一次。仅作者详情返回快照，列表与阅读接口不带请求正文。
- `diagnostics` 可含 `modelOutcome`（completed/blocked/truncated/empty/error）、`finishReason`、`promptBlockReason`。这是模型服务响应的反馈，不代表资料校验通过；Gemini 流式的真实 `promptFeedback.blockReason` 不替换为泛化标签。网关未返回模型反馈时省略相应字段，不从 5xx 猜测拦截原因，旧备份可继续读取。
- POST /jobs/:id/outputs?view=author {text} -> ModelOutputRecord：保存历史响应，不自动应用，也不调用模型。
- POST /jobs/:id/outputs/:outputId/apply?view=author {text,baseRevisionId} -> Job：保存修正后做本地校验。格式或证据不符返回 422，详情接口可取已保存草稿及问题；版本、阶段、进度过期或重复应用返回 409。成功后 completed 或 paused，不自动运行下一次模型请求。
- GET /settings -> Settings（密钥只返回 hasKey）；PUT /settings Settings（同服务空 apiKey 保留已有密钥；clearApiKey 清除；更换服务域名不自动携带旧密钥）-> Settings。
- Gemini 连接可设 `geminiIncludeThoughts?:boolean`，映射至 `generationConfig.thinkingConfig.includeThoughts`；未设置时省略，false 明确发送，且可独立于思考等级或预算使用。其他协议不发送该设置；返回摘要保留在原响应中，但不计入模型正文。
- POST /settings/test {providerId} -> {ok,message,inputTokens,outputTokens,capture?}（按保存的参数和输出上限调用一次真实模型，不暗中缩小上限）。模型服务错误也返回 HTTP 200 / ok:false 及当次脱敏capture；输入错误仍返回4xx。
- GET /branches/:id/export -> txt；GET /projects/:id/backup -> gzip压缩JSON完整作品不含密钥，含任务进度；POST /restore multipart file（JSON或gzip）-> Project。恢复为独立作品，运行中任务转为暂停。历史状态在备份中单独gzip编码，避免长篇多版本膨胀。

前端每 2 秒刷新任务，任务完成后刷新当前 branch 状态；编辑器有未保存内容时不得被后台刷新覆盖。所有写请求使用 baseRevisionId，409 提示刷新/另存，不覆盖草稿。第一版轮询代替 SSE，断线恢复可从服务器任务状态续接。
