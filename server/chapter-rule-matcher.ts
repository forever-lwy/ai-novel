import { Worker } from 'node:worker_threads';
import type { ChapterRuleInput } from '../shared/chapter-rules.js';
import { MAX_CHAPTER_HEADINGS, MAX_HEADING_LENGTH } from '../shared/chapter-rules.js';
import type { ChapterHeading } from './importer.js';
import { HttpError } from './store.js';

// Keep the worker self-contained so both tsx development and compiled Node use it.
// No custom pattern is executed on the HTTP server's event loop.
const workerSource = `
const { parentPort, workerData: data } = require('node:worker_threads');
try {
  const regex = new RegExp('^(?:' + data.pattern + ')$', data.flags);
  if (regex.test('')) throw new Error('规则不能匹配空行。');
  const headings = [];
  let index = 0;
  while (index < data.text.length) {
    const newline = data.text.indexOf('\\n', index);
    const end = newline < 0 ? data.text.length : newline;
    if (end - index <= data.maxLength + 100) {
      const title = data.text.slice(index, end).trim();
      if (title && title.length <= data.maxLength && regex.test(title)) {
        headings.push({ index, end, title });
        if (headings.length > data.maxHeadings) throw new Error('章节标题超过 10000，请调整分章规则。');
      }
    }
    index = end + 1;
  }
  parentPort.postMessage({ headings });
} catch (error) { parentPort.postMessage({ error: error.message }); }
`;

let activeWorkers = 0;
export async function matchChapterHeadings(text: string, rule: Pick<ChapterRuleInput, 'pattern' | 'flags'>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ChapterHeading[]> {
  if (options.signal?.aborted) throw new HttpError('分章操作已取消。', 409);
  if (activeWorkers >= 4) throw new HttpError('正在处理其他分章规则，请稍后重试。', 429);
  activeWorkers++;
  try {
    return await new Promise<ChapterHeading[]>((resolve, reject) => {
      const worker = new Worker(workerSource, { eval: true, workerData: { text, ...rule, maxLength: MAX_HEADING_LENGTH, maxHeadings: MAX_CHAPTER_HEADINGS }, resourceLimits: { maxOldGenerationSizeMb: 192 } });
      let settled = false;
      const finish = (error?: Error, headings?: ChapterHeading[]) => {
        if (settled) return; settled = true;
        clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
        void worker.terminate();
        if (error) reject(error); else resolve(headings!);
      };
      const abort = () => finish(new HttpError('分章操作已取消。', 409));
      const timer = setTimeout(() => finish(new HttpError('分章规则运行超时，请简化表达式后重试。')), options.timeoutMs ?? 4000);
      options.signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', result => finish(result.error ? new HttpError(result.error) : undefined, result.headings));
      worker.once('error', () => finish(new HttpError('分章规则无法完成，请简化表达式后重试。')));
      worker.once('exit', () => { if (!settled) finish(new HttpError('分章规则处理已中断。')); });
    });
  } finally { activeWorkers--; }
}
