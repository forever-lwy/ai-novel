import { GitBranch } from 'lucide-react';
import type { Branch } from '../shared/types';

export function BranchTree({ branches, mainBranchId, currentBranchId, disabled, onSelect, compact = false }: {
  branches: Branch[]; mainBranchId: string; currentBranchId: string; disabled: boolean; onSelect: (id: string) => void; compact?: boolean;
}) {
  const byId = new Map(branches.map(branch => [branch.id, branch]));
  const children = new Map<string, Branch[]>();
  for (const branch of branches) if (branch.parentBranchId && byId.has(branch.parentBranchId)) {
    const siblings = children.get(branch.parentBranchId) ?? []; siblings.push(branch); children.set(branch.parentBranchId, siblings);
  }
  const seen = new Set<string>();
  function node(branch: Branch) {
    if (seen.has(branch.id)) return null; seen.add(branch.id);
    const descendants = children.get(branch.id) ?? [];
    const selected = branch.id === currentBranchId;
    const parent = branch.parentBranchId ? byId.get(branch.parentBranchId) : undefined;
    const start = branch.forkChapterId ? `${branch.forkChapterTitle || '已保存章节'} · 章末` : branch.forkChapterTitle || '起点未记录';
    return <li key={branch.id} className="branch-tree-item">
      <button type="button" className={`branch-tree-node ${selected ? 'selected' : ''} ${branch.deletedAt ? 'is-deleted' : ''}`} data-branch-id={branch.id}
        aria-label={`切换到故事线 ${branch.name}`} aria-pressed={selected} disabled={disabled || !!branch.deletedAt}
        onClick={() => onSelect(branch.id)}>
        <GitBranch size={compact ? 13 : 16} />
        <span className="branch-tree-copy"><strong>{branch.name}</strong><small>{branch.id === mainBranchId ? '故事起点' : start}{!compact && branch.parentBranchId ? ` · 来源：${parent?.name || '来源分支已删除'}` : ''}</small></span>
        <span className="branch-tree-badges">{branch.id === mainBranchId && <span>主线</span>}{branch.deletedAt && <span>已删除</span>}{selected && <span className="branch-tree-current">当前</span>}</span>
      </button>
      {descendants.length > 0 && <ul className="branch-tree-children">{descendants.map(node)}</ul>}
    </li>;
  }
  const roots = branches.filter(branch => !branch.parentBranchId || !byId.has(branch.parentBranchId));
  const nodes = roots.map(node);
  // Legacy backups can contain a cycle; keep every line reachable without recursion loops.
  for (const branch of branches) if (!seen.has(branch.id)) nodes.push(node(branch));
  return <nav className={`branch-tree ${compact ? 'branch-tree-compact' : ''}`} aria-label="故事线分支树"><ul className="branch-tree-roots">{nodes}</ul></nav>;
}
