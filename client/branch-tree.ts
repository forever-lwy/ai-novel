import type { BranchTreeEntry } from '../shared/types';

export interface ChapterTreeNode {
  key: number; chapter: BranchTreeEntry['chapters'][number]; parent?: number; children: number[];
  branchIds: string[]; endings: BranchTreeEntry[]; depth: number; x: number; y: number; width: number;
}
export const chapterTreeSize = { nodeWidth: 180, nodeHeight: 64, columnWidth: 220, endingHeight: 44, endingGap: 8 };

/** Merge immutable chapter IDs only when their entire preceding path is shared. */
export function layoutChapterTree(branches: BranchTreeEntry[], currentBranchId: string) {
  const nodes: ChapterTreeNode[] = []; const roots: number[] = []; const empty: BranchTreeEntry[] = [];
  const children = new Map<number | undefined, Map<string, number>>();
  for (const branch of branches) {
    let parent: number | undefined;
    for (const [depth, chapter] of branch.chapters.entries()) {
      let siblings = children.get(parent);
      if (!siblings) { siblings = new Map(); children.set(parent, siblings); }
      let key = siblings.get(chapter.id);
      if (key === undefined) {
        key = nodes.length; siblings.set(chapter.id, key);
        nodes.push({ key, chapter, parent, children: [], branchIds: [], endings: [], depth, x: 0, y: 0, width: 0 });
        if (parent === undefined) roots.push(key); else nodes[parent].children.push(key);
      }
      const node = nodes[key]; node.branchIds.push(branch.id);
      if (branch.id === currentBranchId) node.chapter = chapter;
      parent = key;
    }
    if (parent === undefined) empty.push(branch); else nodes[parent].endings.push(branch);
  }
  const { columnWidth, nodeHeight, endingHeight, endingGap } = chapterTreeSize;
  const rowEndings: number[] = [];
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    node.width = Math.max(columnWidth, node.children.reduce((width, child) => width + nodes[child].width, 0));
    rowEndings[node.depth] = Math.max(rowEndings[node.depth] || 0, node.endings.length);
  }
  const rowY: number[] = []; let height = 44;
  for (let depth = 0; depth < rowEndings.length; depth++) {
    rowY[depth] = height;
    height += nodeHeight + 56 + (rowEndings[depth] ? 12 + rowEndings[depth] * (endingHeight + endingGap) : 0);
  }
  const left = new Map<number, number>(); let width = 0;
  for (const root of roots) { left.set(root, width); width += nodes[root].width; }
  const emptyX = width + columnWidth / 2;
  if (empty.length) { width += columnWidth; height = Math.max(height, 76 + empty.length * (endingHeight + endingGap)); }
  for (const node of nodes) {
    let start = left.get(node.key)!;
    node.x = start + node.width / 2; node.y = rowY[node.depth];
    for (const child of node.children) { left.set(child, start); start += nodes[child].width; }
  }
  return { nodes, roots, empty, emptyX, width: Math.max(columnWidth, width), height: Math.max(140, height) };
}
