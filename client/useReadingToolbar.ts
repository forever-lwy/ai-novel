import { useEffect, useRef, useState, type PointerEvent, type UIEvent } from 'react';

const interactive = 'button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"]';
const usesTouchLayout = () => window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;

export function useReadingToolbar(enabled: boolean, scope: string) {
  const [collapsed, setCollapsed] = useState(false);
  const position = useRef({ top: 0, distance: 0, lastScroll: 0, userScrollUntil: 0 });
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean; started: number } | null>(null);
  const nearToolbar = useRef(false);
  const toolbarHidden = enabled && collapsed;

  useEffect(() => {
    setCollapsed(false);
    position.current = { top: 0, distance: 0, lastScroll: 0, userScrollUntil: 0 };
    pointer.current = null;
    nearToolbar.current = false;
  }, [enabled, scope]);

  useEffect(() => {
    const reveal = () => { setCollapsed(false); position.current.distance = 0; position.current.userScrollUntil = 0; };
    window.addEventListener('resize', reveal);
    window.addEventListener('keydown', reveal);
    return () => { window.removeEventListener('resize', reveal); window.removeEventListener('keydown', reveal); };
  }, []);

  function onReadingScroll(event: UIEvent<HTMLDivElement>) {
    const top = Math.max(0, event.currentTarget.scrollTop);
    const delta = top - position.current.top;
    position.current.top = top;
    if (!enabled || !delta) return;
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
    if (!usesTouchLayout() && (delta < 0 || nearToolbar.current || top === 0)) setCollapsed(false);
    else setCollapsed(true);
    position.current.distance = 0;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || event.button !== 0 || !(event.target as Element).closest('.manuscript-wrap')) return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, started: performance.now() };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = pointer.current;
    if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
      start.moved = true; position.current.userScrollUntil = performance.now() + 300;
    }
    if (!enabled || usesTouchLayout() || event.pointerType !== 'mouse') return;
    nearToolbar.current = event.clientY - event.currentTarget.getBoundingClientRect().top < 90 || !!(event.target as Element).closest('[data-reading-toolbar]');
    if (nearToolbar.current) setCollapsed(false);
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
    onReadingScroll,
    readingEvents: {
      onPointerDownCapture: onPointerDown,
      onPointerMove,
      onPointerUp,
      onWheelCapture: (event: UIEvent<HTMLDivElement>) => { if (enabled && (event.target as Element).closest('.manuscript-wrap')) position.current.userScrollUntil = performance.now() + 300; },
      onPointerCancel: () => { pointer.current = null; },
      onPointerLeave: () => { nearToolbar.current = false; pointer.current = null; },
    },
  };
}
