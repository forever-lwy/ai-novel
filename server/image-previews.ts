import sharp from 'sharp';
import type { ImageContent } from './image-store.js';

/** Disposable derived pixels. Originals and backups are never rewritten. */
export class ImagePreviews {
  private entries = new Map<string, { ready: Promise<ImageContent>; bytes: number }>();
  private workers = 0;
  private waiting: (() => void)[] = [];

  async get(key: string, source: () => ImageContent): Promise<ImageContent> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key); this.entries.set(key, cached);
      return cached.ready;
    }
    const entry = { ready: this.create(source), bytes: 0 };
    entry.ready = entry.ready.then(content => {
      entry.bytes = content.bytes.byteLength;
      let bytes = [...this.entries.values()].reduce((total, item) => total + item.bytes, 0);
      for (const [id, item] of this.entries) {
        if (this.entries.size <= 256 && bytes <= 32 * 1024 * 1024) break;
        if (item.bytes) { this.entries.delete(id); bytes -= item.bytes; }
      }
      return content;
    }).catch(error => { this.entries.delete(key); throw error; });
    this.entries.set(key, entry);
    return entry.ready;
  }

  private async create(source: () => ImageContent): Promise<ImageContent> {
    if (this.workers >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.workers++;
    try {
      const original = source();
      const bytes = await sharp(original.bytes, { limitInputPixels: 64 * 1024 * 1024 })
        .rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78, effort: 3 }).toBuffer().catch(() => {
          throw Object.assign(new Error('无法生成图片预览，请查看原图'), { statusCode: 422 });
        });
      return { bytes, mimeType: 'image/webp' };
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.workers--;
    }
  }
}
