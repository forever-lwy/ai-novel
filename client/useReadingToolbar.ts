import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject, type UIEvent } from 'react';

const interactive = 'button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"]';
const usesTouchLayout = () => window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;

export function useReadingToolbar(enabled: boolean, scope: string, reader: RefObject<HTMLDivElement | null>) {
  const [collapsed, setCollapsed] = useState(false);
  const [fullScreenScope, setFullScreenScope] = useState<string | null>(null);
  const [exitVisible, setExitVisible] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  const position = useRef({ top: 0, distance: 0, lastScroll: 0, userScrollUntil: 0 });
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean; started: number } | null>(null);
  const pendingPosition = useRef<{ top: number; offset: number } | null>(null);
  const previousLayout = useRef<{ scope: string; fullscreen: boolean; top: number; offset: number } | null>(null);
  const entryButton = useRef<HTMLButtonElement | null>(null);
  const readingFullscreen = enabled && !mobileLayout && fullScreenScope === scope;
  const toolbarHidden = enabled && (mobileLayout ? collapsed : readingFullscreen);

  function changeFullScreen(value: boolean) {
    const element = reader.current;
    if (element) pendingPosition.current = { top: element.scrollTop, offset: element.getBoundingClientRect().top + parseFloat(getComputedStyle(element).paddingTop) };
    setFullScreenScope(value ? scope : null); setExitVisible(false);
  }

  useLayoutEffect(() => {
    const element = reader.current;
    if (!element) return;
    const layout = previousLayout.current;
    const previous = pendingPosition.current ?? (layout?.scope === scope && layout.fullscreen !== readingFullscreen ? layout : null);
    pendingPosition.current = null;
    // Removing the header and chapter-start clearance must not move the paragraph
    // currently being read. At the chapter start, clamp to the new top instead.
    const offset = element.getBoundingClientRect().top + parseFloat(getComputedStyle(element).paddingTop);
    if (previous) {
      element.scrollTop = !readingFullscreen && previous.top === 0 ? 0 : Math.max(0, previous.top + offset - previous.offset);
      if (!readingFullscreen && enabled) entryButton.current?.focus({ preventScroll: true });
    }
    previousLayout.current = { scope, fullscreen: readingFullscreen, top: element.scrollTop, offset };
  }, [readingFullscreen, scope, enabled, reader]);

  useEffect(() => {
    setCollapsed(false);
    setFullScreenScope(null); setExitVisible(false); pendingPosition.current = null;
    position.current = { top: 0, distance: 0, lastScroll: 0, userScrollUntil: 0 };
    pointer.current = null;
  }, [enabled, scope]);

  useEffect(() => {
    const reveal = () => { setCollapsed(false); position.current.distance = 0; position.current.userScrollUntil = 0; };
    const resize = () => {
      const mobile = window.matchMedia('(max-width: 760px)').matches;
      setMobileLayout(mobile); reveal();
      if (mobile) { setFullScreenScope(null); setExitVisible(false); }
    };
    const keydown = (event: KeyboardEvent) => {
      if (window.matchMedia('(max-width: 760px)').matches) reveal();
      else if (readingFullscreen && event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]') && !document.fullscreenElement) {
        event.preventDefault(); changeFullScreen(false);
      }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', keydown);
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('keydown', keydown); };
  }, [readingFullscreen]);

  function onReadingScroll(event: UIEvent<HTMLDivElement>) {
    const top = Math.max(0, event.currentTarget.scrollTop);
    const delta = top - position.current.top;
    position.current.top = top;
    if (previousLayout.current?.scope === scope) previousLayout.current.top = top;
    if (!enabled || !mobileLayout || !delta) return;
    const now = performance.now();
    position.current.lastScroll = now;
    // Chapter navigation and RPG choices also scroll the text automatically.
    // Only a reader's wheel or drag, including its momentum, may hide the bars.
    if (now > position.current.userScrollUntil) { position.current.distance = 0; return; }
    position.current.userScrollUntil = now + 300;
    if (!window.getSelection()?.isCollapsed) return;
    const distance = position.current.distance;
    position.current.distance = Math.sign(delta) === Math.sign(distance) ? distance + delta : delta;
    // Ignore small scroll jitter, and keep a focused or open toolbar usable.
    if (Math.abs(position.current.distance) < 20) return;
    const workspace = event.currentTarget.closest('.workspace');
    if (workspace?.querySelector('[data-reading-toolbar] :focus-visible, [data-reading-toolbar] details[open]')) return;
    setCollapsed(true);
    position.current.distance = 0;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || !mobileLayout || event.button !== 0 || !(event.target as Element).closest('.manuscript-wrap')) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, started: performance.now() };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = pointer.current;
    if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
      start.moved = true; position.current.userScrollUntil = performance.now() + 300;
    }
    if (!readingFullscreen || event.pointerType !== 'mouse') return;
    setExitVisible(event.clientY - event.currentTarget.getBoundingClientRect().top <= 48 || !!(event.target as Element).closest('.reading-fullscreen-exit'));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = pointer.current; pointer.current = null;
    if (!enabled || !toolbarHidden || !usesTouchLayout() || !start || start.id !== event.pointerId || start.moved) return;
    const now = performance.now();
    if (now - start.started > 500 || now - position.current.lastScroll < 220) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    const target = event.target as Element;
    if (!target.closest('.manuscript-wrap') || target.closest(interactive) || !window.getSelection()?.isCollapsed) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    if (x >= 0.2 && x <= 0.8 && y >= 0.25 && y <= 0.75) setCollapsed(false);
  }

  return {
    toolbarHidden,
    headerHidden: toolbarHidden,
    readingFullscreen,
    exitVisible,
    canEnterFullscreen: enabled && !mobileLayout,
    enterFullscreen: (button: HTMLButtonElement) => {
      if (!enabled || mobileLayout) return;
      entryButton.current = button; button.blur(); changeFullScreen(true);
    },
    exitFullscreen: () => changeFullScreen(false),
    readingScrollPosition: () => {
      const element = reader.current; const top = element?.scrollTop ?? 0;
      if (!readingFullscreen || !element || top === 0) return top;
      const workspace = element.closest('.workspace')!;
      const style = getComputedStyle(workspace);
      return top + parseFloat(style.getPropertyValue('--workspace-header-height')) + parseFloat(style.getPropertyValue('--workspace-toolbar-height'));
    },
    onReadingScroll,
    readingEvents: {
      onPointerDownCapture: onPointerDown,
      onPointerMove,
      onPointerUp,
      onWheelCapture: (event: UIEvent<HTMLDivElement>) => { if (enabled && mobileLayout && (event.target as Element).closest('.manuscript-wrap')) position.current.userScrollUntil = performance.now() + 300; },
      onPointerCancel: () => { pointer.current = null; },
      onPointerLeave: () => { setExitVisible(false); pointer.current = null; },
    },
  };
}
