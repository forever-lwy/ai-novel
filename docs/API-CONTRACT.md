# 第一阶段内部接口约定

所有接口 /api，cookie session。JSON 错误 {error:string}。时间 ISO。共享类型 shared/types.ts。

## 登录与安全边界

- 初始密码通过服务启动环境的 `INITIAL_PASSWORD` 设置，只对没有密码的数据目录生效。新密码 12～256 字符，去除首尾空白后仍须至少 12 位，拒绝全空白、重复单字符及常见弱密码；只保存带版本及参数的 scrypt 哈希。首次启动缺失、为空或不合规则时停止启动，错误不包含密码；已有数据库密码不被此变量覆盖。
- `GET /auth/status -> {initialized:boolean,authenticated:boolean}`，不返回初始密码、密码哈希或会话值。不提供网页初始化密码接口；嵌入式实例未初始化时只能提示管理员配置。
- `POST /auth/login {password} -> {ok:true}`，接受旧版 8～256 字符密码；成功登录时将旧 `salt:hash` 升级为带版本与参数的 scrypt 哈希（`N=16384,r=8,p=5`），不更改原密码。错误密码为 401。
- `POST /auth/logout -> {ok:true}`，撤销当前会话并清除 Cookie。
- `POST /auth/password {currentPassword,password} -> {ok:true}`，要求有效会话与当前密码，新密码遵循初始化规则。事务更新密码并撤销全部原会话，返回当前浏览器的新 Cookie；异步校验期间密码或会话已变化时拒绝操作。
- `POST /auth/sessions/revoke {password} -> {ok:true}`，要求有效会话与正确密码，撤销全部原会话并为当前浏览器重新建立会话。错误密码为 401。
- 鉴权依据实际匹配的 API 路由执行；编码路径不能跳过登录或来源检查。会话 token 为随机 32 字节，数据库仅存 SHA-256；Cookie 使用 `HttpOnly`、`SameSite=Strict`，有效期 7 天。配置 `PUBLIC_ORIGIN` 后自动 `Secure`，显式关闭会导致启动失败。
- SSE 在发送每个事件与心跳前重新检查会话；退出、改密码、撤销或过期后关闭原连接，不再发送新内容。
- 上述写接口的请求体上限 4 KiB。登录按可信客户端 IP 限制 5 分钟内 10 次；改密码与撤销会话共享 5 分钟内 5 次。限速在请求体解析前执行，成功登录不清空计数；超限返回 429 和 `Retry-After`。密码运算同时最多 4 项，繁忙返回 429。
- `PUBLIC_ORIGIN` 只接受不含凭据、子路径、查询或片段的 HTTPS 来源；`TRUSTED_PROXIES` 只接受明确 IP／CIDR，默认不信任代理头。写请求执行来源检查；一般响应带浏览器安全头，生产页面启用内容安全策略。请求日志不记录查询参数、请求体、Cookie 或 Authorization。

详细部署设置见 [安全部署](DEPLOYMENT.md)。

## RPG 与剧情选择

