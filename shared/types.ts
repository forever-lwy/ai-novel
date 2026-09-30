export type Mode = 'original' | 'continuation' | 'fanfiction' | 'rewrite';
export type Visibility = 'public' | 'secret';
export type KnowledgeKind = 'character' | 'faction' | 'location' | 'item' | 'ability' | 'rule' | 'event';
export interface Citation { chapterId: string; paragraph: number; quote: string }
export interface Fact { id: string; text: string; attribute?: string; temporal: 'current' | 'past' | 'future' | 'unknown'; certainty: 'fact' | 'inference' | 'conflict'; visibility: Visibility; citation?: Citation; locked?: boolean }
export interface Entity { id: string; kind: KnowledgeKind; name: string; aliases: string[]; description: string; visibility: Visibility; locked: boolean; facts: Fact[]; mergedInto?: string }
export interface Relation { id: string; fromId: string; toId: string; label: string; visibility: Visibility; citation?: Citation }
export interface Foreshadow { id: string; title: string; detail: string; status: 'planned' | 'planted' | 'resolved' | 'abandoned'; plantedChapterId?: string; resolvedChapterId?: string; dueChapter?: number; revealCondition: string; relatedEntityIds: string[] }
export interface Outline { coarse: string; locked: string; fine: { chapter: number; title: string; goal: string }[] }
export interface Chapter { id: string; title: string; text: string; sourceId?: string; summary: string; status: 'pending' | 'ready' | 'failed'; createdAt: string }
export type ChapterRef = Omit<Chapter, 'text'>;
export interface StoryState { chapters: ChapterRef[]; entities: Entity[]; relations: Relation[]; foreshadows: Foreshadow[]; outline: Outline }
export interface Project { id: string; title: string; premise: string; mode: Mode; createdAt: string; updatedAt: string; mainBranchId: string }
export interface Branch { id: string; projectId: string; name: string; revisionId: string; parentBranchId?: string; forkChapterId?: string; createdAt: string }
export interface Revision { id: string; branchId: string; parentId?: string; label: string; createdAt: string; chapterCount: number }
export interface BranchView { branch: Branch; state: StoryState; revisions: Revision[] }
export interface Source { id: string; projectId: string; filename: string; format: 'txt' | 'epub'; chapterCount: number; createdAt: string; confirmed: boolean }
export interface SourcePreview { source: Source; chapters: { title: string; text: string }[] }
export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'gemini' | 'claude';
export interface ProviderConfig {
  id: string; name: string; protocol: ProviderProtocol; baseUrl: string; model: string;
  apiKey?: string; hasKey?: boolean; clearApiKey?: boolean; maxOutputTokens: number; contextTokens: number;
  temperature?: number; topP?: number; topK?: number; presencePenalty?: number; frequencyPenalty?: number; seed?: number; stopSequences?: string[];
  timeoutMs?: number; stream?: boolean;
  openaiMaxTokensField?: 'max_tokens' | 'max_completion_tokens';
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  geminiThinking?: { mode: 'level'; level: 'minimal' | 'low' | 'medium' | 'high' } | { mode: 'budget'; budget: number };
  geminiIncludeThoughts?: boolean;
  claudeThinking?: { type: 'disabled' } | { type: 'enabled'; budgetTokens: number } | { type: 'adaptive' };
  claudeEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
export interface Settings { providers: ProviderConfig[]; writingProviderId: string; planningProviderId: string; extractionProviderId: string; taskTokenLimit: number }
export type JobKind = 'import' | 'extract' | 'generate' | 'plan';
export type JobStatus = 'queued' | 'running' | 'paused' | 'failed' | 'completed' | 'cancelled' | 'stale';
export interface Job { id: string; projectId: string; branchId: string; kind: JobKind; status: JobStatus; baseRevisionId: string; progress: number; total: number; message: string; error?: string; inputTokens: number; outputTokens: number; usageEstimated?: boolean; createdAt: string; updatedAt: string; payload: Record<string, unknown> }
export interface GenerateInput { baseRevisionId: string; mode: Mode; instruction: string; title?: string; chapterId?: string; selection?: { start: number; end: number }; maxWords?: number }
export interface ExtractionResult {
  summary: string;
  entities: { kind: KnowledgeKind; name: string; aliases: string[]; description: string; visibility: Visibility; facts: { text: string; attribute?: string; temporal: Fact['temporal']; certainty: Fact['certainty']; visibility: Visibility; paragraph: number; quote: string }[] }[];
  relations: { from: string; to: string; label: string; visibility: Visibility; paragraph: number; quote: string }[];
  foreshadows: { title: string; detail: string; status: Foreshadow['status']; dueChapter?: number; revealCondition: string; relatedNames: string[] }[];
}
export interface PlanningResult { coarse: string; fine: Outline['fine']; foreshadows: ExtractionResult['foreshadows'] }
export interface ModelResult { text: string; inputTokens: number; outputTokens: number }
export interface ModelRequestSnapshot { protocol: ProviderProtocol; model: string; url: string; method: 'POST'; headers: Record<string, string>; body: string; startedAt: string; timeoutMs: number; stream: boolean }
export interface ModelTransportDiagnostics { elapsedMs: number; responseBytes: number; responseHeaders: Record<string, string>; transport: 'http' | 'network_error' | 'timeout' | 'cancelled' | 'interrupted'; errorCode?: string; modelOutcome?: 'completed' | 'blocked' | 'truncated' | 'empty' | 'error'; finishReason?: string; promptBlockReason?: string }
export interface CapturedModelResponse { rawResponse: string; text: string; inputTokens: number; outputTokens: number; httpStatus?: number; incomplete?: boolean; request?: ModelRequestSnapshot; diagnostics?: ModelTransportDiagnostics }
export interface ModelRequest { system: string; prompt: string; signal?: AbortSignal; maxOutputTokens?: number; onRequest?: (request: ModelRequestSnapshot) => void; onResponse?: (response: CapturedModelResponse) => void }
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
export const emptyState = (): StoryState => ({ chapters: [], entities: [], relations: [], foreshadows: [], outline: { coarse: '', locked: '', fine: [] } });
