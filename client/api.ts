export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  // Bodyless actions (retry, cancel, logout) must not advertise an empty JSON body.
  if (typeof options.body === 'string' && options.body.length > 0 && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error || `请求失败（${response.status}）`, response.status);
  return data as T;
}

export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });

export const modeNames = { original: '原创', continuation: '续写', fanfiction: '同人', rewrite: '改写' };
export const kindNames = { character: '人物', faction: '组织势力', location: '地点', item: '物品', ability: '能力体系', rule: '世界规则', event: '剧情事件' };
export const statusNames = { queued: '等待中', running: '进行中', paused: '已暂停', failed: '失败', completed: '已完成', cancelled: '已取消', stale: '版本已变化' };
export const jobNames = { import: '整理原作', extract: '更新世界资料', generate: '创作正文', plan: '规划大纲' };
export const dateText = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const countText = (value: number) => value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : value.toLocaleString('zh-CN');
