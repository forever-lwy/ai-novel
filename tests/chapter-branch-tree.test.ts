import { describe, expect, it } from 'vitest';
import { layoutChapterTree, chapterTreeSize } from '../client/branch-tree';
import type { BranchTreeEntry } from '../shared/types';

const line = (id: string, ids: string[], parentBranchId?: string): BranchTreeEntry => ({
  id, projectId: 'project', name: id, revisionId: id, createdAt: '', parentBranchId,
  chapters: ids.map(id => ({ id, title: '同名章节' })),
});

describe('chapter nodes and story line endpoints', () => {
  it('merges fifteen shared chapters and places regenerated sixteenth chapters at the same depth, including old nested branches', () => {
    const prefix = Array.from({ length: 15 }, (_, index) => `chapter-${index + 1}`);
    const branches = [line('main', [...prefix, 'sixteen-original']), line('a', [...prefix, 'sixteen-a'], 'main'), line('b', [...prefix, 'sixteen-b'], 'a')];
    const { nodes } = layoutChapterTree(branches, 'b');
    expect(nodes).toHaveLength(18);
    const fifteenth = nodes.find(node => node.chapter.id === 'chapter-15')!;
    const alternatives = nodes.filter(node => node.depth === 15);
    expect(fifteenth.children).toHaveLength(3);
    expect(alternatives.map(node => node.parent)).toEqual([fifteenth.key, fifteenth.key, fifteenth.key]);
    expect(new Set(alternatives.map(node => node.y)).size).toBe(1);
    expect(alternatives.map(node => node.endings.map(branch => branch.id))).toEqual([['main'], ['a'], ['b']]);
  });

  it('keeps genuine later forks connected to their own chapter, and never merges matching later IDs across different prefixes', () => {
    const { nodes } = layoutChapterTree([line('main', ['one', 'two']), line('a', ['one', 'two-a', 'three']), line('b', ['one', 'two-b', 'three'])], 'a');
    expect(nodes.filter(node => node.chapter.id === 'three')).toHaveLength(2);
    expect(nodes.filter(node => node.chapter.id === 'three').map(node => nodes[node.parent!].chapter.id)).toEqual(['two-a', 'two-b']);
    expect(nodes.find(node => node.chapter.id === 'two-a')?.branchIds).toEqual(['a']);
  });

  it('puts several line names under the same last chapter and leaves room for its continuing children', () => {
    const { nodes } = layoutChapterTree([line('main', ['one', 'two']), line('a', ['one']), line('b', ['one'], 'a')], 'b');
    expect(nodes).toHaveLength(2);
    expect(nodes[0].endings.map(branch => branch.id)).toEqual(['a', 'b']);
    const labelsBottom = nodes[0].y + chapterTreeSize.nodeHeight + 12 + 2 * (chapterTreeSize.endingHeight + chapterTreeSize.endingGap);
    expect(nodes[1].y).toBeGreaterThan(labelsBottom);
  });

  it('uses current-line titles, preserves empty and deleted lines, and ignores cyclic legacy branch metadata', () => {
    const current = line('current', ['one'], 'old'); current.chapters[0].title = '当前标题';
    const old = { ...line('old', ['one'], 'current'), deletedAt: '2026-10-15T00:00:00Z' };
    const result = layoutChapterTree([old, current, line('empty', [])], 'current');
    expect(result.nodes[0].chapter.title).toBe('当前标题');
    expect(result.nodes[0].endings).toEqual([old, current]);
    expect(result.empty.map(branch => branch.id)).toEqual(['empty']);
  });

  it('lays out long and wide chapter trees without recursion or overlapping sibling nodes', () => {
    const prefix = Array.from({ length: 5000 }, (_, index) => `chapter-${index}`);
    const { nodes, width } = layoutChapterTree(Array.from({ length: 25 }, (_, index) => line(`line-${index}`, [...prefix, `ending-${index}`])), 'line-24');
    expect(nodes).toHaveLength(5025); expect(width).toBe(25 * chapterTreeSize.columnWidth);
    const leaves = nodes.filter(node => node.depth === 5000).sort((a, b) => a.x - b.x);
    expect(leaves.every((node, index) => !index || node.x - leaves[index - 1].x > chapterTreeSize.nodeWidth)).toBe(true);
  });
});
