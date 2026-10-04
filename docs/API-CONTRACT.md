# 第一阶段内部接口约定

所有接口 /api，cookie session。JSON 错误 {error:string}。时间 ISO。共享类型 shared/types.ts。

- GET /auth/status -> {initialized,authenticated}; POST /auth/setup {password}（首次）; POST /auth/login {password}; POST /auth/logout。
- GET /projects -> Project[]; POST /projects {title,premise,mode} -> Project; GET /projects/:id -> {project,branches:Branch[],sources:Source[]}。GET 默认隐藏 premise（初始作者设定），显式 ?view=author 返回。
- DELETE /projects/:id（无请求体）-> {ok:true}：永久删除整部作品，包括原文、正文、所有故事线及历史快照、世界资料、剧情规划与伏笔、任务、导入队列、模型输出和搜索索引。先取消该作品未结束的任务、中止模型请求并等待收尾，再在事务中清理数据，迟到结果不能重新写回。删除期间创建、恢复或重试任务返回 409；重复并发删除返回 409，作品不存在或已删除返回 404。沿用 session 和同源校验，无需 baseRevisionId 或作者视图参数；不影响其他作品、登录和供应商设置。原文清理如遇文件占用，会保留在内部待清理目录并在下次服务启动重试。
- GET /branches/:id?view=author|reader -> BranchView，默认 reader；读者视图移除 outline/foreshadows/secret 内容（outline 空对象结构保留）。
- GET /branches/:id/chapters/:chapterId -> Chapter（只可取该线实际包含的章）。
- POST /branches/:id/chapters {baseRevisionId,title,text,chapterId?} -> BranchView（保存后 pending，自动整理，没配置模型可保留正文后配置并重试）；改旧章自动另开修订线，返回的 branch 可能不同。
- POST /branches/:id/fork {baseRevisionId,chapterId?,name} -> BranchView（不指定chapterId代表当前结尾）。
- POST /branches/:id/rollback {baseRevisionId,revisionId} -> BranchView。
- 作者视图的 `state.chapters[].summary` 为导入或整理正文时同时提取的已发生剧情摘要，片段摘要按处理顺序累积；与 `state.outline.fine` 的预期规划分开；不再生成或使用 coarse。回退和旧章节分支读取该边界的整份快照，摘要、伏笔状态与人物位置事实一起恢复。读者视图及章节正文接口继续隐藏摘要。
- `state.foreshadows` 保留历史状态，界面默认只显示 `planned/planted`。`resolved/abandoned` 不进入后续待处理伏笔上下文，模型再次提及同名线索不会自动重新打开；作者仍可在历史入口手工查看与修正。
- 地图使用两端均为 `location` 的地理关系，不将人物或任务关系画成地图节点。人物当前位置使用 `attribute=location` 的当前事实；同一状态按引用章节、段落的先后更新，旧记录转为过去，锁定或不确定的冲突保留供作者核对。
- PUT /branches/:id/outline {baseRevisionId,outline:{worldview?,locked,fine}} -> BranchView。沿用内部字段和路由名，内容为世界观、作者约束及未发生章节的预期规划；已发生章节自动过滤。此接口不能设置压缩摘要。
- PUT /branches/:id/entities/:entityId {baseRevisionId,entity} -> BranchView；POST /branches/:id/entities/merge {baseRevisionId,fromId,toId} -> BranchView（回退撤销合并）。
- PUT /branches/:id/foreshadows {baseRevisionId,foreshadows} -> BranchView。
- GET /branches/:id/search?q=&view=reader|author -> {chapters:{id,title,snippet}[],entities:Entity[]}。
- POST /projects/:id/import multipart file -> SourcePreview；GET /sources/:id/preview -> SourcePreview；GET /sources/:id/file 原文件；GET /sources/:id/chapters/:index 原文纯文本。
- POST /sources/:id/confirm {branchId,baseRevisionId,chapters:[{title,text}]} -> Job（确认目录后追加原文章节并整理）。
- POST /branches/:id/generate GenerateInput -> Job：提交后通过 SSE 展示新章；不自动请求规划。generate 在正文保存后立即 completed，另建独立 extract 任务，背景提取失败只重试 extract。GenerateInput 可含 regenerate?:boolean、discardBackground?:boolean；带 chapterId 的改写或重新生成总是从目标章之前新建分支，返回 Job.branchId 为新线，原正文保留。后台 extract 尚未完成或章节 pending 时，默认 409 提醒等待；discardBackground=true 取消旧线后台提取后新建分支，迟到结果不能写回。前面的章节必须已整理完成。普通续写需先完成上一章摘要。
- GET /jobs/:id/events?view=author -> text/event-stream；只允许正文生成任务。连接首先发送 {type:'snapshot',text,title,job,chapterId?,activities?:WritingActivity[]}，随后 {type:'delta',text}、{type:'activity',activity:WritingActivity} 或 {type:'status',job,chapterId?}，paused/failed/cancelled/stale/completed 后结束。草稿持久化，重连读取完整快照；客户端断开订阅不会取消服务器任务，暂停或取消须显式操作任务。
- GET /jobs/:id/activities?view=author -> WritingActivity[]；仅正文 generate 任务，需登录及显式作者视图，缺少作者视图返回 403。活动为 {id,kind:'thinking'|'tool',text?,name?,arguments?,result?,status:'running'|'completed'|'failed',error?}，按发生顺序返回；实时活动消息为同 id 的完整更新，客户端替换而不是重复累加。思考文本与工具参数/结果默认折叠，完成、失败、暂停和取消后仍可回看，刷新由活动接口或 SSE 快照恢复。新写作重试清理上一轮实时活动，原始模型输出另行保留。
- 过程只展示模型实际公开的思考/摘要及实际执行的工具调用，不导出加密推理字段、思考签名；已知密钥和凭据字段脱敏。思考和工具活动独立存储，不能进入 chapter.text、正文编辑器、剧情提取或 TXT 导出。取消及版本变化后拒绝迟到活动，终态活动在正文事务成功后先于 completed 发送。
- POST /branches/:id/summary-compression?view=author {baseRevisionId} -> Job（kind=plan,purpose=compress-summary）；仅创建压缩候选，不修改故事版本。完整源摘要超过规划窗口时分段压缩，再做合并压缩，最多三轮；每段独立校验完整预留输出并持久化进度，重试或人工修复不重复已完成段。进度通过 Job.progress/total/message 返回。GET /jobs/:id/summary-compression?view=author -> {text,chapterIds,baseRevisionId}；POST /branches/:id/summary-compression/confirm?view=author {baseRevisionId,jobId,text} -> BranchView，校验候选版本与覆盖章节后才写入 outline.summaryCompression。候选及确认内容必须比完整原摘要短，原分章摘要保留。
- POST /branches/:id/plan {baseRevisionId,instruction?} -> Job（返回 fine 与 foreshadows，只维护当前待写章和接下来三章的预期规划）；POST /branches/:id/extract {baseRevisionId} -> Job（处理未整理章节）。
- GET /jobs?projectId=&view=reader|author -> Job[]；POST /jobs/:id/:action?view=reader|author（pause/resume/retry/cancel）-> Job。payload 永远不通过HTTP返回；生成 Job 顶层提供 generatedChapterId，作者视图额外提供 title 与 generationInput（mode/instruction/maxWords/title），读者视图隐藏这些创作要求；purpose=compress-summary 区分摘要压缩任务；默认读者视图只返回公共任务状态，作者视图显示详细错误。usageEstimated 表示用量含估算值；inputTokens/outputTokens 为累计统计，不参与请求额度限制。
- 模型输出接口均要求登录及显式 `view=author`，缺少作者视图返回 403；普通任务接口不携带模型输出正文。
- GET /jobs/:id/outputs?view=author -> ModelOutputSummary[]；GET /jobs/:id/outputs/:outputId?view=author -> ModelOutputDetail（原始响应、模型文本、修正文本、校验问题、对应编号原文及 canApply）。
- 详情中的 `normalizedText` 是本地补全与证据对齐后的 JSON，或写作工具多轮返回的合成正文；`adjustments` 记录对应字段及处理说明，不改写 `rawResponse` / `text`。列表摘要不携带这些正文内容。`sourceParagraphs` 只提供当前片段实际可见的原文，超长段落不会提前返回后半段作为本次依据。
- `request` 为发送前保存的脱敏请求快照（真实 URL、头、正文、协议、模型、时限、流式开关）；`diagnostics` 为耗时、响应字节数、白名单响应头及传输结果。空响应或连接失败同样记录；请求和响应使用同一输出ID，响应只可填充一次。仅作者详情返回快照，列表与阅读接口不带请求正文。
- `diagnostics` 可含 `modelOutcome`（completed/blocked/truncated/empty/error）、`finishReason`、`promptBlockReason`。这是模型服务响应的反馈，不代表资料校验通过；Gemini 流式的真实 `promptFeedback.blockReason` 不替换为泛化标签。网关未返回模型反馈时省略相应字段，不从 5xx 猜测拦截原因，旧备份可继续读取。
- POST /jobs/:id/outputs?view=author {text} -> ModelOutputRecord：保存历史响应，不自动应用，也不调用模型。
- POST /jobs/:id/outputs/:outputId/apply?view=author {text,baseRevisionId} -> Job：保存修正后做本地校验。格式或证据不符返回 422，详情接口可取已保存草稿及问题；版本、阶段、进度过期或重复应用返回 409。成功后 completed 或 paused，不自动运行下一次模型请求。
- GET /settings -> Settings（密钥只返回 hasKey）；PUT /settings Settings（同服务空 apiKey 保留已有密钥；clearApiKey 清除；更换服务域名不自动携带旧密钥）-> Settings。
- `Settings.promptTemplates` 保存全局任务提示词编排：`{presets:{writing:PromptPreset[],planning:PromptPreset[],extraction:PromptPreset[],compression:PromptPreset[]},selected:{writing:string,planning:string,extraction:string,compression:string}}`。`PromptPreset` 为 `{id,name,blocks,variables?:Record<string,string>}`，块为 `{id,name,role:'system'|'user'|'assistant',enabled:boolean,content:string,modes?:('original'|'continuation'|'fanfiction'|'rewrite')[]}`；`modes` 仅正文写作使用，缺省或空数组适用于所有模式。自定义变量名以字母开头，仅含字母、数字和下划线，不能覆盖内置变量。模板用 `{{变量名}}` 一次展开，不递归解释素材或自定义变量值。
- 四类任务分别选择预设，压缩沿用 planning 模型。内置变量列表由 `shared/prompt-templates.ts` 的 `promptVariables` 定义，包含任务对应的上下文、当前输入及作品信息；写作和规划可使用完整 `context` 或单独选择世界观、规则、人物、伏笔、摘要与最近正文。提取 `context` 只包含已有名称对照和已埋未揭晓伏笔。空白消息不发送；展开后须有非空 user 消息，写作每种模式都须至少有一个启用的 user 块。
- 每任务 1–20 份预设，每份 1–80 块；单块内容最多 100000 字符，自定义变量最多 100 项，全局文本合计最多 700000 UTF-8 字节。无效变量、重复标识、选中预设不存在、无有效 user 块等返回 400，整份设置不保存。旧存储缺省时补默认预设；旧 PUT 请求省略 `promptTemplates` 时保留已保存编排，不重置。预设独立导出格式为 `{format:'ai-novel-prompt-preset',version:1,task,preset}`，不含连接信息；单作品备份不含全局提示词配置。
- 启用消息按数组顺序展开，OpenAI Chat/Responses 保留全部角色和顺序；Gemini/Claude 将 system 块按出现顺序合并到原生系统区，user/assistant 顺序保留。结构化任务在预算检查前补单个 JSON 输出要求，仍按既有格式、证据和版本校验；所有编排消息及工具结构计入单次上下文预估。摘要压缩按当前模板实际占用（包括重复变量）分段，超限不缩减输出上限。每次后续请求读取当前已保存预设，已发请求与历史结果不受修改影响。连接测试继续使用固定短测试提示词，不执行任务预设。
- `Settings.providers` 为供应商连接，只保存协议、地址和密钥等连接信息。任务分别保存 `writingProviderId/writingModel`、`planningProviderId/planningModel`、`extractionProviderId/extractionModel`。选中供应商时必须指定非空模型名，可使用列表外的自定义名称；未选供应商时对应模型清空。兼容旧连接的 `model` 输入及已有存储，缺少任务模型字段时按各任务原供应商的模型迁移；新返回与保存格式使用任务模型字段。
- `Settings.modelParameters` 为模型参数数组，每项以 `{role,providerId,model}` 唯一标识，`role` 为 `writing/planning/extraction`，包含 `maxOutputTokens/contextTokens` 和可选生成、思考、超时及流式参数。不同任务即使使用同一供应商与模型也各自保存；同一任务的不同模型或供应商分别保存。旧连接的参数和上限迁移到各任务已分配模型；旧无 `role` 的模型参数复制到三个任务，已有显式任务参数优先，历史未选模型保留。新返回与保存格式包含 `role` 并移除连接内的生成字段。新模型缺少记录时使用温度 `1`、Top P `1`、重复惩罚 `0`、输出 `4096`、上下文 `64000`、超时 `180000` 毫秒、非流式；已有记录的可选字段省略表示不发送，显式 `0/false` 保留。
- 每个模型的 `maxOutputTokens` 为单次输出上限，按保存值发送；`contextTokens` 为单次请求预估输入与完整预留输出的合计上限。超出上下文上限时在发送前停止、保留进度并允许手动重试，不缩减输出上限。`Settings` 不再包含累计任务限额 `taskTokenLimit`；旧存储或旧 PUT 请求中的该字段会被忽略，新返回与保存格式移除该字段，保留原有模型限额、密钥和任务分配。
- POST /settings/models `{providerId}` 或 `{provider:ProviderConnection}` -> `{models:{id:string,name?:string}[]}`。后者按草稿查询，不保存设置；只有同源且未清除密钥时才复用已保存密钥。服务端按协议获取上游模型列表并处理分页；获取失败返回明确错误，用户仍可自定义模型名。此接口不调用文本生成，也不自动重试。
- Gemini 模型参数可设 `geminiIncludeThoughts?:boolean`，映射至 `generationConfig.thinkingConfig.includeThoughts`；未设置时省略，false 明确发送，且可独立于思考等级或预算使用。其他协议不发送该设置；返回摘要保留在原响应中，但不计入模型正文。
- POST /settings/test `{providerId,model?,role?}` -> `{ok,message,inputTokens,outputTokens,capture?}`（按指定任务与模型保存的参数和输出上限调用一次真实模型，未保存过的模型使用通用默认值，不暗中缩小上限）。界面总是传入当前任务的模型及 `role`。兼容旧调用：未传 `role` 时，按正文写作、剧情规划、资料提取的顺序选第一个供应商与模型匹配的任务，无匹配则使用正文写作参数或默认值；省略模型时取对应任务已分配的模型，没有可用模型则拒绝请求。模型服务错误也返回 HTTP 200 / ok:false 及当次脱敏capture；输入错误仍返回4xx。
- GET /branches/:id/export -> txt；GET /projects/:id/backup -> gzip压缩JSON完整作品不含密钥，含任务进度及作者过程；过程备份仅重映射所属 jobId，工具参数和结果保留历史实际值；POST /restore multipart file（JSON或gzip）-> Project。恢复为独立作品，运行中任务转为暂停。历史状态在备份中单独gzip编码，避免长篇多版本膨胀。

