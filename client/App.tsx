import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Plus, Settings as SettingsIcon, LogOut, Upload, FolderOpen, Feather, Sparkles, Trash2 } from 'lucide-react';
import type { Mode, Project } from '../shared/types';
import { api, post, modeNames, dateText } from './api';
import { Brand, Empty, Modal, Notice, Spinner } from './ui';
import { SettingsPanel } from './SettingsPanel';
import { Workspace } from './Workspace';

export default function App() {
  const [auth, setAuth] = useState<{ initialized: boolean; authenticated: boolean } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [create, setCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const [mode, setMode] = useState<Mode>('original');

  const loadProjects = async () => setProjects(await api<Project[]>('/projects'));
  useEffect(() => { api<{ initialized: boolean; authenticated: boolean }>('/auth/status').then(setAuth).catch(e => setError(e.message)); }, []);
  useEffect(() => { if (auth?.authenticated) loadProjects().catch(e => setError(e.message)); }, [auth?.authenticated]);
  async function createProject(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const project = await post<Project>('/projects', { title, premise, mode });
      await loadProjects(); setCreate(false); setCurrent(project.id); setTitle(''); setPremise('');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function restore(file?: File) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const form = new FormData(); form.append('file', file);
      const project = await api<Project>('/restore', { method: 'POST', body: form });
      await loadProjects(); setCurrent(project.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function closeDelete() {
    if (deleting) return;
    setDeleteTarget(null); setDeleteError('');
  }
  async function deleteProject() {
    if (!deleteTarget || deleting) return;
    const projectId = deleteTarget.id;
    setDeleting(true); setDeleteError('');
    try {
      await api<{ ok: true }>(`/projects/${projectId}`, { method: 'DELETE' });
      setProjects(previous => previous.filter(project => project.id !== projectId));
      setDeleteTarget(null);
    } catch (e) { setDeleteError((e as Error).message); } finally { setDeleting(false); }
  }
  if (!auth) return <main className="startup"><Brand />{error ? <Notice error={error} /> : <Spinner />}</main>;
  if (!auth.authenticated) return <Auth initialized={auth.initialized} onAuthenticated={() => setAuth({ initialized: true, authenticated: true })} />;

  return <div className="app-shell">
    {current ? <Workspace projectId={current} onBack={() => { setCurrent(null); loadProjects().catch(e => setError(e.message)); }} onSettings={() => setSettings(true)} /> : <>
      <header className="site-header"><Brand /><div className="header-actions"><button className="text-button" onClick={() => setSettings(true)}><SettingsIcon size={17} /><span>供应商设置</span></button><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={async () => { try { await post('/auth/logout'); setAuth({ initialized: true, authenticated: false }); } catch (e) { setError((e as Error).message); } }}><LogOut size={18} /></button></div></header>
      <main className="shelf-page">
        <section className="shelf-intro"><div><span className="eyebrow"><span className="tiny-dot" /> 私人创作空间</span><h1>每一个故事，<br /><em>都值得成为一个世界。</em></h1><p>从一段灵感开始，或走进一本熟悉的小说。<br />让人物、地点与埋下的伏笔，陪故事一起生长。</p></div><div className="intro-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-book"><Feather size={56} strokeWidth={1} /><span>故事未完</span><small>THE WORLD CONTINUES</small></div><span className="art-star star-one">✧</span><span className="art-star star-two">✧</span></div></section>
        {error && <Notice error={error} onClose={() => setError('')} />}
        <section className="library"><div className="section-heading"><div><span className="eyebrow">YOUR LIBRARY</span><h2>我的作品 <span className="count-badge">{projects.length}</span></h2></div><div className="row"><label className={`button secondary ${busy ? 'disabled' : ''}`}><Upload size={16} />恢复备份<input title="选择 JSON 或 GZIP 作品备份" className="visually-hidden" type="file" accept=".json,.gz,application/json,application/gzip" disabled={busy} onChange={e => { void restore(e.target.files?.[0]); e.target.value = ''; }} /></label><button className="button primary" onClick={() => setCreate(true)}><Plus size={17} />新建作品</button></div></div>
          {projects.length === 0 ? <Empty icon={<BookOpen size={32} strokeWidth={1.4} />} title="你的下一部故事，从这里开始" action={<button className="button primary" onClick={() => setCreate(true)}>创建第一部作品 <ArrowRight size={16} /></button>}>写下一个设定，或新建作品后导入 TXT / EPUB 小说。</Empty> : <div className="project-grid">{projects.map((project, index) => <article className="project-card" key={project.id}><button className="project-card-open" aria-label={`打开作品 ${project.title}`} disabled={deleting} onClick={() => setCurrent(project.id)}><div className={`book-cover cover-${index % 4}`}><span className="cover-tag">{modeNames[project.mode]}</span><BookOpen size={36} strokeWidth={1} /><span className="cover-title">{project.title}</span><span className="cover-line" /></div><div className="project-card-body"><h3>{project.title}</h3><p>{project.premise || '打开作品，继续探索故事中的世界。'}</p><div className="project-card-footer"><span>{dateText(project.updatedAt)} 更新</span><ArrowRight size={16} /></div></div></button><button className="project-card-delete" aria-label={`删除作品 ${project.title}`} disabled={deleting} onClick={() => { setDeleteError(''); setDeleteTarget(project); }}><Trash2 size={14} />删除</button></article>)}</div>}
        </section>
        <footer className="shelf-footer"><span><FolderOpen size={14} />作品保存在你的私人服务器</span><span>文字 · 世界 · 无限可能</span></footer>
      </main>
    </>}
    {settings && <Modal title="供应商与任务模型设置" wide onClose={() => setSettings(false)}><SettingsPanel /></Modal>}
    {deleteTarget && <Modal title="删除作品" onClose={closeDelete} closeDisabled={deleting}><div className="form-stack delete-project-confirmation" aria-busy={deleting}><p>确定永久删除《<strong>{deleteTarget.title}</strong>》吗？</p><p className="danger-text">这会删除原文文件、正文、全部故事线及历史版本、世界资料、剧情摘要、规划与伏笔、任务记录和模型输出，无法撤销。</p><p className="hint">需要保留作品时，请先进入工作台下载备份。删除时会停止该作品的后台任务，请稍候。</p>{deleteError && <Notice error={deleteError} />}<div className="row end"><button className="button secondary" disabled={deleting} onClick={closeDelete}>取消</button><button className="button danger" disabled={deleting} onClick={() => void deleteProject()}><Trash2 size={16} />{deleting ? '正在删除…' : '永久删除'}</button></div></div></Modal>}
    {create && <Modal title="开启一部新作品" onClose={() => !busy && setCreate(false)}><form onSubmit={createProject} className="form-stack"><label>作品名称<input autoFocus required maxLength={120} placeholder="给这个世界起个名字" value={title} onChange={e => setTitle(e.target.value)} /></label><label>创作方式<select value={mode} onChange={e => setMode(e.target.value as Mode)}>{Object.entries(modeNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>最初的设定<textarea rows={5} placeholder="世界是什么样的？谁会走进这个故事？也可以先留白，进入后导入原作。" value={premise} onChange={e => setPremise(e.target.value)} /></label><p className="hint">原作与新创作的正文分别保存。你可以随时从某一章建立新的故事线。</p>{error && <Notice error={error} />}<button className="button primary" type="submit" disabled={busy || !title.trim()}><Sparkles size={17} />{busy ? '正在创建…' : '创建作品'}</button></form></Modal>}
  </div>;
}

function Auth({ initialized, onAuthenticated }: { initialized: boolean; onAuthenticated: () => void }) {
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!initialized && password !== confirm) { setError('两次输入的密码不一致。'); return; }
    setBusy(true);
    try { await post(`/auth/${initialized ? 'login' : 'setup'}`, { password }); onAuthenticated(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <main className="auth-page"><div className="auth-decoration" aria-hidden="true"><div className="auth-quote">一念起，<br />万象生。</div><span>EVERY STORY BEGINS WITH A SPARK.</span></div><section className="auth-content"><Brand /><div className="auth-form"><span className="eyebrow">WELCOME TO YOUR WORLD</span><h1>{initialized ? '欢迎回到故事里。' : '为你的世界，留一把钥匙。'}</h1><p>{initialized ? '登录你的私人小说创作工作台。' : '首次使用，请设置工作台的登录密码。'}</p><form className="form-stack" onSubmit={submit}><label>登录密码<input type="password" required minLength={initialized ? 1 : 8} autoFocus autoComplete={initialized ? 'current-password' : 'new-password'} placeholder={initialized ? '输入登录密码' : '至少 8 位字符'} value={password} onChange={e => setPassword(e.target.value)} /></label>{!initialized && <label>确认密码<input type="password" required minLength={8} autoComplete="new-password" placeholder="再次输入密码" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>}{error && <Notice error={error} />}<button type="submit" className="button primary" disabled={busy}>{busy ? '请稍候…' : initialized ? '进入工作台' : '创建私人工作台'}<ArrowRight size={17} /></button></form></div><p className="auth-footnote">你的文字，你的世界。</p></section></main>;
}
