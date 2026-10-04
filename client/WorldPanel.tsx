import { useState } from 'react';
import { Users, Plus, Search, LockKeyhole, FileText, Pencil, Link2, MapPin, EyeOff, Trash2 } from 'lucide-react';
import type { Citation, Entity, Fact, KnowledgeKind, Relation } from '../shared/types';
import { kindNames } from './api';
import { Empty, Modal, Notice } from './ui';

export function WorldPanel({ entities, relations, author, busy, onSave, onMerge, onCitation, revisionId, error }: { revisionId: string; error: string; entities: Entity[]; relations: Relation[]; author: boolean; busy: boolean; onSave: (entity: Entity, revisionId: string) => Promise<boolean>; onMerge: (fromId: string, toId: string, revisionId: string) => Promise<boolean>; onCitation: (citation: Citation) => void }) {
  const [filter, setFilter] = useState<KnowledgeKind | 'all'>('all'); const [search, setSearch] = useState(''); const [editing, setEditing] = useState<Entity | null>(null); const [merging, setMerging] = useState<Entity | null>(null); const [target, setTarget] = useState(''); const [editRevision, setEditRevision] = useState(revisionId); const [mergeRevision, setMergeRevision] = useState(revisionId);
  const [detailId, setDetailId] = useState<string | null>(null);
  const available = entities.filter(e => !e.mergedInto); const filtered = available.filter(e => (filter === 'all' || e.kind === filter) && [e.name, ...e.aliases, e.description].join(' ').toLowerCase().includes(search.toLowerCase()));
  const detail = available.find(entity => entity.id === detailId);
  const edit = (entity: Entity) => { setDetailId(null); setEditRevision(revisionId); setEditing({ ...structuredClone(entity), locked: true }); };
  const merge = (entity: Entity) => { setDetailId(null); setMerging(entity); setMergeRevision(revisionId); setTarget(''); };
  const showCitation = (citation: Citation) => { setDetailId(null); onCitation(citation); };
  const newEntity = () => { setEditRevision(revisionId); setEditing({ id: crypto.randomUUID(), kind: 'character', name: '', nameStatus: 'confirmed', isMain: false, aliases: [], description: '', visibility: 'public', locked: true, facts: [] }); };
  return <section className="data-panel"><div className="panel-heading"><div><span className="eyebrow">WORLD ARCHIVE</span><h2>世界资料</h2><p>维护人物身份、血统、能力与性格等资料；经历只记录重大事件，普通经过保留在剧情摘要中。</p></div>{author && <button className="button primary small" onClick={newEntity}><Plus size={15} />新增资料</button>}</div>
    <div className="world-tools"><div className="filter-chips"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 {available.length}</button>{Object.entries(kindNames).map(([key, name]) => <button className={filter === key ? 'active' : ''} key={key} onClick={() => setFilter(key as KnowledgeKind)}>{name} <span>{available.filter(e => e.kind === key).length}</span></button>)}</div><label className="search-input"><Search size={16} /><input aria-label="查找世界资料" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索名字、别名、资料…" /></label></div>
    {!filtered.length ? <Empty icon={<Users size={30} />} title={available.length ? '没有找到匹配的资料' : '世界还在等待被发现'}>{available.length ? '试试其他名字，或切换资料分类。' : '导入并整理小说，或写下第一章。人物、地点与故事事件会在这里逐渐汇集。'}</Empty> : <div className="entity-grid">{filtered.map(entity => {
      const connections = relations.filter(relation => relation.fromId === entity.id || relation.toId === entity.id);
      const citation = entity.facts.find(fact => fact.citation)?.citation;
      return <article className="entity-card" key={entity.id} onClick={event => { if (!(event.target as Element).closest('button')) setDetailId(entity.id); }}>
        <div className="row between"><span className={`entity-type type-${entity.kind}`}>{kindNames[entity.kind]}{entity.kind === 'character' && entity.isMain ? ' · 主要角色' : ''}</span><div className="row">{entity.locked && <span title="用户锁定的资料"><LockKeyhole size={13} /></span>}{entity.visibility === 'secret' && <span title="作者秘密"><EyeOff size={14} /></span>}{author && <><button className="icon-button" title="编辑资料" aria-label={`编辑 ${entity.name}`} onClick={() => edit(entity)}><Pencil size={15} /></button><button className="icon-button" title="合并重复资料" aria-label={`合并 ${entity.name}`} onClick={() => merge(entity)}><Link2 size={15} /></button></>}</div></div>
        <div className="entity-preview"><h3><button className="entity-name-button" onClick={() => setDetailId(entity.id)} title={entity.name}>{entity.name}</button></h3>{entity.aliases.length > 0 && <div className="alias-list" title={entity.aliases.join('、')}>{entity.aliases.map(alias => <span key={alias}>{alias}</span>)}</div>}<p className="entity-description">{entity.description || '暂无描述'}</p>{entity.facts.length > 0 && <ul className="entity-fact-preview">{entity.facts.slice(0, 2).map(fact => <li key={fact.id}>{fact.text}</li>)}</ul>}</div>
        <div className="entity-card-footer"><span>{entity.facts.length} 条事实{connections.length > 0 && ` · ${connections.length} 项关联`}</span>{citation && <button className="citation" onClick={() => showCitation(citation)} title={citation.quote}><FileText size={12} />原文第 {citation.paragraph} 段</button>}<button className="text-button" aria-label={`查看 ${entity.name} 的详细资料`} onClick={() => setDetailId(entity.id)}>查看详情</button></div>
      </article>;
    })}</div>}
    {detail && <Modal title={`世界资料 · ${detail.name}`} wide onClose={() => setDetailId(null)}><div className="entity-detail"><div className="row between"><span className={`entity-type type-${detail.kind}`}>{kindNames[detail.kind]}{detail.kind === 'character' && detail.isMain ? ' · 主要角色' : ''}</span>{author && <div className="row"><button className="button secondary small" onClick={() => edit(detail)}><Pencil size={14} />编辑资料</button><button className="button secondary small" onClick={() => merge(detail)}><Link2 size={14} />合并资料</button></div>}</div>{detail.aliases.length > 0 && <div className="alias-list">{detail.aliases.map(alias => <span key={alias}>{alias}</span>)}</div>}<p className="entity-description">{detail.description || '暂无描述'}</p><EntityFacts facts={detail.facts} onCitation={showCitation} /><EntityRelations entity={detail} entities={available} relations={relations} /></div></Modal>}
    {editing && <Modal title={editing.name ? `编辑资料 · ${editing.name}` : '新增世界资料'} wide onClose={() => !busy && setEditing(null)}>{error && <Notice error={error} />}<EntityEditor value={editing} onChange={setEditing} busy={busy} onSave={async () => { if (await onSave({ ...editing, name: editing.name.trim(), aliases: editing.aliases.map(alias => alias.trim()).filter(Boolean) }, editRevision)) setEditing(null); }} /></Modal>}
    {merging && <Modal title="合并重复资料" onClose={() => !busy && setMerging(null)}><div className="form-stack">{error && <Notice error={error} />}<p>把「{merging.name}」的别名和资料合并到另一条记录。合并会保留版本，可以通过历史回退撤销。</p><label>保留哪条资料<select value={target} onChange={e => setTarget(e.target.value)}><option value="">选择同类型资料</option>{available.filter(e => e.id !== merging.id && e.kind === merging.kind).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label><button className="button primary" disabled={busy || !target} onClick={async () => { if (await onMerge(merging.id, target, mergeRevision)) setMerging(null); }}><Link2 size={16} />确认合并</button></div></Modal>}
  </section>;
}

function EntityFacts({ facts, onCitation }: { facts: Fact[]; onCitation: (citation: Citation) => void }) {
  if (!facts.length) return null;
  return <ul className="fact-list">{facts.map(fact => <li key={fact.id}><div className="fact-topline">{fact.certainty !== 'fact' && <span className={`fact-badge ${fact.certainty}`}>{fact.certainty === 'inference' ? '推测' : '存在冲突'}</span>}{fact.temporal !== 'current' && <span className="fact-badge">{{ past: '过去', future: '未来', unknown: '时间未明' }[fact.temporal]}</span>}{fact.visibility === 'secret' && <EyeOff size={12} />}{fact.locked && <LockKeyhole size={12} />}</div><p>{fact.text}</p>{fact.citation && <button className="citation" onClick={() => onCitation(fact.citation!)} title={fact.citation.quote}><FileText size={12} />原文第 {fact.citation.paragraph} 段</button>}</li>)}</ul>;
}

function EntityRelations({ entity, entities, relations }: { entity: Entity; entities: Entity[]; relations: Relation[] }) {
  const connections = relations.filter(relation => relation.fromId === entity.id || relation.toId === entity.id);
  return connections.length > 0 && <div className="entity-relations">{connections.map(relation => <span key={relation.id}>{relation.label} · {entities.find(item => item.id === (relation.fromId === entity.id ? relation.toId : relation.fromId))?.name || '关联资料'}</span>)}</div>;
}

function EntityEditor({ value, onChange, onSave, busy }: { value: Entity; onChange: (value: Entity) => void; onSave: () => void; busy: boolean }) {
  function fact(index: number, patch: Partial<Fact>) { onChange({ ...value, facts: value.facts.map((f, i) => index === i ? { ...f, ...patch } : f) }); }
  return <form className="form-stack" onSubmit={e => { e.preventDefault(); onSave(); }}><div className="form-grid"><label>名称<input required value={value.name} onChange={e => onChange({ ...value, name: e.target.value, nameStatus: 'confirmed' })} /></label><label>分类<select value={value.kind} onChange={e => onChange({ ...value, kind: e.target.value as KnowledgeKind })}>{Object.entries(kindNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div><label>别名（用逗号分隔）<input value={value.aliases.join('，')} onChange={e => onChange({ ...value, aliases: e.target.value.split(/[,，]/) })} /></label><label>资料描述<textarea rows={4} value={value.description} onChange={e => onChange({ ...value, description: e.target.value })} /></label><div className="row wrap">{value.kind === 'character' && <label className="checkbox"><input type="checkbox" checked={!!value.isMain} onChange={e => onChange({ ...value, isMain: e.target.checked })} />主要角色，写作时始终放入上下文</label>}<label className="checkbox"><input type="checkbox" checked={value.locked} onChange={e => onChange({ ...value, locked: e.target.checked })} />锁定资料，保留人工修正</label><label className="checkbox"><input type="checkbox" checked={value.visibility === 'secret'} onChange={e => onChange({ ...value, visibility: e.target.checked ? 'secret' : 'public' })} />仅作者可见</label></div><div className="row between"><h3>人物属性、当前状态与关键经历</h3><button className="button secondary small" type="button" onClick={() => onChange({ ...value, facts: [...value.facts, { id: crypto.randomUUID(), text: '', temporal: 'current', certainty: 'fact', visibility: 'public', locked: true }] })}><Plus size={14} />添加事实</button></div>{value.facts.map((f, i) => <div className="fact-editor" key={f.id}><div className="row"><textarea aria-label={`事实 ${i + 1}`} rows={2} required value={f.text} onChange={e => fact(i, { text: e.target.value, locked: true })} /><button className="icon-button danger-text" type="button" aria-label="移除此事实" onClick={() => onChange({ ...value, facts: value.facts.filter(item => item.id !== f.id) })}><Trash2 size={16} /></button></div><label>资料类别<input list="entity-attributes" aria-label={`资料类别 ${i + 1}`} placeholder="例如：性别、血统、能力、性格、重大经历" value={f.attribute || ''} onChange={e => fact(i, { attribute: e.target.value || undefined, locked: true })} /></label><div className="form-grid compact-grid"><label>时间<select value={f.temporal} onChange={e => fact(i, { temporal: e.target.value as Fact['temporal'] })}><option value="current">当前状态</option><option value="past">过去 / 回忆</option><option value="future">未来计划</option><option value="unknown">时间未明</option></select></label><label>可信程度<select value={f.certainty} onChange={e => fact(i, { certainty: e.target.value as Fact['certainty'] })}><option value="fact">明确事实</option><option value="inference">推测</option><option value="conflict">存在冲突</option></select></label></div><div className="row wrap"><label className="checkbox"><input type="checkbox" checked={f.visibility === 'secret'} onChange={e => fact(i, { visibility: e.target.checked ? 'secret' : 'public' })} />作者秘密</label><label className="checkbox"><input type="checkbox" checked={!!f.locked} onChange={e => fact(i, { locked: e.target.checked })} />锁定事实</label></div>{f.citation && <blockquote className="hint">原文第 {f.citation.paragraph} 段：“{f.citation.quote}”</blockquote>}</div>)}<datalist id="entity-attributes">{['性别', '血统', '能力', '性格', '身份', '外貌', '重要关系', '当前位置', '重大经历'].map(attribute => <option key={attribute} value={attribute} />)}</datalist><div className="sticky-modal-footer"><button className="button primary" disabled={busy || !value.name.trim()} type="submit">{busy ? '正在保存…' : '保存资料'}</button></div></form>;
}

export function LocationPanel({ entities, relations, onCitation }: { entities: Entity[]; relations: Relation[]; onCitation: (citation: Citation) => void }) {
  const locations = entities.filter(entity => entity.kind === 'location' && !entity.mergedInto);
  const locationIds = new Set(locations.map(entity => entity.id));
  const [selected, setSelected] = useState<string | null>(null);
  const selection = selected && locationIds.has(selected) ? selected : null;
  const geographic = relations.filter(relation => locationIds.has(relation.fromId) && locationIds.has(relation.toId) && isGeographicRelation(relation.label));
  const shownRelations = geographic.filter(relation => !selection || relation.fromId === selection || relation.toId === selection);
  const display = selection ? locations.filter(entity => entity.id === selection || shownRelations.some(relation => relation.fromId === entity.id || relation.toId === entity.id)) : locations;
  const { points, width, height } = locationLayout(display, shownRelations);
  const characters = entities.filter(entity => entity.kind === 'character' && !entity.mergedInto);
  return <section className="data-panel">
    <div className="panel-heading"><div><span className="eyebrow">WORLD GEOGRAPHY</span><h2>地点关系</h2><p>地图只展示地理地点、区域归属与连接。已知方位用于相对排布，距离不按比例；没有方位记录的连接只表示关联，未连接的地点组仅按行排列。</p></div></div>
    {!locations.length ? <Empty icon={<MapPin size={31} />} title="故事的版图，尚待展开">资料整理发现地点后，会在这里展示世界的地理关系。</Empty> : <>
      <label className="map-filter">查看范围<select value={selection || ''} onChange={event => setSelected(event.target.value || null)}><option value="">所有地理地点</option>{locations.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label>
      <div className="map-canvas"><svg viewBox={`0 0 ${width} ${height}`} style={{ width }} role="img" aria-label="世界地理地点关系图"><defs><pattern id="mapDots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#d3ded6" /></pattern></defs><rect width={width} height={height} fill="url(#mapDots)" />{shownRelations.map(relation => {
        const from = points.find(point => point.entity.id === relation.fromId); const to = points.find(point => point.entity.id === relation.toId);
        return from && to ? <g key={relation.id}><title>{`${from.entity.name} · ${relation.label} · ${to.entity.name}`}</title><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#8aa49a" strokeWidth="1.5" /><rect x={(from.x + to.x) / 2 - 48} y={(from.y + to.y) / 2 - 11} width="96" height="22" rx="11" fill="#fafbf6" /><text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 + 4} textAnchor="middle" fontSize="11" fill="#4d6a61">{relation.label.slice(0, 8)}</text></g> : null;
      })}{points.map(({ entity, x, y }) => <g key={entity.id} data-location-id={entity.id}><title>{entity.name}</title><circle cx={x} cy={y} r="32" fill="#214f44" stroke="#fafbf6" strokeWidth="5" /><text x={x} y={y + 5} textAnchor="middle" fontSize="15" fill="#fff">{entity.name.slice(0, 2)}</text><text x={x} y={y + 52} textAnchor="middle" fontSize="12" fill="#24473d">{entity.name}</text></g>)}</svg></div>
      <div className="map-relations">{shownRelations.map(relation => <div key={relation.id}><span>{locations.find(entity => entity.id === relation.fromId)?.name}</span><span className="relation-label">{relation.label}</span><span>{locations.find(entity => entity.id === relation.toId)?.name}</span>{relation.citation && <button className="citation" onClick={() => onCitation(relation.citation!)}><FileText size={12} />出处</button>}</div>)}</div>{!shownRelations.length && <p className="hint map-empty-relations">当前尚未记录这些地点之间的地理关系。</p>}
    </>}
    {characters.length > 0 && <div className="character-locations"><div className="character-location-heading"><h3>人物当前位置</h3><p>按当前故事版本显示，历史回退和分支会同步恢复对应的位置记录。</p></div>{characters.map(character => {
      const facts = character.facts.filter(fact => fact.temporal === 'current' && isLocationAttribute(fact.attribute));
      const fact = facts.length === 1 ? facts[0] : null;
      return <div className="character-location" key={character.id}><span>{character.name}</span><p>{fact ? fact.text : facts.length > 1 ? '位置记录存在冲突，待确认' : '尚未记录当前位置'}</p>{fact?.certainty === 'inference' && <span className="fact-badge inference">推测</span>}{fact?.certainty === 'conflict' && <span className="fact-badge conflict">存在冲突</span>}{fact?.citation && <button className="citation" onClick={() => onCitation(fact.citation!)}><FileText size={12} />出处</button>}</div>;
    })}</div>}
  </section>;
}

function isLocationAttribute(attribute?: string) { return !!attribute && /^(location|位置|所在地|所在位置|当前地点|当前位置)$/i.test(attribute.trim()); }
function isGeographicRelation(label: string) {
  return !/任务|委托|追捕|战斗|调查|探索|前往|到达|离开|现身|停留|所在地|出发/.test(label) && /位于|坐落|属于|隶属|包含|区域|境内|连接|连通|通往|邻近|附近|相邻|毗邻|接壤|距离|相距|东|西|南|北|上游|下游|入口|出口/.test(label);
}

function direction(label: string): { x: number; y: number } | null {
  const match = label.match(/以([东南西北]{1,2})(?:方|面|侧|岸|边|端|部)?/) || label.match(/([东南西北]{1,2})(?:方|面|侧|岸|边|端|部)/) || label.match(/^(?:位于|在|处于|坐落于)?([东南西北]{1,2})$/);
  if (!match) return null;
  const value = match[1];
  if ((value.includes('东') && value.includes('西')) || (value.includes('南') && value.includes('北'))) return null;
  return { x: value.includes('东') ? 180 : value.includes('西') ? -180 : 0, y: value.includes('北') ? -180 : value.includes('南') ? 180 : 0 };
}

function locationLayout(entities: Entity[], relations: Relation[]) {
  const positions = new Map<string, { x: number; y: number }>();
  let rowX = 0; let rowY = 0; let rowHeight = 0; let width = 0;
  for (const root of entities) {
    if (positions.has(root.id)) continue;
    const group = new Map<string, { x: number; y: number }>([[root.id, { x: 0, y: 0 }]]);
    const queue = [root.id];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]; const origin = group.get(id)!;
      const connections = relations.filter(relation => relation.fromId === id || relation.toId === id);
      connections.forEach((relation, relationIndex) => {
        const neighbor = relation.fromId === id ? relation.toId : relation.fromId;
        if (group.has(neighbor)) return;
        const vector = direction(relation.label);
        const sign = relation.fromId === id ? -1 : 1;
        const angle = relationIndex * Math.PI * 2 / Math.max(1, connections.length);
        group.set(neighbor, { x: origin.x + (vector ? vector.x * sign : Math.cos(angle) * 200), y: origin.y + (vector ? vector.y * sign : Math.sin(angle) * 200) });
        queue.push(neighbor);
      });
    }
    const values = Array.from(group.values());
    const minX = Math.min(...values.map(point => point.x)); const minY = Math.min(...values.map(point => point.y));
    const groupWidth = Math.max(...values.map(point => point.x)) - minX + 200;
    const groupHeight = Math.max(...values.map(point => point.y)) - minY + 190;
    if (rowX > 0 && rowX + groupWidth > 800) { rowX = 0; rowY += rowHeight; rowHeight = 0; }
    for (const [id, point] of group) positions.set(id, { x: point.x - minX + rowX + 100, y: point.y - minY + rowY + 85 });
    rowX += groupWidth; rowHeight = Math.max(rowHeight, groupHeight); width = Math.max(width, rowX);
  }
  return { points: entities.map(entity => ({ entity, ...positions.get(entity.id)! })), width: Math.max(300, width), height: Math.max(240, rowY + rowHeight) };
}