前端每 2 秒刷新任务，任务完成后刷新当前 branch 状态；编辑器有未保存内容时不得被后台刷新覆盖。所有写请求使用 baseRevisionId，409 提示刷新/另存，不覆盖草稿。正文使用 SSE 实时输出，后台任务继续每两秒轮询；重连从持久化草稿快照续接，刷新和切换视图不重发生成请求。

人物 Entity 可含 isMain?:boolean 与 nameStatus?:'placeholder'|'confirmed'。isMainSource 记录 author/extraction 来源，作者显式主次选择优先，未人工指定的角色可随剧情重新识别；有明确名称或别名身份桥时可将暂称升级为真名，锁定身份不覆盖。人物事实优先为资料字段和重大经历，普通行动进入剧情摘要。

正文上下文完整保留世界观、规则、主要人物、未揭晓伏笔、最近三章全文及所有剧情摘要。作者确认的压缩摘要只替代其覆盖章节，后续章节仍用原摘要。search_story/read_entity/read_chapter 工具读取构建时的章节与资料快照；每轮模型工具调用独立检查完整输入加预留输出，累计用量只用于统计。最多六轮、二十四次工具调用，失败不隐式重试。

search_story 推荐传 `{keywords:["林舟","老吴"],scope?:"all"|"entities"|"chapters"}`，各词使用 OR（任一命中）匹配。兼容 query 字符串按空格、逗号、顿号、分号、换行或竖线拆词；整串为已知名称、别名或章标题时保留完整词。keywords 每项按完整短语匹配；同时传 query 和 keywords 时合并去重。至少提供一个非空词，错误类型、空白数组项或无效范围返回工具 error。检索经过 NFKC 和大小写规范化，只匹配名称、别名、描述、事实文字或各章标题/摘要/正文，不匹配内部 ID 与 JSON 字段名，各文本字段分别匹配；仍绑定起始版本，每类最多返回20条且不会重复同一条目。
