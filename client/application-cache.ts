import type { BranchView, Chapter, StoryImage } from '../shared/types';
import { ImageContentCache } from './image-cache';
import { PersistentCache } from './persistent-cache';
import { ResourceCache } from './workspace-cache';

function projectCache(persistent: PersistentCache, project: string) {
  return {
    chapters: new ResourceCache<Chapter>(24, 8 * 1024 * 1024, persistent.storage(project, 'chapters')),
    views: new ResourceCache<BranchView>(8, 16 * 1024 * 1024, persistent.storage(project, 'views')),
    images: new ResourceCache<StoryImage[]>(8, 4 * 1024 * 1024),
    positions: new ResourceCache<number>(24, 4096),
    lastChapter: new ResourceCache<string>(16, 4096, persistent.storage(project, 'last-chapter')),
  };
}
export type ProjectCache = ReturnType<typeof projectCache>;
export function clearStoredCaches() { return new PersistentCache('').remove(undefined, true); }

export class ApplicationCache {
  readonly pixels = new ImageContentCache();
  private persistent: PersistentCache;
  private projects = new Map<string, ProjectCache>();
  constructor(readonly scope: string) {
    this.persistent = new PersistentCache(scope);
    void this.persistent.remove(undefined, true);
  }
  project(id: string) {
    let cache = this.projects.get(id);
    if (!cache) cache = projectCache(this.persistent, id);
    this.projects.delete(id); this.projects.set(id, cache);
    while (this.projects.size > 3) {
      const oldest = this.projects.keys().next().value!;
      this.projects.get(oldest) && Object.values(this.projects.get(oldest)!).forEach(value => value.clear());
      this.projects.delete(oldest);
    }
    return cache;
  }
  async forgetProject(id: string) {
    const cache = this.projects.get(id);
    if (cache) Object.values(cache).forEach(value => value.clear());
    this.projects.delete(id);
    this.pixels.clear();
    await this.persistent.remove(id);
  }
  async clear() {
    for (const cache of this.projects.values()) Object.values(cache).forEach(value => value.clear());
    this.projects.clear(); this.pixels.clear();
    await this.persistent.remove();
  }
}
