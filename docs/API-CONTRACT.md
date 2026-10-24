# 第一阶段内部接口约定

所有接口 /api，cookie session。JSON 错误 {error:string}。时间 ISO。共享类型 shared/types.ts。

工作台统一使用完整作者资料。`view=author`、`view=reader` 作为旧客户端参数继续接受，均不改变返回资料和操作权限；省略参数效果相同。阅读视图仅在客户端隐藏思维链与工具调用过程，不过滤资料、图片、任务或 RPG 选项。资料查询上的旧 `chapterId` 参数不再限定阅读进度；章节操作、图片关联和分支起点的 `chapterId` 仍按原规则校验。所有接口继续校验登录、来源和适用的作品／故事线／版本边界。

## 作品级设置

- `GET /projects/:id/settings -> {revision,overrides,global,effective}`：读取作品覆盖、当前全局值及合并后的生效配置。供应商仅来自全局，返回沿用密钥和 URL 凭据脱敏；作品不存在返回 404。旧作品无记录时返回 `revision:"0",overrides:{}`，读取不创建副本。
- `PUT /projects/:id/settings {revision,overrides}`：完整替换本作品的覆盖，返回同上。`revision` 必须与上次读取一致，冲突返回 409；空 `overrides:{}` 恢复全部继承，省略某组恢复该组继承。请求体最多 8 MiB。接口校验任务、模型参数、提示词和生图设置，拒绝供应商连接、地址、密钥等额外配置字段；不会写入全局设置。
- `overrides.tasks?:{writing?,planning?,extraction?}`：每项为 `{providerId,model,modelParameters}`，参数条目使用现有 `ModelParameterProfile`，`role` 必须与任务一致；`extraction` 项另须包含 `extraction:{outputMode?,autoRetry,maxRetries,retryDelayMs}`。覆盖按整个任务生效，包括曾用模型的参数；参数的省略值保持省略，空供应商／模型表示该作品暂不配置。
- `overrides.promptTemplates?` 沿用完整 `PromptTemplateSettings` 的格式与限制，通用及四类任务目录作为一组；`overrides.imageSettings?` 沿用完整生图设置格式，包含优化模型、画风、参数、参考图与自动插画开关。未提供的组每次读取最新全局值，不把首次读取的全局值冻结到作品。
- `POST /settings/test` 额外接受可选 `projectId`，带该字段时使用该作品生效的任务模型参数，供应商凭据仍从全局获取；省略保持原行为。`POST /settings/prompt-preview` 保持只读示例预览，作品页面传入当前有效的提示词与提取／插画选项，仍不调用模型。
- 写作／RPG、导入与重新提取、自动命名、标题修复、AI 分章规则、摘要压缩、生图提示词优化及手动／自动生图均按所属作品读取配置。设置保存不重发请求、不改正文版本；已发出的请求及历史记录保留原配置。RPG 已保存的工具对话沿用原消息与提示词，原会话模型一致性校验继续生效。
- 完整备份 v1 新增可选 `projectSettings`，仅保存本作品覆盖，不含 revision、全局默认值或供应商连接／密钥。恢复校验结构但保留尚未在当前实例配置的供应商 ID，不替换连接、不重映射提示词 ID；缺失该字段的旧备份全部继承全局。覆盖大小计入备份容量预检；删除作品一并删除其设置。设置不属于正文历史快照，故事线切换和章节回退不改变作品级配置。

## 原作参考与文本查询工具

续写请求以 `continuationAnchor={chapterId,title,ending,instruction}` 标记最后保存的正文结尾，同时提供最近完整正文；自定义预设省略上下文块时，运行规则仍带入该起点。内部章节数量和索引不映射到章节编号变量；旧 `chapterNumber` 展开为“待写章节／当前章节”，新建章节缺省标题为“新章节”，EPUB 缺题名时为“未命名章节”。原文标题里的真实编号和原文段落／行号保留。

- `StoryState.sourceReference?:{branchId,revisionId,sourceIds?:string[]}` 绑定同作品的原作故事线版本和已确认源文件。派生故事线保留当前起点状态，另存完整来源版本；嵌套分支继承该引用。新正文任务在排队时固定参考，包括“没有参考”的状态。旧派生线根据来源任务、父线及创建时的历史版本追溯，不读取原线后来的改动。工作台保留该引用，内部任务 payload 不经 HTTP 返回。
- 写作的 `originalReference` 上下文单列原作完整剧情摘要、世界观／规则、人物与物品等轻量目录，完整档案和后续正文可通过只读工具获取。原作已有有效作者确认压缩摘要时，使用 `authorConfirmedSummary` 加未覆盖章节摘要；覆盖不属于参考版本或为空时退回逐章摘要。默认实体目录最多 100 项、别名 3 项，提供 `entityDirectoryTotal/entityDirectoryTruncated/aliasesTruncated`，工具仍检索完整档案及全部别名。原作里的未来是作者参考，不合并到当前 `state.entities`、当前摘要或玩家知识；提取仍仅处理当前正文。参考引用随版本保存，完整作品恢复时校验来源关联、映射版本／源文件 ID；缺失或跨作品关联不能静默恢复。
- 原作文本来自固定参考版本的章节正文，以及已确认导入目录。目录中的未整理章节可读全文，但不存在的摘要／人物资料不会补造。虚拟路径分别位于 `story/`、`original/`、`original/sources/`；文件名由捕获版本中的章节或源文件标识生成不表示顺序的哈希，不向模型提供内部章节序号。必须使用工具返回的 path；旧 RPG 对话中的顺序路径仅在捕获版本内兼容解析，结果仍返回新路径。只在本次捕获的语料中解析路径，不访问任意文件系统。
- `list_text_files({collection?:'story'|'original'|'all',query?,offset?,limit?})`：按路径、标题或源文件名筛选，返回 `files,total,offset,truncated,nextOffset?`。默认 20 项，`limit` 为 1–100；每个文件含路径、标题、总行数及 `collection/reference/source` 标记。
- `search_text({keywords?:string[],query?,collection?,path?,offset?,limit?,contextLines?})`：文字关键词 OR 检索，支持完整短语，返回 `matches,total,offset,truncated,nextOffset?`。`path` 需为目录中的精确路径，不能在错误 collection 下读取。默认 20 个命中行，`limit` 为 1–100，附近行默认 2、可设 0–10；命中包含路径、行号、命中列、附近文字与裁剪偏移。分页 offset 按命中行计算，空结果正常返回；关键词空白或非法参数返回工具 error。
- `read_text_file({path,startLine?,endLine?,startOffset?})`：起止行从 1 开始，保留空白行；`startOffset` 为起始行内从 0 开始的 UTF-16 字符偏移。返回 `lines[{line,text,startOffset,endOffset,truncated?}],totalLines,startLine,endLine,truncated,nextLine?,nextOffset?`。每次最多 200 行，结果约 20000 字符；长行分片时 `nextLine` 不变，继续传该行及 `nextOffset`。正文裁剪均有标记，不能把部分内容当成完整原文。
- 原有 `search_story`、`read_entity`、`read_chapter` 增加 `collection`；省略时搜索两套资料，单条读取先查当前故事、再查原作，同 ID 可明确指定 `original`。返回的原作结果标为 `reference:true`。原始源文件的搜索结果使用虚拟 path 作为 chapterId，旧 `read_chapter` 也接受目录返回的全部有效虚拟路径，范围限制保持。`read_chapter` 不传范围继续返回完整 `text`，传 `startLine/endLine` 或 `startParagraph/endParagraph` 可分片；两种范围不混用，段号按去掉首尾空白的非空行计算，段落分片用 `nextParagraph/nextOffset` 续读。若转为原始行读取，使用额外返回的 `nextLine/nextLineOffset`，不能把段号当行号。
- 查询和目录工具结果只进入作者模型过程／请求记录，不直接修改世界资料或正文。模型从参考中获知后续剧情，并不代表玩家角色知情；如何安排剧情与避免剧透仍依赖模型。更新前暂停的 RPG 保留旧 wire，现有查询工具兼容原作参考，新增工具声明在新生成请求提供。

## 登录与安全边界

- 初始密码通过服务启动环境的 `INITIAL_PASSWORD` 设置，只对没有密码的数据目录生效。新密码 12～256 字符，去除首尾空白后仍须至少 12 位，拒绝全空白、重复单字符及常见弱密码；只保存带版本及参数的 scrypt 哈希。首次启动缺失、为空或不合规则时停止启动，错误不包含密码；已有数据库密码不被此变量覆盖。
- `GET /auth/status -> {initialized:boolean,authenticated:boolean,cacheScope?:string}`：已登录时返回当前会话稳定的浏览器缓存命名空间，重新登录后变化；该单向摘要不能用作登录凭据。不返回初始密码、密码哈希或原始会话值。不提供网页初始化密码接口；嵌入式实例未初始化时只能提示管理员配置。
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

