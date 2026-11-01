import { z } from 'zod';
import type { ModelOutputRecord } from '../shared/types.js';
import { modelOutputSchema } from './output-store.js';

// Old visibility projections still need the interpreted extraction, never its wire request or response.
export const extractionEvidenceSchema = modelOutputSchema.pick({ id: true, projectId: true, branchId: true, baseRevisionId: true,
  chapterId: true, blockIndex: true, normalizedText: true, adjustments: true }).extend({ chapterId: z.string().min(1), normalizedText: z.string().min(1) }).strict();
export type ExtractionEvidence = z.infer<typeof extractionEvidenceSchema>;
export function extractionEvidence(output: ModelOutputRecord): ExtractionEvidence | undefined {
  if (output.stage !== 'extraction' || output.status !== 'applied' || !output.chapterId || !output.normalizedText) return undefined;
  const { id, projectId, branchId, baseRevisionId, chapterId, blockIndex, normalizedText, adjustments } = output;
  return { id, projectId, branchId, baseRevisionId, chapterId, blockIndex, normalizedText, adjustments };
}
export function evidenceOutput(evidence: ExtractionEvidence): ModelOutputRecord {
  return { ...evidence, jobId: '', stage: 'extraction', status: 'applied', createdAt: '', updatedAt: '',
    rawResponse: '', text: '', inputTokens: 0, outputTokens: 0, issues: [] };
}