- `Mode` 新增 `rpg`，作品创建与提示词模式条件接受该值。`StoryState.rpg` 保存体验角色及入场要求，跟随故事版本、分支与完整作品备份；阅读投影隐藏此作者配置。
- `POST /branches/:id/generate?view=author` 的 `GenerateInput` 可带 `rpg:{character:{kind:'original'|'existing',name,description,entityId?},entryChapterId?,entryInstruction?}`。首次入场按指定章节结尾或当前结尾建立独立 RPG 线，返回 `Job.branchId` 为新线。原创角色须有姓名；已有角色按起点资料中未合并的 character 实体确认，以服务端姓名与资料为准。起点章节须已完成整理。继续体验使用 `mode:'rpg'` 并省略 `rpg`，要求当前版本已有体验配置。RPG 不接受 `chapterId`、选段改写或 `regenerate`。
- RPG 正文工具 `ask_user({question,options:[{id,label,description?}]})` 提供 2–6 个唯一标识的选项。调用后保存工具对话与已收到正文，将任务设为 `paused`，作者 `Job.pendingChoice={id,question,options}` 返回待选节点，SSE 状态消息后关闭连接。等待期间没有在途模型请求，不自行选择或继续；客户端断线不丢节点。询问内容与回答作为工具记录，不混入小说正文。
- `POST /jobs/:id/choice?view=author {choiceId,optionId?:string,customText?:string} -> Job`：必须且只能提交一种回答。`optionId` 须属于当前节点，`customText` 为非空自由行动。检查待选状态、节点标识与任务起始版本，重复回答、取消或过期返回 409；选择后排队，沿保存的原工具对话继续，不清空已有正文、不重复已执行工具。再次订阅事件接口可读取完整快照。
- 等待节点禁止用普通 resume/retry 绕过。服务重启或恢复备份后保持手动恢复，直接回答仍待选的节点即可。模型／协议／供应商配置与保存对话不匹配时拒绝续接；用户需恢复原配置。失败的模型请求不会被隐式重试。每段真实返回用量只累计一次。
- 每章 RPG 至少须发生一次有效询问；模型完全不调用 `ask_user` 时任务失败，保留草稿与模型输出，不保存成章。RPG 单章最多 24 个模型回合／96 次工具调用，等待用户本身不占新回合；普通写作仍为 6／24。每次请求保留完整输出上限，缺失用量按对应回合估算并标记 `usageEstimated`。
- 阅读任务列表不返回待选节点、角色设定或内部对话，所有 `payload` 仍为空；完整备份保留内部对话，且不含供应商凭据。RPG 的关键节点识别及人物行为由模型生成，程序只验证选择结构、等待与版本边界；没有骰子、战斗或背包数值规则。

## 图片接口

- `StoryState.activeImageIds?:string[]` 为当前版本的图片选择，必须是 `imageIds` 的无重复子集；缺省为旧作品兼容选择，按明确关联对象取最新成功图，显式空数组表示全部停用。`StoryImage.active` 为当前故事线投影，不修改历史图片资产。人物／实体按合并后的明确实体 ID 分组，地图一组，CG 按章节及准确选段范围分组，同组最多启用一张。新变体保留旧选择；首次对象的待生成图成功后启用。
- `PUT /branches/:id/images/:imageId/active?view=author {baseRevisionId,active:boolean} -> {view:BranchView,images:StoryImage[]}`：启用／停用当前故事线图片，启用一张会停用同组其他图片；调用方替换整份图片列表并更新版本。新图片须生成完成才能手动启用；不调用任何模型。
- `DELETE /branches/:id/images/:imageId?view=author {baseRevisionId} -> {view:BranchView,images:StoryImage[]}`：从当前版本的图册及启用列表移除；历史及其他故事线引用保留像素，不跨版本破坏资料。删除当前图片不自动换用其他图片。排队／运行任务按所属故事线处理取消与迟到输出，删除后不能通过当前线内容 URL 读取。
- 作者列表包含未启用的暂存图，仍能预览；阅读列表／版本引用／直接内容接口仅返回已启用且通过私密过滤的完成图。未启用或删除的图不会进入提示词优化图片候选、实际图片请求及 CG 参考，显式编辑原图也须启用。优化后参考选择变化则拒绝后续图片请求，显式重试按当前选择重新优化。已生成 CG 的历史引用私密检查不要求源图继续在当前图册或启用，但仍检查秘密、未来事实及档案依赖。