- `Mode` 新增 `rpg`，作品创建与提示词模式条件接受该值。`StoryState.rpg` 保存体验角色及入场要求，跟随故事版本、分支与完整作品备份。可选 `nextChoice={id,question,options,jobId,chapterId,maxWords,instruction,followingChoices?}` 保存已封章的未回答选择；`jobId` 是源生成任务，`chapterId` 是封章正文，备份恢复会重映射关联。同响应后续有效询问放入 `followingChoices`，作为尚未回答的问题带入新章，不能当作玩家已确认行动。
- `POST /branches/:id/generate?view=author` 的 `GenerateInput` 可带 `rpg:{character:{kind:'original'|'existing',name,description,entityId?},entryChapterId?,entryInstruction?}`。首次入场按指定章节结尾或当前结尾建立独立 RPG 线，返回 `Job.branchId` 为新线。原创角色须有姓名；已有角色按起点资料中未合并的 character 实体确认，以服务端姓名与资料为准。起点章节须已完成整理。继续体验使用 `mode:'rpg'` 并省略 `rpg`，要求当前版本已有体验配置。RPG 不接受 `chapterId`、选段改写或 `regenerate`。
- RPG 正文工具 `ask_user({question,options:[{id,label,description?}]})` 提供 2–6 个唯一标识的选项。调用后保存工具对话与已收到正文，将任务设为 `paused`，作者 `Job.pendingChoice={id,question,options}` 返回待选节点，SSE 状态消息后关闭连接。等待期间没有在途模型请求，不自行选择或继续；客户端断线不丢节点。询问内容与回答作为工具记录，不混入小说正文。
- `POST /jobs/:id/choice?view=author {choiceId,optionId?:string,customText?:string} -> Job`：必须且只能提交一种回答。`optionId` 须属于当前节点，`customText` 为非空自由行动。检查待选状态、节点标识与任务起始版本，重复回答、取消或过期返回 409；选择后排队，沿保存的原工具对话继续，不清空已有正文、不重复已执行工具。再次订阅事件接口可读取完整快照。
- 章末选择使用同一接口，额外必填 `baseRevisionId`，可带 `branchId` 指定当前分支（默认源任务故事线）。服务端校验同一作品、当前版本中的 `nextChoice`、封章正文及资料状态；正文被修订、旧版本、重复选择、存在进行中任务或资料尚未完成时拒绝。确认选择、消费 `nextChoice`、提交故事版本与创建新生成任务在同一事务内完成，返回新的 `Job.id`。客户端订阅新任务；新章重新构建上下文并带入问题与真实回答，正文、用量和回合计数重新开始，旧章不追加。普通生成接口不能绕过章末选择。
- 作者任务可返回 `chapterStartChoiceId`，用于章末选择 POST 回包丢失时按作品、故事线和节点精确查找已创建的新任务，只读恢复，不再次提交或隐式重试模型。已接受提交后的视图刷新失败也不阻止客户端打开新章。
- 等待节点禁止用普通 resume/retry 绕过。服务重启或恢复备份后保持手动恢复，直接回答仍待选的节点即可。模型／协议／供应商配置与保存对话不匹配时拒绝续接；用户需恢复原配置。失败的模型请求不会被隐式重试。每段真实返回用量只累计一次。
- RPG `maxWords` 是整章累计目标，默认 2000，范围 100–20000。正文按去空白后的 Unicode 字符数计数；每轮更新目标、已写和剩余字数，85% 开始收束提示。达到目标后在完整响应／工具回合或 `ask_user` 节点封章，不发下一次本章正文请求；保留完整输出，允许最后一轮超出。`ask_user` 封章时节点进入版本中的 `nextChoice`，不作为旧任务的 `pendingChoice`；正文先保存，再整理资料，失败只恢复资料整理。旧超预算暂停回合的已确认回答仍描述一次后果后封章。
- 每章 RPG 至少须发生一次有效询问，或承接已回答的章末节点；均没有时任务失败，保留草稿与模型输出，不保存成章。RPG 单章最多 24 个模型回合／96 次工具调用，等待用户本身不占新回合；普通写作仍为 6／24。达到章节目标的最后完整回合可正常封章，未达目标的回合上限仍报错。每次请求保留完整输出 token 上限，不把字数当成 token 或扣减思考额度，缺失用量按对应回合估算并标记 `usageEstimated`。
- 任务列表返回待选节点与创作配置，内部对话保留在服务端，所有 `payload` 仍为空；完整备份保留内部对话，且不含供应商凭据。RPG 的关键节点识别及人物行为由模型生成，程序只验证选择结构、等待与版本边界；没有骰子、战斗或背包数值规则。

## 图片接口

- 写作工具完整参数校验后同步登记图片并立即返回，图片队列与正文模型异步运行；不等正文或提取完成。`WritingImageRequest.imageId?` 关联原资产，`StoryImage.writingJobId?`、`bindingStatus?:pending|bound|discarded`、`pendingEntityName?` 和 `dependencyImageIds?:string[]` 保存归属与参考图等待关系。未保存的图片仅在所属故事线的图册／内容接口可读，尚未进入 `StoryState.imageIds`，不改变正文起始版本，不进入其他分支或历史快照。
- 自动 CG 按实际参考人物和型号数量上限选定立绘，只有这些图片处于 queued/running 时等待；等待不占图片运行位置，队列仍最多并行 2 项。所需立绘失败／暂停／取消／删除后明确失败，不隐式换图、忽略或重试；无可用立绘请求时仅按文字绘制，关闭人物参考或明确空名单不等待。
- 提取成功后核对人物与原文引用，在图片引用和提取进度的同一事务中将原资产转为 bound；保留像素、任务状态及作者取消，不重复生图。写作中的图片可预览、取消或删除（标为 discarded，不修改故事版本），关联前不支持启用、重试或修改。下一章写作不使已关联的旧章图片自动过期；关联章及所用资料、实际参考选择仍须有效。普通暂停／取消写作停止未关联任务，RPG 选择等待可继续；重启及备份恢复不自动重试。备份保留未关联的图片和依赖，恢复时重新映射任务与图片 ID 并校验归属。

- 公开插画按关联章节筛选公开素材，保留 `StoryImage.publicMaterial`、`materialFactIds/materialRelationIds` 等依据标记及备份兼容；工作台不再按这些标记隐藏图片，已有私密图可直接查看，无需修改历史素材标记或重绘。
- 绑定 `chapterId` 的图片登记、启用、停用和删除会新增该章及后续的章末快照，与当前图册原子保存。更早章节、已有分支与旧快照保留；缺少匹配正文的章末记录时拒绝操作，不拼入最新世界资料。

- `StoryState.activeImageIds?:string[]` 为当前版本的图片选择，必须是 `imageIds` 的无重复子集；缺省为旧作品兼容选择，按明确关联对象取最新成功图，显式空数组表示全部停用。`StoryImage.active` 为当前故事线投影，不修改历史图片资产。人物／实体按合并后的明确实体 ID 分组，地图一组，CG 按章节及准确选段范围分组，同组最多启用一张。新变体保留旧选择；首次对象的待生成图成功后启用。
- `PUT /branches/:id/images/:imageId/active?view=author {baseRevisionId,active:boolean} -> {view:BranchView,images:StoryImage[]}`：启用／停用当前故事线图片，启用一张会停用同组其他图片；调用方替换整份图片列表并更新版本。新图片须生成完成才能手动启用；不调用任何模型。
- `DELETE /branches/:id/images/:imageId?view=author {baseRevisionId} -> {view:BranchView,images:StoryImage[]}`：从当前版本的图册及启用列表移除；历史及其他故事线引用保留像素，不跨版本破坏资料。删除当前图片不自动换用其他图片。排队／运行任务按所属故事线处理取消与迟到输出，删除后不能通过当前线内容 URL 读取。
- 图册包含未启用的暂存图，支持预览、重绘和删除；未启用或已删除的图仍不会进入提示词优化候选、实际图片请求及 CG 参考，显式编辑原图也须启用。参考选择在任务期间变化时仍拒绝后续图片请求，显式重试按当前选择重新优化。

