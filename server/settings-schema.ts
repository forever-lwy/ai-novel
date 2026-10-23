import { z } from 'zod';
import { modelRoles } from '../shared/model-settings.js';
import type { ProjectSettingsOverrides } from '../shared/types.js';
import { parseTaskSettings } from '../shared/task-settings.js';
import { validatePromptTemplates } from '../shared/prompt-templates.js';

export function parseProjectSettingsOverrides(value: unknown): ProjectSettingsOverrides {
  const task = z.object({ providerId: z.string().max(100), model: modelNameSchema, modelParameters: z.array(modelProfileSchema).max(3000) }).strict();
  const parsed = z.object({
    tasks: z.object({ writing: task.optional(), planning: task.optional(), extraction: task.extend({ extraction: z.unknown().optional() }).optional() }).strict().optional(),
    promptTemplates: z.unknown().optional(), imageSettings: imageSettingsSchema.optional(),
  }).strict().parse(value);
  const result: ProjectSettingsOverrides = {};
  if (parsed.tasks) {
    result.tasks = {};
    for (const role of modelRoles) {
      const selected = parsed.tasks[role];
      if (!selected) continue;
      if (selected.providerId && !selected.model) throw new Error('已选择供应商的任务需要填写模型名称。');
      const seen = new Set<string>();
      for (const profile of selected.modelParameters) {
        if (profile.role !== role) throw new Error('作品任务参数必须属于对应任务。');
        const key = JSON.stringify([profile.providerId, profile.model]);
        if (seen.has(key)) throw new Error('同一任务、供应商和模型的参数不能重复。');
        seen.add(key);
        if (profile.maxOutputTokens >= profile.contextTokens) throw new Error('输出上限必须小于上下文上限。');
      }
      result.tasks[role] = { providerId: selected.providerId, model: selected.model, modelParameters: selected.modelParameters };
      if (role === 'extraction') {
        const extraction = parsed.tasks.extraction?.extraction;
        if (extraction === undefined) throw new Error('资料提取覆盖需包含输出模式和重试设置。');
        result.tasks[role]!.extraction = parseTaskSettings({ extraction }).extraction;
      }
    }
    if (!Object.keys(result.tasks).length) delete result.tasks;
  }
  if (parsed.promptTemplates !== undefined) result.promptTemplates = validatePromptTemplates(parsed.promptTemplates);
  if (parsed.imageSettings) result.imageSettings = parsed.imageSettings;
  return result;
}

export const modelNameSchema = z.string().trim().max(300).refine(value => !/[\u0000-\u001f\u007f]/.test(value), '模型名称不能包含控制字符');
export const modelParametersSchema = z.object({
  maxOutputTokens: z.number().int().min(256).max(128000), contextTokens: z.number().int().min(2048).max(2000000),
  temperature: z.number().min(0).max(2).optional(), topP: z.number().min(0).max(1).optional(), topK: z.number().int().min(0).max(1000000).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(), frequencyPenalty: z.number().min(-2).max(2).optional(), seed: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  stopSequences: z.array(z.string().min(1).max(1000)).max(16).optional(), timeoutMs: z.number().int().min(1000).max(3600000).optional(), stream: z.boolean().optional(),
  openaiMaxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(), reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  geminiThinking: z.discriminatedUnion('mode', [z.object({ mode: z.literal('level'), level: z.enum(['minimal', 'low', 'medium', 'high']) }).strict(), z.object({ mode: z.literal('budget'), budget: z.number().int().min(-1).max(1000000) }).strict()]).optional(),
  geminiIncludeThoughts: z.boolean().optional(),
  geminiStreamFunctionCallArguments: z.boolean().optional(),
  claudeThinking: z.discriminatedUnion('type', [z.object({ type: z.literal('disabled') }).strict(), z.object({ type: z.literal('adaptive') }).strict(), z.object({ type: z.literal('enabled'), budgetTokens: z.number().int().min(1024).max(128000) }).strict()]).optional(),
  claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
export const providerSchema = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(100), protocol: z.enum(['openai-chat', 'openai-responses', 'gemini', 'claude']), baseUrl: z.string().url().max(2000).refine(v => { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }, '服务地址必须是 HTTP(S)，不能包含用户名或密码'), model: modelNameSchema.optional(), apiKey: z.string().max(4096).optional(), hasKey: z.boolean().optional(), clearApiKey: z.boolean().optional() }).extend(modelParametersSchema.partial().shape);
export const modelRoleSchema = z.enum(modelRoles);
export const modelProfileSchema = modelParametersSchema.extend({ role: modelRoleSchema.optional(), providerId: z.string().min(1).max(100), model: modelNameSchema.refine(value => Boolean(value), '模型参数需要指定模型名称') }).strict();
export const imageSettingsSchema = z.object({
  providerId: z.string().max(100), model: modelNameSchema, protocol: z.enum(['openai-images', 'gemini', 'together-images']), size: z.string().max(50).refine(value => value === 'auto' || /^\d{2,4}x\d{2,4}$/.test(value), '图片尺寸需为 auto 或合法的宽x高'),
  quality: z.enum(['auto', 'low', 'medium', 'high', 'standard', 'hd', 'xhigh', 'max']), stylePrompt: z.string().max(10000), autoPortrait: z.boolean(), autoCG: z.boolean(), timeoutMs: z.number().int().min(1000).max(3600000),
  promptProviderId: z.string().max(100).optional(), promptModel: modelNameSchema.optional(), promptSystemPrompt: z.string().max(10000).optional(), useCharacterReferences: z.boolean().optional(),
  aspectRatio: z.string().max(30).optional(), imageSize: z.enum(['auto', '512', '1K', '2K', '4K']).optional(), systemInstruction: z.string().max(32000).optional(),
  temperature: z.number().min(0).max(2).optional(), topP: z.number().min(0).max(1).optional(), topK: z.number().int().min(1).max(1000000).optional(), seed: z.number().int().min(-2147483648).max(4294967295).optional(), maxOutputTokens: z.number().int().min(1).max(32768).optional(),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(), includeThoughts: z.boolean().optional(), searchGrounding: z.boolean().optional(),
  outputFormat: z.enum(['png', 'jpeg', 'webp']).optional(), outputCompression: z.number().int().min(0).max(100).optional(), background: z.enum(['auto', 'opaque', 'transparent']).optional(), inputFidelity: z.enum(['low', 'high']).optional(), moderation: z.enum(['auto', 'low']).optional(),
  negativePrompt: z.string().max(32000).optional(), steps: z.number().int().min(1).max(100).optional(), guidanceScale: z.number().min(0).max(20).optional(), width: z.number().int().min(16).max(8192).optional(), height: z.number().int().min(16).max(8192).optional(), promptUpsampling: z.boolean().optional(), disableSafetyChecker: z.boolean().optional(),
}).strict();
export const settingsSchema = z.object({ providers: z.array(providerSchema).max(30), writingProviderId: z.string(), planningProviderId: z.string(), extractionProviderId: z.string(), writingModel: modelNameSchema.optional(), planningModel: modelNameSchema.optional(), extractionModel: modelNameSchema.optional(), modelParameters: z.array(modelProfileSchema).max(3000).optional(), promptTemplates: z.unknown().optional(), imageSettings: imageSettingsSchema.optional(), taskSettings: z.unknown().optional() });
