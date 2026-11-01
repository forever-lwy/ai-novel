import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RotateCcw, Upload, X } from 'lucide-react';
import { Notice } from './ui';
import { appearanceFonts, appearancePalette, defaultAppearance, getAppearance, getAppearanceState, MAX_BACKGROUND_BYTES, normalizeAppearance, saveAppearance, subscribeAppearance, type AppearanceColors, type AppearanceFont, type AppearanceSettings } from './appearance';

function Slider({ label, value, min, max, step = 1, unit = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="appearance-slider"><span>{label}<output>{value}{unit}</output></span><input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} /></label>;
}

export function AppearancePanel() {
  const { settings, error: storageError } = useSyncExternalStore(subscribeAppearance, getAppearanceState);
  const [imageError, setImageError] = useState('');
  const [uploading, setUploading] = useState(false);
  const uploadSequence = useRef(0);
  useEffect(() => () => { ++uploadSequence.current; }, []);
  const palette = appearancePalette(settings, document.documentElement.dataset.theme === 'dark');
  function update(patch: Partial<AppearanceSettings>) { saveAppearance({ ...getAppearance(), ...patch }); }
  function fontControl(label: string, key: 'readerFont' | 'interfaceFont', customKey: 'readerCustomFont' | 'interfaceCustomFont') {
    return <div className="form-stack"><label>{label}<select aria-label={label} value={settings[key]} onChange={event => update({ [key]: event.target.value as AppearanceFont })}>{appearanceFonts.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}</select></label>{settings[key] === 'custom' && <label>自定义{label}<input aria-label={`自定义${label}`} maxLength={100} value={settings[customKey]} onChange={event => update({ [customKey]: event.target.value })} placeholder="例如：霞鹜文楷" /></label>}</div>;
  }
  async function upload(file?: File) {
    if (!file) return;
    const sequence = ++uploadSequence.current;
    setImageError('');
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > MAX_BACKGROUND_BYTES) {
      setImageError('请选择不超过 1 MiB 的 PNG、JPG、WebP 或 GIF 图片。'); return;
    }
    setUploading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败，请重新选择。')); reader.readAsDataURL(file);
      });
      const image = new Image(); image.src = data; await image.decode();
      if (sequence === uploadSequence.current) update({ backgroundImage: data });
    } catch { if (sequence === uploadSequence.current) setImageError('图片无法读取，请选择一张有效的图片。'); }
    finally { if (sequence === uploadSequence.current) setUploading(false); }
  }
  function clearImage() { ++uploadSequence.current; setUploading(false); setImageError(''); update({ backgroundImage: '' }); }
  return <section className="appearance-panel form-stack" aria-label="外观设置">
    <div className="settings-section-heading"><h2>外观</h2><p>修改立即生效，自动保存在当前浏览器。电脑和手机可各自设置，适用于所有作品。</p></div>
    <section className="appearance-card form-stack" aria-labelledby="appearance-colors-title">
      <h3 id="appearance-colors-title">主题与背景</h3>
      <div className="form-grid"><label>主题模式<select aria-label="主题模式" value={settings.mode} onChange={event => update({ mode: event.target.value as AppearanceSettings['mode'], colors: {} })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>配色方案<select aria-label="配色方案" value={settings.palette} onChange={event => update({ palette: event.target.value as AppearanceSettings['palette'], colors: {} })}><option value="default">默认米白</option><option value="paper">暖色纸张</option><option value="green">柔和护眼绿</option></select></label></div>
      <p className="hint">切换主题或配色会重置自定义颜色。深色模式使用夜间配色；字号与排版保持不变。</p>
      <div className="appearance-colors">{([
        ['background', '页面背景'], ['surface', '正文与面板背景'], ['text', '文字颜色'], ['accent', '主题色'],
      ] as const).map(([key, label]) => <label key={key}>{label}<span><input type="color" aria-label={label} value={palette[key]} onChange={event => update({ colors: { ...getAppearance().colors, [key]: event.target.value } as AppearanceColors })} /><code>{palette[key].toUpperCase()}</code></span></label>)}</div>
      <div className="appearance-upload"><label className={`button secondary ${uploading ? 'disabled' : ''}`}><Upload size={15} />{uploading ? '正在读取图片…' : '上传背景图片'}<input className="visually-hidden" aria-label="上传背景图片" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={uploading} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} /></label>{(settings.backgroundImage || uploading) && <button type="button" className="text-button" onClick={clearImage}><X size={15} />移除背景图片</button>}</div>
      <p className="hint">支持不超过 1 MiB 的 PNG、JPG、WebP、GIF，图片仅保存在当前浏览器。降低背景不透明度，可透过正文纸张看到背景图。</p>
      {settings.backgroundImage && <img className="appearance-background-thumbnail" src={settings.backgroundImage} alt="当前背景图片" />}
      <Slider label="背景不透明度" value={settings.paperOpacity} min={60} max={100} unit="%" onChange={paperOpacity => update({ paperOpacity })} />
      {imageError && <Notice error={imageError} />}
    </section>
    <section className="appearance-card form-stack" aria-labelledby="appearance-font-title"><h3 id="appearance-font-title">字体与排版</h3>
      <div className="form-grid">{fontControl('正文字体', 'readerFont', 'readerCustomFont')}{fontControl('界面字体', 'interfaceFont', 'interfaceCustomFont')}</div>
      <p className="hint">字体需已安装在当前设备上；不可用时使用备用字体。正文字体、字号同时应用到阅读、生成正文和正文编辑框。</p>
      <div className="form-grid">
        <Slider label="正文字号" value={settings.fontSize} min={12} max={40} unit=" px" onChange={fontSize => update({ fontSize })} />
        <Slider label="界面缩放" value={settings.uiScale} min={90} max={125} step={5} unit="%" onChange={uiScale => update({ uiScale })} />
        <Slider label="正文行距" value={settings.lineHeight} min={1.2} max={3} step={0.1} unit=" 倍" onChange={lineHeight => update({ lineHeight })} />
        <Slider label="字间距" value={settings.letterSpacing} min={0} max={5} step={0.1} unit=" px" onChange={letterSpacing => update({ letterSpacing })} />
        <Slider label="段落间距" value={settings.paragraphSpacing} min={0} max={40} unit=" px" onChange={paragraphSpacing => update({ paragraphSpacing })} />
        <Slider label="正文宽度" value={settings.contentWidth} min={560} max={1200} step={10} unit=" px" onChange={contentWidth => update({ contentWidth })} />
        <Slider label="左右留白" value={settings.horizontalPadding} min={12} max={80} unit=" px" onChange={horizontalPadding => update({ horizontalPadding })} />
        <label>正文粗细<select aria-label="正文粗细" value={settings.fontWeight} onChange={event => update({ fontWeight: event.target.value as AppearanceSettings['fontWeight'] })}><option value="400">正常</option><option value="500">中等</option><option value="600">加粗</option></select></label>
        <label>正文对齐<select aria-label="正文对齐" value={settings.textAlign} onChange={event => update({ textAlign: event.target.value as AppearanceSettings['textAlign'] })}><option value="left">左对齐</option><option value="justify">两端对齐</option></select></label>
        <label className="checkbox"><input type="checkbox" aria-label="首行缩进" checked={settings.indent} onChange={event => update({ indent: event.target.checked })} />首行缩进两个字</label>
      </div>
      <p className="hint">正文宽度是上限，小屏幕会自动适应。手机上的左右留白会适当收窄。段落间距和首行缩进只影响阅读排版。</p>
    </section>
    <section className="appearance-card appearance-preview" aria-label="外观预览"><h3>正文预览</h3><div className="appearance-preview-paper"><div className="prose"><p>傍晚的光穿过窗棂，落在摊开的书页上。远处传来脚步声，新的故事正从这里开始。</p><p>你可以在这里查看字体、颜色和段落排版，找到适合自己的阅读方式。</p></div></div></section>
    {storageError ? <Notice error={storageError} /> : <p className="notice success" role="status">已自动保存到当前浏览器。</p>}
    <div className="appearance-reset"><p className="hint">恢复默认会清除自定义颜色、背景图和排版设置。</p><button type="button" className="button secondary" onClick={() => { ++uploadSequence.current; setUploading(false); setImageError(''); saveAppearance(normalizeAppearance(defaultAppearance)); }}><RotateCcw size={15} />恢复默认外观</button></div>
  </section>;
}
