import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { ImageOff, LoaderCircle } from 'lucide-react';
import { ImageContentCache } from './image-cache';

const ImageCacheContext = createContext<{ cache: ImageContentCache; scope: string } | null>(null);

export function ImageCacheProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const [cache] = useState(() => new ImageContentCache());
  const value = useMemo(() => ({ cache, scope }), [cache, scope]);
  useEffect(() => () => cache.clear(), [cache]);
  return <ImageCacheContext.Provider value={value}>{children}</ImageCacheContext.Provider>;
}

/** All image surfaces share bytes, while the scope keeps author/reader/version boundaries separate. */
export function CachedImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  const context = useContext(ImageCacheContext);
  if (!context || !props.src) return <img {...props} />;
  const cacheKey = JSON.stringify([context.scope, props.src]);
  return <LoadedImage key={cacheKey} {...props} source={props.src} cache={context.cache} cacheKey={cacheKey} />;
}

function LoadedImage({ source, cache, cacheKey, ...props }: ImgHTMLAttributes<HTMLImageElement> & { source: string; cache: ImageContentCache; cacheKey: string }) {
  const element = useRef<HTMLImageElement>(null);
  // Pin the entry in the layout effect before assigning its URL to the DOM.
  const [url, setUrl] = useState<string>();
  const [visible, setVisible] = useState(() => props.loading !== 'lazy' || !!cache.peek(cacheKey));
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (visible) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '300px' });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [visible]);

  useLayoutEffect(() => {
    if (!visible) return;
    let alive = true;
    const lease = cache.acquire(cacheKey, source);
    setUrl(lease.url); setFailed(false);
    void lease.ready.then(value => { if (alive) setUrl(value); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; lease.release(); };
  }, [cache, cacheKey, source, visible]);

  const state = failed ? 'failed' : loaded ? 'loaded' : 'pending';
  return <span className="cached-image" data-image-load-state={state} aria-busy={state === 'pending'}>
    <img {...props} ref={element} src={url} data-image-source={source} data-image-load-state={state} title={failed ? '图片加载失败，重新打开可重试' : props.title} onLoad={event => { setLoaded(true); props.onLoad?.(event); }} onError={event => { cache.invalidate(cacheKey); setFailed(true); props.onError?.(event); }} />
    {state !== 'loaded' && <span className="cached-image-status" role="status" title={failed ? '关闭后重新打开可重试' : undefined}>{failed ? <ImageOff size={20} aria-hidden="true" /> : <LoaderCircle size={20} className="spin" aria-hidden="true" />}<span>{failed ? '图片加载失败' : '图片加载中…'}</span></span>}
  </span>;
}
