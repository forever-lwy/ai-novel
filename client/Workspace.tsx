import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, Download, Eye, EyeOff, GitBranch, History, List, MapPin, Menu, Pencil, Plus, Save, Search, Settings, Sparkles, Upload, Users, X, Clock3, FileText, RefreshCw, CheckCircle2, ScrollText, Bookmark, ArrowUpRight, Images, ImagePlus, Trash2 } from 'lucide-react';
import type { Branch, BranchTreeEntry, BranchView, Chapter, Citation, Entity, GenerateInput, Job, Mode, Project, Source, WritingActivity, WritingEvent, StoryImage, RpgSetup, RpgCharacter, RpgChoice } from '../shared/types';
import { emptyState } from '../shared/types';
import { includesChapterVersion } from '../shared/chapter-versions';
import { countProseWords } from '../shared/rpg-chapter';
import { api, ApiError, countText, dateText, modeNames, post, put, streamJob } from './api';
import { Brand, Empty, Modal, Notice, Spinner } from './ui';
import { ImportPanel } from './ImportPanel';
import { JobsPanel } from './JobsPanel';
import { ModelOutputsPanel } from './ModelOutputsPanel';
import { LocationPanel, WorldPanel } from './WorldPanel';
import { PlanningPanel } from './PlanningPanel';
import { WritingTimeline } from './WritingTimeline';
import { proseParagraphs } from './writing-timeline';
import { GenerationControls } from './GenerationControls';
import { ChapterImageCards, ImageGallery, ImageRequestDialog, StoryImageCards, imageKindNames, type ImageTarget, type ImageAction } from './StoryImages';
import { RpgChoicePanel, RpgSetupFields, type RpgChoiceDraft } from './RpgMode';
import { BranchTree } from './BranchTree';
import { ChapterTitleRepairPanel } from './ChapterTitleRepairPanel';
import { useReadingToolbar } from './useReadingToolbar';
import { chapterCacheKey, viewCacheKey } from './workspace-cache';
import type { ApplicationCache } from './application-cache';
import { ImageCacheProvider } from './CachedImage';
import type { ChapterTitlePreview } from '../shared/chapter-titles';

type ProjectDetail = { project: Project; branches: Branch[]; branchTree: BranchTreeEntry[]; sources: Source[]; cacheVersion?: string };
type Tab = 'text' | 'world' | 'map' | 'planning' | 'images' | 'jobs';
type Dialog = 'import' | 'generate' | 'regenerate-background' | 'fork' | 'history' | 'search' | 'branches' | null;
type Generation = { job: Job; text: string; title: string; snapshotLoaded: boolean; chapterId?: string; instruction?: string; connectionError?: string };
type WritingProcess = { jobId: string; branchId: string; activities: WritingActivity[]; loading?: boolean; error?: string };
type ChapterAction = { action: 'delete' | 'clear' | 'extract'; chapterId: string; title: string; branchId: string; revisionId: string };
const tabs: { key: Tab; label: string; icon: typeof BookOpen }[] = [{ key: 'text', label: '正文', icon: BookOpen }, { key: 'world', label: '世界资料', icon: Users }, { key: 'map', label: '地点关系', icon: MapPin }, { key: 'planning', label: '剧情与伏笔', icon: ScrollText }, { key: 'images', label: '故事图册', icon: Images }, { key: 'jobs', label: '任务', icon: Clock3 }];
const recoveredChoiceMessage = '章末选择已经接受，已恢复下一章；无需再次提交选择。';
const jobsSignature = (values: Job[]) => values.map(job => `${job.id}:${job.updatedAt}:${job.status}:${job.progress}:${job.total}:${job.message}:${job.error}:${job.generatedChapterId}:${job.pendingChoice?.id}`).join('|');
const imagesSignature = (values: StoryImage[]) => values.map(image => `${image.id}:${image.status}:${image.updatedAt}:${image.active}:${image.url}:${image.chapterId}:${image.sourceChapterId}:${JSON.stringify(image.selection)}:${JSON.stringify(image.sourceSelection)}`).join('|');
const sameView = (previous: BranchView | null, next: BranchView) => previous?.branch.id === next.branch.id && previous.branch.revisionId === next.branch.revisionId && previous.branch.name === next.branch.name && previous.revisions.length === next.revisions.length && JSON.stringify(previous.state.imageIds) === JSON.stringify(next.state.imageIds) && JSON.stringify(previous.state.activeImageIds) === JSON.stringify(next.state.activeImageIds);

function savedBranch(projectId: string) { try { return sessionStorage.getItem(`story-branch:${projectId}`); } catch { return null; } }

