'use client';

import { type ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bot, Check, FileText, ImagePlus, Loader2, Search, Send, Settings2, X } from 'lucide-react';
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
type Source = { id: string; kind: string; label: string; locator: string; href?: string; excerpt?: string };
type CopilotPlan = {
  id: string;
  goal: string;
  requiresConfirmation: boolean;
  steps: Array<{
    id: string;
    title: string;
    tool: string;
    kind: 'read' | 'write' | 'analyze';
    status: 'pending' | 'in_progress' | 'done' | 'blocked';
    requiresConfirmation: boolean;
  }>;
};
type ModelConfig = {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};
type ModelOption = ModelConfig & {
  scope: 'recommended' | 'workspace';
  isDefault: boolean;
  providerLabel: string;
  providerMark: string;
};
type Preview = {
  previewId: string;
  action: 'trace_to_dataset' | 'dataset_create' | 'evaluator_draft' | 'run_filter' | 'dataset_delete' | 'experiment_start' | 'skill_publish';
  target: string;
  changes: Record<string, unknown>;
  sources: Source[];
  missing: string[];
  expiresAt: string;
  confirmationToken: string;
};

const providerMeta: Record<string, { label: string; mark: string }> = {
  'deepseek-official': { label: 'DeepSeek', mark: 'DS' },
  openai: { label: 'OpenAI', mark: 'OA' },
  anthropic: { label: 'Anthropic', mark: 'AN' },
  siliconflow: { label: 'SiliconFlow', mark: 'SF' },
  custom: { label: 'Custom', mark: 'CX' },
};

function modelOption(config: ModelConfig, activeConfigId: string | null): ModelOption {
  const meta = providerMeta[config.provider || 'custom'] || { label: config.provider || 'Model', mark: 'AI' };
  return {
    ...config,
    scope: config.id.startsWith('default_') ? 'recommended' : 'workspace',
    isDefault: config.id === activeConfigId,
    providerLabel: meta.label,
    providerMark: meta.mark,
  };
}

function RoboExpandIcon({ size = 14 }: { size?: number }) {
  return (
    <span className="copilot-robo-icon" aria-hidden="true">
      <Bot size={size} strokeWidth={2.1} />
    </span>
  );
}

function formatSourceExcerpt(value?: string) {
  if (!value?.trim()) return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const fields = Object.entries(parsed).slice(0, 4).map(([key, item]) => {
        const text = typeof item === 'string' ? item : JSON.stringify(item);
        return `${key}: ${text}`;
      });
      return fields.join(' · ').slice(0, 360);
    }
  } catch {
    // Trace content can be plain text; use the compact representation below.
  }
  return compact.slice(0, 360);
}

function ModelGroup({
  label,
  models,
  selectedModelId,
  onSelect,
}: {
  label: string;
  models: ModelOption[];
  selectedModelId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section style={styles.modelGroup}>
      <div style={styles.modelGroupLabel}>{label}</div>
      {models.map(model => (
        <button
          type="button"
          className="copilot-model-option"
          role="option"
          aria-selected={selectedModelId === model.id}
          key={model.id}
          onClick={() => onSelect(model.id)}
          style={styles.modelOption}
        >
          <span style={styles.modelOptionIcon}>{model.providerMark}</span>
          <span style={styles.modelOptionBody}>
            <span style={styles.modelOptionName}>{model.name}</span>
            <span style={styles.modelOptionMeta}>{model.providerLabel}{model.model ? ` · ${model.model}` : ''}</span>
          </span>
          {model.isDefault && <span style={styles.modelBadge}>默认</span>}
          {selectedModelId === model.id && <Check size={15} style={styles.modelCheck} />}
        </button>
      ))}
    </section>
  );
}

