import { useEffect, useRef } from 'react';
import { BookOpen } from 'lucide-react';
import type { BranchTreeEntry } from '../shared/types';
import { chapterTreeSize, layoutChapterTree } from './branch-tree';

export function BranchTree({ branches, mainBranchId, currentBranchId, currentChapterId, disabled, onSelect }: {
  branches: BranchTreeEntry[]; mainBranchId: string; currentBranchId: string; currentChapterId?: string | null;
  disabled: boolean; onSelect: (id: string, chapterId?: string) => void;
}) {
  const viewport = useRef<HTMLElement>(null);
  const { nodes, roots, empty, emptyX, width, height } = layoutChapterTree(branches, currentBranchId);
  const { nodeWidth, nodeHeight } = chapterTreeSize;
  const byId = new Map(branches.map(branch => [branch.id, branch]));
  const currentLine = byId.get(currentBranchId);
  useEffect(() => {
    // The parent dialog opens in its own effect; measure after it becomes visible.
    const frame = requestAnimationFrame(() => {
      const tree = viewport.current; const name = tree?.querySelector<HTMLElement>(`[data-branch-id="${currentBranchId}"]`);
      if (!tree || !name) return;
      const treeBox = tree.getBoundingClientRect(); const nameBox = name.getBoundingClientRect();
      tree.scrollTo({ top: nameBox.bottom - treeBox.top + tree.scrollTop - tree.clientHeight + 32,
        left: nameBox.left - treeBox.left + tree.scrollLeft - (tree.clientWidth - name.offsetWidth) / 2 });
    });
    return () => cancelAnimationFrame(frame);
  }, [currentBranchId, currentLine?.chapters.at(-1)?.id, currentLine?.chapters.length]);
  function endings(lines: BranchTreeEntry[], x: number, y: number) {
    return <div className="branch-tree-endings" style={{ left: x - nodeWidth / 2, top: y, width: nodeWidth }}>
      {lines.map(branch => <button key={branch.id} type="button" className={`branch-tree-name ${branch.id === currentBranchId ? 'selected' : ''} ${branch.deletedAt ? 'is-deleted' : ''}`}
        data-branch-id={branch.id} title={branch.name} aria-label={`切换到故事线 ${branch.name}`} aria-pressed={branch.id === currentBranchId}
        disabled={disabled || !!branch.deletedAt} onClick={() => onSelect(branch.id)}>
        <strong>{branch.name}</strong><span>{branch.id === mainBranchId && <small>主线</small>}{branch.deletedAt && <small>已删除</small>}{branch.id === currentBranchId && <small>当前</small>}</span>
      </button>)}
    </div>;
  }
  return <nav ref={viewport} className="branch-tree" aria-label="故事线分支树" tabIndex={0}>
    <div className="branch-tree-canvas" style={{ width, height }}>
      <svg className="branch-tree-lines" width={width} height={height} aria-hidden="true">
        {roots.map(key => { const node = nodes[key]; return <path key={`root-${key}`} className={node.branchIds.includes(currentBranchId) ? 'selected' : ''} d={`M ${width / 2} 18 V 30 H ${node.x} V ${node.y}`} />; })}
        {empty.length > 0 && <path d={`M ${width / 2} 18 V 30 H ${emptyX} V 62`} />}
        {nodes.filter(node => node.parent !== undefined).map(node => {
          const parent = nodes[node.parent!]; const start = parent.endings.length
            ? `M ${parent.x + nodeWidth / 2} ${parent.y + nodeHeight / 2} H ${parent.x + nodeWidth / 2 + 16}`
            : `M ${parent.x} ${parent.y + nodeHeight}`;
          return <path key={node.key} className={node.branchIds.includes(currentBranchId) ? 'selected' : ''} d={`${start} V ${node.y - 24} H ${node.x} V ${node.y}`} />;
        })}
      </svg>
      <span className="branch-tree-start" style={{ left: width / 2 }}>故事起点</span>
      {nodes.map(node => {
        const available = node.branchIds.filter(id => !byId.get(id)?.deletedAt);
        const branchId = available.includes(currentBranchId) ? currentBranchId : available.includes(mainBranchId) ? mainBranchId : available[0];
        const onCurrentLine = node.branchIds.includes(currentBranchId);
        return <div key={node.key}>
          <button type="button" className={`branch-tree-chapter ${onCurrentLine ? 'on-current-line' : ''} ${onCurrentLine && node.chapter.id === currentChapterId ? 'selected' : ''} ${!branchId ? 'is-deleted' : ''}`}
            data-tree-node-id={node.key} data-parent-node-id={node.parent} data-chapter-id={node.chapter.id}
            style={{ left: node.x - nodeWidth / 2, top: node.y, width: nodeWidth, height: nodeHeight }}
            title={node.chapter.title} aria-label={`打开章节 ${node.chapter.title}`} disabled={disabled || !branchId}
            onClick={() => onSelect(branchId, node.chapter.id)}>
            <BookOpen size={16} /><strong>{node.chapter.title}</strong>
          </button>
          {node.endings.length > 0 && endings(node.endings, node.x, node.y + nodeHeight + 12)}
        </div>;
      })}
      {empty.length > 0 && <><span className="branch-tree-empty" style={{ left: emptyX - nodeWidth / 2, width: nodeWidth }}>尚无章节</span>{endings(empty, emptyX, 76)}</>}
    </div>
  </nav>;
}
