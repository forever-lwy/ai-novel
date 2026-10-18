# v0.8 通用保护框架移植说明

本文是早期简化移植版的历史说明，已不属于内置目录；只有作者编辑或显式绑定的已有项会保留。当前内置中性版、任务 v3 与可选导入文件见 [当前移植说明](TAVERN-PRESETS.md)。

核对日期：2026-10-14（北京时间）。仅移植文本破限和工具防截断，不移植输入混淆、角色、文风、骰子、剧情控制、摘要管理或界面美化。

## 原文件与实际机制

分析对象为 `v0.8_-_1.json`，SHA-256：`5809395435040456533dc4101353ba91f43d40e8dd80a9bd6f9873ab4c8dcf2a`。仅将 JSON 和内嵌 JavaScript 作为文本读取，未执行附件脚本，未导入整份预设或内置长文。

`extensions.tavern_helper.scripts` 只有一项启用脚本“破甲及反截断脚本”，共 2079 行。它依赖浏览器窗口、SillyTavern 当前聊天、localStorage 和酒馆助手按钮接口，直接包装浏览器 fetch，识别 `/api/backends/chat-completions/generate`，发送前改写 JSON，返回后解包 HTTP／SSE。酒馆助手主要承担脚本加载和设置入口，保护能力不由提示词块自动获得。

| 原机制与源码定位 | 核对结果 | 本项目处理 |
| --- | --- | --- |
| DEFAULTS，30–35 行 | 工具传输、输入混淆、头部填充均关闭，用户填充开启；实际值可能被 localStorage 改写，附件不含该状态 | 新增可选内置框架，不改变现有选择；选择此框架后默认启用工具防截断，并提供开关 |
| randomTextSlice、applyTextLibraryMarkers，195–275 行 | 头部最多 14460 字符，用户填充最多 7514 字符；LATEST_USER_INPUT 代表填充文本，真正用户输入另在 latest_input 内 | 两个可编辑字面文本块，头部默认关闭、输入前填充开启；重新编写中性文本，固定内容使预览与实际编译一致，不随机抽片，不带酒馆宏 |
| “破甲3／2／1”及尾部提示词 | 选中的“破甲3”使用固定虚构身份；骰子和年龄改写模块关闭；尾部用 draft 与固定招呼启动，思考强度为 0 只是文本声称 | 保留虚构任务、直接补全、避免无关开场和完整交付约束；去掉固定身份、年龄改写和骰子。短 draft 占位默认关闭，不调整原生思考参数，不要求额外推理过程 |
| syntheticTool、prepareRequest，670–765 行 | 注入 output_everything_here(content)；已有工具、受控工具选择或原生结构化输出时跳过；没有自动续写或重试 | 复用 emit_writing_response(prose, toolCalls)，正文仍能执行查询、插画和 RPG；原生提取工具／Schema 保持原约定。提示词 JSON 与压缩在 prose 中携带 JSON，toolCalls 为空，提交一次即结束 |
| extractContent、ResponseStream，859–1435 行 | 从工具参数恢复文本，处理分片及未完整结束的数据 | 复用四协议流式解析、部分正文留存、镜像去重、用量和诊断；截断或无效返回仍报错，不把片段冒充完整结果 |
| compactEncode、imageInput，355–382、620–668 行 | 对最新输入做 Unicode 编码或绘制 PNG，需要额外输入处理／视觉模型支持，默认关闭 | 按本次范围不移植，也不暗中转换输入 |
| 正则及 SPreset | 包含思考删除、美化和摘要替换；SPreset 的 ChatSquash、输出预处理及强制后处理关闭 | 不执行原正则或脚本。v0.8 专用过滤仅分流 think／thinking／draft，JSON 字符串内原文标签保留；原 Dramatron 行为保持不变 |

原脚本顶部标明 Antigravity Gateway Experimental／Xeltra233／MIT。本项目依据其机制重写集成，没有复制执行器、输入变换、UI 或内置正文。

## 使用与兼容

在“设置 → 提示词编排 → 通用预设”选择 **v0.8 通用防截断与破限**，按需编辑填充文本、切换“工具防截断”，最后保存。填充计入上下文和用量，超限在发送前报错，可缩短或关闭。

正文输出通道默认跟随所搭配的通用预设，显式选择普通文本或工具优先；独立使用任务提示词时不继承通用层。Dramatron 的既有默认行为仍为普通文本。原生提取工具和 Schema 不增加第二层包装；提示词 JSON 和摘要压缩开启工具防截断时只提交一次结果。

`general.catalogVersion` 的版本 1 标识已提供过 v0.8，版本 2 同时提供 Reborn；此后的已有版本标记同样保留 v0.8 的删除。升级只补入缺失预设，不改变选择、绑定或作者内容，保存后删除不会重新添加，同 ID 的作者版本不覆盖。已有 20 份预设或剩余文本容量不足时不挤掉旧内容，可腾出容量后重开设置，或在“恢复默认框架”选择 v0.8，将当前预设改为该框架；名称保留，保存后生效。

导出任务时携带实际搭配的通用预设，复制及导入保留工具开关和过滤方式。未结束的 RPG 回合保持发起时的工具通道、过滤方式及签名。

## 证据与验证边界

公共接口通过原生检索、Firecrawl developer 检索和原文读取核对：

- [SillyTavern：UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)：扩展运行于浏览器环境，可访问 DOM、上下文并拦截提示词，与附件的 fetch 包装机制相符。
- [SillyTavern：Prompts](https://docs.sillytavern.app/usage/prompts/)：Chat Completion 使用 Prompt Manager 组织消息，整份预设不等同于单条系统提示词。
- [酒馆助手：提示词查看器](https://n0vi028.github.io/JS-Slash-Runner-Doc/guide/基本用法/提示词查看器.html)：预设面板之后还可能有宏和脚本处理，查看器也不包含后端提示词后处理。因此迁移依据为启用配置和请求变换，不仅是提示词名称。

这些来源确认接口及处理层次，不证明破限有效。长文本和虚构任务提示只是提示策略；工具提交改变输出承载方式，不能提高模型输出上限、阻止断流或保证上游接受。实际验证见 [验收记录](VALIDATION.md)。本次不调用真实供应商，不修改现有作品或当前预设选择。
