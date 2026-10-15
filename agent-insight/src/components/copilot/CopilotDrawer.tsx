'use client';

import { type ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bot, ChevronDown, ChevronRight, FileText, ImagePlus, Loader2, MessageSquare, Plus, Send, Settings2, Sparkles, X } from 'lucide-react';
import { useAuth } from '@/lib/auth/auth-context';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Context = {
  pageType?: string;
  objectType?: string;
  objectId?: string;
  version?: number;
  caseId?: string;
  snapshot?: { title?: string; summary?: string };
};
type ChatMessage = { role: 'user' | 'assistant'; content: string };
type ImageAttachment = { name: string; mimeType: string; dataUrl: string };
type Source = { id: string; kind: string; label: string; locator: string; href?: string };
type Preview = {
  previewId: string;
  action: 'trace_to_dataset' | 'evaluator_draft' | 'run_filter';
  target: string;
  changes: Record<string, unknown>;
  sources: Source[];
  missing: string[];
  expiresAt: string;
  confirmationToken: string;
};

const suggestions = [
  '这条 Trace 里模型、工具和 Skill 分别做了什么？',
  '解释当前对象的关键问题',
  '帮我定位一个失败步骤',
];

export default function CopilotDrawer() {
  const { user, apiKey } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [showTraceSteps, setShowTraceSteps] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState('当前活动模型');
  const requestRef = useRef<AbortController | null>(null);
  const [context, setContext] = useState<Context>(() => {
    if (typeof window === 'undefined') return {};
    const value = (window as Window & { __AGENT_INSIGHT_COPILOT_CONTEXT__?: Context }).__AGENT_INSIGHT_COPILOT_CONTEXT__;
    if (value && typeof value === 'object') return value;
    const query = new URLSearchParams(window.location.search);
    const taskId = query.get('taskId');
    return taskId ? { pageType: 'trace', objectType: 'task', objectId: taskId } : {};
  });

  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<Context>).detail;
      if (detail && typeof detail === 'object') setContext(detail);
    };
    window.addEventListener('agent-insight:copilot-context', receive);
    return () => window.removeEventListener('agent-insight:copilot-context', receive);
  }, []);

  useEffect(() => {
    requestRef.current?.abort();
  }, [pathname]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const hasObject = Boolean(context.objectId);
  const objectLabel = useMemo(() => {
    if (context.snapshot?.title) return context.snapshot.title;
    if (context.objectId) return `${context.objectType || '对象'} · ${context.objectId}`;
    return '当前页面无对象';
  }, [context.objectId, context.objectType, context.snapshot?.title]);

  async function sendMessage(event?: FormEvent, preset?: string) {
    event?.preventDefault();
    const message = (preset ?? input).trim();
    if (!message || busy) return;
    setInput('');
    setError('');
    setBusy(true);
    setMessages(current => [...current, { role: 'user', content: message }]);
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    try {
      const response = await fetch('/api/copilot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-witty-api-key': apiKey } : {}) },
        body: JSON.stringify({ message, context, user, images: attachments }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error || 'Copilot 请求失败'));
      setMessages(current => [...current, { role: 'assistant', content: String(payload.answer || '没有生成可用回答。') }]);
      setSources(Array.isArray(payload.sources) ? payload.sources : []);
      setShowTraceSteps(false);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      const text = cause instanceof Error ? cause.message : 'Copilot 请求失败';
      setError(text);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []).filter(file => /^image\/(png|jpeg|webp|gif)$/i.test(file.type)).slice(0, 4);
    const loaded = await Promise.all(files.map(file => new Promise<ImageAttachment>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, mimeType: file.type, dataUrl: String(reader.result || '') });
      reader.onerror = () => reject(new Error(`读取图片失败：${file.name}`));
      reader.readAsDataURL(file);
    })));
    setAttachments(loaded);
    event.target.value = '';
  }

  async function createPreview(action: Preview['action']) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/copilot/workflows/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, context, input: {} }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error || '无法生成工作流草稿'));
      setPreview(payload.preview || null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法生成工作流草稿');
    } finally {
      setBusy(false);
    }
  }

  async function confirmPreview() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/copilot/workflows/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: preview.action, confirmationToken: preview.confirmationToken, input: {} }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error || '确认执行失败'));
      setMessages(current => [...current, { role: 'assistant', content: `已完成：${String(payload.message || preview.target || '工作流已写入')}` }]);
      setPreview(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '确认执行失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!open && (
        <button type="button" aria-label="打开助手" onClick={() => setOpen(true)} style={styles.fab}>
          <Bot size={22} strokeWidth={2.2} />
          <span style={styles.fabDot} />
        </button>
      )}
      {open && (
        <aside style={styles.drawer} aria-label="助手">
          <header style={styles.header}>
            <div style={styles.brand}><span style={styles.brandIcon}><Sparkles size={16} /></span></div>
            <div style={styles.headerActions}>
              <button type="button" aria-label="新会话" title="新会话" onClick={() => { setMessages([]); setSources([]); setShowTraceSteps(false); setPreview(null); setError(''); setAttachments([]); }} style={styles.iconButton}><Plus size={17} /></button>
              <button type="button" aria-label="关闭 Copilot" title="关闭" onClick={() => setOpen(false)} style={styles.iconButton}><X size={17} /></button>
            </div>
          </header>

          <div className="copilot-scroll" style={styles.body}>
            <div style={styles.contextPill}><span style={{ ...styles.statusDot, background: hasObject ? '#5ee6a8' : '#9aa4b2' }} />{objectLabel}</div>
            {messages.length === 0 && !error && (
              <section style={styles.welcome}>
                <div style={styles.welcomeIcon}><MessageSquare size={22} /></div>
                <h2 style={styles.title}>今天想一起看什么？</h2>
                <p style={styles.description}>询问当前 Trace、数据集、评估结果和 Skills，回答会引用页面中的证据。</p>
                <div style={styles.suggestions}>{suggestions.map(item => <button type="button" key={item} onClick={() => sendMessage(undefined, item)} style={styles.suggestion}>{item}<ChevronRight size={14} /></button>)}</div>
                <div style={styles.workflowRow}>
                  <button type="button" onClick={() => void createPreview('trace_to_dataset')} style={styles.workflowButton}>Trace → 数据集</button>
                  <button type="button" onClick={() => void createPreview('evaluator_draft')} style={styles.workflowButton}>评估器草稿</button>
                  <button type="button" onClick={() => void createPreview('run_filter')} style={styles.workflowButton}>运行筛选</button>
                </div>
              </section>
            )}
            {messages.map((message, index) => <div key={`${message.role}-${index}`} style={{ ...styles.message, alignSelf: message.role === 'user' ? 'flex-end' : 'stretch' }}><div style={message.role === 'user' ? styles.userBubble : styles.assistantBubble}>{message.role === 'assistant' ? <div className="copilot-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div> : message.content}</div></div>)}
            {busy && <div style={styles.loading}><Loader2 size={15} className="copilot-spin" /> 正在分析当前上下文…</div>}
            {error && <div style={styles.errorCard}><div style={styles.errorText}>{/请先登录/i.test(error) ? '请先登录 Agent Insight 后再使用。' : (/401|api key|apikey|invalid.*key|模型连接/i.test(error) ? '模型 API Key 无效或已过期，请打开模型设置重新连接。' : error)}</div>{/请先登录|401|api key|apikey|invalid.*key|模型连接/i.test(error) && <a href="/modelconfig/registry" style={styles.settingsLink}><Settings2 size={14} /> 模型设置</a>}</div>}
            {sources.length > 0 && (() => {
              const traceSteps = sources.filter(source => source.kind === 'trace-step');
              const summarySources = sources.filter(source => source.kind !== 'trace-step');
              return <section style={styles.sources}>
                <div style={styles.sectionLabel}>来源</div>
                {summarySources.map(source => <a href={source.href || '#'} key={source.id} style={styles.source}><FileText size={14} /><span>{source.label}</span><span style={styles.sourceLocator}>{source.locator}</span></a>)}
                {traceSteps.length > 0 && <button type="button" onClick={() => setShowTraceSteps(value => !value)} style={styles.sourceToggle} aria-expanded={showTraceSteps}>{showTraceSteps ? '收起执行步骤' : `展开执行步骤（${traceSteps.length}）`}<ChevronRight size={13} style={{ transform: showTraceSteps ? 'rotate(90deg)' : 'none' }} /></button>}
                {showTraceSteps && traceSteps.map(source => <a href={source.href || '#'} key={source.id} style={styles.source}><FileText size={14} /><span>{source.label}</span><span style={styles.sourceLocator}>{source.locator}</span></a>)}
              </section>;
            })()}
            {preview && <section style={styles.preview}><div style={styles.sectionLabel}>工作流草稿 · {preview.target}</div><pre style={styles.previewJson}>{JSON.stringify(preview.changes, null, 2)}</pre>{preview.missing.length > 0 && <div style={styles.missing}>还缺少：{preview.missing.join('、')}</div>}<div style={styles.previewActions}><button type="button" onClick={() => setPreview(null)} style={styles.secondaryButton}>取消</button><button type="button" disabled={busy || preview.missing.length > 0} onClick={confirmPreview} style={styles.primaryButton}>确认写入</button></div></section>}
          </div>

          <footer style={styles.footer}>
            <div style={styles.footerMeta}><span><span style={{ ...styles.statusDot, background: hasObject ? '#5ee6a8' : '#9aa4b2' }} />{hasObject ? '当前对象已连接' : '等待页面对象'}</span><a href="/modelconfig" aria-label="模型设置" title="模型设置" style={styles.footerSettings}><Settings2 size={14} /></a></div>
            {attachments.length > 0 && <div style={styles.attachmentList}>{attachments.map((file, index) => <span key={`${file.name}-${index}`} style={styles.attachment}>{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments(current => current.filter((_, itemIndex) => itemIndex !== index))} style={styles.removeAttachment}><X size={11} /></button></span>)}</div>}
            <form onSubmit={sendMessage} style={styles.composer}>
              <textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="询问当前页面…" rows={1} style={styles.textarea} />
              <div style={styles.composerToolbar}>
                <label aria-label="上传图片" title="上传图片" style={styles.attachButton}><ImagePlus size={16} /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={handleFiles} /></label>
                <div style={styles.modelPicker}><button type="button" aria-haspopup="listbox" aria-expanded={modelMenuOpen} onClick={() => setModelMenuOpen(value => !value)} style={styles.modelButton}><span style={styles.modelDot} />{selectedModel}<ChevronDown size={13} /></button>{modelMenuOpen && <div style={styles.modelMenu} role="listbox"><div style={styles.modelMenuLabel}>选择模型</div>{['GPT-4o', 'Gemini 2.5 Pro', 'Claude Sonnet', 'MiniMax', 'DeepSeek'].map(model => <button type="button" role="option" aria-selected={selectedModel === model} key={model} onClick={() => { setSelectedModel(model); setModelMenuOpen(false); }} style={styles.modelOption}>{model}</button>)}<a href="/modelconfig/registry" style={styles.manageModels}><Settings2 size={13} /> 管理模型连接</a></div>}</div>
                <a href="/modelconfig/registry" aria-label="模型设置" title="模型设置" style={styles.footerSettings}><Settings2 size={14} /></a>
                <button type="submit" disabled={busy || (!input.trim() && attachments.length === 0)} aria-label="发送" title="发送" style={styles.sendButton}><Send size={17} /></button>
              </div>
            </form>
          </footer>
        </aside>
      )}
      <style jsx global>{`@keyframes copilot-slide-in { from { transform: translateX(100%); opacity: .7; } to { transform: translateX(0); opacity: 1; } } .copilot-scroll { scrollbar-width: thin; scrollbar-color: #485174 transparent; } .copilot-scroll::-webkit-scrollbar { width: 7px; } .copilot-scroll::-webkit-scrollbar-track { background: transparent; } .copilot-scroll::-webkit-scrollbar-thumb { background: #485174; border-radius: 8px; } .copilot-scroll::-webkit-scrollbar-thumb:hover { background: #6876bd; } .copilot-spin { animation: copilot-spin .9s linear infinite; } @keyframes copilot-spin { to { transform: rotate(360deg); } } .copilot-markdown { font-size: inherit; line-height: inherit; overflow-wrap: anywhere; } .copilot-markdown > :first-child { margin-top: 0; } .copilot-markdown > :last-child { margin-bottom: 0; } .copilot-markdown p { margin: 7px 0; } .copilot-markdown strong { font-weight: 700; color: var(--foreground); } .copilot-markdown em { font-style: italic; } .copilot-markdown h1, .copilot-markdown h2, .copilot-markdown h3 { margin: 10px 0 6px; font-size: 14px; font-weight: 700; color: var(--foreground); } .copilot-markdown ul, .copilot-markdown ol { margin: 7px 0 7px 19px; padding: 0; } .copilot-markdown li { margin: 3px 0; } .copilot-markdown blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid var(--primary); color: var(--foreground-secondary); } .copilot-markdown code { padding: 1px 4px; border-radius: 4px; background: var(--background-secondary); font-size: .92em; } .copilot-markdown pre { margin: 8px 0; padding: 9px; overflow-x: auto; border-radius: 6px; background: var(--background-secondary); } .copilot-markdown pre code { padding: 0; background: transparent; } .copilot-markdown a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; } .copilot-markdown table { width: 100%; margin: 8px 0; border-collapse: collapse; font-size: 12px; } .copilot-markdown th, .copilot-markdown td { border: 1px solid var(--border); padding: 5px 6px; text-align: left; } .copilot-markdown th { background: var(--background-secondary); font-weight: 700; }`}</style>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  fab: { position: 'fixed', right: 24, bottom: 24, zIndex: 1000, width: 50, height: 50, border: '0', borderRadius: '50%', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'grid', placeItems: 'center', cursor: 'pointer', boxShadow: '0 10px 28px var(--shadow-color-lg)' },
  fabDot: { position: 'absolute', right: 3, top: 3, width: 9, height: 9, borderRadius: '50%', background: 'var(--success)', border: '2px solid var(--primary)' },
  drawer: { position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 1000, width: 'min(420px, 100vw)', background: 'var(--background)', color: 'var(--foreground)', display: 'flex', flexDirection: 'column', boxShadow: '-18px 0 45px var(--shadow-color-lg)', animation: 'copilot-slide-in .28s cubic-bezier(.22,1,.36,1)' },
  header: { height: 64, flexShrink: 0, padding: '0 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  brand: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
  brandIcon: { width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--primary)', color: 'var(--primary-foreground)' },
  subtle: { marginTop: 3, color: 'var(--foreground-muted)', fontSize: 11 },
  headerActions: { display: 'flex', gap: 4 },
  iconButton: { border: 0, background: 'transparent', color: 'var(--foreground-muted)', cursor: 'pointer', padding: 7, borderRadius: 7 },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 16px 22px', display: 'flex', flexDirection: 'column', gap: 12 },
  contextPill: { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--foreground-muted)', fontSize: 12, paddingBottom: 4 },
  statusDot: { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 5 },
  welcome: { padding: '36px 6px 16px', textAlign: 'center' },
  welcomeIcon: { margin: '0 auto 15px', width: 46, height: 46, borderRadius: 14, display: 'grid', placeItems: 'center', background: 'var(--primary-subtle)', color: 'var(--primary)' },
  title: { margin: '0 0 9px', fontSize: 20, fontWeight: 650, letterSpacing: 0 },
  description: { margin: '0 auto', maxWidth: 315, color: 'var(--foreground-muted)', fontSize: 13, lineHeight: 1.65 },
  suggestions: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 24, textAlign: 'left' },
  workflowRow: { display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' },
  workflowButton: { border: '1px solid #3a4260', background: 'transparent', color: '#aeb8df', borderRadius: 6, padding: '6px 8px', cursor: 'pointer', fontSize: 11 },
  suggestion: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground)', borderRadius: 9, padding: '11px 12px', fontSize: 12, cursor: 'pointer' },
  message: { maxWidth: '92%', display: 'flex' },
  userBubble: { background: 'var(--primary)', color: 'var(--primary-foreground)', borderRadius: '12px 12px 3px 12px', padding: '10px 12px', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' },
  assistantBubble: { background: 'var(--card-bg)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: '12px 12px 12px 3px', padding: '11px 12px', fontSize: 13, lineHeight: 1.65, width: '100%', overflowWrap: 'anywhere' },
  loading: { color: 'var(--foreground-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 7, padding: '4px 3px' },
  errorCard: { border: '1px solid var(--error-subtle-border)', background: 'var(--error-subtle)', borderRadius: 9, padding: 12, color: 'var(--error)' },
  errorTitle: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 },
  errorText: { color: 'var(--error)', fontSize: 12, lineHeight: 1.55 },
  settingsLink: { display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 9, color: 'var(--primary)', fontSize: 12, textDecoration: 'none' },
  sources: { borderTop: '1px solid var(--border)', paddingTop: 10 },
  sectionLabel: { color: 'var(--foreground-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 7 },
  source: { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--foreground-secondary)', fontSize: 12, padding: '6px 0', textDecoration: 'none' },
  sourceToggle: { display: 'flex', alignItems: 'center', gap: 5, width: '100%', border: 0, background: 'transparent', color: 'var(--primary)', padding: '7px 0', cursor: 'pointer', fontSize: 12, textAlign: 'left' },
  sourceLocator: { marginLeft: 'auto', color: 'var(--foreground-muted)', fontSize: 11, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  preview: { border: '1px solid var(--primary-subtle-border)', borderRadius: 9, background: 'var(--primary-subtle)', padding: 11 },
  previewJson: { margin: 0, color: 'var(--foreground-secondary)', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' },
  missing: { color: 'var(--warning)', fontSize: 12, marginTop: 8 },
  previewActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  secondaryButton: { border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground-secondary)', borderRadius: 6, padding: '7px 10px', cursor: 'pointer', fontSize: 12 },
  primaryButton: { border: 0, background: 'var(--primary)', color: 'var(--primary-foreground)', borderRadius: 6, padding: '7px 10px', cursor: 'pointer', fontSize: 12 },
  footer: { flexShrink: 0, padding: '10px 14px 14px', borderTop: '1px solid var(--border)', background: 'var(--background)' },
  footerMeta: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--foreground-muted)', fontSize: 11, marginBottom: 8 },
  footerSettings: { display: 'grid', placeItems: 'center', color: 'var(--primary)', padding: 4 },
  composer: { display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid var(--primary)', borderRadius: 10, background: 'var(--input-bg)', padding: '7px 7px 6px 11px' },
  textarea: { width: '100%', resize: 'none', outline: 'none', border: 0, background: 'transparent', color: 'var(--foreground)', fontSize: 13, lineHeight: 1.5, minHeight: 22, maxHeight: 100, fontFamily: 'inherit' },
  composerToolbar: { display: 'flex', alignItems: 'center', gap: 6 },
  attachButton: { display: 'grid', placeItems: 'center', width: 28, height: 28, color: 'var(--foreground-muted)', cursor: 'pointer', borderRadius: 6 },
  attachmentList: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  attachment: { display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 180, padding: '4px 6px', borderRadius: 6, background: 'var(--primary-subtle)', color: 'var(--foreground-secondary)', fontSize: 11 },
  removeAttachment: { display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: 'var(--foreground-muted)', cursor: 'pointer', padding: 1 },
  modelPicker: { position: 'relative', marginLeft: 'auto' },
  modelButton: { display: 'flex', alignItems: 'center', gap: 5, border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--foreground-secondary)', padding: '5px 7px', fontSize: 11, cursor: 'pointer' },
  modelDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' },
  modelMenu: { position: 'absolute', right: 0, bottom: 'calc(100% + 7px)', zIndex: 20, minWidth: 190, padding: 6, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--card-bg)', boxShadow: '0 12px 32px var(--shadow-color-lg)' },
  modelMenuLabel: { padding: '5px 7px', color: 'var(--foreground-muted)', fontSize: 10, textTransform: 'uppercase' },
  modelOption: { display: 'block', width: '100%', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--foreground)', padding: '7px', textAlign: 'left', fontSize: 12, cursor: 'pointer' },
  manageModels: { display: 'flex', alignItems: 'center', gap: 5, borderTop: '1px solid var(--border)', marginTop: 4, padding: '8px 7px 4px', color: 'var(--primary)', textDecoration: 'none', fontSize: 11 },
};
