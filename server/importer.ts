import { posix } from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import iconv from 'iconv-lite';
import { decodeHTML } from 'entities';

export interface ImportedChapter { title: string; text: string }
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_TEXT_LENGTH = 20_000_000;

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(Buffer.from(bytes), 'utf16-le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(Buffer.from(bytes), 'utf16-be');
  // Some Windows exports omit the UTF-16 BOM. Only infer it with strong zero-byte evidence.
  const sample = bytes.subarray(0, 4096);
  let evenZeros = 0; let oddZeros = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) oddZeros++; else evenZeros++; }
  if (sample.length > 10 && Math.max(evenZeros, oddZeros) > sample.length / 8) return iconv.decode(Buffer.from(bytes), oddZeros > evenZeros ? 'utf16-le' : 'utf16-be');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return iconv.decode(Buffer.from(bytes), 'gb18030'); }
}

function normalize(text: string): string {
  if (text.length > MAX_TEXT_LENGTH) throw new Error('小说正文超过 2000 万字，请拆分后导入。');
  if (text.includes('\0')) throw new Error('文件包含无法识别的二进制内容，请使用 TXT 或 EPUB 文件。');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

/** Split by standalone chapter headings without repeatedly copying the entire novel. */
export function splitText(text: string): ImportedChapter[] {
  const normalized = normalize(text);
  if (!normalized) throw new Error('文件没有可读取的小说正文。');
  const heading = /^[\t \u3000]*(第[零〇一二三四五六七八九十百千万亿两0-9０-９]{1,24}[章回节卷部集篇][^\n]{0,100}|(?:chapter|book|part)\s+(?:[0-9]+|[ivxlcdm]+)(?:[\s.:：-][^\n]{0,100})?|(?:序章|序言|楔子|引子|前言|尾声|后记|终章|番外)(?:[\s：:、—-][^\n]{0,100})?)[\t \u3000]*$/gim;
  const chapters: ImportedChapter[] = [];
  let start = 0;
  let title = '序章';
  for (const match of normalized.matchAll(heading)) {
    const body = normalized.slice(start, match.index).trim();
    if (body) chapters.push({ title, text: body });
    title = match[1].trim();
    start = match.index + match[0].length;
    if (chapters.length > MAX_ENTRIES) throw new Error('章节数量超过 10000，请调整文件后导入。');
  }
  const body = normalized.slice(start).trim();
  if (body) chapters.push({ title: start === 0 ? '正文' : title, text: body });
  if (!chapters.length) throw new Error('文件只有标题，没有可读取的小说正文。');
  return chapters;
}

function safeArchivePath(name: string): string {
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
    throw new Error('EPUB 包含不安全的文件路径，无法导入。');
  }
  return name;
}

function resolveArchivePath(base: string, href: string): string {
  let path: string;
  try { path = decodeURIComponent(href.split('#')[0].split('?')[0]); } catch { throw new Error('EPUB 中的文件路径编码无效。'); }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/') || path.includes('\\') || path.includes('\0')) throw new Error('EPUB 引用了外部或不安全的正文路径。');
  const joined = posix.normalize(posix.join(base, path));
  safeArchivePath(joined);
  return joined;
}

function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

function parseXml(text: string): any {
  if (/<!ENTITY\b/i.test(text)) throw new Error('EPUB 的 XML 包含不支持的自定义实体。');
  if (XMLValidator.validate(text) !== true) throw new Error('EPUB 的目录文件不是有效 XML。');
  return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: true, parseTagValue: false, parseAttributeValue: false }).parse(text);
}

function decodeEntities(text: string): string {
  return decodeHTML(text).replace(/\u00a0/g, ' ');
}