export function Workspace({ projectId, resources, onBack, onSettings, active = true }: { projectId: string; resources: ApplicationCache; onBack: () => void; onSettings: () => void; active?: boolean }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null); const [branchId, setBranchId] = useState(''); const [view, setView] = useState<BranchView | null>(null); const [showProcess, setShowProcess] = useState(true);
  const [tab, setTab] = useState<Tab>('text'); const [dialog, setDialog] = useState<Dialog>(null); const [sidebar, setSidebar] = useState(false);
  const [chapter, setChapter] = useState<Chapter | null>(null); const [chapterId, setChapterId] = useState<string | null>(null); const [chapterLoading, setChapterLoading] = useState(false);
  const [editing, setEditing] = useState(false); const [draftTitle, setDraftTitle] = useState(''); const [draftText, setDraftText] = useState(''); const [draftRevision, setDraftRevision] = useState(''); const [dirty, setDirty] = useState(false); const [planningDirty, setPlanningDirty] = useState(false);
  const [outputJob, setOutputJob] = useState<Job | null>(null); const [outputDirty, setOutputDirty] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [highlight, setHighlight] = useState<number | null>(null); const [selection, setSelection] = useState<{ start: number; end: number } | undefined>();
  const [generationMode, setGenerationMode] = useState<Mode>('original'); const [instruction, setInstruction] = useState(''); const [generationTitle, setGenerationTitle] = useState(''); const [maxWords, setMaxWords] = useState(2000); const [forkName, setForkName] = useState(''); const [forkChapterId, setForkChapterId] = useState('');
  const [rpgSetup, setRpgSetup] = useState<RpgSetup>({ character: { kind: 'original', name: '', description: '' } }); const [newRpg, setNewRpg] = useState(false); const [rpgChoiceDrafts, setRpgChoiceDrafts] = useState<Record<string, RpgChoiceDraft>>({}); const rpgCharacterDrafts = useRef<Record<RpgCharacter['kind'], RpgCharacter>>({ original: { kind: 'original', name: '', description: '' }, existing: { kind: 'existing', name: '', description: '' } });
  const [choiceSubmissions, setChoiceSubmissions] = useState<Record<string, { busy: boolean; error?: string }>>({}); const submittingChoices = useRef(new Set<string>());
  const [generation, setGeneration] = useState<Generation | null>(null); const [regenerating, setRegenerating] = useState(false); const [discardBackground, setDiscardBackground] = useState(false); const [streamAttempt, setStreamAttempt] = useState(0);
  const [writingProcess, setWritingProcess] = useState<WritingProcess | null>(null);
  const [generationActionState, setGenerationActionState] = useState<{ jobId: string; busy: boolean; error?: string } | null>(null); const changingGeneration = useRef(new Set<string>());
  const [imageState, setImageState] = useState<{ scope: string; values: StoryImage[] }>({ scope: '', values: [] }); const [imageBusy, setImageBusy] = useState(false); const [imageError, setImageError] = useState(''); const [focusEntityId, setFocusEntityId] = useState<string>();
  const [imageRequest, setImageRequest] = useState<{ id: number; branchId: string; revisionId: string; target: ImageTarget; title: string; excerpt?: string } | null>(null);
  const [imageDeletion, setImageDeletion] = useState<{ image: StoryImage; branchId: string; revisionId: string } | null>(null);
  const [chapterAction, setChapterAction] = useState<ChapterAction | null>(null);
  const [titleRepair, setTitleRepair] = useState<{ branchId: string; revisionId: string; chapters: { id: string; title: string }[]; initialChapterId?: string } | null>(null);
  const [titleRepairBusy, setTitleRepairBusy] = useState(false);
  const [branchDeletion, setBranchDeletion] = useState<{ branchId: string; revisionId: string; name: string } | null>(null);
  const [branchRename, setBranchRename] = useState<{ branchId: string; revisionId: string; name: string } | null>(null);
  const [generationBranchName, setGenerationBranchName] = useState<string | null>(null);
  const createsGenerationBranch = regenerating || generationMode === 'rewrite' || generationMode === 'rpg' && (newRpg || !view?.state.rpg);
  const suggestedBranchName = (generationMode === 'rpg' ? `RPG · ${rpgSetup.character.name || '新体验'}` : `${regenerating ? '重新生成' : '改写'} · ${chapter?.title || '新章节'}`).slice(0, 200);
  const newBranchName = generationBranchName ?? suggestedBranchName;
  const worldState = view?.state ?? emptyState();
  const imageScope = `${branchId}:author`; const images = imageState.scope === imageScope ? imageState.values : [];
  const [search, setSearch] = useState(''); const [searchResult, setSearchResult] = useState<{ chapters: { id: string; title: string; snippet: string }[]; entities: Entity[] } | null>(null); const [searchBusy, setSearchBusy] = useState(false);
  const current = useRef<{ branchId: string; chapterId: string | null }>({ branchId: '', chapterId: null }); current.current = { branchId, chapterId };
  const mounted = useRef(true); const chapterSequence = useRef(0); const viewSequence = useRef(0); const metadataSequence = useRef(0); const jobFingerprint = useRef<string | null>(null); const textareaRef = useRef<HTMLTextAreaElement>(null); const searchSequence = useRef(0);
  const [cache] = useState(() => resources.project(projectId));
  const viewRef = useRef(view); viewRef.current = view;
  const rememberView = useCallback((value: BranchView) => {
    if (value.cacheVersion) cache.views.set(JSON.stringify([value.branch.id, value.cacheVersion]), value);
  }, [cache]);
  useLayoutEffect(() => { if (view) rememberView(view); }, [view, rememberView]);
  const streamEnd = useRef<HTMLDivElement>(null); const choiceStart = useRef<HTMLHeadingElement>(null); const followStream = useRef(true);
  const writingScope = useRef(''); const activitiesRequest = useRef<AbortController | null>(null);
  const imageRequestSequence = useRef(0); const imageActionSequence = useRef(0); const imageListSequence = useRef(0);
  const pendingChoiceScope = useRef('');
  const workspaceElement = useRef<HTMLDivElement>(null); const toolbarElement = useRef<HTMLDivElement>(null); const manuscriptElement = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++chapterSequence.current; ++viewSequence.current; ++metadataSequence.current; ++searchSequence.current; }; }, []);
  useEffect(() => { if (branchId) { try { sessionStorage.setItem(`story-branch:${projectId}`, branchId); } catch { /* Storage may be unavailable; tasks remain recoverable from the task list. */ } } }, [projectId, branchId]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty || planningDirty || outputDirty) { event.preventDefault(); } };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, planningDirty, outputDirty]);

  const refreshMetadata = useCallback(async () => { const sequence = ++metadataSequence.current; const value = await api<ProjectDetail>(`/projects/${projectId}?view=author`); if (mounted.current && sequence === metadataSequence.current) setDetail(value); return value; }, [projectId]);
  const refreshView = useCallback(async (id: string, knownVersion?: string) => {
    const seq = ++viewSequence.current;
    const value = await cache.views.load(JSON.stringify([id, knownVersion ?? 'refresh']), () => api<BranchView>(`/branches/${id}?view=author`), !knownVersion, value => !!knownVersion && value.cacheVersion === knownVersion);
    if (mounted.current && seq === viewSequence.current && current.current.branchId === id) { rememberView(value); viewRef.current = value; setView(previous => sameView(previous, value) && previous?.cacheVersion === value.cacheVersion ? previous : value); }
    return value;
  }, [cache, rememberView]);
  const fetchChapter = useCallback(async (id: string, onBranch: string, revision: string, knownTitle?: string) => {
    const sequence = ++chapterSequence.current;
    const key = chapterCacheKey(onBranch, id); const cached = cache.chapters.get(key);
    const relevant = () => mounted.current && sequence === chapterSequence.current && onBranch === current.current.branchId && current.current.chapterId === id;
    const showText = (value: Chapter) => {
      const title = (viewRef.current?.branch.id === onBranch ? viewRef.current.state.chapters.find(chapter => chapter.id === id)?.title : undefined) ?? knownTitle;
      const text = title && title !== value.title ? { ...value, title } : value;
      setChapter(text); setDraftTitle(text.title); setDraftText(text.text); setDraftRevision(revision); setDirty(false); setSelection(undefined); setChapterLoading(false);
      cache.lastChapter.set(onBranch, id);
      return text;
    };
    current.current.chapterId = id; setChapterId(id);
    if (cached) showText(cached); else { setChapter(null); setChapterLoading(true); }
    try {
      const text = await cache.chapters.load(key, () => api<Chapter>(`/branches/${onBranch}/chapters/${id}`));
      if (relevant()) return showText(text);
    }
    catch (e) { if (relevant()) setError((e as Error).message); }
    finally { if (relevant()) setChapterLoading(false); }
  }, [cache]);
  useEffect(() => {
    if (!generation || generation.job.branchId !== branchId) return;
    const controller = new AbortController(); const jobId = generation.job.id; const onBranch = generation.job.branchId;
    let terminal = false; let alive = true;
    const relevant = () => alive && mounted.current && current.current.branchId === onBranch && writingScope.current === `${onBranch}:${jobId}`;
    void streamJob<WritingEvent>(jobId, controller.signal, event => {
      if (!relevant()) return;
      if (event.type === 'activity') {
        setWritingProcess(value => {
          const activities = value?.jobId === jobId && value.branchId === onBranch ? value.activities : [];
          return { jobId, branchId: onBranch, activities: activities.some(activity => activity.id === event.activity.id) ? activities.map(activity => activity.id === event.activity.id ? event.activity : activity) : [...activities, event.activity] };
        });
        return;
      }
      if (event.type === 'snapshot') setWritingProcess({ jobId, branchId: onBranch, activities: event.activities || [] });
      setGeneration(value => !value || value.job.id !== jobId ? value : event.type === 'delta' ? { ...value, text: value.text + event.text } : event.type === 'snapshot' ? { ...value, snapshotLoaded: true, text: event.text, title: event.title, job: event.job, chapterId: event.chapterId || event.job.generatedChapterId } : { ...value, job: event.job, chapterId: event.chapterId || event.job.generatedChapterId || value.chapterId });
      if (event.type === 'delta') return;
      const job = event.job; setJobs(value => [job, ...value.filter(item => item.id !== job.id)]);
      if (['completed', 'failed', 'cancelled', 'stale', 'paused'].includes(job.status)) {
        terminal = true;
        const savedId = event.chapterId || job.generatedChapterId;
        if (job.status === 'completed' && savedId) {
          void (async () => {
            const updated = await refreshView(onBranch); if (!relevant()) return;
            await fetchChapter(savedId, onBranch, updated.branch.revisionId); if (!relevant()) return;
            setGeneration(value => value?.job.id === jobId ? null : value); setMessage(value => value === recoveredChoiceMessage ? value : '正文已保存，人物资料、剧情摘要与伏笔正在后台整理。');
            await refreshMetadata();
          })().catch(e => { if (relevant()) setError((e as Error).message); });
        }
      }
    }).then(() => { if (relevant() && !terminal) setGeneration(value => value?.job.id === jobId ? { ...value, connectionError: '流式连接已断开，服务器任务仍会继续。可重新连接或在任务页查看结果。' } : value); }).catch(e => { if (relevant() && !controller.signal.aborted) setGeneration(value => value?.job.id === jobId ? { ...value, connectionError: (e as Error).message } : value); });
    return () => { alive = false; controller.abort(); };
  }, [generation?.job.id, branchId, streamAttempt, refreshView, refreshMetadata, fetchChapter]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const value = await refreshMetadata(); if (!alive) return;
        const saved = savedBranch(projectId);
        const initial = value.branches.find(item => item.id === saved) || value.branches.find(item => item.id === value.project.mainBranchId)!;
        const previousChapter = await cache.lastChapter.read(initial.id); if (!alive) return;
        const directory = value.branchTree.find(item => item.id === initial.id)?.chapters ?? [];
        const target = directory.find(item => item.id === previousChapter) || directory.at(-1);
        current.current = { branchId: initial.id, chapterId: target?.id ?? null };
        setBranchId(initial.id); setGenerationMode(value.project.mode);
        // Fresh directory permits prose to load independently of the larger material snapshot.
        const viewRequest = refreshView(initial.id, value.cacheVersion);
        const bodyRequest = target ? fetchChapter(target.id, initial.id, initial.revisionId, target.title) : Promise.resolve();
        const [branch] = await Promise.all([viewRequest, bodyRequest]);
        if (!alive || current.current.branchId !== initial.id || current.current.chapterId !== (target?.id ?? null)) return;
        if (viewRef.current?.branch.revisionId !== branch.branch.revisionId || viewRef.current?.cacheVersion !== branch.cacheVersion) return;
        const selected = branch.state.chapters.find(item => item.id === target?.id) || branch.state.chapters.at(-1);
        if (selected && (selected.id !== target?.id || branch.branch.revisionId !== initial.revisionId)) await fetchChapter(selected.id, branch.branch.id, branch.branch.revisionId);
        else if (selected) {
          setChapter(previous => previous?.id === selected.id && previous.title !== selected.title ? { ...previous, title: selected.title } : previous);
          setDraftTitle(selected.title);
        }
      } catch (e) { if (alive) setError((e as Error).message); }
    })();
    return () => { alive = false; };
  }, [projectId, cache, refreshMetadata, refreshView, fetchChapter]);
  useEffect(() => {
    let alive = true; let polling = false;
    async function poll() {
      if (!active || document.hidden || polling) return; polling = true;
      try {
        const value = await api<Job[]>(`/jobs?projectId=${projectId}&view=author`); if (!alive) return;
        const fingerprint = jobsSignature(value); setJobs(previous => jobsSignature(previous) === fingerprint ? previous : value);
        const previous = jobFingerprint.current; jobFingerprint.current = fingerprint;
        if (previous !== null && fingerprint !== previous) { const origin = current.current; if (origin.branchId) { await refreshView(origin.branchId); await refreshMetadata(); } }
      } catch (e) { if (alive) setError((e as Error).message); } finally { polling = false; }
    }
    void poll(); const timer = window.setInterval(poll, 2000); return () => { alive = false; window.clearInterval(timer); };
  }, [projectId, active, refreshMetadata, refreshView]);
  useEffect(() => {
    let alive = true; let polling = false; const onBranch = branchId; const scope = `${onBranch}:author`;
    const revision = viewRef.current?.branch.id === onBranch ? viewRef.current.branch.revisionId : '';
    const cached = cache.images.get(viewCacheKey(onBranch, revision, true, null));
    let fingerprint = cached ? imagesSignature(cached) : null;
    if (cached) setImageState(previous => previous.scope === scope && imagesSignature(previous.values) === fingerprint ? previous : { scope, values: cached });
    setImageRequest(null); setImageDeletion(null); setImageError(''); setImageBusy(false); setFocusEntityId(undefined); ++imageActionSequence.current; ++imageListSequence.current;
    const relevant = () => alive && mounted.current && current.current.branchId === onBranch;
    async function poll() {
      if (!onBranch || !active || document.hidden || polling) return; polling = true; const sequence = ++imageListSequence.current;
      const requestedRevision = viewRef.current?.branch.id === onBranch ? viewRef.current.branch.revisionId : '';
      try {
        const values = await api<StoryImage[]>(`/branches/${onBranch}/images?view=author`); if (!relevant() || sequence !== imageListSequence.current) return;
        const currentRevision = viewRef.current?.branch.id === onBranch ? viewRef.current.branch.revisionId : '';
        // A list that started before a local edit must not repopulate its new version's cache.
        if (currentRevision !== requestedRevision) return;
        cache.images.set(viewCacheKey(onBranch, currentRevision, true, null), values);
        const next = imagesSignature(values); setImageState(previous => previous.scope === scope && imagesSignature(previous.values) === next ? previous : { scope, values });
        const previous = fingerprint; fingerprint = next;
        if (previous !== null && previous !== next) await refreshView(onBranch);
      } catch (e) { if (relevant() && sequence === imageListSequence.current) setImageError((e as Error).message); } finally { polling = false; }
    }
    void poll(); const timer = window.setInterval(poll, 2000); return () => { alive = false; window.clearInterval(timer); };
  }, [branchId, active, cache, refreshView]);
  useEffect(() => {
    const refresh = () => {
      const origin = current.current;
      if (!active || document.hidden || !origin.branchId) return;
      void Promise.all([refreshView(origin.branchId), refreshMetadata()]).catch(error => { if (mounted.current) setError((error as Error).message); });
    };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [active, refreshMetadata, refreshView]);
  useEffect(() => { if (active && highlight !== null && !chapterLoading) { const frame = requestAnimationFrame(() => document.getElementById(`paragraph-${highlight}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })); return () => cancelAnimationFrame(frame); } }, [active, highlight, chapterLoading, chapter?.id]);

  const canLeave = () => !(dirty || planningDirty || outputDirty) || window.confirm('有尚未保存的内容。确定放弃这些修改吗？');
  function openImageRequest(target: ImageTarget) {
    if (!view) return;
    if (dirty || planningDirty || outputDirty) { setError('请先保存当前修改，再生成图片。'); return; }
    const entity = worldState.entities.find(value => value.id === target.entityId); const ref = images.find(image => image.id === target.referenceImageId);
    if (ref?.active === false) { setError('请先启用这张图片，再使用 AI 修改。'); return; }
    const source = target.chapterId === chapter?.id ? chapter?.text : undefined;
    const excerpt = target.selection && source ? source.slice(target.selection.start, target.selection.end) : undefined;
    setImageError(''); setImageRequest({ id: ++imageRequestSequence.current, branchId, revisionId: view.branch.revisionId, target, title: `${ref ? 'AI 修改' : '生成'}${imageKindNames[target.kind]}${entity ? ` · ${entity.name}` : ''}`, excerpt });
  }
  async function submitImage(target: ImageTarget) {
    const request = imageRequest; if (!request || current.current.branchId !== request.branchId || dirty || planningDirty || outputDirty) { setImageError('请先保存修改，再重新打开生图。'); return; }
    const sequence = ++imageActionSequence.current; const onBranch = request.branchId; const relevant = () => mounted.current && sequence === imageActionSequence.current && current.current.branchId === onBranch;
    setImageBusy(true); setImageError('');
    try {
      const result = await post<{ view: BranchView; image: StoryImage }>(`/branches/${onBranch}/images?view=author`, { ...target, baseRevisionId: request.revisionId }); if (!relevant()) return;
      ++imageListSequence.current; ++viewSequence.current; setView(result.view); setDraftRevision(value => value === request.revisionId ? result.view.branch.revisionId : value); setImageState(value => ({ scope: `${onBranch}:author`, values: [result.image, ...(value.scope === `${onBranch}:author` ? value.values.filter(image => image.id !== result.image.id) : [])] }));
      setImageRequest(value => value?.id === request.id ? null : value); setMessage('图片已提交绘制，可在正文、关联资料或故事图册查看进度。');
    } catch (e) { if (relevant()) setImageError((e as Error).message); } finally { if (relevant()) setImageBusy(false); }
  }
  async function imageAction(image: StoryImage, action: ImageAction, deletionRevision?: string) {
    if (!view || dirty || planningDirty || outputDirty) { setError('请先保存当前修改，再操作图片。'); return; }
    if (action === 'delete' && !deletionRevision) { setImageError(''); setImageDeletion({ image, branchId, revisionId: view.branch.revisionId }); return; }
    const onBranch = branchId; const revisionId = deletionRevision || view.branch.revisionId; const sequence = ++imageActionSequence.current;
    const relevant = () => mounted.current && sequence === imageActionSequence.current && current.current.branchId === onBranch;
    setImageBusy(true); setImageError('');
    try {
      const path = `/branches/${onBranch}/images/${image.id}`;
      const result = action === 'delete' ? await api<{ view: BranchView; images: StoryImage[] }>(`${path}?view=author`, { method: 'DELETE', body: JSON.stringify({ baseRevisionId: revisionId }) }) : action === 'activate' || action === 'deactivate' ? await put<{ view: BranchView; images: StoryImage[] }>(`${path}/active?view=author`, { baseRevisionId: revisionId, active: action === 'activate' }) : await post<StoryImage | { view: BranchView; image: StoryImage }>(`${path}/${action}?view=author`, action === 'retry' ? { baseRevisionId: revisionId } : undefined);
      if (!relevant()) return; ++imageListSequence.current;
      if ('view' in result) { ++viewSequence.current; setView(result.view); setDraftRevision(value => value === revisionId ? result.view.branch.revisionId : value); }
      if ('images' in result) setImageState({ scope: `${onBranch}:author`, values: result.images });
      else { const updated = 'image' in result ? result.image : result; setImageState(value => ({ scope: `${onBranch}:author`, values: [updated, ...(value.scope === `${onBranch}:author` ? value.values.filter(item => item.id !== updated.id) : [])] })); }
      if (action === 'delete') setImageDeletion(value => value?.image.id === image.id && value.branchId === onBranch ? null : value);
      setMessage(({ retry: '已重新提交绘制，原记录保留。', cancel: '已取消绘制。', activate: '图片已启用，AI 可使用这张图片作为参考。', deactivate: '图片已停用并暂存，不再用于 AI 参考。', delete: '图片已从当前故事线删除。' } as Record<ImageAction, string>)[action]);
    } catch (e) { if (relevant()) setImageError((e as Error).message); } finally { if (relevant()) setImageBusy(false); }
  }
  const captureProseSelection = useCallback((event: SyntheticEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const selected = window.getSelection(); if (!selected || selected.isCollapsed || !selected.rangeCount) { setSelection(undefined); return; }
    const range = selected.getRangeAt(0); if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
    const offset = (node: Node, at: number) => { const paragraph = (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>('p[data-prose-start]'); if (!paragraph) return undefined; const prefix = document.createRange(); prefix.selectNodeContents(paragraph); prefix.setEnd(node, at); return Number(paragraph.dataset.proseStart) + prefix.toString().length; };
    const start = offset(range.startContainer, range.startOffset); const end = offset(range.endContainer, range.endOffset); setSelection(start !== undefined && end !== undefined && end > start ? { start, end } : undefined);
  }, []);
  function scrollToChoice(smooth = false) {
    const paragraphs = choiceStart.current?.closest('article')?.querySelectorAll<HTMLElement>('.prose p, .prose > p');
    const last = paragraphs?.[paragraphs.length - 1]; (last || choiceStart.current)?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  }
  function openImageEntity(id: string) { if (!canLeave()) return; changeTab('world'); setFocusEntityId(id); }
  function openImageChapter(image: StoryImage) { if (image.chapterId) void openChapter(image.chapterId, undefined, image.selection); }
  function clearWritingProcess() { writingScope.current = ''; activitiesRequest.current?.abort(); activitiesRequest.current = null; setWritingProcess(null); }
  async function operate<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
    setBusy(true); setError(''); setMessage('');
    try { const result = await action(); if (success) setMessage(success); return result; }
    catch (e) { setError(`${(e as Error).message}${e instanceof ApiError && e.status === 409 ? ' 当前草稿已保留。请对照服务器最新版本后重新编辑；正文可先下载为 TXT，再粘贴需要保留的内容。刷新不会自动覆盖草稿或解除版本冲突。' : ''}`); return undefined; } finally { setBusy(false); }
  }
  async function applyView(value: BranchView, selectLast = false) {
    const origin = current.current; const next = value;
    if (!mounted.current) return next;
    ++viewSequence.current; current.current = { branchId: next.branch.id, chapterId: selectLast || next.branch.id !== origin.branchId ? null : origin.chapterId }; setView(next); setBranchId(next.branch.id); await refreshMetadata();
    if (selectLast) { clearWritingProcess(); setGeneration(null); setChapterId(null); const last = next.state.chapters.at(-1); setEditing(false); setDirty(false); if (last) await fetchChapter(last.id, next.branch.id, next.branch.revisionId); else { setChapter(null); setChapterId(null); setDraftTitle(''); setDraftText(''); } }
    return next;
  }
  async function changeBranch(id: string, targetChapterId?: string) {
    if (id === branchId) { if (targetChapterId) { if (await openChapter(targetChapterId)) setDialog(null); } else setDialog(null); return; }
    if (!canLeave()) return; clearWritingProcess(); setGeneration(null); setDialog(null); setOutputJob(null); setOutputDirty(false); ++chapterSequence.current; ++searchSequence.current; ++viewSequence.current; current.current = { branchId: id, chapterId: null }; setChapterLoading(false); setSearchBusy(false); setSearchResult(null); setDirty(false); setPlanningDirty(false); setEditing(false); setChapter(null); setChapterId(null); setView(null); setBranchId(id); setSidebar(false); setError('');
    if (targetChapterId) setTab('text');
    await operate(async () => { const value = await refreshView(id); const target = value.state.chapters.find(chapter => chapter.id === targetChapterId) || value.state.chapters.at(-1); if (target) await fetchChapter(target.id, id, value.branch.revisionId); });
  }
  const processScroll = useRef<{ top: number; offset?: number; y?: number } | null>(null);
  function toggleProcess() {
    const element = manuscriptElement.current;
    if (element) {
      const top = element.getBoundingClientRect().top;
      const paragraph = [...element.querySelectorAll<HTMLElement>('p[data-prose-start]')].find(value => value.getBoundingClientRect().bottom > top);
      processScroll.current = { top: element.scrollTop, offset: paragraph ? Number(paragraph.dataset.proseStart) : undefined, y: paragraph ? paragraph.getBoundingClientRect().top - top : undefined };
    }
    setShowProcess(value => !value);
  }
  useLayoutEffect(() => {
    const saved = processScroll.current; const element = manuscriptElement.current; processScroll.current = null;
    if (!saved || !element) return;
    const paragraph = saved.offset === undefined ? undefined : [...element.querySelectorAll<HTMLElement>('p[data-prose-start]')].find(value => Number(value.dataset.proseStart) <= saved.offset! && Number(value.dataset.proseEnd) > saved.offset!);
    if (paragraph && saved.y !== undefined) element.scrollTop += paragraph.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.y;
    else element.scrollTop = saved.top;
  }, [showProcess]);
  function changeTab(next: Tab) { if (planningDirty && next !== 'planning' && !window.confirm('资料或伏笔还有未保存的修改，确定放弃吗？')) return; setFocusEntityId(undefined); setTab(next); setSidebar(false); }
  async function openChapter(id: string, citation?: Citation, imageSelection?: { start: number; end: number }) {
    if (!view || !canLeave()) return; ++searchSequence.current; setSearchResult(null); setSearchBusy(false); if (id !== chapterId || generation) clearWritingProcess(); setGeneration(null); setDirty(false); setPlanningDirty(false); setEditing(false); setTab('text'); setSidebar(false); setHighlight(citation?.paragraph ?? null);
    const text = await fetchChapter(id, branchId, view.branch.revisionId);
    if (text && imageSelection) setHighlight(Math.max(1, proseParagraphs(text.text).filter(part => part.start <= imageSelection.start).length));
    return text;
  }
  function newChapter() { if (!view || !canLeave()) return; clearWritingProcess(); setGeneration(null); ++chapterSequence.current; setChapterLoading(false); setChapter(null); setChapterId(null); setDraftTitle('新章节'); setDraftText(''); setDraftRevision(view.branch.revisionId); setEditing(true); setDirty(false); setTab('text'); setSidebar(false); setHighlight(null); }
  async function saveChapter() {
    if (!view) return;
    const index = chapterId ? view.state.chapters.findIndex(chapter => chapter.id === chapterId) : view.state.chapters.length;
    await operate(async () => {
      const result = await post<BranchView>(`/branches/${branchId}/chapters?view=author`, { baseRevisionId: draftRevision || view.branch.revisionId, title: draftTitle, text: draftText, chapterId: chapterId || undefined });
      await applyView(result); setEditing(false); setDirty(false); setSelection(undefined);
      const saved = result.state.chapters[index]; if (saved) await fetchChapter(saved.id, result.branch.id, result.branch.revisionId);
    }, chapterId ? '正文已在当前故事线保存；已有资料保留，需要更新时请手动重新提取本章资料。' : '正文已保存，世界资料正在后台整理。');
  }
  function openFork(fromChapterId = chapterId || '') {
    if (!view || busy || dirty || planningDirty || outputDirty) return;
    setError(''); setForkName(`${view.branch.name} · 新分支`.slice(0, 200)); setForkChapterId(fromChapterId); setDialog('fork');
  }
  async function submitBranchRename(event: FormEvent) {
    event.preventDefault(); const request = branchRename;
    if (!request || current.current.branchId !== request.branchId || !request.name.trim()) return;
    await operate(async () => {
      const renamed = await put<Branch>(`/branches/${request.branchId}/name?view=author`, { baseRevisionId: request.revisionId, name: request.name.trim() });
      if (!mounted.current || current.current.branchId !== request.branchId) return;
      ++metadataSequence.current; ++viewSequence.current;
      setView(value => value?.branch.id === renamed.id ? { ...value, branch: { ...value.branch, name: renamed.name } } : value);
      setDetail(value => value && ({ ...value, branches: value.branches.map(branch => branch.id === renamed.id ? { ...branch, name: renamed.name } : branch), branchTree: value.branchTree?.map(branch => branch.id === renamed.id ? { ...branch, name: renamed.name } : branch) }));
      setBranchRename(null); await refreshMetadata();
    }, '故事线已重命名。');
  }
  async function submitBranchDeletion() {
    const request = branchDeletion;
    if (!request || current.current.branchId !== request.branchId || dirty || planningDirty || outputDirty) return;
    await operate(async () => {
      const result = await api<{ ok: true; mainBranchId: string }>(`/branches/${request.branchId}?view=author`, { method: 'DELETE', body: JSON.stringify({ baseRevisionId: request.revisionId }) });
      if (!mounted.current || current.current.branchId !== request.branchId) return;
      ++chapterSequence.current; ++searchSequence.current; clearWritingProcess(); setGeneration(null); setOutputJob(null); setSearchResult(null); setHighlight(null); setSelection(undefined);
      setJobs(value => value.filter(job => job.branchId !== request.branchId)); setTab('text'); setSidebar(false); setBranchDeletion(null);
      await applyView(await api<BranchView>(`/branches/${result.mainBranchId}?view=author`), true);
    }, '分支已删除，已返回主线；其他故事线及其历史参考保留。');
  }
  async function updateMaterialsView(value: BranchView) {
    if (!mounted.current || current.current.branchId !== value.branch.id) return;
    ++viewSequence.current; ++searchSequence.current; ++imageListSequence.current;
    setView(value); setDraftRevision(value.branch.revisionId); setSearchResult(null); setFocusEntityId(undefined);
    setImageState(previous => ({ ...previous, values: previous.values.filter(image => value.state.imageIds?.includes(image.id)) }));
    await refreshMetadata();
  }
  function openChapterAction(action: ChapterAction['action']) {
    if (!view || !chapter || busy || dirty || planningDirty || outputDirty) return;
    setError(''); setChapterAction({ action, chapterId: chapter.id, title: chapter.title, branchId, revisionId: view.branch.revisionId });
  }
  async function submitChapterAction() {
    const request = chapterAction;
    if (!request || current.current.branchId !== request.branchId || dirty || planningDirty || outputDirty) return;
    await operate(async () => {
      const path = `/branches/${request.branchId}/chapters/${request.chapterId}`;
      const result = request.action === 'extract'
        ? await post<{ view: BranchView; job: Job }>(`${path}/extract?view=author`, { baseRevisionId: request.revisionId })
        : await api<BranchView>(`${path}${request.action === 'clear' ? '/extraction' : ''}?view=author`, { method: 'DELETE', body: JSON.stringify({ baseRevisionId: request.revisionId }) });
      if (!mounted.current || current.current.branchId !== request.branchId) return;
      const updated = 'view' in result ? result.view : result;
      const index = view?.state.chapters.findIndex(chapter => chapter.id === request.chapterId) ?? 0;
      await updateMaterialsView(updated);
      if ('job' in result) setJobs(value => [result.job, ...value.filter(job => job.id !== result.job.id)]);
      if (request.action === 'delete' && current.current.chapterId === request.chapterId) {
        clearWritingProcess(); ++chapterSequence.current; setEditing(false); setSelection(undefined); setHighlight(null);
        const next = updated.state.chapters[Math.min(index, updated.state.chapters.length - 1)];
        if (next) await fetchChapter(next.id, request.branchId, updated.branch.revisionId);
        else { current.current.chapterId = null; setChapter(null); setChapterId(null); setChapterLoading(false); setDraftText(''); setDraftTitle(''); }
      }
      setChapterAction(null);
    }, request.action === 'delete' ? '章节已从当前故事线删除，可通过版本回退恢复。' : request.action === 'clear' ? '本章已提取资料已清除，正文保留；可随时重新提取。' : '已提交本章重新提取任务，可在任务页查看进度。');
  }
  async function deleteEntity(entityId: string, revisionId: string) {
    if (dirty || planningDirty || outputDirty) { setError('请先保存当前修改，再删除资料。'); return false; }
    const onBranch = branchId;
    return !!(await operate(async () => {
      const result = await api<BranchView>(`/branches/${onBranch}/entities/${entityId}?view=author`, { method: 'DELETE', body: JSON.stringify({ baseRevisionId: revisionId }) });
      await updateMaterialsView(result); return true;
    }, '资料已从当前故事线删除，可通过版本回退恢复。'));
  }
  function downloadDraft() {
    const title = generation?.title || draftTitle; const text = generation?.text ?? draftText;
    const url = URL.createObjectURL(new Blob([`${title}\n\n${text}`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${(title || '未命名章节').replace(/[\\/:*?"<>|]/g, '_')}-草稿.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function openChapterChoice() {
    const choice = view?.state.rpg?.nextChoice; if (!choice || !canLeave()) return;
    if (chapterId !== choice.chapterId || generation || editing) await openChapter(choice.chapterId);
    else { setTab('text'); setSidebar(false); }
    requestAnimationFrame(() => scrollToChoice(true));
  }
  function openGeneration(asRpg = false) { if (dirty || planningDirty || outputDirty) { setError('请先保存当前修改，再开始生成。'); return; } if (!asRpg && view?.state.rpg?.nextChoice) { void openChapterChoice(); return; } setRegenerating(false); setGenerationBranchName(null); setDiscardBackground(false); setGenerationMode(asRpg || view?.state.rpg ? 'rpg' : detail?.project.mode || 'original'); setNewRpg(asRpg); setInstruction(''); setGenerationTitle(''); setError(''); setDialog('generate'); }
  function openRegeneration() {
    if (!view || !chapterId || dirty || planningDirty || outputDirty) return;
    const previous = jobs.find(job => job.kind === 'generate' && selectedRef && includesChapterVersion(selectedRef, job.generatedChapterId));
    setRegenerating(true); setGenerationBranchName(null); setDiscardBackground(false); setGenerationMode(previous?.generationInput?.mode || detail?.project.mode || 'original'); setInstruction(previous?.generationInput?.instruction || ''); setMaxWords(previous?.generationInput?.maxWords || 2000); setGenerationTitle(chapter?.title || '');
    setDialog(view.state.chapters.some(item => item.status !== 'ready') || jobs.some(job => job.branchId === branchId && ['import', 'extract'].includes(job.kind) && ['queued', 'running', 'paused'].includes(job.status)) ? 'regenerate-background' : 'generate');
  }
  async function resumeGeneration(job: Job, prompt?: string) {
    if (!canLeave()) return;
    // An explicit open owns recovery for this branch; metadata loading must not reopen it a second time.
    restoreScope.current = `${job.branchId}:author`; setSidebar(false); setTab('text');
    if (job.branchId !== current.current.branchId) await applyView(await api<BranchView>(`/branches/${job.branchId}?view=author`));
    ++chapterSequence.current; setChapterLoading(false); setChapter(null); setChapterId(null); setDirty(false); setPlanningDirty(false); setEditing(false); setSelection(undefined); setHighlight(null);
    clearWritingProcess(); writingScope.current = `${job.branchId}:${job.id}`; setWritingProcess({ jobId: job.id, branchId: job.branchId, activities: [] }); followStream.current = true;
    setGeneration({ job, text: '', snapshotLoaded: false, title: job.title || '正在写作的新章节', chapterId: job.generatedChapterId, instruction: prompt ?? job.generationInput?.instruction ?? '' });
    setStreamAttempt(value => value + 1);
  }
  async function generate(e: FormEvent) {
    e.preventDefault(); if (!view) return;
    await operate(async () => {
      const input: GenerateInput = { baseRevisionId: view.branch.revisionId, mode: generationMode, instruction, title: generationTitle || undefined, branchName: createsGenerationBranch ? newBranchName.trim() : undefined, maxWords, chapterId: regenerating || generationMode === 'rewrite' ? chapterId || undefined : undefined, selection: !regenerating && generationMode === 'rewrite' ? selection : undefined, regenerate: regenerating || undefined, discardBackground: discardBackground || undefined, rpg: generationMode === 'rpg' && (newRpg || !view.state.rpg) ? rpgSetup : undefined };
      const job = await post<Job>(`/branches/${branchId}/generate${generationMode === 'rpg' ? '?view=author' : ''}`, input); setJobs(value => [job, ...value.filter(j => j.id !== job.id)]); setDialog(null); await resumeGeneration(job, instruction);
    });
  }
  async function answerChoice(choice: RpgChoice, jobId: string, answer: { optionId?: string; customText?: string }, startsNextChapter = false) {
    const choiceId = choice.id; const onBranch = branchId; const scope = `${onBranch}:${jobId}:${choiceId}`;
    const key = `${jobId}:${choiceId}`; if (submittingChoices.current.has(key)) return;
    submittingChoices.current.add(key); setChoiceSubmissions(value => ({ ...value, [key]: { busy: true } }));
    let submissionError: string | undefined; let attemptedPost = false;
    try {
      if (!active || current.current.branchId !== onBranch || pendingChoiceScope.current !== scope) throw new Error('这个剧情节点已变化，请查看当前任务。');
      if (startsNextChapter && chapterChoiceBlockedReason) throw new Error(chapterChoiceBlockedReason);
      attemptedPost = true;
      const updated = await post<Job>(`/jobs/${jobId}/choice?view=author`, { choiceId, ...answer, ...(startsNextChapter ? { baseRevisionId: view?.branch.revisionId, branchId: onBranch } : {}) });
      if (!mounted.current || current.current.branchId !== onBranch) return;
      setJobs(value => { const existing = value.find(item => item.id === updated.id); return existing && existing.updatedAt > updated.updatedAt ? value : [updated, ...value.filter(item => item.id !== updated.id)]; });
      setGeneration(value => value?.job.id === updated.id && value.job.updatedAt <= updated.updatedAt ? { ...value, job: updated, connectionError: undefined } : value);
      setRpgChoiceDrafts(value => { const next = { ...value }; delete next[key]; return next; });
      followStream.current = true;
      if (startsNextChapter) {
        await resumeGeneration(updated);
        void refreshView(onBranch).catch(reason => { if (mounted.current && current.current.branchId === onBranch) setError(`下一章已经开始，最新资料暂未刷新：${(reason as Error).message}`); });
      }
      else if (generation?.job.id === jobId) setStreamAttempt(value => value + 1);
      else await resumeGeneration(updated);
    } catch (reason) {
      submissionError = (reason as Error).message;
      if (startsNextChapter && attemptedPost && mounted.current && current.current.branchId === onBranch) {
        try {
          // A lost POST reply may follow a committed choice. Recover by reading its exact new job;
          // never repeat the choice or a model request implicitly.
          const latest = await api<Job[]>(`/jobs?projectId=${projectId}&view=author`);
          const accepted = latest.find(job => job.projectId === projectId && job.branchId === onBranch && job.id !== jobId && job.chapterStartChoiceId === choiceId);
          if (accepted && mounted.current && current.current.branchId === onBranch) {
            setJobs(latest); setRpgChoiceDrafts(value => { const next = { ...value }; delete next[key]; return next; });
            followStream.current = true; await resumeGeneration(accepted); submissionError = undefined;
            setMessage(recoveredChoiceMessage);
            void refreshView(onBranch).catch(refreshError => { if (mounted.current && current.current.branchId === onBranch) setError(`下一章已经开始，最新资料暂未刷新：${(refreshError as Error).message}`); });
          }
        } catch { /* Preserve the original submission error and draft; the task list remains available. */ }
      }
    }
    finally {
      submittingChoices.current.delete(key);
      if (mounted.current) setChoiceSubmissions(value => { const next = { ...value }; if (submissionError) next[key] = { busy: false, error: submissionError }; else delete next[key]; return next; });
    }
  }
  async function controlGeneration(job: Job, action: 'pause' | 'resume' | 'retry' | 'cancel') {
    if (!active || current.current.branchId !== job.branchId || generation?.job.id !== job.id || changingGeneration.current.has(job.id)) return;
    if (job.pendingChoice && ['resume', 'retry'].includes(action)) return;
    changingGeneration.current.add(job.id); setGenerationActionState({ jobId: job.id, busy: true });
    const scope = `${job.branchId}:${job.id}`; const relevant = () => mounted.current && current.current.branchId === job.branchId && writingScope.current === scope;
    let actionError: string | undefined;
    try {
      const updated = await post<Job>(`/jobs/${job.id}/${action}?view=author`);
      if (!relevant()) return;
      setJobs(value => { const previous = value.find(item => item.id === updated.id); return previous && previous.updatedAt > updated.updatedAt ? value : [updated, ...value.filter(item => item.id !== updated.id)]; });
      setGeneration(value => value?.job.id === updated.id && value.job.updatedAt <= updated.updatedAt ? { ...value, job: updated, connectionError: undefined } : value);
      if (action === 'resume' || action === 'retry') { followStream.current = true; setStreamAttempt(value => value + 1); }
    } catch (reason) { actionError = `${(reason as Error).message}${reason instanceof ApiError && reason.status === 409 ? ' 当前正文草稿仍保留。' : ''}`; }
    finally { changingGeneration.current.delete(job.id); if (mounted.current) setGenerationActionState(value => value?.jobId === job.id ? { jobId: job.id, busy: false, error: relevant() ? actionError : undefined } : value); }
  }
  async function exitGeneration() {
    const job = jobs.find(value => value.id === generation?.job.id) || generation?.job; const id = job?.generatedChapterId; const onBranch = job?.branchId;
    clearWritingProcess(); setGeneration(null);
    if (id && onBranch === current.current.branchId) await operate(async () => { const updated = await refreshView(onBranch); await fetchChapter(id, onBranch, updated.branch.revisionId); });
  }
  async function submitFork(e: FormEvent) { e.preventDefault(); if (!view) return; await operate(async () => { const value = await post<BranchView>(`/branches/${branchId}/fork`, { baseRevisionId: view.branch.revisionId, name: forkName, chapterId: forkChapterId || undefined }); await applyView(value, true); setDialog(null); }, '新故事线已建立。'); }
  async function doSearch(e: FormEvent) { e.preventDefault(); if (!search.trim()) return; const sequence = ++searchSequence.current; setSearchBusy(true); try { const data = await api<{ chapters: { id: string; title: string; snippet: string }[]; entities: Entity[] }>(`/branches/${branchId}/search?q=${encodeURIComponent(search)}&view=author`); if (sequence === searchSequence.current) setSearchResult(data); } catch (e) { setError((e as Error).message); } finally { if (sequence === searchSequence.current) setSearchBusy(false); } }
  const activeJobs = jobs.filter(j => ['queued', 'running', 'paused'].includes(j.status));
  const branchBusy = jobs.some(j => j.branchId === branchId && ['queued', 'running'].includes(j.status));
  const writingBusy = jobs.some(job => job.branchId === branchId && job.kind === 'generate' && ['queued', 'running', 'paused'].includes(job.status));
  const pending = view?.state.chapters.filter(ch => ch.status !== 'ready').length || 0;
  const selectedRef = view?.state.chapters.find(ch => ch.id === chapterId);
  useEffect(() => {
    if (!selectedRef || view?.branch.id !== branchId || chapter?.id !== selectedRef.id || dirty || chapter.title === selectedRef.title) return;
    setChapter(value => value?.id === selectedRef.id ? { ...value, title: selectedRef.title } : value);
    setDraftTitle(selectedRef.title);
  }, [selectedRef?.id, selectedRef?.title, view?.branch.id, branchId, chapter?.id, chapter?.title, dirty]);
  const visibleText = generation ? generation.text : editing ? draftText : chapter?.text || '';
  const wordCount = useMemo(() => countProseWords(visibleText), [visibleText]);
  const processJob = generation?.job.branchId === branchId ? generation.job : jobs.find(job => job.kind === 'generate' && selectedRef && includesChapterVersion(selectedRef, job.generatedChapterId));
  const currentGenerationJob = jobs.find(job => job.id === generation?.job.id) || generation?.job;
  const visibleProcess = showProcess && processJob && writingProcess?.jobId === processJob.id && writingProcess.branchId === branchId ? writingProcess : undefined;
  const choiceJob = currentGenerationJob?.branchId === branchId && currentGenerationJob.status === 'paused' && currentGenerationJob.pendingChoice ? currentGenerationJob : jobs.find(job => job.branchId === branchId && job.kind === 'generate' && job.status === 'paused' && job.pendingChoice);
  const choiceKey = choiceJob ? `${choiceJob.id}:${choiceJob.pendingChoice!.id}` : '';
  const inlineChoice = active && generation?.snapshotLoaded && generation.job.id === choiceJob?.id && generation.job.status === 'paused' && generation.job.pendingChoice?.id === choiceJob?.pendingChoice?.id ? choiceJob : undefined;
  const chapterChoice = view?.state.rpg?.nextChoice;
  const chapterChoiceKey = chapterChoice ? `${chapterChoice.jobId}:${chapterChoice.id}` : '';
  const inlineChapterChoice = active && !editing && !chapterLoading && (generation ? generation.chapterId : chapter?.id) === chapterChoice?.chapterId ? chapterChoice : undefined;
  const chapterChoiceBlockedReason = chapterChoice ? dirty || planningDirty || outputDirty ? '请先保存当前修改，再开始下一章。' : pending > 0 ? '本章资料整理完成后，才能从此次选择开始下一章。' : jobs.some(job => job.branchId === branchId && ['queued', 'running', 'paused'].includes(job.status)) ? '请先完成或停止当前故事线的后台任务，再开始下一章。' : undefined : undefined;
  const generationTargetWords = generation?.job.generationInput?.mode === 'rpg' ? generation.job.generationInput.maxWords || 2000 : undefined;
  const readingOverlay = tab === 'text' && !!chapter && !editing && !generation;
  useLayoutEffect(() => {
    if (tab === 'text' && chapter && !editing && !generation && manuscriptElement.current) manuscriptElement.current.scrollTop = cache.positions.get(JSON.stringify([branchId, chapter.id])) ?? 0;
  }, [tab, chapter?.id, branchId, editing, generation?.job.id, !!view, cache]);
  useLayoutEffect(() => {
    const element = toolbarElement.current; const workspace = workspaceElement.current;
    if (!element || !workspace) return;
    const measure = () => {
      const height = element.getBoundingClientRect().height;
      if (height > 0) workspace.style.setProperty('--workspace-toolbar-height', `${height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [readingOverlay, active]);
  const { toolbarHidden, headerHidden, onReadingScroll, readingEvents } = useReadingToolbar(
    active && tab === 'text' && !!chapter && !chapterLoading && !editing && !generation && !sidebar && !dialog && !busy && !error && !imageRequest && !imageDeletion && !chapterAction && !titleRepair && !branchDeletion && !branchRename && !outputJob,
    `${branchId}:${chapterId}`,
  );
  pendingChoiceScope.current = chapterChoice ? `${branchId}:${chapterChoiceKey}` : choiceJob ? `${choiceJob.branchId}:${choiceKey}` : '';
  useEffect(() => {
    if (!active || !generation || tab !== 'text' || !followStream.current) return;
    if (inlineChoice) scrollToChoice();
    else streamEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [active, generation?.text, tab, inlineChoice?.pendingChoice?.id, writingProcess?.activities]);
  useEffect(() => {
    if (!inlineChapterChoice || tab !== 'text') return;
    const frame = requestAnimationFrame(() => scrollToChoice()); return () => cancelAnimationFrame(frame);
  }, [inlineChapterChoice?.id, chapterId, tab]);
  useEffect(() => {
    if (!processJob) { clearWritingProcess(); return; }
    const jobId = processJob.id; const onBranch = branchId; const scope = `${onBranch}:${jobId}`;
    writingScope.current = scope;
    if (generation?.job.id === jobId) return;
    const controller = new AbortController(); activitiesRequest.current = controller;
    setWritingProcess(value => ({ jobId, branchId: onBranch, activities: value?.jobId === jobId && value.branchId === onBranch ? value.activities : [], loading: true }));
    const relevant = () => !controller.signal.aborted && mounted.current && current.current.branchId === onBranch && writingScope.current === scope;
    void api<WritingActivity[]>(`/jobs/${jobId}/activities?view=author`, { signal: controller.signal }).then(activities => { if (relevant()) setWritingProcess({ jobId, branchId: onBranch, activities }); }).catch(e => { if (relevant()) setWritingProcess(value => value && ({ ...value, loading: false, error: (e as Error).message })); });
    return () => { controller.abort(); if (activitiesRequest.current === controller) activitiesRequest.current = null; };
  }, [branchId, chapterId, processJob?.id, !!generation]);
  const restoreScope = useRef('');
  useEffect(() => {
    const scope = `${branchId}:author`; if (busy || !jobs.length || restoreScope.current === scope || !view) return;
    restoreScope.current = scope;
    const active = jobs.find(job => job.branchId === branchId && job.kind === 'generate' && (['queued', 'running'].includes(job.status) || (job.status === 'paused' && !!job.pendingChoice)));
    const recoverable = jobs.filter(job => job.branchId === branchId && job.kind === 'generate' && ['paused', 'failed'].includes(job.status) && job.baseRevisionId === view.branch.revisionId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const restored = active || recoverable;
    if (restored && !generation && !dirty && !planningDirty && !outputDirty && !editing) void resumeGeneration(restored).catch(e => setError((e as Error).message));
  }, [busy, jobs, branchId, view, generation, dirty, planningDirty, outputDirty, editing]);

  const currentBranchName = view?.branch.name || detail?.branches.find(branch => branch.id === branchId)?.name || '正在加载…';

  return <ImageCacheProvider shared={resources.pixels} scope={JSON.stringify([projectId, branchId, 'author'])}><div ref={workspaceElement} className={`workspace ${readingOverlay ? 'reading-overlay' : ''}`} data-branch-id={branchId} data-toolbar-state={toolbarHidden ? 'hidden' : 'visible'} {...readingEvents}>
    <div className="workspace-header-shell" data-reading-toolbar hidden={headerHidden} inert={headerHidden}><header className="workspace-header"><div className="row"><button className="icon-button" aria-label="返回书架" title="返回书架" onClick={() => { if (canLeave()) onBack(); }}><ArrowLeft size={19} /></button><Brand small /><span className="header-divider" /><div className="workspace-project-title"><strong>{detail?.project.title || '正在加载作品…'}</strong><small>{detail && modeNames[detail.project.mode]} · 私人作品</small></div></div><div className="header-actions"><button className="text-button branch-tree-toggle" aria-label="选择故事线" title="选择故事线" disabled={!detail || busy} onClick={() => setDialog('branches')}><GitBranch size={17} /><span>分支树</span></button><button className="text-button" onClick={() => { setSearchResult(null); setSearch(''); setDialog('search'); }} disabled={!view}><Search size={17} /><span>搜索</span></button><button className="icon-button" aria-label="设置" title="设置" onClick={onSettings}><Settings size={18} /></button><button className={`button small ${showProcess ? 'secondary' : 'reading-active'}`} onClick={toggleProcess} aria-pressed={!showProcess} title="阅读视图只隐藏思维链和工具调用过程" disabled={!view}>{showProcess ? <EyeOff size={15} /> : <Eye size={15} />}<span>{showProcess ? '阅读视图' : '显示生成过程'}</span></button></div></header></div>
    <div className="workspace-layout">
      {sidebar && <button className="sidebar-backdrop" aria-label="关闭目录" onClick={() => setSidebar(false)} />}
      <aside className={`chapter-sidebar ${sidebar ? 'mobile-open' : ''}`}><div className="branch-selector"><div className="branch-current-name" aria-label="当前故事线"><GitBranch size={15} /><strong title={currentBranchName}>{currentBranchName}</strong></div><div className="row wrap">{<button className="text-button" disabled={!view || busy || dirty || planningDirty || outputDirty} onClick={() => openFork()}><Plus size={14} />建立分支</button>}{<button className="text-button" disabled={!view || busy} onClick={() => { if (view) { setError(''); setBranchRename({ branchId, revisionId: view.branch.revisionId, name: view.branch.name }); } }}><Pencil size={14} />重命名故事线</button>}{<button className="text-button" disabled={!view || dirty || planningDirty} onClick={() => setDialog('history')}><History size={14} />版本历史</button>}{view && view.branch.id !== detail?.project.mainBranchId && <button className="text-button danger-text" disabled={busy || dirty || planningDirty || outputDirty} onClick={() => { setError(''); setBranchDeletion({ branchId, revisionId: view.branch.revisionId, name: view.branch.name }); }}><Trash2 size={14} />删除分支</button>}</div></div>
        <div className="chapter-list-heading"><span><List size={15} />章节目录 <small>{view?.state.chapters.length || 0}</small></span>{<button className="icon-button" title="新建章节" aria-label="新建章节" disabled={!view || busy} onClick={newChapter}><Plus size={17} /></button>}</div>
        <nav className="chapter-list" aria-label="章节目录">{view?.state.chapters.length ? view.state.chapters.map((ch, index) => <button className={`chapter-item ${chapterId === ch.id ? 'selected' : ''}`} key={ch.id} onClick={() => void openChapter(ch.id)}><span className="chapter-index">{String(index + 1).padStart(2, '0')}</span><span className="chapter-item-content"><strong>{ch.title}</strong><small>{ch.sourceId ? '原作' : '创作'}{ch.status !== 'ready' ? ` · ${ch.status === 'pending' ? '待整理' : '整理失败'}` : ''}</small></span>{chapterId === ch.id && <span className="active-dot" />}</button>) : <p className="sidebar-empty">还没有章节。<br />从第一段文字开始。</p>}</nav>
        <div className="sidebar-bottom">{<button className="button secondary" disabled={!view || busy || dirty || planningDirty} onClick={() => setDialog('import')}><Upload size={16} />导入小说</button>}<div className="row between">{view && <a className="text-button" href={`/api/branches/${branchId}/export`} download><Download size={14} />导出正文</a>}<a className="text-button" href={`/api/projects/${projectId}/backup`} download><Download size={14} />作品备份</a></div></div>
      </aside>
      <main className={`workspace-main ${tab === 'text' ? 'is-text' : ''}`} onScroll={event => { const element = event.currentTarget; if (generation && element.scrollHeight > element.clientHeight) followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 150; }}>
        <div ref={toolbarElement} className="workspace-toolbars" data-reading-toolbar hidden={toolbarHidden} inert={toolbarHidden}>
          <div className="workspace-toolbar-row"><div className="workspace-tabs"><button className="icon-button mobile-menu" aria-label="打开章节目录" onClick={() => setSidebar(true)}><Menu size={19} /></button>{tabs.map(({ key, label, icon: Icon }) => <button className={tab === key ? 'active' : ''} key={key} onClick={() => changeTab(key)}><Icon size={16} /><span>{label}</span>{key === 'jobs' && activeJobs.length > 0 && <span className="tab-count">{activeJobs.length}</span>}</button>)}<span className="view-indicator">{showProcess ? <><Eye size={12} />生成过程可见</> : <><EyeOff size={12} />阅读视图</>}</span></div><button className="button primary small workspace-continue" disabled={!view || busy || !!generation || editing || dirty || planningDirty || outputDirty || (!chapterChoice && (branchBusy || writingBusy || pending > 0))} onClick={() => { setTab('text'); setSidebar(false); openGeneration(); }}><Sparkles size={15} /><span>{view?.state.rpg ? '继续体验' : view?.state.chapters.length ? '继续创作' : '开始创作'}</span></button></div>
          {view && tab === 'text' && (
          <div className="editor-toolbar"><div className="row wrap"><span className="chapter-breadcrumb">{view.branch.name}<ChevronRight size={12} />{chapterId ? `目录位置 ${view.state.chapters.findIndex(ch => ch.id === chapterId) + 1}` : '新章节'}</span>{dirty && <span className="draft-badge">未保存</span>}{selectedRef && selectedRef.status !== 'ready' && <span className="status-pill paused">{selectedRef.status === 'pending' ? '待整理' : '整理失败'}</span>}</div><div className="row wrap">{chapter && !generation && <><details className="chapter-actions"><summary className="button secondary small">章节操作<ChevronDown size={14} /></summary><div className="chapter-actions-menu"><button disabled={busy || dirty || planningDirty || outputDirty || jobs.some(job => job.branchId === branchId && ['queued', 'running', 'paused'].includes(job.status))} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setTitleRepairBusy(false); setTitleRepair({ branchId, revisionId: view.branch.revisionId, chapters: view.state.chapters.map(chapter => ({ id: chapter.id, title: chapter.title })), initialChapterId: chapter.id }); }}><Sparkles size={14} />AI 修复章节标题</button>{([['extract', '重新提取本章资料'], ['clear', '清除本章提取资料'], ['delete', '删除本章']] as const).map(([action, label]) => <button key={action} className={action === 'delete' ? 'danger-text' : ''} disabled={busy || dirty || planningDirty || outputDirty || jobs.some(job => job.branchId === branchId && ['queued', 'running', 'paused'].includes(job.status))} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); openChapterAction(action); }}>{action === 'extract' ? <RefreshCw size={14} /> : <Trash2 size={14} />}{label}</button>)}</div></details><button className="button secondary small" disabled={busy || imageBusy || dirty || planningDirty || outputDirty} onClick={() => openImageRequest({ kind: 'cg', chapterId: chapter.id })}><ImagePlus size={14} />生成本章 CG</button><button className="button secondary small" disabled={busy || imageBusy || dirty || planningDirty || outputDirty || !selection} onClick={() => openImageRequest({ kind: 'cg', chapterId: chapter.id, selection })}><ImagePlus size={14} />生成选段 CG</button></>}{<>{generation ? <><button className="text-button draft-download" disabled={!generation.text} onClick={downloadDraft}><Download size={13} />下载当前正文 TXT</button>{!['queued', 'running', 'paused'].includes(currentGenerationJob?.status || generation.job.status) && <button className="button secondary small" onClick={() => void exitGeneration()}>退出生成</button>}</> : editing ? <><button className="text-button draft-download" disabled={!draftText} onClick={downloadDraft}><Download size={13} />下载草稿 TXT</button><button className="button secondary small" disabled={busy || dirty || !selection || !chapterId || branchBusy || pending > 0} onClick={() => { setRegenerating(false); setGenerationBranchName(null); setDiscardBackground(false); setGenerationMode("rewrite"); setInstruction(""); setGenerationTitle(""); setDialog("generate"); }}>改写选段</button><button className="text-button" onClick={() => { if (!dirty || window.confirm('放弃尚未保存的正文修改？')) { setEditing(false); setDirty(false); setSelection(undefined); setDraftText(chapter?.text || ''); setDraftTitle(chapter?.title || ''); } }}>取消编辑</button><button className="button primary small" disabled={busy || !draftTitle.trim() || !draftText.trim() || !dirty} onClick={() => void saveChapter()}><Save size={14} />保存正文</button></> : <>{chapter && <button className="button secondary small" disabled={busy} onClick={() => { setEditing(true); setDraftRevision(view.branch.revisionId); setDraftTitle(chapter.title); setDraftText(chapter.text); }}><Pencil size={14} />编辑</button>}{chapter && !chapter.sourceId && !view.state.rpg && <button className="button secondary small" disabled={busy || writingBusy || dirty || planningDirty || outputDirty} onClick={openRegeneration}><RefreshCw size={14} />重新生成</button>}<button className="button secondary small" disabled={busy || branchBusy || writingBusy || pending > 0} onClick={() => openGeneration(true)}><Users size={14} />穿越体验</button></>}</>}</div></div>
          )}
        {error && <div className="workspace-notice"><Notice error={error} onClose={() => setError('')} /><button className="text-button" disabled={busy} onClick={() => void operate(async () => { if (branchId) await refreshView(branchId); }, '已刷新最新版本，当前草稿仍保留。')}><RefreshCw size={13} />刷新版本，保留草稿</button></div>}{message && <div className="workspace-notice notice success" role="status"><CheckCircle2 size={16} /><span>{message}</span><button className="icon-button" aria-label="关闭成功提示" onClick={() => setMessage('')}><X size={14} /></button></div>}
          {view && tab === 'text' && <>
          {chapterChoice && <div className="pending-strip rpg-waiting"><span><Users size={14} />本章已结束，下一章将承接你的选择。</span><button className="button primary small" disabled={busy || dirty || planningDirty || outputDirty} onClick={() => void openChapterChoice()}>回答章末选择</button></div>}{choiceJob && <div className="pending-strip rpg-waiting"><span><Users size={14} />剧情正在等待你的决定。</span><button className="button primary small" disabled={busy || dirty || planningDirty || outputDirty} onClick={() => { if (inlineChoice) scrollToChoice(true); else void operate(() => resumeGeneration(choiceJob)); }}>回答剧情选择</button></div>}{pending > 0 && <div className="pending-strip"><span><RefreshCw size={14} />{pending} 章资料在后台整理，正文可以先阅读；整理完成后可继续创作。</span><button className="text-button" disabled={busy || branchBusy} onClick={() => void operate(async () => { await post(`/branches/${branchId}/extract`, { baseRevisionId: view.branch.revisionId }); setTab('jobs'); }, '已提交资料整理任务。')}>整理 / 重试<ArrowUpRight size={13} /></button></div>}
          </>}
    {imageError && !imageRequest && !imageDeletion && <div className="workspace-notice"><Notice error={imageError} onClose={() => setImageError('')} /></div>}
        </div>
        {!view && ((!chapter && !chapterLoading) || tab !== 'text') && <Spinner text="正在打开故事世界…" />}
        {(view || chapter || chapterLoading) && <>
          <div className="writing-layout" hidden={tab !== 'text'} inert={tab !== 'text'}><div ref={manuscriptElement} className="manuscript-wrap" onScroll={event => { if (tab === 'text' && chapter && !generation && !editing && !chapterLoading) cache.positions.set(JSON.stringify([branchId, chapter.id]), event.currentTarget.scrollTop); onReadingScroll(event); const element = event.currentTarget; if (generation && element.scrollHeight > element.clientHeight) followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 150; }}>{generation ? <article className="manuscript streaming-manuscript" aria-label="正在生成的章节"><div className="reading-label"><span className="eyebrow">WRITING</span><span data-testid={generationTargetWords ? "rpg-chapter-budget" : undefined}>{countText(wordCount)}{generationTargetWords ? ` / ${countText(generationTargetWords)} 字 · 本章累计` : " 字"}</span></div>{generationTargetWords && wordCount >= generationTargetWords * 0.85 && <p className="hint" role="status">本章接近目标字数，正在收束；章末选择将由下一章承接。</p>}{generation.instruction && <div className="writing-prompt"><span>本次写作要求</span><p>{generation.instruction}</p></div>}<h1>{generation.title}</h1><WritingTimeline text={generation.text} activities={visibleProcess?.activities} loading={visibleProcess?.loading} error={visibleProcess?.error} status={currentGenerationJob?.status || generation.job.status} streaming awaitingChoice={!!inlineChoice} />{inlineChoice && <RpgChoicePanel key={choiceKey} choice={inlineChoice.pendingChoice!} panelRef={choiceStart} draft={rpgChoiceDrafts[choiceKey] || { selected: null, customText: '' }} busy={choiceSubmissions[choiceKey]?.busy || false} error={choiceSubmissions[choiceKey]?.error} onDraft={draft => setRpgChoiceDrafts(value => ({ ...value, [choiceKey]: draft }))} onSubmit={answer => answerChoice(inlineChoice.pendingChoice!, inlineChoice.id, answer)} />}{inlineChapterChoice && <RpgChoicePanel key={chapterChoiceKey} choice={inlineChapterChoice} startsNextChapter blockedReason={chapterChoiceBlockedReason} panelRef={choiceStart} draft={rpgChoiceDrafts[chapterChoiceKey] || { selected: null, customText: "" }} busy={choiceSubmissions[chapterChoiceKey]?.busy || false} error={choiceSubmissions[chapterChoiceKey]?.error} onDraft={draft => setRpgChoiceDrafts(value => ({ ...value, [chapterChoiceKey]: draft }))} onSubmit={answer => answerChoice(inlineChapterChoice, inlineChapterChoice.jobId, answer, true)} />}{generation.connectionError && ['queued', 'running'].includes(currentGenerationJob?.status || generation.job.status) && <div className="form-stack"><Notice error={generation.connectionError} /><button className="button secondary small align-start" onClick={() => { setGeneration(value => value && ({ ...value, connectionError: undefined })); setStreamAttempt(value => value + 1); }}><RefreshCw size={14} />重新连接</button></div>}<GenerationControls job={currentGenerationJob || generation.job} busy={busy || (generationActionState?.jobId === generation.job.id && generationActionState.busy) || submittingChoices.current.has(choiceKey)} error={generationActionState?.jobId === generation.job.id ? generationActionState.error : undefined} onAction={action => void controlGeneration(currentGenerationJob || generation.job, action)} /><div className="manuscript-footer"><span className="row">{['queued', 'running'].includes(generation.job.status) && <RefreshCw size={12} className="spin" />}{currentGenerationJob?.message || generation.job.message || '正在生成正文…'}</span><span>保存正文后，资料在后台整理</span></div>{images.some(image => image.writingJobId === generation.job.id) && <section className="chapter-images" aria-label="本次写作插画"><h3>本次写作插画</h3><p className="hint">图片与正文同时生成；所需参考图完成后，相关 CG 会接着绘制。</p><StoryImageCards images={images.filter(image => image.writingJobId === generation.job.id)} author busy={imageBusy} onAction={(image, action) => void imageAction(image, action)} /></section>}<div ref={streamEnd} /></article> : chapterLoading ? <Spinner text="正在翻开这一章…" /> : editing ? <section className="manuscript editor-manuscript"><span className="eyebrow">MANUSCRIPT</span><input className="chapter-title-input" aria-label="章节标题" value={draftTitle} placeholder="章节标题" onChange={e => { setDraftTitle(e.target.value); setDirty(true); }} /><textarea ref={textareaRef} className="manuscript-textarea" aria-label="章节正文" placeholder="落笔于此，让故事发生。" value={draftText} onChange={e => { setDraftText(e.target.value); setDirty(true); }} onSelect={e => { const el = e.currentTarget; setSelection(el.selectionEnd > el.selectionStart ? { start: el.selectionStart, end: el.selectionEnd } : undefined); }} /><div className="manuscript-footer"><span>{countText(wordCount)} 字</span><span>正文与世界资料一起留下版本</span></div></section> : chapter ? <article className="manuscript"><div className="reading-label"><span className="eyebrow">{chapter.sourceId ? 'ORIGINAL TEXT' : 'MANUSCRIPT'}</span><span>{countText(wordCount)} 字 · 约 {Math.max(1, Math.ceil(wordCount / 500))} 分钟</span></div><h1>{chapter.title}</h1><div className="chapter-ornament"><span />✦<span /></div><WritingTimeline originalProcess={!!processJob && processJob.generatedChapterId !== chapter.id} text={chapter.text} activities={visibleProcess?.activities} loading={visibleProcess?.loading} error={visibleProcess?.error} status={processJob?.status || 'completed'} highlight={highlight} onMouseUp={captureProseSelection} onKeyUp={captureProseSelection} />{inlineChapterChoice && <RpgChoicePanel key={chapterChoiceKey} choice={inlineChapterChoice} startsNextChapter blockedReason={chapterChoiceBlockedReason} panelRef={choiceStart} draft={rpgChoiceDrafts[chapterChoiceKey] || { selected: null, customText: "" }} busy={choiceSubmissions[chapterChoiceKey]?.busy || false} error={choiceSubmissions[chapterChoiceKey]?.error} onDraft={draft => setRpgChoiceDrafts(value => ({ ...value, [chapterChoiceKey]: draft }))} onSubmit={answer => answerChoice(inlineChapterChoice, inlineChapterChoice.jobId, answer, true)} />}<div className="manuscript-footer"><span>· 本章完 ·</span><span>{selectedRef?.status === 'ready' ? '世界资料已整理' : '正文已保存'}</span></div>{<div className="chapter-end-actions"><button className="button secondary small" disabled={!view || busy || dirty || planningDirty || outputDirty || selectedRef?.status !== 'ready'} onClick={() => openFork(chapter.id)}><GitBranch size={15} />从此章节分支</button></div>}</article> : <div className="writing-empty"><span className="eyebrow">A BLANK PAGE, A NEW WORLD</span><Empty icon={<BookOpen size={40} strokeWidth={1.2} />} title="故事，在下一笔开始" action={<div className="row wrap center"><button className="button primary" disabled={busy} onClick={() => openGeneration()}><Sparkles size={16} />从设定开始创作</button><button className="button secondary" onClick={newChapter}><Pencil size={16} />手动写第一章</button></div>}>{(detail?.project.premise) || '你可以写下第一章，也可以导入一本小说，让它成为新故事的起点。'}</Empty></div>}{tab === 'text' && chapterId && images.some(image => image.chapterId === chapterId) && <section className="chapter-images"><div className="row between"><h3>本章插画</h3><button className="text-button" onClick={() => changeTab('images')}>查看全部图片<ArrowUpRight size={13} /></button></div><ChapterImageCards key={chapterId} entities={worldState.entities} chapters={view?.state.chapters || []} images={images.filter(image => image.chapterId === chapterId)} author busy={imageBusy || dirty || planningDirty || outputDirty} onGenerate={openImageRequest} onAction={(image, action) => void imageAction(image, action)} onChapter={openImageChapter} onEntity={openImageEntity} /></section>}</div>
            {view ? <aside className="context-sidebar"><section><span className="eyebrow">STORY COMPANION</span><h3>此刻的世界</h3><p className="context-note">当前故事线的完整资料</p><div className="world-stats"><div><strong>{worldState.entities.filter(e => e.kind === 'character' && !e.mergedInto).length}</strong><span>人物</span></div><div><strong>{worldState.entities.filter(e => e.kind === 'location' && !e.mergedInto).length}</strong><span>地点</span></div><div><strong>{view.state.chapters.length}</strong><span>章节</span></div></div></section>{selectedRef?.summary && <section><h4><FileText size={14} />本章提要</h4><p className="context-summary">{selectedRef.summary}</p></section>}<section><h4><Users size={14} />世界中的人物</h4>{worldState.entities.filter(e => e.kind === 'character' && !e.mergedInto).slice(0, 5).map((e, i) => <button className="context-character" key={e.id} onClick={() => openImageEntity(e.id)}><span className={`avatar avatar-${i % 3}`}>{e.name.slice(0, 1)}</span><span><strong>{e.name}</strong><small>{e.description || e.aliases.join(' / ') || '人物档案'}</small></span><ChevronRight size={13} /></button>)}{!worldState.entities.some(e => e.kind === 'character') && <p className="hint">人物出现后，档案会记录在这里。</p>}</section>{<section><h4><Bookmark size={14} />待揭晓的伏笔</h4>{view.state.foreshadows.filter(f => ['planned', 'planted'].includes(f.status)).slice(0, 4).map(f => <button className="context-foreshadow" key={f.id} onClick={() => setTab('planning')}><span />{f.title}{f.dueChapter && <small>第 {f.dueChapter} 章</small>}</button>)}{!view.state.foreshadows.some(f => ['planned', 'planted'].includes(f.status)) && <p className="hint">故事中的秘密，会被认真记住。</p>}</section>}<div className="context-footnote"><EyeOff size={14} /><p>资料包含尚未揭晓的伏笔与秘密。</p></div></aside> : <aside className="context-sidebar"><Spinner text="正在读取世界资料…" /></aside>}
          </div>
        </>}
        {view && (tab === 'text' ? null : tab === 'world' ? <WorldPanel key={branchId} images={images} imageBusy={imageBusy || dirty || planningDirty || outputDirty} onGenerateImage={openImageRequest} onImageAction={(image, action) => void imageAction(image, action)} focusEntityId={focusEntityId} revisionId={view.branch.revisionId} error={error} entities={worldState.entities} relations={worldState.relations} author busy={busy} onCitation={citation => void openChapter(citation.chapterId, citation)} onSave={async (entity, revision) => !!(await operate(async () => applyView(await put<BranchView>(`/branches/${branchId}/entities/${entity.id}`, { baseRevisionId: revision, entity })), '资料已保存。'))} onDelete={deleteEntity} onMerge={async (fromId, toId, revision) => !!(await operate(async () => applyView(await post<BranchView>(`/branches/${branchId}/entities/merge`, { baseRevisionId: revision, fromId, toId })), '资料已合并。可通过版本历史撤销。'))} /> : tab === 'map' ? <LocationPanel key={branchId} author images={images} imageBusy={imageBusy || dirty || planningDirty || outputDirty} onGenerateImage={openImageRequest} onImageAction={(image, action) => void imageAction(image, action)} entities={worldState.entities} relations={worldState.relations} onCitation={citation => void openChapter(citation.chapterId, citation)} /> : tab === 'images' ? <ImageGallery key={branchId} images={images} entities={worldState.entities} chapters={view.state.chapters} author busy={imageBusy || dirty || planningDirty || outputDirty} onGenerate={openImageRequest} onAction={(image, action) => void imageAction(image, action)} onChapter={openImageChapter} onEntity={openImageEntity} /> : tab === 'planning' ? <PlanningPanel key={branchId} outline={view.state.outline} foreshadows={view.state.foreshadows} chapters={view.state.chapters} entities={worldState.entities} revisionId={view.branch.revisionId} busy={busy || branchBusy} branchId={branchId} jobs={jobs} onJob={job => setJobs(value => [job, ...value.filter(item => item.id !== job.id)])} onCompressed={async value => { await applyView(value); setMessage('已确认压缩摘要，之后的写作会使用这份摘要。'); }} onDirtyChange={setPlanningDirty} onOutline={async (outline, revision) => !!(await operate(async () => applyView(await put<BranchView>(`/branches/${branchId}/outline`, { baseRevisionId: revision, outline: { worldview: outline.worldview, locked: outline.locked } })), '世界观与锁定设定已保存。'))} onForeshadows={async (foreshadows, revision) => !!(await operate(async () => applyView(await put<BranchView>(`/branches/${branchId}/foreshadows`, { baseRevisionId: revision, foreshadows })), '伏笔手记已保存。'))} /> : <section className="data-panel"><div className="panel-heading"><div><span className="eyebrow">BACKGROUND TASKS</span><h2>创作任务</h2><p>任务在服务器继续运行，离开页面也不会丢失进度。</p></div><span className="status-pill">每 2 秒更新</span></div><JobsPanel onWriting={job => void operate(() => resumeGeneration(job))} author onOutputs={job => { setOutputJob(job); }} jobs={jobs} branches={detail?.branches || []} busy={busy} onAction={(job, action) => void operate(async () => { const updated = await post<Job>(`/jobs/${job.id}/${action}?view=author`); setJobs(value => value.map(j => j.id === updated.id ? updated : j)); if (generation?.job.id === updated.id && action === 'resume') { setGeneration(value => value && ({ ...value, job: updated })); setStreamAttempt(value => value + 1); } }, '任务状态已更新。')} /></section>)}
      </main>
    </div>
    {dialog === 'branches' && detail && <Modal title="选择故事线 · 分支树" wide closeDisabled={busy} onClose={() => { if (!busy) setDialog(null); }}><div className="form-stack"><p className="hint">每个节点是一章，共用章节沿同一条线显示。故事线名称在末章下方，点击名称切换故事线，点击章节打开正文；可上下、左右滚动查看。</p><BranchTree branches={detail.branchTree} mainBranchId={detail.project.mainBranchId} currentBranchId={branchId} currentChapterId={chapterId} disabled={busy} onSelect={(id, chapterId) => void changeBranch(id, chapterId)} /></div></Modal>}
    {branchRename?.branchId === branchId && <Modal title="重命名故事线" closeDisabled={busy} onClose={() => { if (!busy) setBranchRename(null); }}><form className="form-stack" onSubmit={submitBranchRename}><label>故事线名称<input aria-label="故事线名称" autoFocus required maxLength={200} value={branchRename.name} onChange={event => setBranchRename(value => value && ({ ...value, name: event.target.value }))} /></label><p className="hint">名称用于识别故事线，正文、资料和正在进行的任务继续保留。</p>{error && <Notice error={error} />}<div className="row end wrap"><button type="button" className="button secondary" disabled={busy} onClick={() => setBranchRename(null)}>取消</button><button className="button primary" type="submit" disabled={busy || !branchRename.name.trim()}>保存名称</button></div></form></Modal>}
    {branchDeletion?.branchId === branchId && <Modal title="删除分支" closeDisabled={busy} onClose={() => { if (!busy) setBranchDeletion(null); }}><div className="form-stack"><p>删除故事线「{branchDeletion.name}」？</p><p className="hint">删除后从故事线列表移除，并返回主线。主线和其他分支保留；其他故事线依赖的历史、原作参考和图片继续保存。此操作不能通过版本回退恢复，完整备份会保留删除状态。</p>{error && <Notice error={error} />}<div className="row end wrap"><button className="button secondary" disabled={busy} onClick={() => setBranchDeletion(null)}>取消</button><button className="button danger" disabled={busy} onClick={() => void submitBranchDeletion()}>{busy ? '正在删除…' : '确认删除分支'}</button></div></div></Modal>}
    {imageRequest?.branchId === branchId && <ImageRequestDialog key={imageRequest.id} target={imageRequest.target} title={imageRequest.title} excerpt={imageRequest.excerpt} reference={images.find(image => image.id === imageRequest.target.referenceImageId)} images={images} busy={imageBusy} error={imageError} onClose={() => { setImageRequest(null); setImageError(''); }} onSubmit={submitImage} />}
    {titleRepair?.branchId === branchId && <Modal title="AI 修复章节标题" wide closeDisabled={titleRepairBusy} onClose={() => { if (!titleRepairBusy) setTitleRepair(null); }}><ChapterTitleRepairPanel key={`${titleRepair.branchId}:${titleRepair.revisionId}`} chapters={titleRepair.chapters} initialChapterId={titleRepair.initialChapterId} onBusy={setTitleRepairBusy} onPreview={(chapterIds, instruction, signal) => api<ChapterTitlePreview>(`/branches/${titleRepair.branchId}/chapter-titles/preview?view=author`, { method: 'POST', signal, body: JSON.stringify({ baseRevisionId: titleRepair.revisionId, chapterIds, instruction }) })} onApply={async changes => {
      const request = titleRepair;
      const value = await post<BranchView>(`/branches/${request.branchId}/chapter-titles/apply?view=author`, { baseRevisionId: request.revisionId, changes });
      if (!mounted.current || current.current.branchId !== request.branchId) return;
      await updateMaterialsView(value);
      if (current.current.chapterId) await fetchChapter(current.current.chapterId, request.branchId, value.branch.revisionId);
      setTitleRepair(null); setTitleRepairBusy(false); setMessage('所选章节标题已修复，可通过版本历史回退。');
    }} /></Modal>}
    {chapterAction?.branchId === branchId && <Modal title={chapterAction.action === 'delete' ? '删除章节' : chapterAction.action === 'clear' ? '清除本章提取资料' : '重新提取本章资料'} closeDisabled={busy} onClose={() => { if (!busy) setChapterAction(null); }}><div className="form-stack"><p>{chapterAction.action === 'delete' ? '从当前故事线删除' : chapterAction.action === 'clear' ? '清除已提取资料：' : '重新提取资料：'}「{chapterAction.title}」{chapterAction.action === 'delete' ? '？' : ''}</p><p className="hint">{chapterAction.action === 'delete' ? '只删除这一章，其他章节保留。本章提取的资料、摘要和关联图片引用会同步移除；人工锁定资料保留，锁定事实的原文引用会解除。' : chapterAction.action === 'extract' ? '正文保留，先清除本章旧的提取资料与摘要，再从头整理；人工锁定的资料和事实保留。' : '正文保留，仅清除本章旧的提取资料与摘要；人工锁定的资料和事实保留。'}历史版本与其他故事线保留，可通过版本回退恢复。后续章节的原有提取结果保留，相关资料视图会同步更新。</p>{chapterAction.action === 'extract' && <p className="hint">只请求本章，按当前资料提取模型、提示词和输出模式处理，可能产生新的模型费用。失败后可在任务页修正或重试；不会重新生成正文。</p>}{chapterAction.action === 'clear' && <p className="hint">本次只清除资料，不调用模型。清除后本章标为待整理，需要完成资料整理后才能继续创作。</p>}{error && <Notice error={error} />}<div className="row end wrap"><button className="button secondary" disabled={busy} onClick={() => setChapterAction(null)}>取消</button><button className={`button ${chapterAction.action === 'extract' ? 'primary' : 'danger'}`} disabled={busy} onClick={() => void submitChapterAction()}>{busy ? '正在处理…' : chapterAction.action === 'delete' ? '确认删除章节' : chapterAction.action === 'clear' ? '确认清除资料' : '开始重新提取'}</button></div></div></Modal>}
    {imageDeletion?.branchId === branchId && <Modal title="删除图片" onClose={() => { if (!imageBusy) { setImageDeletion(null); setImageError(''); } }} closeDisabled={imageBusy}><div className="form-stack"><p>从当前故事线删除「{imageDeletion.image.title}」？</p><p className="hint">历史版本与其他故事线中的引用会保留。你可以之后手动启用其它图片。</p>{imageError && <Notice error={imageError} />}<div className="row end wrap"><button className="button secondary" disabled={imageBusy} onClick={() => { setImageDeletion(null); setImageError(''); }}>取消</button><button className="button danger" disabled={imageBusy} onClick={() => void imageAction(imageDeletion.image, 'delete', imageDeletion.revisionId)}>{imageBusy ? '正在删除…' : '确认删除图片'}</button></div></div></Modal>}
    {outputJob && <ModelOutputsPanel key={outputJob.id} job={jobs.find(job => job.id === outputJob.id) || outputJob} branchName={detail?.branches.find(branch => branch.id === outputJob.branchId)?.name || '故事线'} onDirtyChange={setOutputDirty} onClose={() => { setOutputJob(null); setOutputDirty(false); }} onApplied={updatedJob => { setJobs(value => value.map(job => job.id === updatedJob.id ? updatedJob : job)); setOutputJob(updatedJob); if (current.current.branchId === updatedJob.branchId) void refreshView(updatedJob.branchId).catch(e => setError((e as Error).message)); void refreshMetadata().catch(e => setError((e as Error).message)); }} />}
    {dialog === 'import' && view && <Modal title="导入小说 · 确认原作目录" wide onClose={() => setDialog(null)}><ImportPanel projectId={projectId} branchId={branchId} revisionId={view.branch.revisionId} sources={detail?.sources || []} onUploaded={() => { void refreshMetadata(); }} onImported={job => { setJobs(value => [job, ...value]); setDialog(null); setTab('jobs'); void refreshMetadata(); void refreshView(branchId); }} /></Modal>}
    {dialog === 'generate' && view && <Modal title={regenerating ? '重新生成这一章 · 自动建立分支' : generationMode === 'rpg' ? '穿越小说 · RPG 体验' : '让故事继续生长'} onClose={() => !busy && setDialog(null)}><form className="form-stack" onSubmit={generate}>
      <label>创作方式<select aria-label="创作方式" value={generationMode} disabled={!!view.state.rpg} onChange={e => setGenerationMode(e.target.value as Mode)}>{Object.entries(modeNames).map(([key, label]) => <option key={key} value={key} disabled={(key === 'rewrite' && !chapterId) || (key === 'rpg' && regenerating)}>{label}</option>)}</select></label>
      {generationMode === 'rpg' && (newRpg || !view.state.rpg) && <RpgSetupFields value={rpgSetup} onChange={value => { rpgCharacterDrafts.current[value.character.kind] = value.character; setRpgSetup(value); }} onCharacterKind={kind => setRpgSetup(value => ({ ...value, character: rpgCharacterDrafts.current[kind] }))} entities={worldState.entities} chapters={view.state.chapters} />}
      {generationMode === 'rpg' && !newRpg && view.state.rpg && <p className="notice">继续以「{view.state.rpg.character.name}」的身份体验小说。关键剧情会等待你的选择。要回到常规创作，可以切回原故事线。</p>}
      {regenerating && <p className="notice">将从「{chapter?.title}」之前建立新故事线并重新创作这一章，当前正文会保留在原线。</p>}
      {!regenerating && generationMode === 'rewrite' && <p className="notice">改写「{chapter?.title}」{selection ? `中选定的 ${selection.end - selection.start} 个字符` : '整章'}。将建立独立修订线，当前正文会保留。</p>}
      {createsGenerationBranch && <label>新故事线名称<input aria-label="新故事线名称" required maxLength={200} value={newBranchName} onChange={event => setGenerationBranchName(event.target.value)} /><span className="hint">开始生成时使用这个名字，之后也可以重命名。</span></label>}
      <label>章节标题（可选）<input value={generationTitle} onChange={e => setGenerationTitle(e.target.value)} placeholder="留空时根据本章正文自动起名" /></label><p className="hint">留空时，正文保存后会调用一次写作模型为本章起名；手动填写时直接使用。</p><label>这一次，你想写什么？<textarea aria-label="这一次，你想写什么？" rows={5} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder={generationMode === 'rpg' ? '你想探索哪里，或希望从怎样的场景开始？' : '推进哪段情节、采用谁的视角，或者有什么需要特别保留的设定？'} /></label><label>目标字数<input type="number" min={200} max={20000} step={100} value={maxWords} onChange={e => setMaxWords(Number(e.target.value))} /></label><p className="hint">开始后会打开这一章并逐步显示正文。写作上下文包含世界观、主要角色、未揭晓伏笔、最近几章全文和剧情摘要；更早正文、原作后续剧情与其他资料由模型按关键词和章节行号按需查询。正文保存后在后台整理人物、剧情摘要与伏笔。</p>{error && <Notice error={error} />}<button className="button primary" type="submit" disabled={busy || (createsGenerationBranch && !newBranchName.trim()) || (generationMode === 'rewrite' && !chapterId) || (generationMode === 'rpg' && (newRpg || !view.state.rpg) && (!rpgSetup.character.name.trim() || (rpgSetup.character.kind === 'existing' && !worldState.entities.some(entity => entity.id === rpgSetup.character.entityId))))}><Sparkles size={16} />{busy ? '正在提交…' : generationMode === 'rpg' ? newRpg || !view.state.rpg ? '开始体验' : '继续体验' : '开始生成'}</button>
    </form></Modal>}
    {dialog === 'regenerate-background' && <Modal title="这一章的资料还在后台整理" onClose={() => setDialog(null)}><div className="form-stack"><p>正文已经保存。人物资料、剧情摘要或伏笔尚未整理完成，你可以等待完成后重新生成，也可以放弃当前后台整理，在新故事线上重新生成。</p><p className="hint">原故事线与已保存正文会保留。放弃整理后，尚未完成的资料不会继续应用到原线。</p><div className="row end wrap"><button className="button secondary" onClick={() => { setDialog(null); setMessage('继续等待资料整理完成，完成后可点击重新生成。'); }}>等待后台整理</button><button className="button primary" onClick={() => { setDiscardBackground(true); setDialog('generate'); }}>放弃后台任务并重新生成</button></div></div></Modal>}
    {dialog === 'fork' && view && <Modal title="从这里，让故事走向另一条路" onClose={() => !busy && setDialog(null)}><form className="form-stack" onSubmit={submitFork}><label>新故事线名称<input autoFocus required maxLength={200} value={forkName} onChange={e => setForkName(e.target.value)} /></label><label>从哪一章的结尾出发<select value={forkChapterId} onChange={e => setForkChapterId(e.target.value)}><option value="">当前故事线结尾</option>{view.state.chapters.map(ch => <option key={ch.id} value={ch.id}>{ch.title}</option>)}</select></label><p className="hint">只继承截至这一章的正文与资料；原线保留，后续事件不会提前发生。</p>{error && <Notice error={error} />}<button className="button primary" type="submit" disabled={busy || !forkName.trim()}><GitBranch size={16} />建立故事线</button></form></Modal>}
    {dialog === 'history' && view && <Modal title="故事的版本历史" onClose={() => !busy && setDialog(null)}><p className="muted">每次修改都留下记录。回退将同时恢复正文、人物状态、剧情摘要、规划和伏笔。</p><div className="revision-list">{view.revisions.map(revision => <div className="revision-item" key={revision.id}><span className={`revision-dot ${revision.id === view.branch.revisionId ? 'current' : ''}`} /><div><strong>{revision.label}</strong><small>{dateText(revision.createdAt)} · {revision.chapterCount} 章</small></div>{revision.id === view.branch.revisionId ? <span className="status-pill completed">当前</span> : <button className="button secondary small" disabled={busy} onClick={() => { if (!window.confirm(`回退到“${revision.label}”？正文与世界资料将一起恢复。`)) return; void operate(async () => { await applyView(await post<BranchView>(`/branches/${branchId}/rollback`, { baseRevisionId: view.branch.revisionId, revisionId: revision.id }), true); setDialog(null); }, '已恢复所选版本。'); }}>回退</button>}</div>)}</div>{error && <Notice error={error} />}</Modal>}
    {dialog === 'search' && <Modal title="搜索这个故事世界" onClose={() => setDialog(null)}><form className="search-form" onSubmit={doSearch}><label className="search-input"><Search size={17} /><input aria-label="搜索正文和资料" autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="人物、地点，或一段原文…" /></label><button className="button primary" disabled={searchBusy || !search.trim()}>搜索</button></form><p className="hint">搜索当前故事线的完整正文与资料，包含秘密资料。</p>{searchBusy ? <Spinner /> : searchResult && <div className="search-results">{!searchResult.chapters.length && !searchResult.entities.length ? <Empty icon={<Search size={25} />} title="没有找到对应线索">试试更短的关键词或人物别名。</Empty> : <>{searchResult.chapters.map(ch => <button key={ch.id} onClick={() => { setDialog(null); void openChapter(ch.id); }}><span className="eyebrow">正文</span><strong>{ch.title}</strong><p>{ch.snippet}</p></button>)}{searchResult.entities.map(e => <button key={e.id} onClick={() => { setDialog(null); changeTab('world'); }}><span className="eyebrow">世界资料</span><strong>{e.name}</strong><p>{e.description}</p></button>)}</>}</div>}</Modal>}
  </div></ImageCacheProvider>;
}
