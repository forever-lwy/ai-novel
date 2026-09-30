import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import iconv from 'iconv-lite';
import { parseNovel, splitText } from '../server/importer.js';

const novel = '前言内容。\r\n\r\n第一章 入城\r\n林舟望向城门。\r\n\r\n守卫抬起头。\r\n\r\n第2章 旧事\r\n她记起多年前的夏天。';
const expected = [{ title: '序章', text: '前言内容。' }, { title: '第一章 入城', text: '林舟望向城门。\n\n守卫抬起头。' }, { title: '第2章 旧事', text: '她记起多年前的夏天。' }];

function epub(extra: Record<string, Uint8Array> = {}, opf?: string) {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/book.opf': strToU8(opf ?? '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="two" href="Text/two.xhtml" media-type="application/xhtml+xml"/><item id="one" href="Text/one.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="nav"/><itemref idref="one"/><itemref idref="two"/></spine></package>'),
    'OEBPS/nav.xhtml': strToU8('<html><body><nav>这不是正文</nav></body></html>'),
    'OEBPS/Text/two.xhtml': strToU8('<html><head><title>第二章</title></head><body><h1>第二章 夜谈</h1><p>故事继续。</p></body></html>'),
    'OEBPS/Text/one.xhtml': strToU8('<html><head><title>第一章</title><style>.secret { color:red }</style><script>secret</script></head><body><nav>导航文字</nav><h1>第一章 入城</h1><p>林舟说：&ldquo;你好&nbsp;&amp;&nbsp;再见&rdquo;。</p><p>她看到了&#x57CE;&#38376;。<br/>风吹来。</p><script>alert(1)</script></body></html>'),
    ...extra,
  });
}

describe('TXT import', () => {
  it.each(['utf8', 'utf16-le', 'utf16-be', 'gb18030'])('decodes %s while preserving paragraphs', (encoding) => {
    const bytes = iconv.encode(novel, encoding, { addBOM: encoding.startsWith('utf') });
    expect(parseNovel('世界.TXT', bytes)).toEqual({ format: 'txt', chapters: expected });
  });

  it('recognizes English headings and keeps untitled prose', () => {
    expect(splitText('Chapter I: Arrival\n\nA traveler arrived.\n\nChapter 2 - Dawn\nThe sun rose.')).toEqual([{ title: 'Chapter I: Arrival', text: 'A traveler arrived.' }, { title: 'Chapter 2 - Dawn', text: 'The sun rose.' }]);
    expect(splitText('没有标题的故事。\n\n第二段。')).toEqual([{ title: '正文', text: '没有标题的故事。\n\n第二段。' }]);
  });

  it('handles a million-character book as separate chapters without losing paragraphs', () => {
    const body = '林舟沿着长街走进古老的城池。\n\n'.repeat(700);
    const source = Array.from({ length: 100 }, (_, i) => `第${i + 1}章\n${body}`).join('\n');
    expect(source.length).toBeGreaterThan(1_000_000);
    const result = parseNovel('long.txt', strToU8(source));
    expect(result.chapters).toHaveLength(100);
    expect(result.chapters[99]).toEqual({ title: '第100章', text: body.trim() });
  });

  it('rejects empty, unsupported, binary and oversized files', () => {
    expect(() => parseNovel('empty.txt', new Uint8Array())).toThrow('空文件');
    expect(() => parseNovel('blank.txt', strToU8(' \n\t '))).toThrow('没有可读取');
    expect(() => parseNovel('book.pdf', strToU8('book'))).toThrow('只支持');
    expect(() => parseNovel('binary.txt', new Uint8Array([1, 2, 0, 4]))).toThrow('二进制');
    expect(() => parseNovel('huge.txt', new Uint8Array(32 * 1024 * 1024 + 1))).toThrow('32 MiB');
  });
});

