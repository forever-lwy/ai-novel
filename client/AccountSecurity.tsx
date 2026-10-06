import { useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, LogOut } from 'lucide-react';
import { post } from './api';
import { Notice } from './ui';

export function AccountSecurity({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [revokePassword, setRevokePassword] = useState('');
  const [busy, setBusy] = useState<'password' | 'sessions' | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  function clearPasswords() { setCurrentPassword(''); setPassword(''); setConfirm(''); setRevokePassword(''); }
  async function submit(event: FormEvent, action: 'password' | 'sessions') {
    event.preventDefault(); if (busy) return;
    setError(''); setMessage('');
    if (action === 'password' && password !== confirm) { setError('两次输入的新密码不一致。'); return; }
    setBusy(action); onBusyChange?.(true);
    try {
      if (action === 'password') await post('/auth/password', { currentPassword, password });
      else await post('/auth/sessions/revoke', { password: revokePassword });
      clearPasswords(); setMessage(action === 'password' ? '登录密码已修改，其他登录已退出。当前页面保持登录。' : '其他登录已退出。当前页面保持登录。');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(null); onBusyChange?.(false); }
  }
  return <section className="account-security form-stack" data-settings-section="account" aria-label="账号安全设置" aria-busy={!!busy}>
    <div className="settings-section-heading"><h2>账号安全</h2><p>管理工作台的登录密码，或让其他设备退出登录。</p></div>
    <div aria-live="polite">{error && <Notice error={error} />}{message && <div className="notice success" role="status"><CheckCircle2 size={17} />{message}</div>}</div>
    <form className="account-security-card form-stack" aria-label="修改登录密码" onSubmit={event => void submit(event, 'password')}>
      <h3>修改登录密码</h3><p className="hint">新密码至少 12 位，避免常见弱密码。修改后，其他设备需要重新登录。</p>
      <fieldset className="settings-section-fields form-stack" disabled={!!busy}>
        <label>当前密码<input type="password" required minLength={8} maxLength={256} autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label>
        <label>新密码<input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
        <label>确认新密码<input type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
        <button type="submit" className="button primary align-start" disabled={!!busy}><KeyRound size={16} />{busy === 'password' ? '正在修改…' : '修改密码'}</button>
      </fieldset>
    </form>
    <form className="account-security-card form-stack" aria-label="退出其他登录" onSubmit={event => void submit(event, 'sessions')}>
      <h3>退出其他登录</h3><p className="hint">让其他浏览器和设备重新登录，当前页面继续使用。</p>
      <fieldset className="settings-section-fields form-stack" disabled={!!busy}>
        <label>验证当前密码<input type="password" required minLength={8} maxLength={256} autoComplete="current-password" value={revokePassword} onChange={event => setRevokePassword(event.target.value)} /></label>
        <button type="submit" className="button secondary align-start" disabled={!!busy}><LogOut size={16} />{busy === 'sessions' ? '正在退出…' : '退出其他登录'}</button>
      </fieldset>
    </form>
  </section>;
}