- `GET /branches/:id/images -> StoryImage[]`：返回当前故事线完整图册，含私密图片、未启用图片、生成中的记录与该线写作中尚未关联的图片。完成图带同源原图 `url` 和缩略图 `previewUrl`，URL 的 v 参数随图片记录变化；图片内容接口仍校验当前故事线引用及登录。阅读开关不改变结果。
- `POST /branches/:id/images?view=author`，请求为 `ImageGenerateInput={baseRevisionId,kind:'portrait'|'entity'|'map'|'cg',entityId?,chapterId?,selection?:{start,end},instruction?,referenceImageId?,selectedReferenceImageIds?:string[]}`，返回 `{view:BranchView,image:StoryImage}`。登记引用创建一个新版本，独立图片任务随后运行；调用方更新 `view.branch.revisionId`。资料图必须指定当前实体，地图依据地点与地理关系，CG 必须指定当前章，选段为正文 UTF-16 起止索引，结束位置不包含在选段内。图片修改需同一关联对象的已完成参考图与修改要求，使用实际原图输入，不覆盖旧图。
- `selectedReferenceImageIds` 省略时保留自动人物参考，空数组表示不用额外参考图，非空时按数组顺序严格使用作者指定图片，文字优化 AI 的参考人物选择不再决定图片输入。允许当前故事线已启用、已完成且有像素的各类图片；重复、跨线／跨作品、未启用、未完成、缺失及超出当前模型参考图总数量上限的选择在登记前拒绝。最多 16 项，编辑原图 `referenceImageId` 另占一张且始终排第一，不得重复选择。显式选择优先于 `useCharacterReferences`，不等待未选人物的排队立绘；作者选择为可选字段，旧请求保持原行为。
- `GET /branches/:id/images/:imageId/content`：默认返回当前故事线引用的已完成 PNG、JPEG 或 WebP 原始二进制；`size=preview` 返回等比例、最长边不超过 480 像素、不放大小图的 WebP 预览，转换失败返回 422，原图仍可读取。私密和未启用图片也可查看；跨作品、当前故事线不包含或回退后已移除的图片返回 404，未完成返回 409。旧 view、chapterId 及缓存标识 v 参数不改变访问范围。
- 图片内容接口使用 `Cache-Control: private, no-cache` 与内容 ETag，原图和预览有独立标识；先校验登录、当前故事线引用与完成状态，再处理 `If-None-Match`，未变化返回无正文的 304。失败不作为可复用图片；服务端合并相同预览转换，最多 2 项并行，派生缓存最多 256 项／32 MiB，不改写原图或备份。前端在同一登录会话中按作品、故事线及图片 URL 共用 Blob URL，不随无关故事版本变化失效；返回书架保留，退出登录释放。未显示图片最多保留 96 项、64 MiB 原始字节，使用中的图片不被淘汰；失败不自动重试，迟到响应不能填入已清理的会话缓存。
- `POST /branches/:id/images/:imageId/retry?view=author {baseRevisionId}`：显式再次请求，返回新资源和新版本，原记录与原图保留。重试可能再次计费。
- `POST /branches/:id/images/:imageId/cancel?view=author -> StoryImage`：停止排队或正在生成的图片，拒绝迟到结果。
- 图片状态为 `queued/running/completed/failed/paused/stale/cancelled`。服务重启或关闭后排队与运行任务转为 `paused`，不自动重复调用；正文或资料版本变化后迟到结果转为 `stale`。图片二进制持久化在 SQLite，单图上限 20 MiB，作品删除和完整备份／恢复包括图片及历史引用，旧版无图片备份继续可用。
- 手动登记、修改与重试沿用 session、同源、起始版本校验；文字任务处于等待、运行或暂停时返回 `409`，防止改变写作起始版本。图片失败不重试文字生成。图片提示词、请求与结果不参与正文保存或 TXT 导出。
- 设置可保存 `imageSettings={providerId,model,protocol:'openai-images'|'gemini',size,quality,stylePrompt,autoPortrait,autoCG,timeoutMs}`，复用加密供应商密钥。默认新人物自动立绘开启、自动 CG 关闭，未配置图片模型时不暴露写作生图工具。旧设置缺失该字段时采用默认；旧客户端省略字段保存时保留已存在配置。
- 写作工具 `generate_character_portrait {name,description}` 与 `generate_scene_cg {prompt,sourceText,referenceNames?,parameters?}` 登记自动插画意图，返回 `requested`；不在写作过程中改变正文版本。CG 的 `prompt` 由写作模型结合本次写作上下文直接给出，`referenceNames` 指定画面中的人物姓名／别名（空数组表示不用人物参考），`parameters` 只建议自动尺寸、画幅或分辨率，固定设置优先。工具说明包含当前画风、作者提示词要求与型号允许值，预览和发送共用定义。旧会话 `{description,sourceText}` 继续接受并走原来的提示词优化。资料整理完成后按明确姓名／别名匹配人物，CG 引用须逐字存在于已保存正文，再批量关联原资产；旧任务没有已登记图片时兼容生成，仅未请求的新人物立绘按提取资料补充，已有立绘不重复请求。本章最多 12 个自动插画，自动 CG 开关及触发由原规则控制。
- 图片任务分为提示词准备与图片生成：手动请求及旧自动请求保存 `material/instruction` 和 `promptStatus='pending'`，优化模型返回专用 `prompt`、参考人物和自动尺寸；新自动 CG 使用写作模型的原提示词，不再调用优化模型。程序补充画风及实际参考顺序、验证参数后保存 `promptStatus='completed'/promptSource/optimizedAt`，再调用图片接口。准备失败不发图片请求，像素失败重试复用结果；资料或设置变化时重新准备。写作提示词在故事素材未变的重试中保留，自动参数与新型号不兼容时明确失败，不偷偷换用优化模型。主动重新绘制与 AI 修改仍按当前资料重新优化。任一阶段取消、回退、删除或版本变化都阻止后续计费请求及迟到应用。
- 手动 CG 的 `storyContext` 保存提示词准备时参考的完整本章前后文、前两章全文、此前摘要（或适用的已确认压缩摘要）及相关人物、地点、物品、规则与关系；不读取目标章节之后的其他章节。目标 `sourceText/selection` 不扩大，后文与未来设定只能辅助理解，不能提前画入目标时刻。沿用原有公开素材／作者补充素材范围，作者固定设定仅进入作者素材上下文；所用档案、事实和关系计入原有依赖检查。上下文完整计入模型输入预算，超限拒绝，持久上下文上限 2000000 字符，不静默截断。新自动 CG 不把事后重建的上下文冒充写作模型的实际输入；实际上下文可在正文写作请求诊断中查看。
- 手动编辑后，图片列表的 `chapterId` 指向当前修订正文，新增只读 `sourceChapterId/sourceSelection` 保留原始归属及选段；数据库图片记录和像素不改写。原选段仍在同一位置或能唯一匹配时返回新的 `selection`，否则省略 `selection` 并保留原选段，禁止用过期范围重试。原整章 CG 可按当前整章重绘；启停、删除、分支和回退使用所属版本的映射。旧编辑快照在读取时按明确的手动编辑历史恢复关联，不重发模型请求；后续主动删除不会复活。备份映射并校验章节修订 ID，兼容旧备份。
- `StoryImage` 新增可选 `storyContext`、`writingPrompt/writingReferenceNames/writingParameters` 和 `promptSource:'writing'|'optimizer'`，随任务、版本引用及备份保留。写作提示词只在新工具请求携带 `prompt` 时直接使用，旧图片不迁移。图册详情区分来源，手动 CG 可展开本次实际参考上下文。
- `StoryImage` 可含 `materialEntityIds`（提示词使用的档案依赖）、`selectedReferenceImageIds`（作者指定的额外参考及顺序，空数组表示不用）、`referenceImageIds/referenceEntityIds/referenceCharacters:{entityId,imageId,name}[]`（本次实际输入）、`generationParameters`（本次实际参数）。原 `sourceText/chapterId/selection` 保持剧情证据，不被优化提示词改写；原单一 `referenceImageId` 继续代表编辑原图。手选在优化前持久化并参与依赖检查，中途停用或删除所选图会停止旧任务；失败重试、分支、备份恢复保留决定并重映射图片 ID，手选失效时明确拒绝重试，不自动换图。图册响应保留优化素材、参数、手选 ID 和参考名册，服务端继续检查图片属于当前作品和故事线。
- `imageSettings` 新增 `promptProviderId/promptModel/promptSystemPrompt/useCharacterReferences`。优化模型默认依次使用已配置的摘要压缩和写作模型，读取摘要压缩用途的参数；输入加完整输出预留超限时请求前停止。所有优化及图片调用均无自动重试。配置未改变时重试像素不重复支付优化请求；旧图片在再次绘制时进入优化步骤，已有数据继续可读取。
- 旧 `quality` 必需字段为设置兼容保留，只有 OpenAI Images 将其用于生成；Gemini 通过分辨率控制输出，不发送该字段，Together 也不把它当作图片质量参数。原图任务及旧备份字段仍可读取，新增优化和参考字段均为可选字段。
- 图片协议新增 `together-images`。`size` 接受 `auto` 或合法 `宽x高`；可设 `aspectRatio`、`imageSize`（`auto/512/1K/2K/4K`），自动值由负责提示词的文字 AI 依据型号能力选择，固定值优先。额外图片参数按已知型号能力校验，含 Gemini 的 `systemInstruction/temperature/topP/topK/seed/maxOutputTokens/thinkingLevel/includeThoughts`，OpenAI 的 `quality/background/outputFormat/outputCompression/inputFidelity/moderation`，Together 的 `width/height/steps/guidanceScale/negativePrompt/promptUpsampling/disableSafetyChecker`。不可用参数在保存或请求前明确报错，不静默丢弃。
- OpenAI 多图输入为 `images/edits` multipart 的 `image[]`；Gemini 为多条 `inlineData` 及原生 `systemInstruction/generationConfig`；已知 Together 型号为 `/images/generations` JSON，单图 `image_url` 或多图 `reference_images`，响应格式固定 `base64`。自动模式的 CG 仅按已保存剧情和当前版本中的明确人物选择已完成立绘，记录实际参考图对应关系；自动 CG 等同批相关立绘完成或失败后再生成。手动模式只发送指定参考图；不支持人物参考的型号在自动模式下按资料绘制。
- 全部参考图原始字节合计不超过 20 MiB；Gemini 另检查完整内联 JSON 请求（含 Base64、提示词及系统提示）不超过 20,000,000 字节。Together 的 `data:` 私有参考输入已实现并经本地协议模拟验证，官方资料只明确 URL 输入，真实服务接受情况未验收；拒绝时不上传公开地址、不取消参考后偷偷重试。每个任务固定生成一张图片，不提供图片流式分块或搜索工具。能力与设置说明见 [使用指南](USAGE.md#插画与故事图册)。

## 分章规则接口

以下路径带 `/api` 前缀，均需登录。规则库在服务端全局保存，独立于 `Settings` 和作品备份，完整数据目录迁移保留。

- `GET /chapter-rules -> {rules:ChapterRule[]}`：返回 10 条内置规则与至多 100 条自定义规则。标题规则字段为 `{id,type?:"regex",name,pattern,flags,description,builtIn?}`，省略 type 沿用标题匹配，兼容已有规则库。字数规则字段为 `{id,type:"length",name,wordsPerChapter,description,builtIn?}`。内置 ID 为 auto/chinese/volume/english/numbered/bracketed/markdown/special/none/length，length 默认每章 3000 字。
- `POST /chapter-rules ChapterRuleInput -> ChapterRule`；`PUT /chapter-rules/:id` 同请求体；`DELETE /chapter-rules/:id -> {ok:true}`。标题规则输入 `{type?:"regex",name,pattern,flags?,description?}`；字数规则输入 `{type:"length",name,wordsPerChapter,description?}`，wordsPerChapter 为 100～100000 的整数，不转换字符串或截断小数，不接受标题匹配字段。名称去首尾空白后为 1–80 字符，不与已有规则重复；表达式 1–1000 字符，说明最多 500 字符，flags 为 `""|"i"|"u"|"iu"`、默认 i。拒绝未知字段、无效表达式及匹配空行的规则。内置规则不能覆盖或删除，另存时由服务生成新 ID。
- `POST /sources/:id/split {ruleId} | {rule:ChapterRuleInput} | {native:true} -> SourcePreview & {headingCount?,wordsPerChapter?}`：三个字段恰好提供一个。从保留的原始 TXT（沿用编码识别）或 EPUB 正文按阅读顺序重算；native 恢复原始分章，EPUB 默认保留原有阅读顺序。标题规则匹配去首尾空白的完整短行、最多 160 字符；连续及无正文的末尾标题保留在相邻正文中，不产生空章，没有匹配时全文为一章，返回 headingCount。字数规则返回 wordsPerChapter，不返回 headingCount；以去除空白后的 Unicode 字符数为每章上限，优先选择 80%～100% 范围内最后一个段落换行，无合适换行时按字数切开，末章保留剩余内容，暂命名第1章、第2章等。字数规则保留标题样式的原文行，不调用模型；调整内置或已保存字数规则的参数时可用内联 rule 预览，不自动更新规则库。标题数与最终章节数均不超过 10000，超限报错，不截断正文。返回预览不写入 sources、正文或故事版本；只有原有 confirm 接口保存最终目录。
- `GET /sources/:id/heading-candidates?q=&offset=0&limit=60 -> {candidates:[{line,title}],nextOffset:number|null}`：短行候选来自原始正文，可能包括短正文段落，由作者选择实际标题。q 最多 160 字符，使用不区分大小写的字面包含检索；limit 为 1–120，offset 为上页最后的原文行号（从 1 开始，空行仍计数），nextOffset 为 null 表示结束。行号基于去 BOM、统一换行、去首尾空白后的 TXT；EPUB 为按正文阅读顺序拼接的文本。
- `POST /sources/:id/generate-rule {lines:number[],instruction?} -> GeneratedChapterRule`：选 2–20 个不同的有效行号，至少两个不同标题，补充要求最多 1000 字符。服务重新读取原文核对样本，只发送所选标题及要求，依次使用已保存的 extraction/writing/planning 模型和任务参数，完整请求及输出预留计入上下文。只请求模型一次，生成失败不自动重试，也不受资料提取的自动重试开关影响。成功返回 `{ok:true,rule,headingCount,chapterCount,examples,inputTokens,outputTokens,capture}`，验证全部样本匹配后再计算原文匹配数，examples 至多 8 项；不保存规则、不替换目录、不创建故事任务。模型／结果失败返回 `{ok:false,error,capture?}` 以保留诊断，非法样本和未配置模型在发送前返回 400。capture 包含脱敏后的实际请求／响应，在当前窗口可查看或下载，不作为作品资料保存。
- 已确认原文的 split/heading-candidates/generate-rule 返回 409；预览计算或 AI 结束时再次检查原文仍存在且未确认，拒绝迟到结果。自定义表达式仅在独立工作线程执行，单次最多 4 秒、最多 4 个并发；超时终止线程，繁忙返回 429，不阻塞 HTTP 服务。AI 生成沿用模型操作限流（默认 20 次／分钟），客户端断开会取消模型请求。

## 章节标题修复接口

- `POST /branches/:id/chapter-titles/preview?view=author {baseRevisionId,chapterIds:string[],instruction?:string} -> ChapterTitlePreview`：选择1～20个不同章节，检查当前版本及空闲任务状态；读取固定版本本章首4000／长章末1500字符，以及邻章各600字符。导入章节能在原文件中用本章开头唯一定位时，附带起点前800字符与匹配开头作为 sourceContext；查不到或重复时不猜测。返回前再次检查版本和任务。
- `POST /sources/:id/chapter-titles/preview?view=author {chapters:ChapterTitleSample[],instruction?:string} -> ChapterTitlePreview`：仅未确认的原文件可用，支持当前窗口手动编辑／分章后的草稿样本，每次1～20条，不写入源文件、导入目录或故事版本；正文样本及相邻片段采用上述长度限制，原文件上下文由服务端定位补充。source 确认或删除后的迟到结果拒绝。
- 两种预览都把客户端／数据库标识映射为临时 UUID，模型只见标题和文本，不见目录位置；结果按标识映射回原选择。优先提取模型，依次写作、压缩模型；配置及上下文预算在请求前检查，一次请求不自动重试。同一故事线或源文件同时最多一个标题预览。关闭连接取消请求；与已有模型操作共用限速。
- `ChapterTitlePreview={ok,suggestions?:[{chapterId,originalTitle,title,reason,evidence,confidence:high|medium|low,multipleChapters:boolean}],error?,inputTokens?,outputTokens?,capture?}`。要求全部标识恰好返回一次，evidence 必须是该章已提供正文或原文件上下文的逐字摘录；high 改名须有依据。新编号必须已出现于原标题或本章材料，拒绝按目录位置猜号。失败返回 `ok:false` 及已收到的脱敏诊断，不应用标题。
- `POST /branches/:id/chapter-titles/apply?view=author {baseRevisionId,changes:[{chapterId,originalTitle,title}]} -> BranchView`：一次应用1～20条作者选择的改名；作者可编辑建议。验证当前版本、原标题、归属、无重复且标题有实际变化，再事务提交。只改当前线章节引用中的 title，并同步受影响的章末快照；不可变正文、资料、摘要、原文件及其他线不改。可回退，完整备份保留。版本冲突或未结束任务返回409。

## 文字与作品接口

- `Revision.restoredFromRevisionId?` 记录回退实际恢复的历史版本，完整审计父链仍保留；章末快照沿恢复来源读取，确保回退后的分支和资料维护使用所恢复的历史状态。完整备份重映射该关联，来源必须属于正常父链中的历史版本，非法或循环来源拒绝恢复。

- 认证接口见上文“登录与安全边界”，初始密码由服务器环境提供；改密与会话撤销不进入作品备份。
- GET /projects -> Project[]; POST /projects {title,premise,mode} -> Project; GET /projects/:id -> {project,branches:Branch[],branchTree:BranchTreeEntry[],sources:Source[],cacheVersion:string}。GET 返回完整 premise（初始作者设定）。cacheVersion 是不透明的服务状态校验值，不是可用于写操作的故事 revisionId。
- DELETE /projects/:id（无请求体）-> {ok:true}：永久删除整部作品，包括原文、正文、所有故事线及历史快照、世界资料、剧情规划与伏笔、任务、导入队列、模型输出和搜索索引。先取消该作品未结束的任务、中止模型请求并等待收尾，再在事务中清理数据，迟到结果不能重新写回。删除期间创建、恢复或重试任务返回 409；重复并发删除返回 409，作品不存在或已删除返回 404。沿用 session 和同源校验，无需 baseRevisionId 或作者视图参数；不影响其他作品、登录和供应商设置。原文清理如遇文件占用，会保留在内部待清理目录并在下次服务启动重试。
- GET /branches/:id -> BranchView：返回当前故事线完整状态、版本历史、世界设定、伏笔、秘密与未来资料、摘要及 RPG 选择，以及 cacheVersion，不再返回 readingChapterId。前端先读取作品信息，只有 cacheVersion 与本地快照一致时才复用完整资料；任意数据库写入、外部连接修改或服务重启使该保守校验值失效，包括原版本内的快照修正。正文按当前目录中的不可变章节 ID 复用，名称由最新目录覆盖。写操作仍须携带 baseRevisionId。
- GET /branches/:id/chapters/:chapterId -> Chapter（只可取该线实际包含的章）。
- POST /branches/:id/chapters {baseRevisionId,title,text,chapterId?} -> BranchView。新建章节保存为 pending 并自动整理，未配置模型也保留正文。携带 `chapterId` 编辑已有章节时，必须无未结束文字任务；在原分支新建正文版本，保留后续章节、已有摘要、资料、关系、锁定内容及原整理状态，不创建分支、不排队提取、不请求模型。旧正文不覆盖；受影响章末快照同步更新，历史与手动分支仍使用一致边界。仅改标题保留正文 ID；正文改变时创建新正文 ID，匹配到的引文更新章节及段号，失效或无法唯一定位的引文解除但保留事实，伏笔和压缩摘要的章节关联同步映射。新增正文引用的 `previousChapterIds` 保留此前手动修订的不可变章节 ID，原生成任务及图片、启用选择继续可用；历史和其他线保持原关联。生成过程保留原始内容与偏移，编辑后在界面集中展示原过程，不改写任务所属章节；RPG 旧章末选择仍失效。需更新资料时显式使用单章 extract 接口。过期版本返回 409，其他线的章节返回 404。
- `DELETE /branches/:id/chapters/:chapterId?view=author {baseRevisionId} -> BranchView`：只移除当前故事线的所选章，保留其他正文、原文件、历史和其他线。清理该章摘要、非锁定事实、引用关系和章节图片引用；锁定事实保留并解除被删正文的引用。后续编号、未来规划及伏笔预计章节顺延，被处理章覆盖的压缩摘要移除；删除 RPG 章末选择所属章时移除该选择，作者角色设定保留。
- `DELETE /branches/:id/chapters/:chapterId/extraction?view=author {baseRevisionId} -> BranchView`：保留正文并清除该章旧提取资料与摘要，保留锁定条目与锁定事实，章节改为 pending，不调用模型。其他章节原有结果保留，相关章末快照同步修正。
- `POST /branches/:id/chapters/:chapterId/extract?view=author {baseRevisionId} -> {view:BranchView,job:Job}`：在同一事务中清除旧结果、创建 total=1 的单章提取任务。未配置模型时先拒绝，不清除资料。内部 targetChapterId 固定所选章，extractChapterId/blockIndex 保存断点；运行、恢复和本地应用输出都只处理目标章。沿用提取输出模式、证据校验、用量、输出留存、配置的显式自动重试策略及手工修正流程。
- `DELETE /branches/:id/entities/:entityId?view=author {baseRevisionId} -> BranchView`：删除本线档案、事实、合并别名记录、关联关系与资料图片引用，清理伏笔 relatedEntityIds，保留正文。删除正在扮演的已有角色档案时，玩家设定以原创角色继续保存；重新提取仍可能重新发现该档案。
- 上述四个接口要求登录、同源与当前版本。排队、运行、暂停或请求仍在结束时返回 409，需先完成或取消；过期版本或缺少匹配正文路径的历史快照返回 409，非本线条目返回 404。维护与历史章提取新增受影响的章末快照，旧快照和输出不改写；回退恢复旧状态，迟到输出不能写入新版本。单章提取名称索引固定到该章进度，后续别名、伏笔和事实不进入提取上下文；较晚章节的新状态优先于早章重新发现的旧状态。
- `POST /branches/:id/fork {baseRevisionId,chapterId?,name} -> BranchView`：不指定 `chapterId` 代表当前结尾。名称去首尾空白后为 1–200 个字符。新分支保存实际起点 `forkChapterId` 与可选 `forkChapterTitle`，显示分叉位置；旧记录可只读补充现存章标题，未知起点不推测。
- `GET /projects/:id` 的 `branches` 仍只包含可用故事线，`branchTree:BranchTreeEntry[]` 增加仍被可用子线依赖的已删祖先，不包含无子线依赖的已删分支。每项包含原 `Branch` 字段及当前版本的 `chapters:{id,title}[]`，只返回章节标识与标题，不返回正文、摘要、资料或内部任务。章节树按完整前缀与不可变正文 ID 合并节点，不按同名章节或旧 `parentBranchId` 嵌套；同一末章可显示多条线的名称，已删线的名称不可选择。旧记录只读投影，数据库与备份无需迁移。
- `PUT /branches/:id/name?view=author {baseRevisionId,name} -> Branch`：重命名主线或可用分支。要求登录、同源和当前版本；过期版本返回 409，已删分支返回 404，空白或超过 200 个字符返回 400。只更新故事线名称与作品更新时间，不新增正文版本、不改变父子关系或中断任务；名称不随正文回退，完整作品备份保留名称。
- `GenerateInput.branchName?:string`：AI 整章／选段改写、重新生成及首次 RPG 入场自动开分支时使用指定名称，同样须为 1–200 个字符；旧客户端省略时沿用自动名称。UI 开始生成前可编辑这个名称。普通续写及 RPG 后续选择沿当前线继续。
- AI 改写与重新生成按目标章之前的完整正文前缀确定 `parentBranchId`：起点仍属于本线创建时继承的章节时，向来源祖先查找；同一章的多次生成挂到共同来源，继承前缀被本线编辑或起点包含本线新增章节时保留本线为父分支。版本历史仍连接到发起线的实际章末快照，原作参考与任务的 `sourceBranchId` 保留真实发起来源，迟到写入与原线保护沿用现有检查。手动分支及 RPG 入场的来源记录保持原规则。
- `DELETE /branches/:id?view=author {baseRevisionId} -> {ok:true,mainBranchId}`：删除所选非主线分支，客户端切回主线并刷新列表。要求登录、同源、当前版本；主线、未结束文字／生图任务或文字请求仍在收尾时返回 409，重复删除或访问已删分支返回 404。逻辑删除以 `Branch.deletedAt` 保存，项目列表与任务列表不显示已删分支，其任务不能继续／重试；正文、版本、输出及图片保留，用于其他线的历史、原作参考和 RPG 章末选择。子分支不随父分支删除，完整备份保留删除状态与依赖，恢复后已删分支仍不可选择，仅在树中保留可用子线所需的祖先章节目录；主线被标为删除的备份拒绝恢复。分支删除不改变其他分支的版本，也不能通过正文回退撤销。
- POST /branches/:id/rollback {baseRevisionId,revisionId} -> BranchView。
- `state.chapters[].summary` 为导入或整理正文时同时提取的已发生剧情摘要，片段摘要按处理顺序累积；与 `state.outline.fine` 的预期规划分开；不再生成或使用 coarse。回退和旧章节分支读取该边界的整份快照，摘要、伏笔状态与人物位置事实一起恢复。章节正文接口继续仅返回正文信息，完整摘要保留在 BranchView。
- `state.foreshadows` 保留历史状态，界面默认只显示 `planned/planted`。`resolved/abandoned` 不进入后续待处理伏笔上下文，模型再次提及同名线索不会自动重新打开；作者仍可在历史入口手工查看与修正。
- 地图使用两端均为 `location` 的地理关系，不将人物或任务关系画成地图节点。人物当前位置使用 `attribute=location` 的当前事实；同一状态按引用章节、段落的先后更新，旧记录转为过去，锁定或不确定的冲突保留供作者核对。
- PUT /branches/:id/outline {baseRevisionId,outline:{worldview?,locked,fine?}} -> BranchView。编辑世界观与作者约束；历史 fine 可省略，携带时必须与现有值相同，修改返回 410。此接口不能设置压缩摘要。
- PUT /branches/:id/entities/:entityId {baseRevisionId,entity} -> BranchView；POST /branches/:id/entities/merge {baseRevisionId,fromId,toId} -> BranchView（回退撤销合并）。
- PUT /branches/:id/foreshadows {baseRevisionId,foreshadows} -> BranchView。
- GET /branches/:id/search?q= -> {chapters,entities}：搜索当前故事线的完整正文与资料，包含秘密与未来事实；旧 view 与 chapterId 查询参数不改变范围。
- 旧默认可见性兼容发生在版本读取阶段：仅使用对应版本祖先路径内的 applied 提取记录、明确的旧补字段标记、唯一名称／别名匹配和一致的事实／原文引用恢复误隐藏的公开内容。人工秘密、锁定、真实秘密及未来事实仍受原规则约束；没有可靠依据时不放开。旧快照和提取输出保留，接口不生成新版本、不重发模型请求，完整备份恢复后继续兼容。
- POST /projects/:id/import multipart file -> SourcePreview；GET /sources/:id/preview -> SourcePreview；GET /sources/:id/file 原文件；GET /sources/:id/chapters/:index 原文纯文本。
- POST /sources/:id/confirm {branchId,baseRevisionId,chapters:[{title,text}]} -> Job（确认目录后追加原文章节并整理）。
- POST /branches/:id/generate GenerateInput -> Job：`title` 去除首尾空白后非空则直接保存；缺省、空串或纯空白则先保存正文，后台资料任务先额外调用一次写作模型自动命名，再整理资料。命名仅发送本章完整文本，返回 `{title:string}`，不带内部序号、目录位置或章节 ID；自动题名不含章节编号。整章／选段改写与重新生成遵守同一选择，选段使用合并后的全章；RPG 章末选择开启的新章自动命名。标题与章末快照、任务进度原子保存，绑定起始版本；完成后作者 Job.title 和实时快照显示最终题名。命名不自动重试，失败保留正文且显式重试只处理未完成阶段。既有任务未标记自动命名时保持原行为。完整保存后创建资料整理任务；不调用剧情规划模型或后置规划工具。旧已保存正文的任务恢复时仅完成资料整理，不重新请求正文。
- GET /jobs/:id/events?view=author -> text/event-stream；只允许正文生成任务。连接首先发送 {type:'snapshot',text,title,job,chapterId?,activities?:WritingActivity[]}，随后 {type:'delta',text}、{type:'activity',activity:WritingActivity} 或 {type:'status',job,chapterId?}，paused/failed/cancelled/stale/completed 后结束。草稿持久化，重连读取完整快照；客户端断开订阅不会取消服务器任务，暂停或取消须显式操作任务。
- GET /jobs/:id/activities?view=author -> WritingActivity[]；仅 generate 任务，需登录。活动为 {id,kind:'thinking'|'tool',text?,thinkingSource?:'native'|'preset',thinkingTokens?:number,name?,arguments?,result?,status:'running'|'completed'|'failed',error?,proseOffset?:number}，按记录顺序返回；proseOffset 为活动首次出现时作者可见正文的 UTF-16 位置，同 id 后续更新不移动。选段改写保存完整章节后加原文前缀位置，快照同步完整正文。旧记录无位置字段，界面明确提示；位置随备份恢复。实时消息是同 id 完整更新，客户端替换而非重复累加；过程按位置分组且默认折叠，刷新由接口／快照恢复。普通写作重新生成会清理上一轮实时过程，原输出记录保留；RPG 已保存的完整交互保留此前位置，历史规划过程仍可查看。
- 每轮实际工具结果之后追加可见的“工具结果复核”指令：Chat／Responses 在结果后追加 user 消息，Gemini／Claude 在本轮用户工具结果消息末尾追加 text；不修改已有工具结果和签名，不改变思考配置或输出额度，不增加额外确认回合。旧 RPG 已完成工具的断点在下次续接前补入一次，重复预览不改原断点。写作完整预览展示相同规则，实际追加位置见逐轮请求诊断。
- 过程展示接口返回的原生思考摘要、文本 think/thinking 块中的预设思考及实际执行的工具调用。thinkingSource=preset 标识预设思考，旧记录省略时按原生展示；该字段随 SSE、快照和备份保留。Gemini 单轮没有公开原生摘要、但返回正整数 thoughtsTokenCount 时，新增 text 缺省、thinkingTokens 为实际用量、status=completed 的原生思考活动；同轮有公开摘要则不重复创建，没有文本及正数用量则不造活动。用量在响应结束后才确认，活动定位到本轮开始处（工具后续接沿用前一个工具的正文位置），旧位置未知时保留缺省。thinkingTokens 随刷新和备份保留，不进入正文或阅读视图。textFilter=dramatron 时在移除标签的同时按正文顺序分流，流式标签可跨片段，普通文本及外层 prose 工具字段均支持，JSON 字符串内的字面标签和辅助尾段不生成思考活动。未完成块在取消／失败时保留并结束为失败，记录回调失败后不再次提交片段。不导出加密推理字段、思考签名；已知密钥和凭据字段脱敏。思考和工具活动独立存储，不能进入 chapter.text、正文编辑器、剧情提取或 TXT 导出。取消及版本变化后拒绝迟到活动，终态活动在正文事务成功后先于 completed 发送。
- POST /branches/:id/summary-compression?view=author {baseRevisionId} -> Job（kind=plan,purpose=compress-summary，历史名称兼容）；使用 compression 输出阶段，仅创建压缩候选，不修改故事版本。完整源摘要超过摘要压缩模型窗口时分段压缩，再做合并压缩，最多三轮；每段独立校验完整预留输出并持久化进度，重试或人工修复不重复已完成段。进度通过 Job.progress/total/message 返回。GET /jobs/:id/summary-compression?view=author -> {text,chapterIds,baseRevisionId}；POST /branches/:id/summary-compression/confirm?view=author {baseRevisionId,jobId,text} -> BranchView，校验候选版本与覆盖章节后才写入 outline.summaryCompression。候选及确认内容必须比完整原摘要短，原分章摘要保留。
- 剧情规划接口 /branches/:id/plan 已移除，返回 404。新任务不提供 update_plot_plan；旧保存工具会话中的同名工具仅返回停用说明。
- GET /jobs?projectId=&view=reader|author -> Job[]；POST /jobs/:id/:action?view=reader|author（pause/resume/retry/cancel）-> Job。payload 永远不通过HTTP返回；生成 Job 顶层提供 generatedChapterId，同时提供 title 与 generationInput（mode/instruction/maxWords/title）及 RPG 选择信息；purpose=compress-summary 区分摘要压缩任务；返回完整任务状态和详细错误。usageEstimated 表示用量含估算值；inputTokens/outputTokens 为累计统计，不参与请求额度限制。
- 模型输出接口均要求登录；普通任务接口不携带模型输出正文。
- GET /jobs/:id/outputs?view=author -> ModelOutputSummary[]；GET /jobs/:id/outputs/:outputId?view=author -> ModelOutputDetail（原始响应、模型文本、修正文本、校验问题、对应编号原文及 canApply）。
- 自动命名记录使用 `stage=chapter-title`，保留完整脱敏请求与响应；可在后台任务的输出记录中查看、导入并手工修正 `{title:"题名"}`。应用后任务保持暂停，手动继续只进行资料整理。`generationInput.title` 保留手动输入语义，自动命名时省略；`Job.title` 显示最终保存的名称。
- 详情中的 `normalizedText` 是本地补全与证据对齐后的 JSON，或写作工具多轮返回的合成正文；`adjustments` 记录对应字段及处理说明，不改写 `rawResponse` / `text`。列表摘要不携带这些正文内容。`sourceParagraphs` 只提供当前片段实际可见的原文，超长段落不会提前返回后半段作为本次依据。
- `request` 为发送前保存的脱敏请求快照（真实 URL、头、正文、协议、模型、时限、流式开关）；`diagnostics` 为耗时、响应字节数、白名单响应头及传输结果。空响应或连接失败同样记录；请求和响应使用同一输出ID，响应只可填充一次。仅模型输出详情返回快照，普通任务列表不带请求正文。
- `diagnostics` 可含 `modelOutcome`（completed/blocked/truncated/empty/error）、`finishReason`、`promptBlockReason`。这是模型服务响应的反馈，不代表资料校验通过；Gemini 流式的真实 `promptFeedback.blockReason` 不替换为泛化标签。网关未返回模型反馈时省略相应字段，不从 5xx 猜测拦截原因，旧备份可继续读取。
- POST /jobs/:id/outputs?view=author {text} -> ModelOutputRecord：保存历史响应，不自动应用，也不调用模型。
- POST /jobs/:id/outputs/:outputId/apply?view=author {text,baseRevisionId} -> Job：保存修正后做本地校验。格式或证据不符返回 422，详情接口可取已保存草稿及问题；版本、阶段、进度过期或重复应用返回 409。成功后 completed 或 paused，不自动运行下一次模型请求。
- GET /settings -> Settings（独立密钥只返回 hasKey）；PUT /settings Settings（同来源空 apiKey 保留已有密钥；clearApiKey 清除；更换来源不自动携带旧密钥）-> Settings。服务地址拒绝凭据查询参数；旧含凭据地址在启动时迁为加密保留，公开返回移除凭据后的 baseUrl 和 hasUrlCredentials:true，不返回原地址或密文。该连接须明确提交非空 apiKey 或 clearApiKey:true 后才能保存清理后的地址；只保存其他设置返回 400，原配置及密文保留。
- GET /extensions -> `{revision,scripts,mcpServers,skills}`；PUT /extensions 接受相同结构，独立于 Settings 全量保存，须携带当前 revision，旧版本返回 409。配置加密保存，最多 8 MiB；50 个脚本、20 个服务、100 个技能。完整结构见 `shared/extensions.ts`。脚本参数须为不超过 32 KiB 的 object JSON Schema，代码须是有效异步函数体；技能名称与简介从 SKILL.md 重新解析，同名拒绝。保存或移除扩展不改变任何作品及模型设置。
- MCP 公开配置中的 env/headers 始终为 `{}`，以 hasSecrets 表示是否保存。空对象保留同一连接的原值，非空对象替换整组；clearSecrets 清除两组。连接方式、URL、命令或参数变化不沿用旧凭据。tools/discoveredAt 由服务端发现结果管理，PUT 不接受客户端伪造或修改目录；连接或凭据变化清空旧目录。HTTP 沿用模型出站策略，本地进程只继承基础环境和显式配置。
- POST /extensions/mcp/:id/discover `{revision}` -> 最新公开 ExtensionSettings：初始化 stdio／Streamable HTTP，读取全部分页 tools/list，不执行工具。限制 200 个工具、20 页、2 MiB 响应和 100–60000ms 总时限；结束关闭连接。发现期间配置改变返回 409，不覆盖新配置。
- POST /extensions/scripts/:id/test `{revision,arguments:object}` -> 实际 JSON 结果：手动测试已保存脚本，允许测试停用项；校验参数后在独立 Node 进程执行。100–60000ms 时限、64 MiB V8 堆、64 KiB 参数／输出，取消或超限终止，不自动重试。该进程不是权限沙箱。
- POST /extensions/skills/import multipart `file` -> ImportedSkill：只解析并返回默认停用的草稿，不保存、不执行。支持 UTF-8 Markdown 和单技能 ZIP，上传及展开均最多 2 MiB、最多 200 文件、每个 512 KiB；拒绝重复路径、越界路径和多个 SKILL.md。二进制附件以 Base64 原样保留。
- 写作与 RPG 新增固定入口 `search_extensions({query?,kind?,offset?})`、`load_extension({id})`、`read_skill_resource({id,path,offset?,limit?})`、`run_extension({id,argumentsJson})`。首轮最多 40 项简短目录，检索每页 20 项；加载工具后才允许调用，参数字符串解析后按工具 Schema 校验，返回结果按凭据脱敏。技能每次最多读取 16000 字符，未读的附件内容不注入请求。配置指纹改变会阻止旧调用，RPG 的 `extensionLoads` 随 ModelToolContinuation 保留。四协议及两种结果工具通道共用入口；过程与正文分开保存，预算涵盖逐轮实际内容。普通写作启用扩展时最多 16 轮，RPG 沿用 24 轮。
- 扩展接口均沿用登录、同源、流量和请求体保护；最多 4 个并发扩展操作。保存配置会取消当前扩展操作，外部已经产生的副作用不保证撤销。全局配置不随单作品备份，历史诊断仍可包含已加载说明与工具结果。完整数据目录迁移连同加密密钥保留配置。
- 生产模型出站默认只允许 HTTPS 全球公网地址，检查 DNS 结果并将实际连接绑定到已检查地址；设置 `OUTBOUND_ALLOWED_ORIGINS` 后仅允许名单中来源，可明确允许指定来源的 HTTP／私网网关，链路本地及已知云元数据地址仍禁止，所有模式拒绝 URL 查询凭据及重定向。
- Settings.taskSettings 为 {extraction:{outputMode:prompt|structured|tool,autoRetry:boolean,maxRetries:number,retryDelayMs:number}}。原 planning 开关接受为旧格式但忽略且不返回。提取默认 prompt、自动重试关闭，最多额外 2 次、间隔 5000ms；次数 0–10，间隔 0–300000ms。旧 PUT 省略整个设置保留已有提取配置，省略 outputMode 保留原模式，其余字段及未知值仍校验。
- `extraction.outputMode`：prompt 只要求文本 JSON；structured 发送原生 JSON Schema（Chat 的 response_format、Responses 的 text.format、Gemini 的 responseJsonSchema、Claude 的 output_config.format）；tool 提供唯一的 submit_extraction，参数包含 summary/entities/relations/foreshadows，只接收一次同名调用并结束，不执行操作、不回传工具结果、不再生成确认文本。Claude 采用 auto 工具选择以保留思考，其他协议限定工具名称；所有协议都检查实际调用。结构及工具定义计入上下文预算，流式／非流式共用已有证据、关联、版本检查及显式配置的提取重试；失败保留参数文本、原始响应与用量，不自动切换模式。nameStatus/isMain/attribute/dueChapter 可空字段的 null 归为未填写，其他必填值仍校验。
- 自动重试按提取任务的章节／片段计数，导入与独立 extract 共用；失败次数持久化，成功片段的资料、进度及计数清理同事务提交。网络、超时、HTTP 5xx／408／429、输出格式与证据校验失败按设置重试，其他 HTTP 4xx、配置／预算错误、存储错误、停止与版本变化不重试。等待期间 status=running，message 显示次数；每次输出留档、用量累计，耗尽后 failed，人工 resume/retry 重置失败次数。重启或恢复备份转暂停，仍需手动操作；不重发正文、规划、压缩、连接测试或生图请求。
- 历史规划兼容：旧非压缩 plan 队列在启动及备份恢复时取消，记录与模型输出保留且不能应用；继续／重试或导入新规划输出拒绝。outline.fine 不再自动注入写作，历史快照与备份保留。PUT outline 仅编辑 worldview/locked，fine 可省略；旧客户端携带现有 fine 时保留它，试图修改规划返回 410。
- `Settings.promptTemplates` 保存两层编排：presets/selected 保存 writing/extraction/compression/image 四个活动任务，旧 planning 条目只作为兼容归档，general?:{presets:PromptPreset[],selected:string,catalogVersion?:number} 保存通用框架。PromptPreset 为 {id,name,blocks,variables?,useGeneral?,generalPresetId?,writingOutputMode?,toolTransport?,textFilter?,responseCarrier?,messageTransform?}。useGeneral=false 独立使用，否则接入指定或当前通用预设；writingOutputMode:text|tool 仅正文预设允许，省略时跟随通用工具开关，否则默认 text。textFilter:dramatron|v08|reborn|tavern 清理辅助格式（优先任务设置，否则继承所用通用层）。块增加 tasks?:PromptTask[]（仅通用层）、feature?:snow|literal|tavern|cot-three|cot-single|defense-normal|defense-laoda|defense-v08、slot?:task。通用框架恰好一个启用的空任务插槽，引用须存在；modes 仅正文使用。两层变量一次展开，snow／literal 块为完整字面文本，不解释花括号。
- 正文、资料提取、摘要压缩、生图提示词四个任务分别选择预设；规划任务与预览入口移除。角色、业务和素材边界由任务层提供，正文使用项目原版写作规则。context 可使用完整材料，或分别使用世界观、人物、摘要与最近正文；提取 context 只含名称对照及已埋未揭晓伏笔索引。旧自定义 writing 的 currentChapterPlan 变量继续接受以免配置失效，当前任务不提供规划值。
- 通用及每任务各 1–20 份预设，每份 1–80 块；单块最多 100000 字符，自定义变量最多 100 项，全局文本合计最多 1000000 UTF-8 字节。无效变量、重复标识、缺失选择／引用／插槽或任务无有效 user 块等返回 400，整份不保存。旧配置缺少通用层时补默认框架，完全未修改的历史默认升级为两层默认；旧默认带提取承接消息时兼容编辑器块 ID。作者修改和副本保留内容并设 `useGeneral=false`，不增加提示词、不原地修改输入；再次规范化保持稳定。旧 PUT 省略 `promptTemplates` 时保留现有配置。导出为 `{format:'ai-novel-prompt-preset',version:2,task:'general'|PromptTask,preset,generalPreset?}`；任务使用通用层时附该框架。导入两层均生成独立 ID，任务引用导入框架，不切换全局通用选择；兼容 version:1 任务文件并默认独立使用。预设不含连接信息，单作品备份不含全局提示词配置。
- 未配置 responseCarrier 时，正文 writingOutputMode=tool 使用外层 emit_writing_response({prose:string,toolCalls:{name:string,argumentsJson:string}[]})，每轮只接受一个外层调用，内层至多四项；先检查全部名称与 JSON 对象参数，再实际执行。prose 可含启用的辅助格式，清理后才保存与计入章字数。结果 {toolResults:{id,name,result}[]} 按真实外层原生 ID 回送；原响应、签名、过程和用量保留。Chat/Responses 指定工具并禁并行，Gemini ANY 使用 parametersJsonSchema，Claude auto 禁并行并严格核验。工具定义计入预算。按原脚本从同一响应保留更完整的普通文本／工具正文，流式镜像只追加相容后缀；无效调用不会被普通文本掩盖，也不自动重发。最终 toolCalls=[] 直接结束。RPG 断点保留输出模式、辅助清理规则和原生历史，修改预设不改变已保存会话。
- Gemini 请求带实际工具或采用结果工具通道时，解码后的输出候选先清理完整异常串 `]]>🪒úm`、`Sides]]>🪒úm` 及重复组合，再比较通道长度并输出；流式缓存尚未判明的标记前缀，结束时保留未组成完整异常串的普通文本。SSE 正文、最终结果、模型记录的 text 和新续接正文采用相同规则；独立的 `Sides`、`]]>`、表情和双引号内的字面内容保留。此处理独立于 textFilter，不改 rawResponse、原生工具历史、参数、调用 ID、签名或用量；无工具普通文本请求保持原样。清理后只有真实工具调用的回合仍可执行，最终空回仍报错且不自动重发，旧章节及已存续接正文不迁移。
- Dramatron 通用层保留雪融雪降、CLEAR、任务插槽、三段／单段输出包装、普通／牢大防空回替代及 continue，承接消息维持对话交替；角色及证据约束位于任务中。三段／单段互斥且默认仅正文，不含酒馆人物、文风或剧情指令；普通／牢大互斥且默认关闭，原生工具／Schema 跳过尾段。textFilter=dramatron 清理辅助块，保留 JSON 字符串内的原文标签，原始诊断与签名不改写。全部文本与工具计入预算，填充不自动裁剪。写作运行规则提醒按资料缺口使用检索和原文读取工具，按开启的配置使用立绘／场景工具，并明确包装不禁用真实调用；模拟调用文本不触发执行，生图登记成功不等于图片已完成。提醒在预览及实际写作中共用，不改保护模块内容或开关。旧默认迁移保留开关与通道，作者编辑和历史规划预设保留；新任务不编译规划。
- 内置目录：通用层只有 `general-neutral-v1`，默认选择也是该项，最早的 `default-general` 不再内置，正文／提取／压缩各保留原默认与 v3，image 只有 v3。`general.catalogVersion` 保留历史里程碑 7，仅补入中性版；`taskCatalogVersions` 各任务保留里程碑 2，仅补入 v3，缺失 image 按默认补入。已有标记的删除不重建，数量／文本容量不足时延后补入。`catalogCleanupVersion?:number` 当前为 2：在清理版本 1 的基础上，通过完整内容指纹移除未改动的最早三种 `default-general`、早期 v0.8／Reborn 通用版、任务 v2 和四份 `tavern-*`；编辑、复制或被任务显式绑定的通用项保留，选择引用始终有效。
- 提示词文件交换由客户端完成，使用现有 PUT /settings 保存，设置及完整预览请求体上限为 8 MiB，容纳 JSON 转义开销。单项格式 `{format:"ai-novel-prompt-preset",version:2,task,preset,generalPreset?}`，任务可携带通用框架，导入重新分配 ID 并绑定副本；兼容 v1 任务独立导入。整套格式 `{format:"ai-novel-prompt-templates",version:1,templates}` 保留选择、绑定和作者旧版本，确认替换编辑后再保存。严格校验类型、字段、变量、引用和容量，不执行脚本；文件最大 8000000 UTF-8 字节，内容仍受 1000000 文本字节上限约束。仅导出提示词，不包含其他 Settings、供应商或密钥。
- 旧分层工具扩展（未配置 responseCarrier）：`PromptPreset.toolTransport?:boolean` 仅通用层允许，v0.8 与 Reborn 默认 true；正文未显式选择 writingOutputMode 时继承，否则以正文选择为准；独立任务不继承。提示词 JSON 提取和压缩通过同一工具承载完整 JSON 字符串，toolCalls=[]，一次提交结束；原生提取工具／Schema 优先，不重复包装。编译、预算、预览及 `structuredRequest` 使用同一工具 JSON 提交规则，不再在实际发送前追加普通文本 JSON 指令。`textFilter` 支持 dramatron／v08／reborn／tavern；v08 分流 think/thinking/draft，Reborn 分流 think/thinking/think_nya~、移除 game 外包装和仅在开头出现的 finishReason／finishMessage 文本行，保留 JSON 字段原文、真实供应商结束状态和完整响应诊断；断点保存该过滤方式。`feature` 的 literal 为字面文本，defense-v08 在原生工具／Schema 下跳过。详见 [v0.8](V08-PRESET.md) 和 [Reborn 移植说明](REBORN-PRESET.md)。
- 任务 v2 用独立系统职责和单条用户素材消息，不伪造助手确认。任务插槽仅展开各任务块，保留原有 role 和顺序，不以插槽自身 role 覆盖；编辑器显示“任务插槽”，角色控件不可编辑。结果内容约定与实际提交通道分离，写作、证据、可见性及压缩边界仍在任务中，不移植附件的角色伪装、推理预填或浏览器执行器。
- 原版结构扩展：通用层 `responseCarrier?:{name,field,archive?:boolean}` 声明与真实工具并列的文字结果工具；未设置时沿用旧分层工具。`archive=true` 时将本次预设、任务和运行规则移入结果工具说明，真实消息使用调度链；只有预设块的 `carrierPart:guide|description|field` 标记参与分类，不解释素材中的标记。`messageTransform=reborn` 复现启用的伪对话后处理；仅拆分预设源块角色标记，原生提取工具／Schema 优先。最终预览直接读取实际协议工具定义，完整展示归档内容。RPG 断点保留结果工具名称、字段及编排方式。
- `feature=tavern` 在预设文本内展开 setvar/getvar、注释、trim、稳定 random/roll 及当前用户／角色变量；素材不二次解释，未知宏报错。`textFilter=tavern` 分离原版思考、正文包装、终端前导、摘要、状态与选项，JSON 字符串保留原文。
- 生图提示词 `image` 通过 `compileTaskPrompt` 编译、完整输入预算和实际结果工具提交，变量为 `imageInput/imageSystemPrompt/maxCharacterReferences` 及通用变量；实际模型仍由 imageSettings 的独立优化模型或既有后备模型决定，作者补充要求保留。结果仍校验 prompt、referenceEntityIds 和 parameters，失败不自动发像素请求。旧设置缺少 image 时兼容补入，不覆盖旧任务。
- POST /api/settings/prompt-preview：已登录会话提交 {task:writing|extraction|compression|image,templates,variables,protocol,runtime}，只编译请求，不读取作品、保存设置、执行工具或调用模型。runtime 包含 extractionOutputMode、illustrations、rpg、chapterAnswer；不接受 planningMode。返回 messages/runtimeBlocks/tools/body，使用实际请求构建器完整展示规则、工具和四协议正文。变量／预设沿用原有容量与结构校验，非法或退役任务返回 400。
- `Settings.providers` 为供应商连接，只保存协议、地址和密钥等连接信息。任务分别保存 `writingProviderId/writingModel`、`planningProviderId/planningModel`（兼容旧字段名，当前用于摘要压缩）、`extractionProviderId/extractionModel`。选中供应商时必须指定非空模型名，可使用列表外的自定义名称；未选供应商时对应模型清空。兼容旧连接的 `model` 输入及已有存储，缺少任务模型字段时按各任务原供应商的模型迁移；新返回与保存格式使用任务模型字段。
- `Settings.modelParameters` 为模型参数数组，每项以 `{role,providerId,model}` 唯一标识，`role` 为 `writing/planning/extraction`（planning 当前对应摘要压缩），包含 `maxOutputTokens/contextTokens` 和可选生成、思考、超时及流式参数。不同任务即使使用同一供应商与模型也各自保存；同一任务的不同模型或供应商分别保存。旧连接的参数和上限迁移到各任务已分配模型；旧无 `role` 的模型参数复制到三个任务，已有显式任务参数优先，历史未选模型保留。新返回与保存格式包含 `role` 并移除连接内的生成字段。新模型缺少记录时使用温度 `1`、Top P `1`、重复惩罚 `0`、输出 `4096`、上下文 `64000`、超时 `180000` 毫秒、非流式；已有记录的可选字段省略表示不发送，显式 `0/false` 保留。
- 每个模型的 `maxOutputTokens` 为单次输出上限，按保存值发送；`contextTokens` 为单次请求预估输入与完整预留输出的合计上限。超出上下文上限时在发送前停止、保留进度并允许手动重试，不缩减输出上限。`Settings` 不再包含累计任务限额 `taskTokenLimit`；旧存储或旧 PUT 请求中的该字段会被忽略，新返回与保存格式移除该字段，保留原有模型限额、密钥和任务分配。
- POST /settings/models `{providerId}` 或 `{provider:ProviderConnection}` -> `{models:{id:string,name?:string}[]}`。后者按草稿查询，不保存设置；只有同源且未清除密钥时才复用已保存密钥。服务端按协议获取上游模型列表并处理分页；获取失败返回明确错误，用户仍可自定义模型名。此接口不调用文本生成，也不自动重试。
- 设置页的上游模型搜索仅在客户端按返回的 `id/name` 做不区分大小写的包含筛选，不增加搜索接口或请求参数；关键词不进入 `Settings`，搜索不修改任务模型。刷新使用原目录接口，已选但未匹配的模型和自定义名称继续保留。
- Gemini 模型参数可设 `geminiIncludeThoughts?:boolean`，映射至 `generationConfig.thinkingConfig.includeThoughts`；未设置时省略，false 明确发送，且可独立于思考等级或预算使用。其他协议不发送该设置；返回摘要保留在原响应中，但不计入模型正文。
- Gemini 模型参数可设 `geminiStreamFunctionCallArguments?:boolean`，仅在实际流式请求且包含工具定义时映射至 `toolConfig.functionCallingConfig.streamFunctionCallArguments`；未设置时省略，false 明确发送。按任务／连接／模型独立保存，其他协议及非流式、无工具请求不发送；不会修改原生工具的自动选择或强制提交规则。接收 `partialArgs`／`willContinue` 时按安全的属性／数组路径合并参数，结果工具的顶层正文可提前显示；真实工具须等完整响应和参数校验通过后才执行。分片未结束、结构错误或中断时保留草稿和原响应并报错，不执行工具或自动重发；合并后的原生历史保留调用 ID 与思考签名。
- 文字 `timeoutMs` 在流式请求中同时用作等待首段响应内容及内容间空闲的阈值；每个非空 body 字节块均重置，覆盖正文、思考、工具、心跳和部分 JSON／UTF-8，响应头不重置。没有整次流总时限，底层连接／响应头／响应体计时由该取消信号统一管理；非流式仍固定整次请求超时，主动取消仍优先且不自动重试。所有供应商请求显式使用项目依赖中的 Undici `fetch`，避免旧 Node 内置实现因内存回收丢失取消监听；收到响应头后的超时或取消结束读取、关闭连接并保留已收到输出与用量。图片与模型目录沿用各自限时，来源／DNS／重定向限制保持。
- POST /settings/test `{providerId,model?,role?}` -> `{ok,message,inputTokens,outputTokens,capture?}`（按指定任务与模型保存的参数和输出上限调用一次真实模型，未保存过的模型使用通用默认值，不暗中缩小上限）。界面总是传入当前任务的模型及 `role`。兼容旧调用：未传 `role` 时，按正文写作、摘要压缩、资料提取的顺序选第一个供应商与模型匹配的任务，无匹配则使用正文写作参数或默认值；省略模型时取对应任务已分配的模型，没有可用模型则拒绝请求。模型服务错误也返回 HTTP 200 / ok:false 及当次脱敏capture；输入错误仍返回4xx。
- GET /branches/:id/export -> txt；GET /projects/:id/backup -> gzip压缩JSON完整作品不含密钥，含任务进度及作者过程；过程备份仅重映射所属 jobId，工具参数和结果保留历史实际值；POST /restore multipart file（JSON或gzip）-> Project。恢复为独立作品，运行中任务转为暂停。导出在读取原文件与完整历史前执行容量预检，未压缩 JSON、压缩下载、外层上传及解压分别最多 128 MiB。最多恢复 5000 个历史版本；单历史状态解压最多 64 MiB，全部历史状态累计最多 256 MiB。请求体或历史容量超限返回 413，无效 JSON／GZIP 或外层解压超限返回 400；原作品保留。历史状态在备份中单独gzip编码，避免长篇多版本膨胀；超限使用停机后的完整数据目录迁移。
- 小说文件上传、作品备份下载与作品恢复共用每个可信客户端 IP 5 分钟内 3 次的限额，超限返回 429。正文 TXT 导出不计入这项限额。

前端每 2 秒刷新任务，任务完成后刷新当前 branch 状态；编辑器有未保存内容时不得被后台刷新覆盖。所有写请求使用 baseRevisionId，409 提示刷新/另存，不覆盖草稿。正文使用 SSE 实时输出，后台任务继续每两秒轮询；重连从持久化草稿快照续接，刷新和切换视图不重发生成请求。

人物 Entity 可含 isMain?:boolean 与 nameStatus?:'placeholder'|'confirmed'。isMainSource 记录 author/extraction 来源，作者显式主次选择优先，未人工指定的角色可随剧情重新识别；有明确名称或别名身份桥时可将暂称升级为真名，锁定身份不覆盖。人物事实优先为资料字段和重大经历，普通行动进入剧情摘要。

正文上下文完整保留世界观、规则、主要人物、未揭晓伏笔、最近三章全文及所有剧情摘要。作者确认的压缩摘要只替代其覆盖章节，后续章节仍用原摘要。search_story/read_entity/read_chapter 及虚拟文本工具读取构建时捕获的当前故事／原作参考快照；每轮模型工具调用独立检查完整输入加预留输出，累计用量只用于统计。普通写作最多六轮、二十四次工具调用；RPG 最多二十四轮、九十六次工具调用，失败均不隐式重试。

search_story 推荐传 `{keywords:["林舟","老吴"],scope?:"all"|"entities"|"chapters"}`，各词使用 OR（任一命中）匹配。兼容 query 字符串按空格、逗号、顿号、分号、换行或竖线拆词；整串为已知名称、别名或章标题时保留完整词。keywords 每项按完整短语匹配；同时传 query 和 keywords 时合并去重。至少提供一个非空词，错误类型、空白数组项或无效范围返回工具 error。检索经过 NFKC 和大小写规范化，只匹配名称、别名、描述、事实文字或各章标题/摘要/正文，不匹配内部 ID 与 JSON 字段名，各文本字段分别匹配；当前故事与原作参考分别绑定固定版本，每类最多返回20条；不同 collection 或 snapshot／source 的同名结果分别标明归属。