export default function CopilotDrawer() {
  const { user, apiKey } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [plan, setPlan] = useState<CopilotPlan | null>(null);
  const [showTraceSteps, setShowTraceSteps] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [modelConfigs, setModelConfigs] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  const hydratedStorageKeyRef = useRef<string | null>(null);
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

  useEffect(() => {
    if (pathname === '/dataset' && context.pageType !== 'dataset') {
      setContext({ pageType: 'dataset', objectType: 'unknown' });
    }
  }, [context.pageType, pathname]);

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const loadingTimer = window.setTimeout(() => {
      if (!cancelled) setModelsLoading(true);
    }, 0);
    fetch(`/api/eval/settings?user=${encodeURIComponent(user)}`)
      .then(response => response.ok ? response.json() : Promise.reject(new Error('model settings unavailable')))
      .then(payload => {
        if (cancelled) return;
        const configs = Array.isArray(payload?.configs) ? payload.configs as ModelConfig[] : [];
        const activeId = typeof payload?.activeConfigId === 'string' ? payload.activeConfigId : null;
        const options = configs.filter(config => config.id && config.name && config.model).map(config => modelOption(config, activeId));
        setModelConfigs(options);
        setSelectedModelId(current => current && options.some(option => option.id === current)
          ? current
          : activeId && options.some(option => option.id === activeId)
            ? activeId
            : options[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setModelConfigs([]);
          setSelectedModelId(null);
        }
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(loadingTimer);
    };
  }, [user]);

  // Keep the current Copilot conversation when navigating between pages.
  useEffect(() => {
    if (typeof window === 'undefined' || !user) return;
    const storageKey = `agent-insight-copilot-${user}`;
    hydratedStorageKeyRef.current = null;
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        const saved = raw ? JSON.parse(raw) as { messages?: ChatMessage[]; sources?: Source[]; scrollTop?: number } : null;
        setMessages(Array.isArray(saved?.messages) ? saved.messages : []);
        setSources(Array.isArray(saved?.sources) ? saved.sources : []);
        scrollTopRef.current = typeof saved?.scrollTop === 'number' && Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : 0;
      } catch {
        setMessages([]);
        setSources([]);
      }
      hydratedStorageKeyRef.current = storageKey;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [user]);

  useEffect(() => {
    const storageKey = hydratedStorageKeyRef.current;
    if (typeof window === 'undefined' || !storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ messages, sources, scrollTop: scrollTopRef.current }));
    } catch {
      // Keep the in-memory conversation if browser storage is unavailable.
    }
  }, [messages, sources]);

  useEffect(() => {
    if (!open) return;
    let firstFrame = 0;
    let secondFrame = 0;
    const restore = () => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTop = Math.min(scrollTopRef.current, Math.max(0, element.scrollHeight - element.clientHeight));
    };
    firstFrame = window.requestAnimationFrame(() => {
      restore();
      secondFrame = window.requestAnimationFrame(restore);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [open]);

  function rememberScrollPosition() {
    const value = scrollRef.current?.scrollTop;
    if (typeof value === 'number' && Number.isFinite(value)) scrollTopRef.current = Math.max(0, value);
    const storageKey = hydratedStorageKeyRef.current;
    if (!storageKey || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      const saved = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      window.localStorage.setItem(storageKey, JSON.stringify({ ...saved, messages, sources, scrollTop: scrollTopRef.current }));
    } catch {
      // Keep the position in memory if browser storage is unavailable.
    }
  }

  function openDrawer() {
    setClosing(false);
    setOpen(true);
  }

  function closeDrawer() {
    rememberScrollPosition();
    setClosing(true);
    window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 240);
  }

  const hasObject = Boolean(context.objectId);
  const objectLabel = useMemo(() => {
    if (context.snapshot?.title) return context.snapshot.title;
    if (context.objectId) return `${context.objectType || '对象'} · ${context.objectId}`;
    return '当前页面无对象';
  }, [context.objectId, context.objectType, context.snapshot?.title]);
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return modelConfigs;
    return modelConfigs.filter(model => [model.name, model.model, model.providerLabel].some(value => value?.toLowerCase().includes(query)));
  }, [modelConfigs, modelQuery]);
  const recommendedModels = filteredModels.filter(model => model.scope === 'recommended');
  const workspaceModels = filteredModels.filter(model => model.scope === 'workspace');
  const selectedModel = modelConfigs.find(model => model.id === selectedModelId);

  async function sendMessage(event?: FormEvent, preset?: string) {
    event?.preventDefault();
    const message = (preset ?? input).trim();
    if (!message || busy) return;
    setInput('');
    setError('');
    setPlan(null);
    setBusy(true);
    setMessages(current => [...current, { role: 'user', content: message }]);
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    try {
      const response = await fetch('/api/copilot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-witty-api-key': apiKey } : {}) },
        body: JSON.stringify({ message, context, user, images: attachments, modelConfigId: selectedModelId }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error || 'Copilot 请求失败'));
      setMessages(current => [...current, { role: 'assistant', content: String(payload.answer || '没有生成可用回答。') }]);
      setSources(Array.isArray(payload.sources) ? payload.sources : []);
      if (payload.preview && !payload.workflowResult) setPreview(payload.preview as Preview);
      if (payload.workflowResult) setPreview(null);
      if (payload.workflowResult && payload.preview?.action === 'evaluator_draft') {
        setMessages(current => [...current, { role: 'assistant', content: `评估器草稿已创建：${payload.preview.target}` }]);
      }
      if (payload.react?.status === 'awaiting_confirmation' && Array.isArray(payload.react.proposedActions) && payload.react.proposedActions.length > 0) {
        setMessages(current => [...current, { role: 'assistant', content: `诊断已完成，等待确认：${payload.react.proposedActions.join('；')}` }]);
      }
      setPlan(payload.plan && Array.isArray(payload.plan.steps)
        ? payload.plan as CopilotPlan
        : payload.react && Array.isArray(payload.react.steps)
          ? {
              id: `react-${Date.now()}`,
              goal: '有界 Trace 诊断循环',
              requiresConfirmation: true,
              steps: payload.react.steps.map((step: { id: string; tool: string; summary: string; status: string }) => ({
                id: step.id,
                title: step.summary,
                tool: step.tool,
                kind: 'analyze' as const,
                status: step.status === 'done' ? 'done' as const : 'blocked' as const,
                requiresConfirmation: false,
              })),
            }
          : null);
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

  async function createPreview(action: Preview['action'], input: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/copilot/workflows/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-witty-api-key': apiKey } : {}) },
        body: JSON.stringify({ action, context, input, user }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error || '无法生成工作流草稿'));
      const nextPreview = payload.preview as Preview | null;
      if (action === 'evaluator_draft' && nextPreview) {
        const confirmResponse = await fetch('/api/copilot/workflows/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-witty-api-key': apiKey } : {}) },
          body: JSON.stringify({ action, confirmationToken: nextPreview.confirmationToken, input: {}, user }),
        });
        const confirmPayload = await confirmResponse.json().catch(() => ({}));
        if (!confirmResponse.ok) throw new Error(String(confirmPayload.error || '评估器草稿创建失败'));
        setMessages(current => [...current, { role: 'assistant', content: `评估器草稿已创建：${nextPreview.target}` }]);
        setPreview(null);
      } else {
        setPreview(nextPreview);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法生成工作流草稿');
    } finally {
      setBusy(false);
    }
  }

  async function confirmPreview() {
    if (!preview || preview.action === 'run_filter') return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/copilot/workflows/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-witty-api-key': apiKey } : {}) },
        body: JSON.stringify({ action: preview.action, confirmationToken: preview.confirmationToken, input: {}, user }),
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
        <button type="button" aria-label="打开助手" onClick={openDrawer} style={styles.fab}>
          <Bot size={22} strokeWidth={2.2} />
          <span style={styles.fabDot} />
        </button>
      )}
      {(open || closing) && (
        <aside style={{ ...styles.drawer, animation: closing ? 'copilot-fade-out .24s ease forwards' : styles.drawer.animation }} aria-label="助手">
          <header style={styles.header}>
            <div style={styles.headerActions}>
              <button type="button" aria-label="关闭 Copilot" title="关闭" onClick={closeDrawer} style={styles.iconButton}><X size={17} /></button>
            </div>
          </header>

          <div ref={scrollRef} className="copilot-scroll" style={styles.body} onScroll={() => {
            const value = scrollRef.current?.scrollTop;
            if (typeof value === 'number' && Number.isFinite(value)) scrollTopRef.current = Math.max(0, value);
          }}>
            <div style={styles.contextPill}><span style={{ ...styles.statusDot, background: hasObject ? '#5ee6a8' : '#9aa4b2' }} />{objectLabel}</div>
            {messages.length === 0 && !error && (
              <section style={styles.welcome}>
                <h2 style={styles.title}>今天想一起看什么？</h2>
                <p style={styles.description}>询问当前 Trace、数据集、评估结果和 Skills，回答会引用页面中的证据。</p>
                <div style={styles.workflowRow}>
                  <button type="button" className="copilot-workflow-button" onClick={() => void createPreview('trace_to_dataset')} style={styles.workflowButton}>Trace → 数据集</button>
                  <button type="button" className="copilot-workflow-button" onClick={() => void createPreview('evaluator_draft')} style={styles.workflowButton}>评估器草稿</button>
                  <button type="button" className="copilot-workflow-button" onClick={() => void createPreview('run_filter', { instructions: '列出最近的 Trace' })} style={styles.workflowButton}>运行筛选</button>
                </div>
              </section>
            )}
            {messages.map((message, index) => <div key={`${message.role}-${index}`} style={{ ...styles.message, alignSelf: message.role === 'user' ? 'flex-end' : 'stretch' }}><div style={message.role === 'user' ? styles.userBubble : styles.assistantBubble}>{message.role === 'assistant' ? <div className="copilot-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div> : message.content}</div></div>)}
            {plan && (
              <section style={styles.plan} aria-label="执行计划">
                <div style={styles.planHeader}>
                  <span style={styles.sectionLabel}>执行计划</span>
                  {plan.requiresConfirmation && <span style={styles.planBadge}>写操作需确认</span>}
                </div>
                <div style={styles.planGoal}>{plan.goal}</div>
                <ol style={styles.planList}>
                  {plan.steps.map(step => (
                    <li key={step.id} style={styles.planStep}>
                      <span style={styles.planStepIndex}>{step.id.replace('step-', '')}</span>
                      <span style={styles.planStepBody}>
                        <span style={styles.planStepTitle}>{step.title}</span>
                        <span style={styles.planStepMeta}>{step.tool}{step.requiresConfirmation ? ' · 需要确认' : ''}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {busy && <div style={styles.loading}><Loader2 size={15} className="copilot-spin" /> 正在分析当前上下文…</div>}
            {error && <div style={styles.errorCard}><div style={styles.errorText}>{/请先登录/i.test(error) ? '请先登录 Agent Insight 后再使用。' : (/401|api key|apikey|invalid.*key|模型连接/i.test(error) ? '模型 API Key 无效或已过期，请打开模型设置重新连接。' : error)}</div>{/请先登录|401|api key|apikey|invalid.*key|模型连接/i.test(error) && <a href="/modelconfig/registry" style={styles.settingsLink}><Settings2 size={14} /> 模型设置</a>}</div>}
            {sources.length > 0 && (() => {
              const traceSteps = sources.filter(source => source.kind === 'trace-step');
              const summarySources = sources.filter(source => source.kind !== 'trace-step');
              return <section style={styles.sources}>
                <div style={styles.sectionLabel}>来源</div>
                {summarySources.map(source => <a href={source.href || '#'} key={source.id} style={styles.source}><FileText size={14} /><span>{source.label}</span><span style={styles.sourceLocator}>{source.locator}</span></a>)}
                {traceSteps.length > 0 && <button type="button" onClick={() => setShowTraceSteps(value => !value)} style={styles.sourceToggle} aria-expanded={showTraceSteps}>{showTraceSteps ? '收起执行步骤' : `展开执行步骤（${traceSteps.length}）`}<RoboExpandIcon size={13} /></button>}
                {showTraceSteps && traceSteps.map(source => <div key={source.id} style={styles.traceStep}><a href={source.href || '#'} style={styles.source} title="打开当前 Trace"><FileText size={14} /><span>{source.label}</span><span style={styles.sourceLocator}>{source.locator}</span></a>{source.excerpt && <div style={styles.traceStepExcerpt}>{formatSourceExcerpt(source.excerpt)}</div>}</div>)}
              </section>;
            })()}
            {preview && <section style={styles.preview}><div style={styles.sectionLabel}>{preview.action === 'run_filter' ? 'Trace 查询结果' : `工作流草稿 · ${preview.target}`}</div><pre style={styles.previewJson}>{JSON.stringify(preview.changes, null, 2)}</pre>{preview.missing.length > 0 && <div style={styles.missing}>还缺少：{preview.missing.join('、')}</div>}<div style={styles.previewActions}><button type="button" onClick={() => setPreview(null)} style={styles.secondaryButton}>{preview.action === 'run_filter' ? '关闭' : '取消'}</button>{preview.action !== 'run_filter' && <button type="button" disabled={busy} onClick={confirmPreview} style={styles.primaryButton}>{preview.action === 'dataset_delete' ? '确认删除' : preview.action === 'experiment_start' ? '确认启动' : preview.action === 'skill_publish' ? '确认发布' : '确认写入'}</button>}</div></section>}
          </div>

          <footer style={styles.footer}>
            <div style={styles.footerMeta}><span><span style={{ ...styles.statusDot, background: hasObject ? '#5ee6a8' : '#9aa4b2' }} />{hasObject ? '当前对象已连接' : '等待页面对象'}</span></div>
            {attachments.length > 0 && <div style={styles.attachmentList}>{attachments.map((file, index) => <span key={`${file.name}-${index}`} style={styles.attachment}>{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments(current => current.filter((_, itemIndex) => itemIndex !== index))} style={styles.removeAttachment}><X size={11} /></button></span>)}</div>}
            <form onSubmit={sendMessage} className="copilot-composer" style={styles.composer}>
              <textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="询问当前页面…" rows={1} style={styles.textarea} />
              <div style={styles.composerToolbar}>
                <label aria-label="上传图片" title="上传图片" style={styles.attachButton}><ImagePlus size={16} /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={handleFiles} /></label>
                <div style={styles.modelPicker}>
                  <button type="button" aria-haspopup="listbox" aria-expanded={modelMenuOpen} onClick={() => { setModelMenuOpen(value => !value); setModelQuery(''); }} style={styles.modelButton} disabled={modelsLoading}>
                    <span style={styles.modelDot} />
                    <span style={styles.modelButtonLabel}>{modelsLoading ? '加载模型…' : selectedModel?.name || '选择模型'}</span>
                    <RoboExpandIcon size={13} />
                  </button>
                  {modelMenuOpen && (
                    <div style={styles.modelMenu} role="listbox" aria-label="选择模型">
                      <div style={styles.modelSearchWrap}><Search size={14} /><input autoFocus value={modelQuery} onChange={event => setModelQuery(event.target.value)} placeholder="搜索模型…" aria-label="搜索模型" style={styles.modelSearch} /></div>
                      {recommendedModels.length > 0 && <ModelGroup label="推荐模型" models={recommendedModels} selectedModelId={selectedModelId} onSelect={id => { setSelectedModelId(id); setModelMenuOpen(false); setModelQuery(''); }} />}
                      {recommendedModels.length > 0 && workspaceModels.length > 0 && <div style={styles.modelDivider} />}
                      {workspaceModels.length > 0 && <ModelGroup label="工作区模型" models={workspaceModels} selectedModelId={selectedModelId} onSelect={id => { setSelectedModelId(id); setModelMenuOpen(false); setModelQuery(''); }} />}
                      {recommendedModels.length === 0 && workspaceModels.length === 0 && <div style={styles.modelEmpty}>没有匹配的模型</div>}
                      <a href="/modelconfig/registry" style={styles.manageModels}><Settings2 size={13} /> 管理模型</a>
                    </div>
                  )}
                </div>
                <button type="submit" disabled={busy || (!input.trim() && attachments.length === 0)} aria-label="发送" title="发送" style={styles.sendButton}><Send size={17} /></button>
              </div>
            </form>
          </footer>
        </aside>
      )}
      <style jsx global>{`.copilot-robo-icon { border-radius: 50%; background: var(--primary); color: var(--primary-foreground); box-shadow: 0 2px 6px var(--shadow-color-sm); } button:hover > .copilot-robo-icon { transform: translateY(-1px); box-shadow: 0 3px 9px var(--shadow-color-md); }`}</style>
      <style jsx global>{`@keyframes copilot-slide-in { from { transform: translateX(100%); opacity: .7; } to { transform: translateX(0); opacity: 1; } } @keyframes copilot-fade-out { from { transform: translateX(0); opacity: 1; } to { transform: translateX(18px); opacity: 0; } } .copilot-scroll { scrollbar-width: thin; scrollbar-color: #485174 transparent; } .copilot-scroll::-webkit-scrollbar { width: 7px; } .copilot-scroll::-webkit-scrollbar-track { background: transparent; } .copilot-scroll::-webkit-scrollbar-thumb { background: #485174; border-radius: 8px; } .copilot-scroll::-webkit-scrollbar-thumb:hover { background: #6876bd; } .copilot-spin { animation: copilot-spin .9s linear infinite; } @keyframes copilot-spin { to { transform: rotate(360deg); } } .copilot-composer:focus-within { border-color: var(--primary) !important; box-shadow: 0 0 0 3px var(--primary-subtle), 0 8px 24px var(--shadow-color-sm); } .copilot-robo-icon { display: inline-grid; place-items: center; width: 20px; height: 20px; flex: 0 0 20px; border-radius: 50%; background: var(--primary); color: var(--primary-foreground); box-shadow: 0 2px 6px var(--shadow-color-sm); transition: transform .15s ease, box-shadow .15s ease; } button:hover > .copilot-robo-icon { transform: translateY(-1px); box-shadow: 0 3px 9px var(--shadow-color-md); } .copilot-workflow-button:hover { background: var(--primary-subtle) !important; border-color: var(--primary-subtle-border) !important; color: var(--primary) !important; } .copilot-model-option:hover { background: var(--primary-subtle) !important; color: var(--primary) !important; } .copilot-markdown { font-size: inherit; line-height: inherit; overflow-wrap: anywhere; } .copilot-markdown > :first-child { margin-top: 0; } .copilot-markdown > :last-child { margin-bottom: 0; } .copilot-markdown p { margin: 7px 0; } .copilot-markdown strong { font-weight: 700; color: var(--foreground); } .copilot-markdown em { font-style: italic; } .copilot-markdown h1, .copilot-markdown h2, .copilot-markdown h3 { margin: 10px 0 6px; font-size: 14px; font-weight: 700; color: var(--foreground); } .copilot-markdown ul, .copilot-markdown ol { margin: 7px 0 7px 19px; padding: 0; } .copilot-markdown li { margin: 3px 0; } .copilot-markdown blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid var(--primary); color: var(--foreground-secondary); } .copilot-markdown code { padding: 1px 4px; border-radius: 4px; background: var(--background-secondary); font-size: .92em; } .copilot-markdown pre { margin: 8px 0; padding: 9px; overflow-x: auto; border-radius: 6px; background: var(--background-secondary); } .copilot-markdown pre code { padding: 0; background: transparent; } .copilot-markdown a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; } .copilot-markdown table { width: 100%; margin: 8px 0; border-collapse: collapse; font-size: 12px; } .copilot-markdown th, .copilot-markdown td { border: 1px solid var(--border); padding: 5px 6px; } .copilot-markdown th { background: var(--background-secondary); font-weight: 700; }`}</style>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  fab: { position: 'fixed', right: 24, bottom: 24, zIndex: 1000, width: 50, height: 50, border: '0', borderRadius: '50%', background: 'var(--primary)', color: 'var(--primary-foreground)', display: 'grid', placeItems: 'center', cursor: 'pointer', boxShadow: '0 10px 28px var(--shadow-color-lg)' },
  fabDot: { position: 'absolute', right: 3, top: 3, width: 9, height: 9, borderRadius: '50%', background: 'var(--success)', border: '2px solid var(--primary)' },
  drawer: { position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 1000, width: 'min(420px, 100vw)', background: 'var(--background)', color: 'var(--foreground)', display: 'flex', flexDirection: 'column', boxShadow: '-18px 0 45px var(--shadow-color-lg)', animation: 'copilot-slide-in .28s cubic-bezier(.22,1,.36,1)' },
  header: { height: 64, flexShrink: 0, padding: '0 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  subtle: { marginTop: 3, color: 'var(--foreground-muted)', fontSize: 11 },
  headerActions: { display: 'flex', gap: 4 },
  iconButton: { border: 0, background: 'transparent', color: 'var(--foreground-muted)', cursor: 'pointer', padding: 7, borderRadius: 7 },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 16px 22px', display: 'flex', flexDirection: 'column', gap: 12 },
  contextPill: { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--foreground-muted)', fontSize: 12, paddingBottom: 4 },
  statusDot: { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 5 },
  welcome: { padding: '36px 6px 16px', textAlign: 'center' },
  title: { margin: '0 0 9px', fontSize: 20, fontWeight: 650, letterSpacing: 0 },
  description: { margin: '0 auto', maxWidth: 315, color: 'var(--foreground-muted)', fontSize: 13, lineHeight: 1.65 },
  workflowRow: { display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' },
  workflowButton: { border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--foreground-secondary)', borderRadius: 6, padding: '6px 8px', cursor: 'pointer', fontSize: 11, transition: 'background .15s ease, border-color .15s ease, color .15s ease' },
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
  plan: { border: '1px solid var(--border)', borderRadius: 9, background: 'var(--card-bg)', padding: 11 },
  planHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  planBadge: { color: 'var(--warning)', fontSize: 10, border: '1px solid var(--warning-subtle-border)', borderRadius: 999, padding: '2px 6px' },
  planGoal: { color: 'var(--foreground)', fontSize: 12, fontWeight: 600, lineHeight: 1.5, marginBottom: 8 },
  planList: { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 7 },
  planStep: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  planStepIndex: { display: 'grid', placeItems: 'center', width: 18, height: 18, flex: '0 0 18px', borderRadius: '50%', background: 'var(--primary-subtle)', color: 'var(--primary)', fontSize: 10, fontWeight: 700 },
  planStepBody: { minWidth: 0, display: 'grid', gap: 1 },
  planStepTitle: { color: 'var(--foreground-secondary)', fontSize: 12 },
  planStepMeta: { color: 'var(--foreground-muted)', fontSize: 10, fontFamily: 'var(--font-mono, monospace)' },
  source: { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--foreground-secondary)', fontSize: 12, padding: '6px 0', textDecoration: 'none' },
  traceStep: { borderBottom: '1px solid var(--border)', paddingBottom: 7, marginBottom: 7 },
  traceStepExcerpt: { margin: '0 0 2px 21px', color: 'var(--foreground-muted)', fontSize: 11, lineHeight: 1.5, overflowWrap: 'anywhere' },
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
  composer: { display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--input-bg)', padding: '7px 7px 6px 11px', transition: 'border-color .15s ease, box-shadow .15s ease' },
  textarea: { width: '100%', resize: 'none', outline: 'none', border: 0, boxShadow: 'none', background: 'transparent', color: 'var(--foreground)', fontSize: 13, lineHeight: 1.5, minHeight: 22, maxHeight: 100, fontFamily: 'inherit' },
  composerToolbar: { display: 'flex', alignItems: 'center', gap: 6 },
  attachButton: { display: 'grid', placeItems: 'center', width: 28, height: 28, color: 'var(--foreground-muted)', cursor: 'pointer', borderRadius: 6 },
  attachmentList: { display: 'flex', flexWrap: 'wrap', gap: 5 },
  attachment: { display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 180, padding: '4px 6px', borderRadius: 6, background: 'var(--primary-subtle)', color: 'var(--foreground-secondary)', fontSize: 11 },
  removeAttachment: { display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: 'var(--foreground-muted)', cursor: 'pointer', padding: 1 },
  modelPicker: { position: 'relative', marginLeft: 'auto' },
  modelButton: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 132, maxWidth: 190, border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--foreground-secondary)', padding: '5px 7px', fontSize: 11, cursor: 'pointer' },
  modelButtonLabel: { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' },
  modelDot: { width: 6, height: 6, borderRadius: '50%', background: 'var(--success)' },
  modelMenu: { position: 'absolute', right: 0, bottom: 'calc(100% + 7px)', zIndex: 20, width: 288, maxWidth: 'min(288px, calc(100vw - 32px))', padding: 6, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--card-bg)', boxShadow: '0 12px 32px var(--shadow-color-lg)' },
  modelSearchWrap: { display: 'flex', alignItems: 'center', gap: 7, margin: '2px 2px 7px', padding: '6px 9px', borderRadius: 6, background: 'var(--background-secondary)', color: 'var(--foreground-muted)' },
  modelSearch: { minWidth: 0, flex: 1, border: 0, outline: 0, background: 'transparent', color: 'var(--foreground)', fontSize: 12, fontFamily: 'inherit' },
  modelGroup: { margin: 0 },
  modelGroupLabel: { display: 'block', padding: '4px 7px 5px', color: 'var(--foreground-muted)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' },
  modelDivider: { height: 1, margin: '6px 0', background: 'var(--border)' },
  modelEmpty: { padding: '18px 8px', color: 'var(--foreground-muted)', textAlign: 'center', fontSize: 12 },
  modelOption: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 0, borderRadius: 6, background: 'transparent', color: 'var(--foreground)', padding: '7px', textAlign: 'left', fontSize: 12, cursor: 'pointer' },
  modelOptionIcon: { width: 18, height: 18, display: 'grid', placeItems: 'center', borderRadius: 5, background: 'var(--background-secondary)', color: 'var(--foreground-secondary)', fontSize: 10, fontWeight: 700, flexShrink: 0 },
  modelOptionBody: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  modelOptionName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  modelOptionMeta: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--foreground-muted)', fontSize: 10 },
  modelBadge: { flexShrink: 0, padding: '2px 5px', borderRadius: 4, background: 'var(--primary-subtle)', color: 'var(--primary)', fontSize: 10 },
  modelCheck: { flexShrink: 0, color: 'var(--primary)' },
  manageModels: { display: 'flex', alignItems: 'center', gap: 5, borderTop: '1px solid var(--border)', marginTop: 6, padding: '8px 7px 3px', color: 'var(--primary)', textDecoration: 'none', fontSize: 11 },
};