describe('EPUB import', () => {
  it('follows spine order, strips executable/navigation elements and decodes entities', () => {
    const result = parseNovel('book.epub', epub());
    expect(result.format).toBe('epub');
    expect(result.chapters.map((chapter) => chapter.title)).toEqual(['第一章 入城', '第二章 夜谈']);
    expect(result.chapters[0].text).toBe('第一章 入城\n\n林舟说：“你好 & 再见”。\n\n她看到了城门。\n风吹来。');
    expect(result.chapters[0].text).not.toMatch(/导航|script|secret|alert/);
  });

  it('handles namespace prefixes and relative paths contained within the archive', () => {
    const opf = '<opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:manifest><opf:item id="one" href="Text/../Text/one.xhtml#start" media-type="application/xhtml+xml"/></opf:manifest><opf:spine><opf:itemref idref="one"/></opf:spine></opf:package>';
    expect(parseNovel('book.epub', epub({}, opf)).chapters).toHaveLength(1);
  });

  it('decodes the full set of HTML entities and UTF-16 XML chapter text', () => {
    const archive = epub({ 'OEBPS/Text/one.xhtml': iconv.encode('<html><head><title>Caf&eacute;</title></head><body><p>&Eacute;lise &amp; &#x6797;&#33311; &NotEqualTilde;</p></body></html>', 'utf16-le', { addBOM: true }) });
    expect(parseNovel('entities.epub', archive).chapters[0]).toEqual({ title: 'Café', text: 'Élise & 林舟 ≂̸' });
  });

  it('does not use manifest order or load non-linear appendices', () => {
    const opf = '<package><manifest><item id="two" href="Text/two.xhtml" media-type="application/xhtml+xml"/><item id="one" href="Text/one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two" linear="no"/></spine></package>';
    expect(parseNovel('book.epub', epub({}, opf)).chapters).toHaveLength(1);
  });

  it('refuses archive traversal, external references and root escapes', () => {
    expect(() => parseNovel('book.epub', epub({ '../outside.txt': strToU8('private') }))).toThrow('不安全');
    for (const href of ['https://example.com/file.xhtml', '../../outside.xhtml', '%2e%2e/%2e%2e/outside.xhtml']) {
      const opf = `<package><manifest><item id="one" href="${href}" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>`;
      expect(() => parseNovel('book.epub', epub({}, opf))).toThrow(/外部|不安全/);
    }
  });

  it('rejects a decompression bomb before inflating its body', () => {
    const archive = epub({ 'OEBPS/bomb.xhtml': new Uint8Array(24 * 1024 * 1024 + 1) });
    expect(archive.byteLength).toBeLessThan(100_000);
    expect(() => parseNovel('book.epub', archive)).toThrow('解压后过大');
  });

  it('counts skipped binary resources toward the total size limit before decompression', () => {
    const archive = epub(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`OEBPS/image${i}.bin`, strToU8('x')])));
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    for (let i = 0; i < archive.length - 46; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(i + 28, true);
      const name = new TextDecoder().decode(archive.subarray(i + 46, i + 46 + nameLength));
      if (name.endsWith('.bin')) view.setUint32(i + 24, 23 * 1024 * 1024, true);
    }
    expect(() => parseNovel('book.epub', archive)).toThrow('解压后过大');
  });

  it('reports broken packages and rejects encrypted resources and custom XML entities', () => {
    expect(() => parseNovel('broken.epub', strToU8('not zip'))).toThrow('无法读取 EPUB');
    expect(() => parseNovel('missing.epub', zipSync({ 'book.txt': strToU8('story') }))).toThrow('缺少');
    expect(() => parseNovel('encrypted.epub', epub({ 'META-INF/encryption.xml': strToU8('<encryption><EncryptedData/></encryption>') }))).toThrow('加密');
    const opf = '<!DOCTYPE package [<!ENTITY x "expanded">]><package><manifest/><spine/></package>';
    expect(() => parseNovel('entity.epub', epub({}, opf))).toThrow('自定义实体');
  });
});
