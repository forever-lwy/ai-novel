import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Expand, Info, Maximize, Minimize, Scan, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { StoryImage } from '../shared/types';

type ChromeEdge = 'top' | 'bottom';

export function ImageViewer({ image, onClose, children, initialDetailsOpen = false, detailsLabel = '生图详情' }: { image: StoryImage; onClose: () => void; children?: ReactNode; initialDetailsOpen?: boolean; detailsLabel?: string }) {
  const dialog = useRef<HTMLDialogElement>(null); const panel = useRef<HTMLDivElement>(null); const viewport = useRef<HTMLDivElement>(null);
  const detailsId = useId(); const [detailsOpen, setDetailsOpen] = useState(initialDetailsOpen);
  const [natural, setNatural] = useState({ width: 0, height: 0 }); const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1); const [fit, setFit] = useState(true); const [fullMode, setFullMode] = useState<'none' | 'native' | 'page'>('none');
  const [chromeVisible, setChromeVisible] = useState({ top: true, bottom: true }); const [chromeMenu, setChromeMenu] = useState<'title' | 'zoom' | null>(null);
  const hideTimers = useRef<{ top?: number; bottom?: number }>({}); const nearEdges = useRef({ top: false, bottom: false });
  const keyboardMode = useRef(false); const heldEdge = useRef<ChromeEdge | null>(null); const lastPointer = useRef('mouse');
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null); const closing = useRef(false); const alive = useRef(true);
  const fullScreen = fullMode !== 'none';
  const scale = fit && natural.width && available.width ? Math.min(available.width / natural.width, available.height / natural.height, 1) : zoom;
  const rendered = { width: natural.width * scale, height: natural.height * scale };

  function clearHide(edge: ChromeEdge) { window.clearTimeout(hideTimers.current[edge]); delete hideTimers.current[edge]; }
  function reveal(edge: ChromeEdge) { clearHide(edge); setChromeVisible(value => value[edge] ? value : { ...value, [edge]: true }); }
  function edgeOf(target: EventTarget | null): ChromeEdge | undefined { return target instanceof Element ? target.closest<HTMLElement>('[data-image-chrome-edge]')?.dataset.imageChromeEdge as ChromeEdge | undefined : undefined; }
  function hideLater(edge: ChromeEdge) {
    clearHide(edge); if (!fullScreen) return;
    hideTimers.current[edge] = window.setTimeout(() => {
      delete hideTimers.current[edge];
      if (!alive.current || closing.current || panel.current?.dataset.fullscreenMode === 'none' || nearEdges.current[edge] || heldEdge.current === edge || keyboardMode.current && edgeOf(document.activeElement) === edge) return;
      setChromeVisible(value => ({ ...value, [edge]: false }));
      setChromeMenu(value => value === (edge === 'top' ? 'title' : 'zoom') ? null : value);
    }, 1500);
  }
  function movePointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (!fullScreen || event.pointerType !== 'mouse' || event.buttons || drag.current) return;
    keyboardMode.current = false;
    const bounds = event.currentTarget.getBoundingClientRect(); const edge = edgeOf(event.target);
    nearEdges.current = { top: event.clientY <= bounds.top + 80 || edge === 'top', bottom: event.clientY >= bounds.bottom - 80 || edge === 'bottom' };
    for (const side of ['top', 'bottom'] as const) if (nearEdges.current[side]) reveal(side); else if (hideTimers.current[side] === undefined) hideLater(side);
  }

  useEffect(() => {
    const element = dialog.current; const shell = panel.current; alive.current = true; element?.showModal();
    const changed = () => { if (alive.current && !closing.current) { setFullMode(document.fullscreenElement === shell ? 'native' : 'none'); setDetailsOpen(false); } };
    document.addEventListener('fullscreenchange', changed);
    return () => { alive.current = false; document.removeEventListener('fullscreenchange', changed); element?.close(); if (shell && document.fullscreenElement === shell) void document.exitFullscreen().catch(() => undefined); };
  }, []);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const resized = () => setAvailable({ width: Math.max(1, element.clientWidth - 24), height: Math.max(1, element.clientHeight - 24) });
    const observer = new ResizeObserver(resized); observer.observe(element); resized(); return () => observer.disconnect();
  }, [image.status, image.url]);
  useEffect(() => {
    clearHide('top'); clearHide('bottom'); nearEdges.current = { top: false, bottom: false }; setChromeMenu(null);
    if (!fullScreen) setChromeVisible({ top: true, bottom: true });
    else {
      const focused = keyboardMode.current ? edgeOf(document.activeElement) : undefined;
      const touch = lastPointer.current !== 'mouse'; setChromeVisible({ top: touch || focused === 'top', bottom: touch || focused === 'bottom' });
      if (touch) { hideLater('top'); hideLater('bottom'); }
    }
    return () => { clearHide('top'); clearHide('bottom'); };
  }, [fullMode]);
  useEffect(() => {
    if (fullMode !== 'page') return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFullMode('none'); setDetailsOpen(false); } };
    window.addEventListener('keydown', escape, true); return () => window.removeEventListener('keydown', escape, true);
  }, [fullMode]);

  async function leaveFullScreen() { if (document.fullscreenElement === panel.current) await document.exitFullscreen().catch(() => undefined); if (alive.current) { setFullMode('none'); setDetailsOpen(false); } }
  async function close() { if (closing.current) return; closing.current = true; await leaveFullScreen(); onClose(); }
  async function toggleFullScreen() {
    if (fullMode !== 'none' || document.fullscreenElement === panel.current) { await leaveFullScreen(); return; }
    setDetailsOpen(false);
    const element = panel.current;
    try { if (!element?.requestFullscreen) throw new Error('Fullscreen unavailable'); await element.requestFullscreen(); if (!alive.current || closing.current) { if (document.fullscreenElement === element) await document.exitFullscreen().catch(() => undefined); return; } setFullMode('native'); }
    catch { if (alive.current && !closing.current) setFullMode('page'); }
  }
  function setScale(value: number) { setFit(false); setZoom(Math.max(0.01, Math.min(4, value))); }
  function resetFit() { setFit(true); if (viewport.current) { viewport.current.scrollTop = 0; viewport.current.scrollLeft = 0; } }

  return <dialog ref={dialog} className="modal image-viewer-modal" data-testid="image-viewer" onCancel={event => { event.preventDefault(); if (fullMode !== 'none' || document.fullscreenElement === panel.current) void leaveFullScreen(); else void close(); }} onClick={event => { if (event.target === dialog.current) void close(); }}>
    <div ref={panel} className={`image-viewer-panel ${fullMode === 'page' ? 'is-page-fullscreen' : ''}`} data-fullscreen-mode={fullMode} data-chrome-top={chromeVisible.top ? 'visible' : 'hidden'} data-chrome-bottom={chromeVisible.bottom ? 'visible' : 'hidden'}
      onPointerMove={movePointer} onPointerLeave={() => { if (!fullScreen) return; nearEdges.current = { top: false, bottom: false }; hideLater('top'); hideLater('bottom'); }}
      onPointerDownCapture={event => { keyboardMode.current = false; lastPointer.current = event.pointerType; heldEdge.current = edgeOf(event.target) ?? null; if (fullScreen && event.pointerType !== 'mouse') { nearEdges.current = { top: false, bottom: false }; reveal('top'); reveal('bottom'); hideLater('top'); hideLater('bottom'); } }}
      onPointerUp={event => { heldEdge.current = null; if (event.pointerType === 'mouse') movePointer(event); else if (fullScreen) { hideLater('top'); hideLater('bottom'); } }}
      onPointerCancel={() => { heldEdge.current = null; if (fullScreen) { hideLater('top'); hideLater('bottom'); } }}
      onKeyDownCapture={event => { if (event.key === 'Escape') return; keyboardMode.current = true; if (!fullScreen) return; const edge = edgeOf(event.target); if (edge) reveal(edge); else { reveal('top'); reveal('bottom'); hideLater('top'); hideLater('bottom'); } }}
      onFocusCapture={event => { if (fullScreen && (keyboardMode.current || event.target.matches(':focus-visible'))) { keyboardMode.current = true; const edge = edgeOf(event.target); if (edge) reveal(edge); } }}
      onBlurCapture={event => { const edge = edgeOf(event.target); if (fullScreen && edge && edgeOf(event.relatedTarget) !== edge) hideLater(edge); }}>
      <div className="image-viewer-heading" data-image-chrome-edge="top">
        <h2>{image.title}</h2>
        <div className="image-viewer-title-control"><button className="icon-button" aria-label="查看图片标题" title="查看图片标题" aria-expanded={chromeMenu === 'title'} onClick={() => setChromeMenu(value => value === 'title' ? null : 'title')}><Info size={18} /></button>{chromeMenu === 'title' && <div className="image-viewer-title-popover">{image.title}</div>}</div>
        <div className="image-viewer-heading-actions">{children && <button className="text-button" aria-label={detailsLabel} title={detailsOpen ? '收起详情' : detailsLabel} aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(value => !value)}>{detailsOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span className="image-viewer-control-text">{detailsOpen ? '收起详情' : detailsLabel}</span></button>}<button className="icon-button" aria-label="关闭图片查看器" title="关闭图片查看器" onClick={() => void close()}><X size={20} /></button></div>
      </div>
      {image.url && image.status === 'completed' && <><div className="image-viewer-controls" data-image-chrome-edge="bottom">
        <div className="row"><button className="icon-button" aria-label="缩小图片" title="缩小图片" disabled={scale <= 0.01} onClick={() => setScale(scale - 0.25)}><ZoomOut size={18} /></button>
          {fullScreen ? <button className="image-viewer-zoom-button" aria-label="设置图片缩放" title="设置图片缩放" aria-expanded={chromeMenu === 'zoom'} onClick={() => setChromeMenu(value => value === 'zoom' ? null : 'zoom')}><output className="image-zoom-value" aria-label="图片缩放比例">{scale < 0.01 ? (scale * 100).toFixed(1) : Math.round(scale * 100)}%</output></button> : <output className="image-zoom-value" aria-label="图片缩放比例">{scale < 0.01 ? (scale * 100).toFixed(1) : Math.round(scale * 100)}%</output>}
          <button className="icon-button" aria-label="放大图片" title="放大图片" disabled={scale >= 4} onClick={() => setScale(scale + 0.25)}><ZoomIn size={18} /></button>
          {(!fullScreen || chromeMenu === 'zoom') && <div className={fullScreen ? 'image-viewer-zoom-popover' : 'image-viewer-zoom-inline'}><input type="range" min={1} max={400} step={1} aria-label="调整图片缩放" value={Math.min(400, Math.max(1, Math.round(scale * 100)))} onChange={event => setScale(Number(event.target.value) / 100)} /></div>}
        </div>
        <div className="row wrap"><button className="text-button" aria-label="适应窗口" title="适应窗口" onClick={resetFit}><Scan size={18} /><span className="image-viewer-control-text">适应窗口</span></button><button className="text-button" aria-label="原始大小" title="原始大小" onClick={() => setScale(1)}><Expand size={18} /><span className="image-viewer-control-text">原始大小</span></button><button className="text-button" aria-label={fullMode === 'page' ? '退出页面全屏' : fullMode === 'native' ? '退出全屏' : '全屏查看图片'} title={fullScreen ? '退出全屏' : '全屏查看图片'} onClick={() => void toggleFullScreen()}>{fullMode === 'none' ? <Maximize size={18} /> : <Minimize size={18} />}<span className="image-viewer-control-text">{fullMode === 'page' ? '退出页面全屏' : fullMode === 'native' ? '退出全屏' : '全屏查看'}</span></button></div>
      </div>
        <div ref={viewport} className="image-viewer-viewport" aria-label="可滚动的图片区域" tabIndex={0} onPointerDown={event => { if (event.pointerType !== 'mouse' || event.button !== 0) return; drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (!drag.current) return; event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX; event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY; }} onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { drag.current = null; }}>
          <div className="image-viewer-canvas" style={{ width: Math.max(rendered.width + 24, available.width + 24), height: Math.max(rendered.height + 24, available.height + 24) }}><img className="image-viewer-image" src={image.url} alt={image.title} draggable={false} onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} style={natural.width ? { width: rendered.width, height: rendered.height } : undefined} /></div>
        </div></>}
      {children && detailsOpen && <div id={detailsId} className="image-viewer-details" data-image-chrome-edge="top">{children}</div>}
    </div>
  </dialog>;
}
