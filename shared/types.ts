export type Mode = 'original' | 'continuation' | 'fanfiction' | 'rewrite' | 'rpg';
export interface RpgCharacter { kind: 'original' | 'existing'; name: string; description: string; entityId?: string }
export interface RpgSetup { character: RpgCharacter; entryChapterId?: string; entryInstruction?: string }
export interface RpgSession { character: RpgCharacter; entryChapterId?: string; entryInstruction: string }
export interface RpgChoice { id: string; question: string; options: { id: string; label: string; description?: string }[] }
export type Visibility = 'public' | 'secret';
export type KnowledgeKind = 'character' | 'faction' | 'location' | 'item' | 'ability' | 'rule' | 'event';
export interface Citation { chapterId: string; paragraph: number; quote: string }
export interface Fact { id: string; text: string; attribute?: string; temporal: 'current' | 'past' | 'future' | 'unknown'; certainty: 'fact' | 'inference' | 'conflict'; visibility: Visibility; citation?: Citation; locked?: boolean }
export interface Entity { id: string; kind: KnowledgeKind; name: string; aliases: string[]; description: string; visibility: Visibility; locked: boolean; facts: Fact[]; mergedInto?: string; isMain?: boolean; isMainSource?: 'author' | 'extraction'; nameStatus?: 'placeholder' | 'confirmed' }
export interface Relation { id: string; fromId: string; toId: string; label: string; visibility: Visibility; citation?: Citation }
export interface Foreshadow { id: string; title: string; detail: string; status: 'planned' | 'planted' | 'resolved' | 'abandoned'; plantedChapterId?: string; resolvedChapterId?: string; dueChapter?: number; revealCondition: string; relatedEntityIds: string[] }
export interface SummaryCompression { text: string; chapterIds: string[] }
/** The persisted field name remains outline; it now stores world settings and future plans only. */
export interface Outline { coarse?: string; worldview?: string; locked: string; fine: { chapter: number; title: string; goal: string }[]; summaryCompression?: SummaryCompression }
export interface Chapter { id: string; title: string; text: string; sourceId?: string; summary: string; status: 'pending' | 'ready' | 'failed'; createdAt: string }
export type ChapterRef = Omit<Chapter, 'text'>;
export interface StoryState { chapters: ChapterRef[]; entities: Entity[]; relations: Relation[]; foreshadows: Foreshadow[]; outline: Outline; imageIds?: string[]; activeImageIds?: string[]; rpg?: RpgSession }
export interface Project { id: string; title: string; premise: string; mode: Mode; createdAt: string; updatedAt: string; mainBranchId: string }
export interface Branch { id: string; projectId: string; name: string; revisionId: string; parentBranchId?: string; forkChapterId?: string; createdAt: string }
export interface Revision { id: string; branchId: string; parentId?: string; label: string; createdAt: string; chapterCount: number }
export interface BranchView { branch: Branch; state: StoryState; revisions: Revision[] }
export interface Source { id: string; projectId: string; filename: string; format: 'txt' | 'epub'; chapterCount: number; createdAt: string; confirmed: boolean }
export interface SourcePreview { source: Source; chapters: { title: string; text: string }[] }
export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'gemini' | 'claude';
export interface ModelParameters {
  maxOutputTokens: number; contextTokens: number;
  temperature?: number; topP?: number; topK?: number; presencePenalty?: number; frequencyPenalty?: number; seed?: number; stopSequences?: string[];
  timeoutMs?: number; stream?: boolean;
  openaiMaxTokensField?: 'max_tokens' | 'max_completion_tokens';
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  geminiThinking?: { mode: 'level'; level: 'minimal' | 'low' | 'medium' | 'high' } | { mode: 'budget'; budget: number };
  geminiIncludeThoughts?: boolean;
  claudeThinking?: { type: 'disabled' } | { type: 'enabled'; budgetTokens: number } | { type: 'adaptive' };
  claudeEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
export type ModelRole = 'writing' | 'planning' | 'extraction';
/** Missing role is accepted only when upgrading parameters shared by older settings. */
export interface ModelParameterProfile extends ModelParameters { role?: ModelRole; providerId: string; model: string }
export interface ProviderConfig extends ModelParameters {
  id: string; name: string; protocol: ProviderProtocol; baseUrl: string; model: string;
  apiKey?: string; hasKey?: boolean; clearApiKey?: boolean;
}
/** Generation fields and model are accepted only when upgrading older settings. */
export type ProviderConnection = Omit<ProviderConfig, keyof ModelParameters | 'model'> & Partial<ModelParameters> & { model?: string };
export interface ProviderModel { id: string; name?: string }
export type PromptTask = 'writing' | 'planning' | 'extraction' | 'compression';
export interface PromptMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface PromptBlock extends PromptMessage { id: string; name: string; enabled: boolean; modes?: Mode[] }
export interface PromptPreset { id: string; name: string; blocks: PromptBlock[]; variables?: Record<string, string> }
export interface PromptTemplateSettings { presets: Record<PromptTask, PromptPreset[]>; selected: Record<PromptTask, string> }
export interface ImageSettings {
  providerId: string; model: string; protocol: 'openai-images' | 'gemini' | 'together-images'; size: string;
  quality: 'auto' | 'low' | 'medium' | 'high' | 'standard' | 'hd' | 'xhigh' | 'max'; stylePrompt: string; autoPortrait: boolean; autoCG: boolean; timeoutMs: number;
  promptProviderId?: string; promptModel?: string; promptSystemPrompt?: string; useCharacterReferences?: boolean;
  aspectRatio?: string; imageSize?: 'auto' | '512' | '1K' | '2K' | '4K'; systemInstruction?: string;
  temperature?: number; topP?: number; topK?: number; seed?: number; maxOutputTokens?: number;
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'; includeThoughts?: boolean; searchGrounding?: boolean;
  outputFormat?: 'png' | 'jpeg' | 'webp'; outputCompression?: number; background?: 'auto' | 'opaque' | 'transparent'; inputFidelity?: 'low' | 'high'; moderation?: 'auto' | 'low';
  negativePrompt?: string; steps?: number; guidanceScale?: number; width?: number; height?: number; promptUpsampling?: boolean; disableSafetyChecker?: boolean;
}
export interface ImageResolvedParameters { size?: ImageSettings['size']; aspectRatio?: string; imageSize?: Exclude<ImageSettings['imageSize'], 'auto'>; width?: number; height?: number }
export type ImageGenerationParameters = ImageResolvedParameters & Partial<Omit<ImageSettings, 'providerId' | 'promptProviderId' | 'promptModel' | 'promptSystemPrompt' | 'stylePrompt' | 'autoCG' | 'autoPortrait' | 'useCharacterReferences' | 'timeoutMs'>>;
export type StoryImageKind = 'portrait' | 'entity' | 'map' | 'cg';
export type StoryImageStatus = 'queued' | 'running' | 'completed' | 'failed' | 'paused' | 'stale' | 'cancelled';
export interface StoryImage { id: string; projectId: string; branchId: string; baseRevisionId: string; kind: StoryImageKind; status: StoryImageStatus; title: string; prompt: string; entityId?: string; chapterId?: string; sourceText?: string; selection?: { start: number; end: number }; referenceImageId?: string; automatic: boolean; visibility: Visibility; createdAt: string; updatedAt: string; error?: string; mimeType?: 'image/png' | 'image/jpeg' | 'image/webp'; url?: string; material?: string; instruction?: string; materialEntityIds?: string[]; referenceImageIds?: string[]; referenceEntityIds?: string[]; referenceCharacters?: { entityId: string; imageId: string; name: string }[]; generationParameters?: ImageGenerationParameters; promptStatus?: 'pending' | 'completed'; optimizedAt?: string; active?: boolean }
export interface ImageGenerateInput { baseRevisionId: string; kind: StoryImageKind; entityId?: string; chapterId?: string; selection?: { start: number; end: number }; instruction?: string; referenceImageId?: string }
/** Writing tools request illustrations; they bind to saved prose and confirmed entities after extraction. */
export interface WritingImageRequest { kind: 'portrait' | 'cg'; name?: string; description: string; sourceText?: string }
export interface TaskSettings {
  extraction: { autoRetry: boolean; maxRetries: number; retryDelayMs: number };
  planning: { enabled: boolean; mode: 'separate' | 'tool' };
}
export interface Settings { providers: ProviderConnection[]; writingProviderId: string; planningProviderId: string; extractionProviderId: string; writingModel?: string; planningModel?: string; extractionModel?: string; modelParameters?: ModelParameterProfile[]; promptTemplates?: PromptTemplateSettings; imageSettings?: ImageSettings; taskSettings?: TaskSettings }
export type JobKind = 'import' | 'extract' | 'generate' | 'plan';
export type JobStatus = 'queued' | 'running' | 'paused' | 'failed' | 'completed' | 'cancelled' | 'stale';
export interface Job { id: string; projectId: string; branchId: string; kind: JobKind; status: JobStatus; baseRevisionId: string; progress: number; total: number; message: string; error?: string; inputTokens: number; outputTokens: number; usageEstimated?: boolean; createdAt: string; updatedAt: string; payload: Record<string, unknown>; generatedChapterId?: string; title?: string; purpose?: 'compress-summary'; generationInput?: Pick<GenerateInput, 'mode' | 'instruction' | 'maxWords' | 'title' | 'rpg'>; pendingChoice?: RpgChoice }
export type ModelActivityEvent = { type: 'thinking'; id: string; text: string } | { type: 'thinking_done'; id: string } | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> } | { type: 'tool_result'; id: string; name: string; result?: unknown; error?: string };
export interface WritingActivity { id: string; kind: 'thinking' | 'tool'; text?: string; name?: string; arguments?: Record<string, unknown>; result?: unknown; status: 'running' | 'completed' | 'failed'; error?: string }
export type WritingEvent = { type: 'snapshot'; text: string; title: string; job: Job; chapterId?: string; activities?: WritingActivity[] } | { type: 'delta'; text: string } | { type: 'activity'; activity: WritingActivity } | { type: 'status'; job: Job; chapterId?: string };
export interface GenerateInput { baseRevisionId: string; mode: Mode; instruction: string; title?: string; chapterId?: string; selection?: { start: number; end: number }; maxWords?: number; regenerate?: boolean; discardBackground?: boolean; rpg?: RpgSetup }
export interface ExtractionResult {
  summary: string;
  entities: { kind: KnowledgeKind; name: string; aliases: string[]; description: string; visibility: Visibility; isMain?: boolean; nameStatus?: 'placeholder' | 'confirmed'; facts: { text: string; attribute?: string; temporal: Fact['temporal']; certainty: Fact['certainty']; visibility: Visibility; paragraph: number; quote: string }[] }[];
  relations: { from: string; to: string; label: string; visibility: Visibility; paragraph: number; quote: string }[];
  foreshadows: { title: string; detail: string; status: Foreshadow['status']; dueChapter?: number; revealCondition: string; relatedNames: string[] }[];
}
export interface PlanningResult { coarse?: string; fine: Outline['fine']; foreshadows: ExtractionResult['foreshadows'] }
export interface ModelResult { text: string; inputTokens: number; outputTokens: number; usageEstimated?: boolean }
export interface ModelRequestSnapshot { protocol: ProviderProtocol; model: string; url: string; method: 'POST'; headers: Record<string, string>; body: string; startedAt: string; timeoutMs: number; stream: boolean }
export interface ModelTransportDiagnostics { elapsedMs: number; responseBytes: number; responseHeaders: Record<string, string>; transport: 'http' | 'network_error' | 'timeout' | 'cancelled' | 'interrupted'; errorCode?: string; modelOutcome?: 'completed' | 'blocked' | 'truncated' | 'empty' | 'error'; finishReason?: string; promptBlockReason?: string }
export interface CapturedModelResponse { rawResponse: string; text: string; inputTokens: number; outputTokens: number; httpStatus?: number; incomplete?: boolean; request?: ModelRequestSnapshot; diagnostics?: ModelTransportDiagnostics }
export interface ModelTool { name: string; description: string; parameters: Record<string, unknown>; execute: (arguments_: Record<string, unknown>) => Promise<unknown> | unknown }
export interface ModelToolCall { id: string; name: string; arguments: unknown }
/** Wire history is preserved verbatim so tool calls and signed model content survive a user decision. */
export interface ModelToolContinuation {
  protocol: ProviderProtocol; model: string; body: Record<string, unknown>; text: string;
  inputTokens: number; outputTokens: number; round: number; callCount: number; usageEstimated?: boolean;
  pending?: { data: Record<string, unknown>; calls: ModelToolCall[]; results: { call: ModelToolCall; output: string }[]; nextIndex: number };
}
export interface ModelRequest { system: string; prompt: string; messages?: PromptMessage[]; signal?: AbortSignal; maxOutputTokens?: number; maxToolRounds?: number; onRequest?: (request: ModelRequestSnapshot) => void; onResponse?: (response: CapturedModelResponse) => void; onTextDelta?: (text: string) => void; onActivity?: (event: ModelActivityEvent) => void; tools?: ModelTool[]; continuation?: ModelToolContinuation; onContinuation?: (state: ModelToolContinuation) => void | Promise<void> }
export type OutputStage = 'planning' | 'writing' | 'extraction';
export interface OutputIssue { path: string; message: string; paragraph?: number; quote?: string; sourceText?: string }
export interface ModelOutputRecord extends CapturedModelResponse {
  id: string; jobId: string; projectId: string; branchId: string; baseRevisionId: string;
  stage: OutputStage; chapterId?: string; blockIndex?: number;
  createdAt: string; updatedAt: string; status: 'received' | 'invalid' | 'applied';
  editedText?: string; normalizedText?: string; adjustments?: OutputIssue[]; error?: string; issues: OutputIssue[];
}
export type ModelOutputSummary = Omit<ModelOutputRecord, 'rawResponse' | 'text' | 'editedText' | 'normalizedText' | 'adjustments' | 'issues' | 'request' | 'diagnostics'>;
export interface ModelOutputDetail { output: ModelOutputRecord; sourceParagraphs: { paragraph: number; text: string }[]; canApply: boolean; unavailableReason?: string }
export const emptyState = (): StoryState => ({ chapters: [], entities: [], relations: [], foreshadows: [], outline: { worldview: '', locked: '', fine: [] } });