- `GET /branches/:id/images?view=author|reader -> StoryImage[]`：当前快照引用的图片，默认阅读视图。仅返回该故事线可查看的图；完成图带同源、需登录的 `url`。阅读响应隐藏提示词、原文片段、参考图标识及错误，并过滤秘密和未来资料图片。
- `POST /branches/:id/images?view=author`，请求为 `ImageGenerateInput={baseRevisionId,kind:'portrait'|'entity'|'map'|'cg',entityId?,chapterId?,selection?:{start,end},instruction?,referenceImageId?}`，返回 `{view:BranchView,image:StoryImage}`。登记引用创建一个新版本，独立图片任务随后运行；调用方更新 `view.branch.revisionId`。资料图必须指定当前实体，地图依据地点与地理关系，CG 必须指定当前章，选段为正文 UTF-16 起止索引，结束位置不包含在选段内。图片修改需同一关联对象的已完成参考图与修改要求，使用实际原图输入，不覆盖旧图。
- `GET /branches/:id/images/:imageId/content?view=author|reader`：只返回快照引用且通过可见性过滤的已完成 PNG、JPEG 或 WebP 图片二进制；跨作品、回退后不再包含及秘密图不可绕过列表直接读取。
- `POST /branches/:id/images/:imageId/retry?view=author {baseRevisionId}`：显式再次请求，返回新资源和新版本，原记录与原图保留。重试可能再次计费。
- `POST /branches/:id/images/:imageId/cancel?view=author -> StoryImage`：停止排队或正在生成的图片，拒绝迟到结果。
- 图片状态为 `queued/running/completed/failed/paused/stale/cancelled`。服务重启或关闭后排队与运行任务转为 `paused`，不自动重复调用；正文或资料版本变化后迟到结果转为 `stale`。图片二进制持久化在 SQLite，单图上限 20 MiB，作品删除和完整备份／恢复包括图片及历史引用，旧版无图片备份继续可用。
- 手动登记、修改与重试沿用 session、同源、作者视图及起始版本校验；文字任务处于等待、运行或暂停时返回 `409`，防止改变写作起始版本。图片失败不重试文字生成。图片提示词、请求与结果不参与正文保存或 TXT 导出。
- 设置可保存 `imageSettings={providerId,model,protocol:'openai-images'|'gemini',size,quality,stylePrompt,autoPortrait,autoCG,timeoutMs}`，复用加密供应商密钥。默认新人物自动立绘开启、自动 CG 关闭，未配置图片模型时不暴露写作生图工具。旧设置缺失该字段时采用默认；旧客户端省略字段保存时保留已存在配置。
- 写作工具 `generate_character_portrait {name,description}` 与 `generate_scene_cg {description,sourceText}` 登记自动插画意图，返回 `requested`；不在写作过程中改变正文版本。资料整理完成后按明确姓名／别名匹配新人物，CG 引用须逐字存在于已保存正文，再批量绑定引用并独立生图。自动新人物立绘按提取资料补充，已有立绘不重复请求；自动 CG 只在开关开启时提供，由写作模型判断触发。本章最多 12 个自动插画。
- 图片任务分为提示词优化与图片生成：登记时保存 `material/instruction` 和 `promptStatus='pending'`；文字模型返回专用 `prompt`、选择的参考人物和自动尺寸，校验后保存 `promptStatus='completed'/optimizedAt`，再调用图片接口。优化失败时不发图片请求，像素失败重试复用已优化结果；资料、图片型号／协议、固定构图参数或参考开关已变化时重新优化。任一阶段取消、回退、删除或版本变化都阻止后续计费请求及迟到应用。
- `StoryImage` 可含 `materialEntityIds`（提示词使用的档案依赖）、`referenceImageIds/referenceEntityIds/referenceCharacters:{entityId,imageId,name}[]`、`generationParameters`（本次实际参数）。原 `sourceText/chapterId/selection` 保持剧情证据，不被优化提示词改写；原单一 `referenceImageId` 继续代表编辑原图。阅读响应清除全部优化素材、参数和参考名册；服务端检查档案及所有参考图链当前可见性，不能从直接图片 URL 绕过。
- `imageSettings` 新增 `promptProviderId/promptModel/promptSystemPrompt/useCharacterReferences`。优化模型默认依次使用已配置的规划和写作模型，读取规划用途的参数；输入加完整输出预留超限时请求前停止。所有优化及图片调用均无自动重试。配置未改变时重试像素不重复支付优化请求；旧图片在再次绘制时进入优化步骤，已有数据继续可读取。
- 旧 `quality` 必需字段为设置兼容保留，只有 OpenAI Images 将其用于生成；Gemini 通过分辨率控制输出，不发送该字段，Together 也不把它当作图片质量参数。原图任务及旧备份字段仍可读取，新增优化和参考字段均为可选字段。
- 图片协议新增 `together-images`。`size` 接受 `auto` 或合法 `宽x高`；可设 `aspectRatio`、`imageSize`（`auto/512/1K/2K/4K`），自动值由优化 AI 依据型号能力选择，固定值优先。额外图片参数按已知型号能力校验，含 Gemini 的 `systemInstruction/temperature/topP/topK/seed/maxOutputTokens/thinkingLevel/includeThoughts`，OpenAI 的 `quality/background/outputFormat/outputCompression/inputFidelity/moderation`，Together 的 `width/height/steps/guidanceScale/negativePrompt/promptUpsampling/disableSafetyChecker`。不可用参数在保存或请求前明确报错，不静默丢弃。
- OpenAI 多图输入为 `images/edits` multipart 的 `image[]`；Gemini 为多条 `inlineData` 及原生 `systemInstruction/generationConfig`；已知 Together 型号为 `/images/generations` JSON，单图 `image_url` 或多图 `reference_images`，响应格式固定 `base64`。CG 仅按已保存剧情和当前版本中的明确人物选择已完成立绘，记录实际参考图对应关系；自动 CG 等同批相关立绘完成或失败后再生成。不支持人物参考的型号按资料绘制。
- 全部参考图原始字节合计不超过 20 MiB；Gemini 另检查完整内联 JSON 请求（含 Base64、提示词及系统提示）不超过 20,000,000 字节。Together 的 `data:` 私有参考输入已实现并经本地协议模拟验证，官方资料只明确 URL 输入，真实服务接受情况未验收；拒绝时不上传公开地址、不取消参考后偷偷重试。每个任务固定生成一张图片，不提供图片流式分块或搜索工具。能力与设置说明见 [使用指南](USAGE.md#插画与故事图册)。

## 文字与作品接口

- 认证接口见上文“登录与安全边界”，初始密码由服务器环境提供；改密与会话撤销不进入作品备份。
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
- POST /branches/:id/plan {baseRevisionId,instruction?} -> Job（返回 fine 与 foreshadows，只维护当前待写章和接下来三章的预期规划）；仅 planning.enabled=true 且 mode=separate 可创建或应用规划，否则返回 400。摘要压缩不受该开关或模式限制。POST /branches/:id/extract {baseRevisionId} -> Job（处理未整理章节）。
- GET /jobs?projectId=&view=reader|author -> Job[]；POST /jobs/:id/:action?view=reader|author（pause/resume/retry/cancel）-> Job。payload 永远不通过HTTP返回；生成 Job 顶层提供 generatedChapterId，作者视图额外提供 title 与 generationInput（mode/instruction/maxWords/title），读者视图隐藏这些创作要求；purpose=compress-summary 区分摘要压缩任务；默认读者视图只返回公共任务状态，作者视图显示详细错误。usageEstimated 表示用量含估算值；inputTokens/outputTokens 为累计统计，不参与请求额度限制。
- 模型输出接口均要求登录及显式 `view=author`，缺少作者视图返回 403；普通任务接口不携带模型输出正文。
- GET /jobs/:id/outputs?view=author -> ModelOutputSummary[]；GET /jobs/:id/outputs/:outputId?view=author -> ModelOutputDetail（原始响应、模型文本、修正文本、校验问题、对应编号原文及 canApply）。
- 详情中的 `normalizedText` 是本地补全与证据对齐后的 JSON，或写作工具多轮返回的合成正文；`adjustments` 记录对应字段及处理说明，不改写 `rawResponse` / `text`。列表摘要不携带这些正文内容。`sourceParagraphs` 只提供当前片段实际可见的原文，超长段落不会提前返回后半段作为本次依据。
- `request` 为发送前保存的脱敏请求快照（真实 URL、头、正文、协议、模型、时限、流式开关）；`diagnostics` 为耗时、响应字节数、白名单响应头及传输结果。空响应或连接失败同样记录；请求和响应使用同一输出ID，响应只可填充一次。仅作者详情返回快照，列表与阅读接口不带请求正文。
- `diagnostics` 可含 `modelOutcome`（completed/blocked/truncated/empty/error）、`finishReason`、`promptBlockReason`。这是模型服务响应的反馈，不代表资料校验通过；Gemini 流式的真实 `promptFeedback.blockReason` 不替换为泛化标签。网关未返回模型反馈时省略相应字段，不从 5xx 猜测拦截原因，旧备份可继续读取。
- POST /jobs/:id/outputs?view=author {text} -> ModelOutputRecord：保存历史响应，不自动应用，也不调用模型。
- POST /jobs/:id/outputs/:outputId/apply?view=author {text,baseRevisionId} -> Job：保存修正后做本地校验。格式或证据不符返回 422，详情接口可取已保存草稿及问题；版本、阶段、进度过期或重复应用返回 409。成功后 completed 或 paused，不自动运行下一次模型请求。
- GET /settings -> Settings（独立密钥只返回 hasKey）；PUT /settings Settings（同来源空 apiKey 保留已有密钥；clearApiKey 清除；更换来源不自动携带旧密钥）-> Settings。服务地址拒绝凭据查询参数；旧含凭据地址在启动时迁为加密保留，公开返回移除凭据后的 baseUrl 和 hasUrlCredentials:true，不返回原地址或密文。该连接须明确提交非空 apiKey 或 clearApiKey:true 后才能保存清理后的地址；只保存其他设置返回 400，原配置及密文保留。
- 生产模型出站默认只允许 HTTPS 全球公网地址，检查 DNS 结果并将实际连接绑定到已检查地址；设置 `OUTBOUND_ALLOWED_ORIGINS` 后仅允许名单中来源，可明确允许指定来源的 HTTP／私网网关，链路本地及已知云元数据地址仍禁止，所有模式拒绝 URL 查询凭据及重定向。
- `Settings.taskSettings` 为 `{extraction:{autoRetry:boolean,maxRetries:number,retryDelayMs:number},planning:{enabled:boolean,mode:'separate'|'tool'}}`。重试默认关闭、最多额外 2 次、间隔 5000 毫秒；次数为 0–10 整数，间隔为 0–300000 整数毫秒。规划默认开启并使用 separate。旧配置缺字段时补默认，旧 PUT 省略整个 taskSettings 保留已保存值；传入时必须完整且拒绝未知字段及非法范围。
- 自动重试按提取任务的章节／片段计数，导入与独立 extract 共用；失败次数持久化，成功片段的资料、进度及计数清理同事务提交。网络、超时、HTTP 5xx／408／429、输出格式与证据校验失败按设置重试，其他 HTTP 4xx、配置／预算错误、存储错误、停止与版本变化不重试。等待期间 status=running，message 显示次数；每次输出留档、用量累计，耗尽后 failed，人工 resume/retry 重置失败次数。重启或恢复备份转暂停，仍需手动操作；不重发正文、规划、压缩、连接测试或生图请求。
- planning.mode=tool 且 enabled=true 时，正文请求提供 `update_plot_plan({fine,foreshadows})`：fine 必须为当前待写章及后面三章的四项唯一规划，foreshadows 仅允许 planned，关联名称须匹配唯一已有实体。工具直接接受写作模型提供的内容，不调用 planning 模型；返回 staged 或可修正的 error。有效规划暂存于写作任务，正文成功保存时一起写入同一版本并清除暂存；失败、暂停及取消不先应用规划，手工修复正文可一起恢复，重新生成清除旧暂存。保存前关闭规划或离开工具模式会丢弃暂存规划。关闭规划保留已有数据但正文上下文 currentChapterPlan 为 null；独立规划按钮停用，人工编辑仍可用。
- `Settings.promptTemplates` 保存全局任务提示词编排：`{presets:{writing:PromptPreset[],planning:PromptPreset[],extraction:PromptPreset[],compression:PromptPreset[]},selected:{writing:string,planning:string,extraction:string,compression:string}}`。`PromptPreset` 为 `{id,name,blocks,variables?:Record<string,string>}`，块为 `{id,name,role:'system'|'user'|'assistant',enabled:boolean,content:string,modes?:('original'|'continuation'|'fanfiction'|'rewrite'|'rpg')[]}`；`modes` 仅正文写作使用，缺省或空数组适用于所有模式。自定义变量名以字母开头，仅含字母、数字和下划线，不能覆盖内置变量。模板用 `{{变量名}}` 一次展开，不递归解释素材或自定义变量值。
- 四类任务分别选择预设，压缩沿用 planning 模型。内置变量列表由 `shared/prompt-templates.ts` 的 `promptVariables` 定义，包含任务对应的上下文、当前输入及作品信息；写作和规划可使用完整 `context` 或单独选择世界观、规则、人物、伏笔、摘要与最近正文。提取 `context` 只包含已有名称对照和已埋未揭晓伏笔。空白消息不发送；展开后须有非空 user 消息，写作每种模式都须至少有一个启用的 user 块。
- 每任务 1–20 份预设，每份 1–80 块；单块内容最多 100000 字符，自定义变量最多 100 项，全局文本合计最多 700000 UTF-8 字节。无效变量、重复标识、选中预设不存在、无有效 user 块等返回 400，整份设置不保存。旧存储缺省时补默认预设；旧 PUT 请求省略 `promptTemplates` 时保留已保存编排，不重置。预设独立导出格式为 `{format:'ai-novel-prompt-preset',version:1,task,preset}`，不含连接信息；单作品备份不含全局提示词配置。
- 启用消息按数组顺序展开，OpenAI Chat/Responses 保留全部角色和顺序；Gemini/Claude 将 system 块按出现顺序合并到原生系统区，user/assistant 顺序保留。结构化任务在预算检查前补单个 JSON 输出要求，仍按既有格式、证据和版本校验；所有编排消息及工具结构计入单次上下文预估。摘要压缩按当前模板实际占用（包括重复变量）分段，超限不缩减输出上限。新任务读取当前已保存预设，已发请求与历史结果不受修改影响。RPG 续接沿用已保存的工具对话与请求参数，修改后的预设在下一章或新体验中生效。连接测试继续使用固定短测试提示词，不执行任务预设。
- `Settings.providers` 为供应商连接，只保存协议、地址和密钥等连接信息。任务分别保存 `writingProviderId/writingModel`、`planningProviderId/planningModel`、`extractionProviderId/extractionModel`。选中供应商时必须指定非空模型名，可使用列表外的自定义名称；未选供应商时对应模型清空。兼容旧连接的 `model` 输入及已有存储，缺少任务模型字段时按各任务原供应商的模型迁移；新返回与保存格式使用任务模型字段。
- `Settings.modelParameters` 为模型参数数组，每项以 `{role,providerId,model}` 唯一标识，`role` 为 `writing/planning/extraction`，包含 `maxOutputTokens/contextTokens` 和可选生成、思考、超时及流式参数。不同任务即使使用同一供应商与模型也各自保存；同一任务的不同模型或供应商分别保存。旧连接的参数和上限迁移到各任务已分配模型；旧无 `role` 的模型参数复制到三个任务，已有显式任务参数优先，历史未选模型保留。新返回与保存格式包含 `role` 并移除连接内的生成字段。新模型缺少记录时使用温度 `1`、Top P `1`、重复惩罚 `0`、输出 `4096`、上下文 `64000`、超时 `180000` 毫秒、非流式；已有记录的可选字段省略表示不发送，显式 `0/false` 保留。
- 每个模型的 `maxOutputTokens` 为单次输出上限，按保存值发送；`contextTokens` 为单次请求预估输入与完整预留输出的合计上限。超出上下文上限时在发送前停止、保留进度并允许手动重试，不缩减输出上限。`Settings` 不再包含累计任务限额 `taskTokenLimit`；旧存储或旧 PUT 请求中的该字段会被忽略，新返回与保存格式移除该字段，保留原有模型限额、密钥和任务分配。
- POST /settings/models `{providerId}` 或 `{provider:ProviderConnection}` -> `{models:{id:string,name?:string}[]}`。后者按草稿查询，不保存设置；只有同源且未清除密钥时才复用已保存密钥。服务端按协议获取上游模型列表并处理分页；获取失败返回明确错误，用户仍可自定义模型名。此接口不调用文本生成，也不自动重试。
- Gemini 模型参数可设 `geminiIncludeThoughts?:boolean`，映射至 `generationConfig.thinkingConfig.includeThoughts`；未设置时省略，false 明确发送，且可独立于思考等级或预算使用。其他协议不发送该设置；返回摘要保留在原响应中，但不计入模型正文。
- POST /settings/test `{providerId,model?,role?}` -> `{ok,message,inputTokens,outputTokens,capture?}`（按指定任务与模型保存的参数和输出上限调用一次真实模型，未保存过的模型使用通用默认值，不暗中缩小上限）。界面总是传入当前任务的模型及 `role`。兼容旧调用：未传 `role` 时，按正文写作、剧情规划、资料提取的顺序选第一个供应商与模型匹配的任务，无匹配则使用正文写作参数或默认值；省略模型时取对应任务已分配的模型，没有可用模型则拒绝请求。模型服务错误也返回 HTTP 200 / ok:false 及当次脱敏capture；输入错误仍返回4xx。
- GET /branches/:id/export -> txt；GET /projects/:id/backup -> gzip压缩JSON完整作品不含密钥，含任务进度及作者过程；过程备份仅重映射所属 jobId，工具参数和结果保留历史实际值；POST /restore multipart file（JSON或gzip）-> Project。恢复为独立作品，运行中任务转为暂停。导出在读取原文件与完整历史前执行容量预检，未压缩 JSON、压缩下载、外层上传及解压分别最多 128 MiB。最多恢复 5000 个历史版本；单历史状态解压最多 64 MiB，全部历史状态累计最多 256 MiB。请求体或历史容量超限返回 413，无效 JSON／GZIP 或外层解压超限返回 400；原作品保留。历史状态在备份中单独gzip编码，避免长篇多版本膨胀；超限使用停机后的完整数据目录迁移。
- 小说文件上传、作品备份下载与作品恢复共用每个可信客户端 IP 5 分钟内 3 次的限额，超限返回 429。正文 TXT 导出不计入这项限额。

前端每 2 秒刷新任务，任务完成后刷新当前 branch 状态；编辑器有未保存内容时不得被后台刷新覆盖。所有写请求使用 baseRevisionId，409 提示刷新/另存，不覆盖草稿。正文使用 SSE 实时输出，后台任务继续每两秒轮询；重连从持久化草稿快照续接，刷新和切换视图不重发生成请求。

人物 Entity 可含 isMain?:boolean 与 nameStatus?:'placeholder'|'confirmed'。isMainSource 记录 author/extraction 来源，作者显式主次选择优先，未人工指定的角色可随剧情重新识别；有明确名称或别名身份桥时可将暂称升级为真名，锁定身份不覆盖。人物事实优先为资料字段和重大经历，普通行动进入剧情摘要。

正文上下文完整保留世界观、规则、主要人物、未揭晓伏笔、最近三章全文及所有剧情摘要。作者确认的压缩摘要只替代其覆盖章节，后续章节仍用原摘要。search_story/read_entity/read_chapter 工具读取构建时的章节与资料快照；每轮模型工具调用独立检查完整输入加预留输出，累计用量只用于统计。普通写作最多六轮、二十四次工具调用；RPG 最多二十四轮、九十六次工具调用，失败均不隐式重试。

search_story 推荐传 `{keywords:["林舟","老吴"],scope?:"all"|"entities"|"chapters"}`，各词使用 OR（任一命中）匹配。兼容 query 字符串按空格、逗号、顿号、分号、换行或竖线拆词；整串为已知名称、别名或章标题时保留完整词。keywords 每项按完整短语匹配；同时传 query 和 keywords 时合并去重。至少提供一个非空词，错误类型、空白数组项或无效范围返回工具 error。检索经过 NFKC 和大小写规范化，只匹配名称、别名、描述、事实文字或各章标题/摘要/正文，不匹配内部 ID 与 JSON 字段名，各文本字段分别匹配；仍绑定起始版本，每类最多返回20条且不会重复同一条目。
