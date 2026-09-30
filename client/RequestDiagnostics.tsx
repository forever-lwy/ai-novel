import { useState } from 'react';
import { Copy, Download, Info } from 'lucide-react';
import type { CapturedModelResponse, ModelTransportDiagnostics } from '../shared/types';
import { countText, dateText } from './api';
import { Notice } from './ui';

const protocolNames = { 'openai-chat': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', gemini: 'Google Gemini', claude: 'Claude Messages' };
const transportNames: Record<ModelTransportDiagnostics['transport'], string> = { http: '收到 HTTP 响应', network_error: '连接错误', timeout: '等待超时', cancelled: '主动取消', interrupted: '响应接收中断' };
const outcomeNames = { completed: '已返回正文', blocked: '模型拦截', truncated: '响应不完整', empty: '没有模型正文', error: '服务错误' };

function formatJSON(text: string) { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } }
function outputLimit(capture: CapturedModelResponse): string {
  if (!capture.request) return '未记录';
  try {
    const body = JSON.parse(capture.request.body);
    const value = body.max_completion_tokens ?? body.max_output_tokens ?? body.max_tokens ?? body.generationConfig?.maxOutputTokens;
    return typeof value === 'number' ? `${value.toLocaleString('zh-CN')} tokens` : '请求中未提供';
  } catch { return '请求体无法解析，请查看原始内容'; }
}
function download(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: filename.endsWith('.json') ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function RequestDiagnostics({ capture, filename = 'model-request-diagnostics', showResponse = false }: { capture?: CapturedModelResponse; filename?: string; showResponse?: boolean }) {
  const [feedback, setFeedback] = useState(''); const [error, setError] = useState('');
  const request = capture?.request; const diagnostics = capture?.diagnostics;
  const json = JSON.stringify({ request, diagnostics, httpStatus: capture?.httpStatus, incomplete: capture?.incomplete }, null, 2);
  async function copy(text: string) {
    setError('');
    try { if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持直接复制，请下载后查看，或选中文本复制。'); await navigator.clipboard.writeText(text); setFeedback('已复制。'); }
    catch (e) { setError((e as Error).message); }
  }
  return <details className="output-fold request-diagnostics">
    <summary>实际请求与连接诊断{capture?.httpStatus !== undefined ? ` · HTTP ${capture.httpStatus}` : diagnostics ? ` · ${transportNames[diagnostics.transport]}` : ''}</summary>
    <div className="request-diagnostics-body">
      {!request ? <p className="hint">这条记录没有保存当时的请求快照，无法从现在的设置还原。后续请求会记录实际发送的参数。</p> : <>
        <p className="request-privacy-note"><Info size={14} />这是当次发送的请求，地址和请求头已在服务端脱敏；正文可能含作者素材，不属于普通阅读资料。</p>
        <dl className="request-metadata">
          <div><dt>协议</dt><dd>{protocolNames[request.protocol]}</dd></div><div><dt>模型</dt><dd>{request.model}</dd></div>
          <div><dt>请求开始</dt><dd>{dateText(request.startedAt)}</dd></div><div><dt>最终输出上限</dt><dd>{outputLimit(capture!)}</dd></div>
          <div><dt>超时设置</dt><dd>{request.timeoutMs / 1000} 秒</dd></div><div><dt>实际返回方式</dt><dd>{request.stream ? '流式' : '非流式'}</dd></div>
        </dl>
        <label className="request-url-label">实际请求地址<pre>{request.method} {request.url}</pre></label>
      </>}
      {diagnostics && <dl className="request-metadata transport-metadata"><div><dt>传输结果</dt><dd>{transportNames[diagnostics.transport]}</dd></div><div><dt>耗时</dt><dd>{(diagnostics.elapsedMs / 1000).toFixed(2)} 秒</dd></div><div><dt>响应大小</dt><dd>{countText(diagnostics.responseBytes)} 字节</dd></div>{capture?.httpStatus !== undefined && <div><dt>HTTP 状态</dt><dd>{capture.httpStatus}</dd></div>}{diagnostics.errorCode && <div><dt>错误代码</dt><dd>{diagnostics.errorCode}</dd></div>}{capture?.incomplete && <div><dt>完整性</dt><dd>响应可能不完整</dd></div>}</dl>}
      {diagnostics && (diagnostics.modelOutcome || diagnostics.finishReason || diagnostics.promptBlockReason) && <dl className="request-metadata" aria-label="模型响应反馈">{diagnostics.modelOutcome && <div><dt>模型结果</dt><dd>{outcomeNames[diagnostics.modelOutcome]}</dd></div>}{diagnostics.finishReason && <div><dt>模型结束原因</dt><dd>{diagnostics.finishReason}</dd></div>}{diagnostics.promptBlockReason && <div><dt>输入拦截原因</dt><dd>{diagnostics.promptBlockReason}</dd></div>}</dl>}
      {capture?.httpStatus !== undefined && capture.httpStatus >= 400 && !diagnostics?.finishReason && !diagnostics?.promptBlockReason && <p className="hint">网关错误没有提供模型结束或拦截反馈。仅凭 HTTP 错误码无法确定是否与内容有关，需要核对网关保存的出站响应。</p>}
      {(request || diagnostics) && <div className="row wrap end"><button type="button" className="text-button" onClick={() => void copy(json)}><Copy size={13} />复制请求与诊断</button><button type="button" className="text-button" onClick={() => download(json, `${filename}.json`)}><Download size={13} />下载请求与诊断</button></div>}
      {request && <>
        <details className="request-inner-fold"><summary>实际请求头（已脱敏）</summary><pre aria-label="实际请求头">{JSON.stringify(request.headers, null, 2)}</pre></details>
        <details className="request-inner-fold"><summary>实际请求体（含提示词）</summary><div className="row wrap end"><button type="button" className="text-button" onClick={() => void copy(request.body)}><Copy size={13} />复制实际请求体</button><button type="button" className="text-button" onClick={() => download(request.body, `${filename}-body.json`)}><Download size={13} />下载实际请求体</button></div><pre aria-label="实际请求体">{formatJSON(request.body)}</pre></details>
      </>}
      {diagnostics && <details className="request-inner-fold"><summary>响应头（已脱敏）</summary><pre aria-label="响应头">{JSON.stringify(diagnostics.responseHeaders, null, 2)}</pre></details>}
      {showResponse && capture && <details className="request-inner-fold"><summary>本次测试原始响应（只读）</summary><div className="row wrap end"><button type="button" className="text-button" onClick={() => void copy(capture.rawResponse)}><Copy size={13} />复制测试响应</button><button type="button" className="text-button" onClick={() => download(capture.rawResponse, `${filename}-response.txt`)}><Download size={13} />下载测试响应</button></div><pre aria-label="本次测试原始响应">{capture.rawResponse || '未收到响应正文。'}</pre></details>}
      {feedback && <p className="hint" aria-live="polite">{feedback}</p>}{error && <Notice error={error} />}
    </div>
  </details>;
}