function htmlText(html: string): { title: string; text: string } {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|nav)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const heading = clean.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]\s*>/i)?.[1];
  const titleElement = clean.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const title = decodeEntities((heading ?? titleElement ?? '').replace(/<[^>]*>/g, '')).trim();
  let body = clean.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? clean.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '');
  body = body.replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|h[1-6]|li|blockquote|section|article|tr|pre)\s*>/gi, '\n\n').replace(/<[^>]*>/g, '');
  // HTML source indentation is not a paragraph boundary; block elements are.
  body = decodeEntities(body).replace(/[\t ]+\n/g, '\n').replace(/\n[\t ]+/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { title, text: normalize(body) };
}

function parseEpub(bytes: Uint8Array): ImportedChapter[] {
  let total = 0; let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (entry) => {
      safeArchivePath(entry.name);
      count++; total += entry.originalSize;
      if (count > MAX_ENTRIES || entry.originalSize > MAX_ENTRY_BYTES || total > MAX_ARCHIVE_BYTES) throw new Error('EPUB 解压后过大或文件过多，请拆分后导入。');
      // Images/fonts are deliberately not inflated; all entries still count toward limits.
      return /\.(?:xml|opf|xhtml|html|htm)$/i.test(entry.name);
    } });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EPUB')) throw error;
    throw new Error('无法读取 EPUB 压缩包，文件可能已损坏或受到加密保护。');
  }
  const read = (path: string) => {
    const content = files[path];
    if (!content) throw new Error('EPUB 缺少目录或正文文件。');
    return decodeText(content);
  };
  if (files['META-INF/encryption.xml'] && /EncryptedData/i.test(read('META-INF/encryption.xml'))) throw new Error('此 EPUB 包含加密资源，请提供不带加密的版本。');
  const container = parseXml(read('META-INF/container.xml'));
  const rootfiles = list<any>(container.container?.rootfiles?.rootfile);
  const rootfile = rootfiles.find((entry) => entry['@_media-type'] === 'application/oebps-package+xml') ?? rootfiles[0];
  if (typeof rootfile?.['@_full-path'] !== 'string') throw new Error('EPUB 没有有效的正文目录。');
  const opfPath = resolveArchivePath('', rootfile['@_full-path']);
  const document = parseXml(read(opfPath))?.package;
  if (!document?.manifest || !document?.spine) throw new Error('EPUB 缺少正文清单或阅读顺序。');
  const manifest = new Map<string, any>(list<any>(document.manifest.item).map((item) => [item['@_id'], item]));
  const chapters: ImportedChapter[] = [];
  let textLength = 0;
  for (const ref of list<any>(document.spine.itemref)) {
    if (ref['@_linear'] === 'no') continue;
    const item = manifest.get(ref['@_idref']);
    if (!item) throw new Error('EPUB 的阅读顺序引用了不存在的正文。');
    if (String(item['@_properties'] ?? '').split(/\s+/).includes('nav')) continue;
    if (!['application/xhtml+xml', 'text/html'].includes(item['@_media-type'])) continue;
    if (typeof item['@_href'] !== 'string') throw new Error('EPUB 的正文路径无效。');
    const page = htmlText(read(resolveArchivePath(posix.dirname(opfPath), item['@_href'])));
    if (!page.text) continue;
    textLength += page.text.length;
    if (textLength > MAX_TEXT_LENGTH) throw new Error('小说正文超过 2000 万字，请拆分后导入。');
    chapters.push({ title: page.title || `第 ${chapters.length + 1} 章`, text: page.text });
  }
  if (!chapters.length) throw new Error('EPUB 没有可读取的小说正文。');
  return chapters;
}

export function parseNovel(filename: string, bytes: Uint8Array): { format: 'txt' | 'epub'; chapters: ImportedChapter[] } {
  if (!bytes.length) throw new Error('上传的文件是空文件。');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('上传文件超过 32 MiB，请拆分后导入。');
  const extension = filename.toLowerCase().split('.').at(-1);
  if (extension === 'txt') return { format: 'txt', chapters: splitText(decodeText(bytes)) };
  if (extension === 'epub') return { format: 'epub', chapters: parseEpub(bytes) };
  throw new Error('目前只支持 TXT 和 EPUB 文件。');
}
