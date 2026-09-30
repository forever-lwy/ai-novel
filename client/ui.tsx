import { useEffect, useRef, type ReactNode } from 'react';
import { LoaderCircle, X, Feather } from 'lucide-react';

export function Brand({ small = false }: { small?: boolean }) {
  return <span className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-symbol"><Feather size={small ? 18 : 22} strokeWidth={1.6} /></span><span>墨境<small>AI NOVEL</small></span></span>;
}
export function Spinner({ text = '正在加载…' }: { text?: string }) { return <div className="loading" role="status"><LoaderCircle className="spin" size={20} />{text}</div>; }
export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); const el = ref.current; return () => el?.close(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><X size={20} /></button></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}
export function Notice({ error, onClose }: { error: string; onClose?: () => void }) {
  return <div className="notice error" role="alert"><span>{error}</span>{onClose && <button className="icon-button" aria-label="关闭提示" onClick={onClose}><X size={16} /></button>}</div>;
}
