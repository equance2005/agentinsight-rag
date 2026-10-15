/**
 * 知识库助手网页插件。
 *
 * 集成方式（宿主只需要一段 script 标签）：
 *   <script src="https://<host>/api/public/kb/widget.js"
 *           data-kb-id="kb_xxx"
 *           data-api-key="pk_xxx"
 *           data-title="产品助手"></script>
 *
 * 设计约束：
 *  - 所有 DOM 挂在 Shadow DOM 内，宿主的 CSS 不会污染插件，反之亦然
 *  - 只调用 /api/public/kb/* 的公开契约，不假定宿主有任何专有接口
 *  - 多轮上下文由服务端按 conversationId 维护，前端只持标识
 *  - 流式优先 SSE，不支持时退化为一次性请求
 *  - 对严格 CSP 站点提供 iframe 兜底模式（data-mode="iframe"）
 *
 * 本文件是插件源码，由 scripts/build-widget.mjs 打包为 public/kb-widget.js。
 */

interface WidgetConfig {
  kbId: string;
  apiKey: string;
  apiBase: string;
  title: string;
  welcome: string;
  placeholder: string;
  theme: 'light' | 'dark' | 'auto';
  accent: string;
  position: 'bottom-right' | 'bottom-left';
  layout?: 'sidebar' | 'floating';
  mode: 'shadow' | 'iframe';
  /** 允许用户在插件输入区切换的模型列表。 */
  models?: string[];
  model?: string;
}

interface ModelPreset {
  provider: string;
  model: string;
  baseUrl?: string;
}

/** 用户为某个模型保存的连接凭据（仅存于当前浏览器会话）。 */
interface ModelConnection {
  provider: string;
  apiKey: string;
  baseUrl?: string;
}

const MODEL_PRESETS: ModelPreset[] = [
  { provider: 'OpenAI', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com' },
  { provider: 'OpenAI', model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com' },
  { provider: 'Google', model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { provider: 'Anthropic', model: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com' },
  { provider: 'MiniMax', model: 'MiniMax-Text-01', baseUrl: 'https://api.minimax.chat' },
  { provider: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
  { provider: 'DeepSeek', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com' },
];

interface Citation {
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  locator: {
    page?: number;
    pageEnd?: number;
    sheet?: string;
    cellRange?: string;
    headingPath?: string[];
    lineStart?: number;
    lineEnd?: number;
  };
  snippet: string;
  score: number;
  kind: 'chunk' | 'qa';
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  gateDecision?: string | null;
  suggestions?: string[];
}

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }

.root {
  --kb-accent: #4f46e5;
  --kb-bg: #ffffff;
  --kb-fg: #1f2328;
  --kb-muted: #6b7280;
  --kb-border: #e5e7eb;
  --kb-user-bg: #eef2ff;
  --kb-assistant-bg: #f6f7f9;
  --kb-warn-bg: #fff8e6;
  --kb-warn-border: #f0d69a;

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: var(--kb-fg);
  position: fixed;
  z-index: 2147483000;
  inset: auto;
}

.root[data-theme="dark"] {
  --kb-bg: #1c1f24;
  --kb-fg: #e6e8eb;
  --kb-muted: #9aa2ad;
  --kb-border: #333941;
  --kb-user-bg: #2a2f3a;
  --kb-assistant-bg: #23272e;
  --kb-warn-bg: #3a3320;
  --kb-warn-border: #6b5a2a;
}

.root[data-pos="bottom-right"] { right: 20px; bottom: 20px; }
.root[data-pos="bottom-left"] { left: 20px; bottom: 20px; }

/* --- 悬浮入口 --- */
.launcher {
  width: 56px; height: 56px;
  border-radius: 50%;
  border: none;
  background: var(--kb-accent);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.22);
  display: flex; align-items: center; justify-content: center;
  transition: transform .16s ease, box-shadow .16s ease;
}
.launcher:hover { transform: scale(1.06); box-shadow: 0 8px 26px rgba(0,0,0,.28); }
.launcher:active { transform: scale(.97); }
.launcher svg { width: 26px; height: 26px; }
.launcher.hidden { display: none; }

/* --- 对话框 --- */
.panel {
  position: absolute;
  bottom: 72px;
  width: 400px;
  max-width: calc(100vw - 32px);
  height: 560px;
  max-height: calc(100vh - 110px);
  background: var(--kb-bg);
  border: 1px solid var(--kb-border);
  border-radius: 14px;
  box-shadow: 0 16px 48px rgba(0,0,0,.20);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.root[data-pos="bottom-right"] .panel { right: 0; }
.root[data-pos="bottom-left"] .panel { left: 0; }
.panel.hidden { display: none; }

.header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--kb-border);
  background: var(--kb-bg);
}
.header h2 { font-size: 15px; font-weight: 600; flex: 1; }
.header .sub { font-size: 12px; color: var(--kb-muted); }
.icon-btn {
  border: none; background: transparent; cursor: pointer;
  color: var(--kb-muted); padding: 4px; border-radius: 6px;
  display: flex; align-items: center;
}
.icon-btn:hover { background: var(--kb-assistant-bg); color: var(--kb-fg); }
.icon-btn svg { width: 18px; height: 18px; }

.messages {
  flex: 1; overflow-y: auto; padding: 14px;
  display: flex; flex-direction: column; gap: 12px;
  overscroll-behavior: contain;
}

.msg { display: flex; flex-direction: column; gap: 6px; max-width: 100%; }
.msg.user { align-items: flex-end; }
.bubble {
  padding: 9px 12px; border-radius: 10px;
  white-space: pre-wrap; word-break: break-word;
  max-width: 88%;
}
.msg.user .bubble { background: var(--kb-user-bg); }
.msg.assistant .bubble { background: var(--kb-assistant-bg); max-width: 100%; }

.bubble strong { font-weight: 600; }
.bubble code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  background: rgba(127,127,127,.14);
  padding: 1px 4px; border-radius: 4px;
}

/* 拒答 / 冲突态的醒目标识 */
.notice {
  border: 1px solid var(--kb-warn-border);
  background: var(--kb-warn-bg);
  border-radius: 8px; padding: 8px 10px;
  font-size: 13px;
}

.citations { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.citation {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--kb-border);
  background: var(--kb-bg);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--kb-muted);
  cursor: pointer;
  max-width: 100%;
}
.citation:hover { border-color: var(--kb-accent); color: var(--kb-accent); }
.citation .idx {
  background: var(--kb-accent); color: #fff;
  border-radius: 999px; min-width: 16px; height: 16px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; padding: 0 4px;
}
.citation .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }

.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.vote {
  position: relative; overflow: visible;
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--kb-border); background: transparent;
  border-radius: 8px; cursor: pointer; padding: 4px 10px;
  font: inherit; font-size: 12px; color: var(--kb-muted);
  transition: border-color .15s, color .15s, background .15s;
}
.vote:hover { border-color: var(--kb-accent); color: var(--kb-accent); }
.vote.active { border-color: var(--kb-accent); color: var(--kb-accent); background: var(--kb-user-bg); }
.vote:disabled { cursor: default; }
.vote .vote-icon { font-size: 12.5px; line-height: 1; }

/* 点赞粒子：以按钮中心为原点向四周飞散 */
.like-burst {
  position: absolute; left: 50%; top: 50%;
  width: 0; height: 0; pointer-events: none; z-index: 5;
}
.like-burst i {
  position: absolute; left: 0; top: 0;
  width: var(--size, 4px); height: var(--size, 4px);
  border-radius: 50%;
  animation: kb-burst .72s cubic-bezier(.16,.84,.34,1) forwards;
}
@keyframes kb-burst {
  0% { opacity: 1; transform: translate(-50%,-50%) scale(.4); }
  60% { opacity: 1; }
  100% {
    opacity: 0;
    transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .like-burst { display: none; }
}

/* ── 没帮助：原因选择面板 ── */
.feedback-panel {
  margin-top: 8px; padding: 11px 12px 12px;
  border: 1px solid var(--kb-border); border-radius: 10px;
  background: var(--kb-assistant-bg);
  animation: kb-pop .14s ease-out;
}
.feedback-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.feedback-title { font-size: 12px; font-weight: 500; color: var(--kb-fg); }
.feedback-dismiss {
  width: 20px; height: 20px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--kb-muted); cursor: pointer;
  font-size: 15px; line-height: 1;
}
.feedback-dismiss:hover { background: var(--kb-bg); color: var(--kb-fg); }

.feedback-options { display: flex; flex-wrap: wrap; gap: 6px; }
.feedback-option {
  border: 1px solid var(--kb-border); border-radius: 999px;
  background: var(--kb-bg); color: var(--kb-muted);
  padding: 4px 11px; font: inherit; font-size: 11.5px; cursor: pointer;
  transition: border-color .13s, color .13s, background .13s;
}
.feedback-option:hover { border-color: var(--kb-accent); color: var(--kb-accent); }
.feedback-option[aria-pressed="true"] {
  border-color: var(--kb-accent); color: #fff; background: var(--kb-accent);
}

.feedback-comment {
  display: block; width: 100%; margin-top: 9px;
  border: 1px solid var(--kb-border); border-radius: 8px;
  padding: 7px 9px; resize: none;
  color: var(--kb-fg); background: var(--kb-bg);
  font: inherit; font-size: 12px; outline: none;
  transition: border-color .15s;
}
.feedback-comment:focus { border-color: var(--kb-accent); }
.feedback-comment::placeholder { color: var(--kb-muted); }

.feedback-actions { display: flex; justify-content: flex-end; margin-top: 9px; }
.feedback-submit {
  border: 0; border-radius: 8px; padding: 6px 14px;
  background: var(--kb-accent); color: #fff;
  font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
  transition: filter .15s;
}
.feedback-submit:hover { filter: brightness(1.06); }
.feedback-submit:disabled { opacity: .45; cursor: not-allowed; filter: none; }

.hint { font-size: 12px; color: var(--kb-muted); padding: 0 2px; }

.composer {
  border-top: 1px solid var(--kb-border);
  padding: 10px 12px;
  display: flex; gap: 8px; align-items: flex-end;
  background: var(--kb-bg);
}
.composer textarea {
  flex: 1; resize: none;
  border: 1px solid var(--kb-border);
  border-radius: 9px;
  padding: 8px 10px;
  font: inherit; color: inherit; background: transparent;
  max-height: 110px; min-height: 38px;
  outline: none;
}
.composer textarea:focus { border-color: var(--kb-accent); }
.send {
  border: none; border-radius: 9px; cursor: pointer;
  background: var(--kb-accent); color: #fff;
  width: 38px; height: 38px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.send:disabled { opacity: .45; cursor: not-allowed; }
.send svg { width: 18px; height: 18px; }

.typing { display: inline-flex; gap: 3px; align-items: center; }
.typing i {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--kb-muted);
  animation: kb-bounce 1.2s infinite;
}
.typing i:nth-child(2) { animation-delay: .15s; }
.typing i:nth-child(3) { animation-delay: .3s; }
@keyframes kb-bounce { 0%,60%,100% { opacity:.3; transform: translateY(0); } 30% { opacity:1; transform: translateY(-3px); } }

/* --- 引用详情抽屉 --- */
.drawer {
  position: absolute; inset: 0;
  background: var(--kb-bg);
  display: flex; flex-direction: column;
  z-index: 10;
}
.drawer.hidden { display: none; }
.drawer .header { flex-shrink: 0; }
.drawer-body { flex: 1; overflow-y: auto; padding: 14px; }
.drawer-body .meta { font-size: 12px; color: var(--kb-muted); margin-bottom: 10px; }
.drawer-body .locator {
  display: inline-block; font-size: 12px;
  background: var(--kb-user-bg); color: var(--kb-accent);
  border-radius: 6px; padding: 2px 8px; margin: 0 6px 6px 0;
}
.drawer-body pre {
  white-space: pre-wrap; word-break: break-word;
  font-family: inherit; font-size: 13px;
  background: var(--kb-assistant-bg);
  border-radius: 8px; padding: 12px;
  border-left: 3px solid var(--kb-accent);
}

@media (max-width: 520px) {
  .root { right: 12px !important; left: 12px !important; bottom: 12px !important; }
  .panel {
    position: fixed; inset: 0;
    width: auto; height: auto; max-height: none; max-width: none;
    border-radius: 0; border: none;
  }
  .launcher { margin-left: auto; }
}

/* Screenshot-aligned dark workspace skin. */
.root { --kb-bg:#0f121c; --kb-fg:#e8ebf2; --kb-muted:#8790a3; --kb-border:#2d3547; --kb-user-bg:#1d2535; --kb-assistant-bg:#141925; --kb-warn-bg:#27231b; --kb-warn-border:#796338; }
.root[data-theme="light"] { --kb-bg:#fff; --kb-fg:#1f2328; --kb-muted:#6b7280; --kb-border:#e5e7eb; --kb-user-bg:#eef2ff; --kb-assistant-bg:#f6f7f9; --kb-warn-bg:#fff8e6; --kb-warn-border:#f0d69a; }
.root[data-theme="dark"] .panel { background:linear-gradient(180deg,#10131e,#0d1018); border-color:#30394d; box-shadow:0 20px 60px rgba(0,0,0,.48); }
.panel { opacity:1; visibility:visible; transform:translateX(0); transition:opacity .24s ease, transform .32s cubic-bezier(.16,1,.3,1), visibility 0s linear 0s; }
.panel.hidden { display:flex; opacity:0; visibility:hidden; pointer-events:none; transform:translateX(36px); transition:opacity .20s ease, transform .28s cubic-bezier(.7,0,.84,0), visibility 0s linear .28s; }
.launcher { transition:opacity .22s ease, transform .28s cubic-bezier(.16,1,.3,1), box-shadow .16s ease; }
.launcher.hidden { display:flex; opacity:0; pointer-events:none; transform:translateX(18px) scale(.9); }
.root[data-theme="dark"] .header, .root[data-theme="dark"] .composer { background:#10131e; }
.root[data-theme="dark"] .header { min-height:52px; border-color:#30394d; }
.root[data-theme="dark"] .header h2 { font-size:14px; letter-spacing:-.01em; }
.root[data-theme="dark"] .messages { scrollbar-color:#3b465c transparent; }
.root[data-theme="dark"] .messages::-webkit-scrollbar, .root[data-theme="dark"] .drawer-body::-webkit-scrollbar { width:8px; }
.root[data-theme="dark"] .messages::-webkit-scrollbar-track, .root[data-theme="dark"] .drawer-body::-webkit-scrollbar-track { background:transparent; }
.root[data-theme="dark"] .messages::-webkit-scrollbar-thumb, .root[data-theme="dark"] .drawer-body::-webkit-scrollbar-thumb { background:#374158; border:2px solid #10131e; border-radius:999px; }
.root[data-theme="dark"] .messages::-webkit-scrollbar-thumb:hover, .root[data-theme="dark"] .drawer-body::-webkit-scrollbar-thumb:hover { background:#566582; }
.messages:has(.welcome-state) { justify-content:center; }
.welcome-state { padding:20px 0 10px; color:var(--kb-muted); }
.welcome-state h3 { color:var(--kb-fg); font-size:14px; margin-bottom:4px; }
.welcome-state p { font-size:13px; line-height:1.5; margin-bottom:14px; }
.suggestions { display:grid; gap:4px; }
.suggestion { border:0; background:transparent; color:var(--kb-fg); padding:6px 0; text-align:left; font-size:13px; cursor:pointer; }
.suggestion:hover { color:var(--kb-accent); }
.composer { flex-direction:column; align-items:stretch; gap:0; padding:10px 12px 9px; }
.composer-shell { border:1px solid var(--kb-accent); border-radius:9px; background:rgba(4,7,14,.25); box-shadow:0 0 0 1px rgba(94,106,210,.18),0 0 18px rgba(94,106,210,.08); overflow:hidden; }
.composer textarea { display:block; width:100%; min-height:56px; max-height:130px; border:0; border-radius:0; padding:12px 13px 4px; background:transparent; }
.composer textarea:focus { border:0; box-shadow:none; }
.composer textarea { scrollbar-width:thin; scrollbar-color:#3b465c transparent; }
.composer textarea::-webkit-scrollbar { width:7px; }
.composer textarea::-webkit-scrollbar-track { background:transparent; }
.composer textarea::-webkit-scrollbar-thumb { background:#3b465c; border:2px solid transparent; border-radius:999px; background-clip:padding-box; }
.composer textarea::-webkit-scrollbar-thumb:hover { background:#566582; background-clip:padding-box; }
.composer-toolbar { display:flex; align-items:center; gap:7px; padding:5px 6px 6px; }
.attach { width:28px; height:28px; padding:0; border:0; color:var(--kb-muted); background:transparent; display:flex; align-items:center; justify-content:center; cursor:pointer; }
.attach:hover { color:var(--kb-fg); background:var(--kb-assistant-bg); }
.attach svg { width:16px; height:16px; }

/* ── 模型选择器 ────────────────────────────────────────────────────────
   用自定义下拉替代原生 <select>：原生控件无法跨浏览器统一外观，
   也放不下「提供商 + 模型名 + 已连接状态」这类信息层级。

   菜单不放在 .composer-shell 内部：那个容器有 overflow:hidden 用来裁切
   输入框圆角，会把向上弹出的菜单整个裁掉（实测模型列表完全看不见）。
   因此菜单挂在 .panel 下，由 JS 按触发按钮位置定位。 */
.model-picker { margin-left:auto; }
.model-trigger {
  display:flex; align-items:center; gap:6px;
  max-width:168px; height:28px; padding:0 8px 0 9px;
  border:1px solid var(--kb-border); border-radius:8px;
  background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,0));
  color:var(--kb-fg); font:inherit; font-size:12px; cursor:pointer;
  transition:border-color .15s, background .15s;
}
.model-trigger:hover { border-color:var(--kb-accent); }
.model-trigger[aria-expanded="true"] { border-color:var(--kb-accent); background:var(--kb-assistant-bg); }
.model-trigger .dot {
  width:6px; height:6px; border-radius:50%; flex:0 0 6px;
  background:var(--kb-muted); box-shadow:0 0 0 2px rgba(127,127,127,.14);
}
.model-trigger .dot.connected { background:#22c55e; box-shadow:0 0 0 2px rgba(34,197,94,.18); }
.model-trigger .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.model-trigger .caret { width:12px; height:12px; flex:0 0 12px; opacity:.6; transition:transform .18s ease; }
.model-trigger[aria-expanded="true"] .caret { transform:rotate(180deg); }

/* 具体位置由 JS 写入 left/top/width；这里只定义外观 */
.model-menu {
  position:absolute; z-index:60;
  max-height:min(300px, 44vh); overflow-y:auto; overscroll-behavior:contain;
  padding:6px;
  border:1px solid var(--kb-border); border-radius:12px;
  background:var(--kb-bg);
  box-shadow:0 6px 16px rgba(0,0,0,.14), 0 18px 48px rgba(0,0,0,.30);
  animation:kb-pop .14s ease-out;
}
.model-menu.hidden { display:none; }

/* 滚动条统一：面板内所有可滚动区域共用一套细滚动条，
   避免出现浏览器默认的粗灰条与整体风格不一致。 */
.model-menu::-webkit-scrollbar,
.messages::-webkit-scrollbar,
.drawer-body::-webkit-scrollbar { width:8px; height:8px; }
.model-menu::-webkit-scrollbar-track,
.messages::-webkit-scrollbar-track,
.drawer-body::-webkit-scrollbar-track { background:transparent; }
.model-menu::-webkit-scrollbar-thumb,
.messages::-webkit-scrollbar-thumb,
.drawer-body::-webkit-scrollbar-thumb {
  background:color-mix(in srgb, var(--kb-muted) 34%, transparent);
  border-radius:8px;
  border:2px solid transparent;
  background-clip:padding-box;
}
.model-menu::-webkit-scrollbar-thumb:hover,
.messages::-webkit-scrollbar-thumb:hover,
.drawer-body::-webkit-scrollbar-thumb:hover {
  background:color-mix(in srgb, var(--kb-muted) 58%, transparent);
  border:2px solid transparent;
  background-clip:padding-box;
}
.model-menu, .messages, .drawer-body {
  scrollbar-width:thin;
  scrollbar-color: color-mix(in srgb, var(--kb-muted) 40%, transparent) transparent;
}

@keyframes kb-pop { from { opacity:0; transform:translateY(5px) scale(.98); } to { opacity:1; transform:none; } }

.model-menu-label {
  padding:6px 8px 5px; font-size:10.5px; font-weight:600;
  letter-spacing:.05em; text-transform:uppercase; color:var(--kb-muted);
}
.model-group + .model-group { margin-top:2px; padding-top:4px; border-top:1px solid var(--kb-border); }

.model-item {
  display:flex; align-items:center; gap:9px; width:100%;
  padding:7px 8px; border:0; border-radius:8px;
  background:transparent; color:var(--kb-fg);
  font:inherit; font-size:12.5px; text-align:left; cursor:pointer;
  transition:background .12s;
}
.model-item:hover { background:var(--kb-assistant-bg); }
.model-item[aria-selected="true"] { background:var(--kb-user-bg); }
.model-item .meta { flex:1; min-width:0; }
.model-item .title { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.model-item .subtitle { display:block; font-size:11px; color:var(--kb-muted); margin-top:1px; }
.model-item .check { width:14px; height:14px; flex:0 0 14px; color:var(--kb-accent); opacity:0; }
.model-item[aria-selected="true"] .check { opacity:1; }
.model-item .state {
  font-size:10px; padding:1px 6px; border-radius:999px;
  border:1px solid var(--kb-border); color:var(--kb-muted); flex:0 0 auto;
}
.model-item .state.connected { color:#16a34a; border-color:rgba(34,197,94,.42); background:rgba(34,197,94,.10); }

/* ── 连接模型弹窗 ────────────────────────────────────────────────────
   居中浮层 + 遮罩，比原先贴在头部的卡片更像一个完整的交互步骤。 */
.connection-overlay {
  position:absolute; inset:0; z-index:40;
  display:flex; align-items:center; justify-content:center;
  padding:20px;
  background:rgba(12,15,22,.46);
  backdrop-filter:blur(3px);
  -webkit-backdrop-filter:blur(3px);
  animation:kb-fade .16s ease-out;
}
.connection-overlay.hidden { display:none; }
@keyframes kb-fade { from { opacity:0; } to { opacity:1; } }

.connection-card {
  width:100%; max-width:330px;
  border:1px solid var(--kb-border); border-radius:14px;
  background:var(--kb-bg);
  box-shadow:0 10px 30px rgba(0,0,0,.20), 0 30px 70px rgba(0,0,0,.34);
  overflow:hidden;
  animation:kb-rise .18s cubic-bezier(.2,.9,.3,1);
}
@keyframes kb-rise { from { opacity:0; transform:translateY(10px) scale(.985); } to { opacity:1; transform:none; } }

.connection-head {
  display:flex; align-items:center; gap:10px;
  padding:15px 16px 13px;
  border-bottom:1px solid var(--kb-border);
  background:linear-gradient(180deg, var(--kb-assistant-bg), transparent);
}
.connection-glyph {
  width:32px; height:32px; flex:0 0 32px; border-radius:9px;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(140deg, var(--kb-accent), color-mix(in srgb, var(--kb-accent) 62%, #000));
  color:#fff; box-shadow:0 4px 12px color-mix(in srgb, var(--kb-accent) 34%, transparent);
}
.connection-glyph svg { width:17px; height:17px; }
.connection-head .titles { flex:1; min-width:0; }
.connection-title { font-size:14px; font-weight:600; margin:0; }
.connection-provider { font-size:11.5px; color:var(--kb-muted); margin:2px 0 0; }
.connection-close {
  width:26px; height:26px; flex:0 0 26px; padding:0;
  border:0; border-radius:7px; background:transparent; color:var(--kb-muted);
  display:flex; align-items:center; justify-content:center; cursor:pointer;
}
.connection-close:hover { background:var(--kb-assistant-bg); color:var(--kb-fg); }
.connection-close svg { width:15px; height:15px; }

.connection-body { padding:15px 16px 4px; }
.connection-description { color:var(--kb-muted); font-size:12px; line-height:1.55; margin:0 0 12px; }

.connection-field { position:relative; }
.connection-field input {
  width:100%; height:38px; padding:0 38px 0 11px;
  border:1px solid var(--kb-border); border-radius:9px;
  color:var(--kb-fg); background:var(--kb-assistant-bg);
  font:inherit; font-size:13px; outline:none;
  transition:border-color .15s, box-shadow .15s;
}
.connection-field input:focus {
  border-color:var(--kb-accent);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--kb-accent) 16%, transparent);
}
.connection-field input::placeholder { color:var(--kb-muted); }
.reveal-key {
  position:absolute; right:6px; top:50%; transform:translateY(-50%);
  width:26px; height:26px; padding:0; border:0; border-radius:6px;
  background:transparent; color:var(--kb-muted); cursor:pointer;
  display:flex; align-items:center; justify-content:center;
}
.reveal-key:hover { color:var(--kb-fg); background:var(--kb-bg); }
.reveal-key svg { width:15px; height:15px; }

.connection-error {
  display:none; align-items:flex-start; gap:6px;
  margin-top:10px; padding:8px 10px; border-radius:8px;
  font-size:11.5px; line-height:1.5;
  color:#b42318; background:rgba(220,38,38,.08); border:1px solid rgba(220,38,38,.22);
}
.connection-error.show { display:flex; }
.connection-error svg { width:14px; height:14px; flex:0 0 14px; margin-top:1px; }

.connection-note { margin-top:10px; font-size:11px; color:var(--kb-muted); line-height:1.5; }
.connection-note code {
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10.5px;
  background:var(--kb-assistant-bg); padding:1px 4px; border-radius:4px;
}

.connection-actions {
  display:flex; gap:8px; justify-content:flex-end;
  padding:14px 16px 15px;
}
.connection-actions button {
  height:34px; padding:0 15px; border-radius:9px;
  font:inherit; font-size:12.5px; cursor:pointer;
  transition:filter .15s, background .15s, border-color .15s;
}
.cancel-connection { border:1px solid var(--kb-border); background:transparent; color:var(--kb-fg); }
.cancel-connection:hover { border-color:var(--kb-muted); }
.save-connection {
  border:0; color:#fff; font-weight:500;
  background:var(--kb-accent);
  box-shadow:0 2px 8px color-mix(in srgb, var(--kb-accent) 30%, transparent);
}
.save-connection:hover { filter:brightness(1.06); }
.save-connection:disabled { opacity:.5; cursor:not-allowed; filter:none; box-shadow:none; }

.file-list { display:flex; flex-wrap:wrap; gap:4px; padding:0 10px 5px; }
.file-chip { display:flex; align-items:center; gap:5px; max-width:190px; border:1px solid var(--kb-border); border-radius:7px; padding:3px 5px; color:var(--kb-muted); font-size:11px; background:var(--kb-assistant-bg); }
.file-chip img { width:24px; height:24px; object-fit:cover; border-radius:4px; }
.file-chip span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.file-chip button { border:0; background:transparent; color:var(--kb-muted); cursor:pointer; padding:0 2px; font-size:14px; line-height:1; }
.upload-status { color:var(--kb-muted); font-size:11px; margin-left:4px; }
.connection-actions { display:flex; justify-content:flex-end; gap:7px; margin-top:10px; }
.connection-actions button { padding:5px 10px; border-radius:6px; border:1px solid var(--kb-border); background:transparent; color:var(--kb-fg); cursor:pointer; }
.connection-actions .save-connection { background:var(--kb-accent); border-color:var(--kb-accent); color:#fff; }
.send { width:30px; height:30px; border-radius:6px; margin-left:2px; }
.send svg { width:16px; height:16px; }
.root[data-theme="dark"] .bubble { color:var(--kb-fg); }
.root[data-theme="dark"] .msg.assistant .bubble { background:#151a27; }
.root[data-theme="dark"] .msg.user .bubble { background:#202a40; }
.root[data-theme="dark"] .drawer { background:#10131e; }
@media (min-width:521px) { .panel { width:460px; height:min(700px, calc(100vh - 40px)); max-height:calc(100vh - 40px); bottom:64px; border-radius:10px; } }
@media (min-width:521px) {
  .root[data-layout="sidebar"] .panel { position:fixed; inset:0 0 0 auto; width:480px; height:100vh; max-height:100vh; bottom:auto; border-radius:0; border-top:0; border-right:0; border-bottom:0; }
  .root[data-pos="bottom-left"][data-layout="sidebar"] .panel { inset:0 auto 0 0; border-left:0; border-right:1px solid var(--kb-border); }
}
@media (prefers-reduced-motion: reduce) { .launcher, .panel, .typing i { transition:none !important; animation:none !important; } }
`;

/** 全局挂载标记：防止同一页面重复加载脚本产生多个悬浮球。 */
const MOUNT_FLAG = '__kbWidgetMounted';

export function initWidget(rawConfig: Partial<WidgetConfig>): void {
  const config: WidgetConfig = {
    kbId: rawConfig.kbId ?? '',
    apiKey: rawConfig.apiKey ?? '',
    apiBase: (rawConfig.apiBase ?? detectApiBase()).replace(/\/$/, ''),
    title: rawConfig.title ?? '知识库助手',
    welcome: rawConfig.welcome ?? '你好，我可以基于知识库中的文档回答问题，并给出引用来源。',
    placeholder: rawConfig.placeholder ?? '请输入你的问题…',
    theme: rawConfig.theme ?? 'dark',
    accent: rawConfig.accent ?? '#4f46e5',
    position: rawConfig.position ?? 'bottom-right',
    mode: rawConfig.mode ?? 'shadow',
    layout: rawConfig.layout ?? 'sidebar',
    models: rawConfig.models?.filter(Boolean) ?? [],
    model: rawConfig.model,
  };

  if (!config.kbId) {
    console.error('[kb-widget] 缺少 data-kb-id，插件未加载');
    return;
  }
  if (!config.apiKey) {
    console.error('[kb-widget] 缺少 data-api-key，插件未加载');
    return;
  }
  // 占位符值：多半是直接复制了模板而没替换，明确拒绝比发出必然 401 的请求更好
  if (config.kbId.startsWith('__') || config.apiKey.startsWith('__')) {
    console.error(
      `[kb-widget] data-kb-id / data-api-key 仍是占位符（${config.kbId}），插件未加载。` +
        `请替换为 kb show <知识库> 输出的真实值。`,
    );
    return;
  }

  // 重复挂载防护：已挂载过就不再创建第二个实例，
  // 否则页面上会出现两个悬浮球，且请求带着各自的凭据互相干扰。
  const globalFlags = window as unknown as Record<string, unknown>;
  if (globalFlags[MOUNT_FLAG]) {
    console.warn('[kb-widget] 插件已在本页挂载，忽略重复加载');
    return;
  }
  globalFlags[MOUNT_FLAG] = true;

  if (config.mode === 'iframe') {
    mountIframe(config);
    return;
  }

  const host = document.createElement('div');
  host.id = 'kb-widget-host';
  // 宿主可能对 div 设了样式，这里显式复位关键属性
  host.style.cssText = 'all: initial; position: static;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.appendChild(style);

  const root = document.createElement('div');
  root.className = 'root';
  root.setAttribute('data-pos', config.position);
  root.setAttribute('data-layout', config.layout ?? 'sidebar');
  root.style.setProperty('--kb-accent', config.accent);
  root.setAttribute('data-theme', resolveTheme(config.theme));
  shadow.appendChild(root);

  new WidgetController(root, config).mount();
  document.body.appendChild(host);

  // 主题跟随系统
  if (config.theme === 'auto' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      root.setAttribute('data-theme', resolveTheme(config.theme));
    });
  }
}

function resolveTheme(theme: WidgetConfig['theme']): 'light' | 'dark' {
  if (theme !== 'auto') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 从脚本标签的 src 推断 API 基地址，使宿主无需单独配置。 */
function detectApiBase(): string {
  const script = document.currentScript as HTMLScriptElement | null;
  if (script?.src) {
    try {
      const url = new URL(script.src);
      // widget.js 挂在 /api/public/kb/widget.js 下，取到 /api/public 之前的部分
      const marker = url.pathname.indexOf('/api/public/');
      return marker >= 0 ? `${url.origin}${url.pathname.slice(0, marker)}` : url.origin;
    } catch {
      return '';
    }
  }
  return '';
}

/** iframe 兜底：用于严格 CSP 禁止内联脚本/样式的站点。 */
function mountIframe(config: WidgetConfig): void {
  const launcher = document.createElement('button');
  launcher.setAttribute('aria-label', config.title);
  launcher.style.cssText = [
    'position:fixed',
    config.position === 'bottom-left' ? 'left:20px' : 'right:20px',
    'bottom:20px',
    'width:56px',
    'height:56px',
    'border-radius:50%',
    'border:none',
    'background:' + config.accent,
    'color:#fff',
    'cursor:pointer',
    'z-index:2147483000',
    'box-shadow:0 6px 20px rgba(0,0,0,.22)',
    'font-size:22px',
  ].join(';');
  launcher.textContent = '💬';

  let frame: HTMLIFrameElement | null = null;
  launcher.addEventListener('click', () => {
    if (frame) {
      frame.remove();
      frame = null;
      return;
    }
    frame = document.createElement('iframe');
    const params = new URLSearchParams({
      kbId: config.kbId,
      key: config.apiKey,
      title: config.title,
    });
    frame.src = `${config.apiBase}/api/public/kb/embed?${params.toString()}`;
    frame.style.cssText = [
      'position:fixed',
      config.position === 'bottom-left' ? 'left:20px' : 'right:20px',
      'bottom:86px',
      'width:400px',
      'height:560px',
      'max-width:calc(100vw - 32px)',
      'max-height:calc(100vh - 110px)',
      'border:1px solid #e5e7eb',
      'border-radius:14px',
      'box-shadow:0 16px 48px rgba(0,0,0,.2)',
      'z-index:2147483000',
      'background:#fff',
    ].join(';');
    document.body.appendChild(frame);
  });

  document.body.appendChild(launcher);
}

/** 插件交互控制器。 */
class WidgetController {
  private messages: ChatMessage[] = [];
  private conversationId: string | null = null;
  private streaming = false;
  private votes = new Map<string, 'up' | 'down'>();
  private selectedFiles: File[] = [];

  private launcher!: HTMLButtonElement;
  private panel!: HTMLDivElement;
  private messagesEl!: HTMLDivElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private attachBtn!: HTMLButtonElement;
  private fileInput!: HTMLInputElement;
  private fileList!: HTMLDivElement;
  private uploadStatus!: HTMLSpanElement;
  private modelTrigger!: HTMLButtonElement;
  private modelMenu!: HTMLDivElement;
  private connectionCard!: HTMLDivElement;
  private connectionKey!: HTMLInputElement;
  private connectionError!: HTMLDivElement;
  private pendingModel = '';
  private previousModel = '';
  private readonly connections = new Map<string, ModelConnection>();
  /** 服务端返回或 data-models 指定的可用模型；为空时用内置预设。 */
  private availableModels: string[] = [];
  /**
   * 选择未连接的模型时是否自动弹出连接框。
   * 首次切换弹一次，之后用户可通过菜单主动连接，避免打断对话。
   */
  private autoPromptConnection = true;
  private drawer!: HTMLDivElement;
  private drawerBody!: HTMLDivElement;

  constructor(
    private readonly root: HTMLDivElement,
    private readonly config: WidgetConfig,
  ) {}

  mount(): void {
    this.render();
    this.bind();
    this.restoreConversation();
    void this.loadModelOptions();
  }

  private async loadModelOptions(): Promise<void> {
    try {
      const response = await fetch(
        `${this.config.apiBase}/api/public/kb/${encodeURIComponent(this.config.kbId)}/config`,
        { headers: { 'x-kb-key': this.config.apiKey } },
      );
      if (!response.ok) return;
      const payload = await response.json() as { capabilities?: { models?: string[] } };
      const remoteModels = payload.capabilities?.models?.filter(Boolean) ?? [];
      const models = this.config.models?.length
        ? this.config.models
        : [...new Set([...remoteModels, ...MODEL_PRESETS.map((preset) => preset.model)])];
      if (models.length === 0) return;
      this.availableModels = models;
      this.refreshModelMenu();
    } catch {
      // 配置探测失败不影响基础问答，保留 data-models / 默认选项。
    }
  }

  private loadConnections(): void {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`kb-widget-connections:${this.config.kbId}`) ?? '{}') as Record<string, { provider?: string; apiKey?: string; baseUrl?: string }>;
      for (const [model, connection] of Object.entries(saved)) {
        if (connection.apiKey && connection.provider) this.connections.set(model, { provider: connection.provider, apiKey: connection.apiKey, baseUrl: connection.baseUrl });
      }
    } catch { /* 隐私模式或损坏数据时重新询问 */ }
  }

  /** 当前选中的模型。 */
  private get selectedModel(): string {
    return this.config.model ?? '';
  }

  /** 重绘模型菜单与触发按钮，使其反映最新的可用列表与连接状态。 */
  private refreshModelMenu(): void {
    const config: WidgetConfig = { ...this.config, models: this.availableModels };
    this.modelMenu.innerHTML = modelMenuMarkup(config, this.connections);

    const nameEl = this.modelTrigger.querySelector('.name') as HTMLSpanElement;
    nameEl.textContent = shortModelName(this.selectedModel);

    // 已连接的模型用绿点标出，用户不点开也知道当前状态
    const dot = this.modelTrigger.querySelector('.dot') as HTMLSpanElement;
    dot.classList.toggle('connected', this.connections.has(this.selectedModel));

    for (const item of Array.from(this.modelMenu.querySelectorAll('.model-item'))) {
      const model = (item as HTMLElement).dataset.model ?? '';
      item.setAttribute('aria-selected', model === this.selectedModel ? 'true' : 'false');
    }
  }

  private toggleModelMenu(open?: boolean): void {
    const next = open ?? this.modelMenu.classList.contains('hidden');
    if (next) this.positionModelMenu();
    this.modelMenu.classList.toggle('hidden', !next);
    this.modelTrigger.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      const current = this.modelMenu.querySelector('.model-item[aria-selected="true"]');
      (current as HTMLElement | null)?.focus();
    }
  }

  /**
   * 按触发按钮的位置摆放菜单。
   *
   * 菜单挂在 .panel 下（不能放在 composer-shell 里，那里 overflow:hidden 会裁掉它），
   * 所以需要手动定位：优先向上弹出；上方空间不足时改为向下。
   */
  private positionModelMenu(): void {
    const panel = this.panel.getBoundingClientRect();
    const trigger = this.modelTrigger.getBoundingClientRect();
    const menuWidth = Math.max(trigger.width, 250);
    const GAP = 8;
    const edge = 10;

    // 水平：右对齐触发按钮，但不超出面板左右边界
    const idealLeft = trigger.right - panel.left - menuWidth;
    const left = Math.min(Math.max(idealLeft, edge), panel.width - menuWidth - edge);

    // 垂直：先按向上弹出估算高度，放不下就向下
    const spaceAbove = trigger.top - panel.top;
    const spaceBelow = panel.bottom - trigger.bottom;
    const estimated = Math.min(this.modelMenu.scrollHeight || 300, panel.height * 0.44);
    const openUp = spaceAbove >= estimated + GAP || spaceAbove > spaceBelow;

    this.modelMenu.style.width = `${menuWidth}px`;
    this.modelMenu.style.left = `${left}px`;
    if (openUp) {
      this.modelMenu.style.bottom = `${panel.bottom - trigger.top + GAP}px`;
      this.modelMenu.style.top = 'auto';
    } else {
      this.modelMenu.style.top = `${trigger.bottom - panel.top + GAP}px`;
      this.modelMenu.style.bottom = 'auto';
    }
  }

  /** 用户从菜单里选了某个模型。 */
  private selectModel(model: string): void {
    this.toggleModelMenu(false);
    if (model === this.config.model) return;

    this.config.model = model;
    this.refreshModelMenu();

    // 未连接的模型不阻断对话：仍可回退到服务端默认模型。
    // 这里只提示一次，避免每次切换都弹窗打断。
    if (!this.connections.has(model) && this.autoPromptConnection) {
      void this.requireModelConnection(model);
    }
  }

  /** 打开连接弹窗，等待用户填入该模型的密钥。 */
  private async requireModelConnection(model: string): Promise<void> {
    if (!model || this.connections.has(model)) return;
    this.pendingModel = model;
    this.previousModel = this.config.model ?? '';

    const preset = resolveModelPresets(this.config).find((item) => item.model === model);
    const provider = preset?.provider ?? '自定义提供商';
    (this.root.querySelector('.connection-title') as HTMLElement).textContent = `连接 ${model}`;
    (this.root.querySelector('.connection-provider') as HTMLElement).textContent = `由 ${provider} 提供`;
    (this.root.querySelector('.connection-error-text') as HTMLElement).textContent = '';
    this.connectionError.classList.remove('show');
    this.connectionKey.value = '';
    this.syncSaveButton();
    this.connectionCard.parentElement?.classList.remove('hidden');
    setTimeout(() => this.connectionKey.focus(), 30);
  }

  private closeConnectionCard(): void {
    this.connectionCard.parentElement?.classList.add('hidden');
    this.connectionKey.value = '';
    this.connectionError.classList.remove('show');
  }

  /** 保存按钮仅在输入了内容时可用，避免空提交。 */
  private syncSaveButton(): void {
    const save = this.root.querySelector('.save-connection') as HTMLButtonElement;
    save.disabled = this.connectionKey.value.trim().length === 0;
  }

  private async saveModelConnection(): Promise<void> {
    const apiKey = this.connectionKey.value.trim();
    if (!apiKey || !this.pendingModel) return;
    const preset = resolveModelPresets(this.config).find((item) => item.model === this.pendingModel);
    const provider = preset?.provider.toLowerCase().split(' ')[0] ?? 'openai';
    const providerId = provider === 'google' ? 'gemini' : provider === 'anthropic' ? 'claude' : provider;
    const save = this.root.querySelector('.save-connection') as HTMLButtonElement;

    save.disabled = true;
    save.textContent = '验证中…';
    this.connectionError.classList.remove('show');

    try {
      const response = await fetch(`${this.config.apiBase}/api/public/kb/${encodeURIComponent(this.config.kbId)}/models/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kb-key': this.config.apiKey },
        body: JSON.stringify({ provider: providerId, model: this.pendingModel, apiKey }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '连接验证失败');
      this.connections.set(this.pendingModel, { provider: providerId, apiKey, baseUrl: preset?.baseUrl });
    } catch (error) {
      // 行内错误提示比浏览器原生气泡更清晰，也不会遮挡输入框
      (this.root.querySelector('.connection-error-text') as HTMLElement).textContent =
        (error as Error).message;
      this.connectionError.classList.add('show');
      return;
    } finally {
      save.textContent = '保存并连接';
      this.syncSaveButton();
    }

    try {
      const saved: Record<string, unknown> = {};
      for (const [model, connection] of this.connections) saved[model] = connection;
      sessionStorage.setItem(`kb-widget-connections:${this.config.kbId}`, JSON.stringify(saved));
    } catch { /* 允许无法使用 sessionStorage 的浏览器继续本次请求 */ }

    this.closeConnectionCard();
    this.refreshModelMenu();
  }

  private render(): void {
    this.root.innerHTML = `
      <button class="launcher" aria-label="打开${escapeAttr(this.config.title)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </button>

      <div class="panel hidden" role="dialog" aria-label="${escapeAttr(this.config.title)}">
        <div class="header">
          <h2>${escapeHtml(this.config.title)}</h2>
          <button class="icon-btn reset" title="新会话" aria-label="新会话">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>
            </svg>
          </button>
          <button class="icon-btn close" title="关闭" aria-label="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="messages" role="log" aria-live="polite">
          <div class="welcome-state">
            <h3>${escapeHtml(this.config.title)}</h3>
            <p>${escapeHtml(this.config.welcome)}</p>
            <div class="suggestions">
              <button class="suggestion" data-question="如何使用这个知识库？">✧　如何使用这个知识库？</button>
              <button class="suggestion" data-question="请解释一个概念">⌕　解释一个概念</button>
              <button class="suggestion" data-question="帮我定位一个问题">◌　帮我定位一个问题</button>
            </div>
          </div>
        </div>

        <div class="composer">
          <div class="composer-shell">
            <textarea rows="1" placeholder="${escapeAttr(this.config.placeholder)}"
                      aria-label="输入问题"></textarea>
            <div class="file-list"></div>
            <div class="composer-toolbar">
              <button class="attach" aria-label="上传图片" title="上传图片">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>
                </svg>
              </button>
              <input class="file-input" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" hidden />
              <span class="upload-status" aria-live="polite"></span>

              <div class="model-picker">
                <button class="model-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                  <span class="dot" aria-hidden="true"></span>
                  <span class="name">${escapeHtml(shortModelName(this.config.model ?? ''))}</span>
                  <svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m6 9 6 6 6-6"/>
                  </svg>
                </button>
              </div>

              <button class="send" aria-label="发送" disabled>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round">
                  <path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>
                </svg>
              </button>
            </div>
          </div>
        </div>

        <!-- 菜单挂在 panel 下：composer-shell 有 overflow:hidden，会裁掉它 -->
        <div class="model-menu hidden" role="listbox" aria-label="选择模型"></div>

        <div class="connection-overlay hidden">
          <div class="connection-card" role="dialog" aria-modal="true" aria-labelledby="kb-conn-title">
            <div class="connection-head">
              <span class="connection-glyph" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/>
                </svg>
              </span>
              <span class="titles">
                <span class="connection-title" id="kb-conn-title">连接模型</span>
                <span class="connection-provider">填写密钥后即可使用该模型回答</span>
              </span>
              <button class="connection-close" type="button" aria-label="关闭">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>

            <div class="connection-body">
              <p class="connection-description">
                密钥仅保存在当前浏览器会话中，不会上传到知识库服务。
              </p>
              <div class="connection-field">
                <input class="connection-key" type="password" autocomplete="off"
                       spellcheck="false" placeholder="API Key" aria-label="API Key" />
                <button class="reveal-key" type="button" aria-label="显示密钥">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                       stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>
                  </svg>
                </button>
              </div>
              <div class="connection-error" role="alert">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>
                </svg>
                <span class="connection-error-text"></span>
              </div>
              <p class="connection-note">
                没有密钥？可以直接使用
                <code>服务端默认模型</code>
                回答，无需在此填写。
              </p>
            </div>

            <div class="connection-actions">
              <button class="cancel-connection" type="button">稍后再说</button>
              <button class="save-connection" type="button" disabled>保存并连接</button>
            </div>
          </div>
        </div>

        <div class="drawer hidden">
          <div class="header">
            <h2>引用来源</h2>
            <button class="icon-btn drawer-close" aria-label="返回">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
            </button>
          </div>
          <div class="drawer-body"></div>
        </div>
      </div>
    `;

    this.launcher = this.root.querySelector('.launcher') as HTMLButtonElement;
    this.panel = this.root.querySelector('.panel') as HTMLDivElement;
    this.messagesEl = this.root.querySelector('.messages') as HTMLDivElement;
    this.input = this.root.querySelector('textarea') as HTMLTextAreaElement;
    this.sendBtn = this.root.querySelector('.send') as HTMLButtonElement;
    this.attachBtn = this.root.querySelector('.attach') as HTMLButtonElement;
    this.fileInput = this.root.querySelector('.file-input') as HTMLInputElement;
    this.fileList = this.root.querySelector('.file-list') as HTMLDivElement;
    this.uploadStatus = this.root.querySelector('.upload-status') as HTMLSpanElement;
    this.modelTrigger = this.root.querySelector('.model-trigger') as HTMLButtonElement;
    this.modelMenu = this.root.querySelector('.model-menu') as HTMLDivElement;
    this.connectionCard = this.root.querySelector('.connection-card') as HTMLDivElement;
    this.connectionKey = this.root.querySelector('.connection-key') as HTMLInputElement;
    this.connectionError = this.root.querySelector('.connection-error') as HTMLDivElement;
    this.drawer = this.root.querySelector('.drawer') as HTMLDivElement;
    this.drawerBody = this.root.querySelector('.drawer-body') as HTMLDivElement;
  }

  private bind(): void {
    this.launcher.addEventListener('click', () => {
      this.panel.classList.toggle('hidden');
      this.launcher.classList.toggle('hidden', !this.panel.classList.contains('hidden'));
      if (!this.panel.classList.contains('hidden')) this.input.focus();
    });

    (this.root.querySelector('.close') as HTMLButtonElement).addEventListener('click', () => {
      this.panel.classList.add('hidden');
      this.launcher.classList.remove('hidden');
    });

    (this.root.querySelector('.reset') as HTMLButtonElement).addEventListener('click', () => {
      this.conversationId = null;
      this.messages = [];
      this.votes.clear();
      this.selectedFiles = [];
      this.renderFileList();
      this.showWelcomeState();
    });

    this.root.querySelectorAll<HTMLButtonElement>('.suggestion').forEach((button) => {
      button.addEventListener('click', () => {
        this.input.value = button.dataset.question ?? '';
        this.input.dispatchEvent(new Event('input'));
        this.input.focus();
      });
    });

    this.attachBtn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      this.selectedFiles = Array.from(this.fileInput.files ?? []);
      this.renderFileList();
      this.updateSendState();
    });
    // ── 模型选择器 ──
    this.modelTrigger.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleModelMenu();
    });

    this.modelMenu.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest('.model-item') as HTMLElement | null;
      if (!item) return;
      event.stopPropagation();
      this.selectModel(item.dataset.model ?? '');
    });

    // 点击面板其他地方收起菜单
    this.panel.addEventListener('click', () => this.toggleModelMenu(false));

    // 键盘操作：Esc 关闭菜单，方向键在选项间移动
    this.modelMenu.addEventListener('keydown', (event) => {
      const items = Array.from(this.modelMenu.querySelectorAll('.model-item')) as HTMLElement[];
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'Escape') {
        this.toggleModelMenu(false);
        this.modelTrigger.focus();
      } else if (event.key === 'ArrowDown' && current < items.length - 1) {
        event.preventDefault();
        items[current + 1].focus();
      } else if (event.key === 'ArrowUp' && current > 0) {
        event.preventDefault();
        items[current - 1].focus();
      }
    });

    this.connectionKey.addEventListener('input', () => {
      this.syncSaveButton();
      this.connectionError.classList.remove('show');
    });
    this.connectionKey.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!(this.root.querySelector('.save-connection') as HTMLButtonElement).disabled) {
          void this.saveModelConnection();
        }
      } else if (event.key === 'Escape') {
        this.closeConnectionCard();
      }
    });

    // 显示/隐藏密钥
    (this.root.querySelector('.reveal-key') as HTMLButtonElement).addEventListener('click', () => {
      this.connectionKey.type = this.connectionKey.type === 'password' ? 'text' : 'password';
      this.connectionKey.focus();
    });

    (this.root.querySelector('.cancel-connection') as HTMLButtonElement).addEventListener('click', () => {
      this.closeConnectionCard();
    });
    (this.root.querySelector('.connection-close') as HTMLButtonElement).addEventListener('click', () => {
      this.closeConnectionCard();
    });
    // 点击遮罩空白处关闭
    (this.connectionCard.parentElement as HTMLElement).addEventListener('click', (event) => {
      if (event.target === this.connectionCard.parentElement) this.closeConnectionCard();
    });
    (this.root.querySelector('.save-connection') as HTMLButtonElement).addEventListener('click', () => void this.saveModelConnection());

    this.loadConnections();
    this.refreshModelMenu();

    (this.root.querySelector('.drawer-close') as HTMLButtonElement).addEventListener('click', () => {
      this.drawer.classList.add('hidden');
    });

    this.input.addEventListener('input', () => {
      this.autoGrow();
      this.updateSendState();
    });

    this.input.addEventListener('keydown', (event) => {
      // Enter 发送，Shift+Enter 换行
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
    });

    this.sendBtn.addEventListener('click', () => this.submit());
  }

  private autoGrow(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 110)}px`;
  }

  private updateSendState(): void {
    this.sendBtn.disabled = (this.input.value.trim().length === 0 && this.selectedFiles.length === 0) || this.streaming;
  }

  private renderFileList(): void {
    this.fileList.innerHTML = this.selectedFiles
      .map((file, index) => `<span class="file-chip" title="${escapeAttr(file.name)}"><img src="${escapeAttr(URL.createObjectURL(file))}" alt="" /><span>${escapeHtml(file.name)}</span><button type="button" data-file-index="${index}" aria-label="移除 ${escapeAttr(file.name)}">×</button></span>`)
      .join('');
    this.uploadStatus.textContent = this.selectedFiles.length > 0 ? `${this.selectedFiles.length} 张图片待发送` : '';
    this.fileList.querySelectorAll<HTMLButtonElement>('button[data-file-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.fileIndex);
        this.selectedFiles.splice(index, 1);
        this.renderFileList();
        this.updateSendState();
      });
    });
  }

  private showWelcomeState(): void {
    this.messagesEl.innerHTML = `
      <div class="welcome-state">
        <h3>${escapeHtml(this.config.title)}</h3>
        <p>${escapeHtml(this.config.welcome)}</p>
        <div class="suggestions">
          <button class="suggestion" data-question="如何使用这个知识库？">✧　如何使用这个知识库？</button>
          <button class="suggestion" data-question="请解释一个概念">⌕　解释一个概念</button>
          <button class="suggestion" data-question="帮我定位一个问题">◌　帮我定位一个问题</button>
        </div>
      </div>`;
    this.messagesEl.querySelectorAll<HTMLButtonElement>('.suggestion').forEach((button) => {
      button.addEventListener('click', () => {
        this.input.value = button.dataset.question ?? '';
        this.input.dispatchEvent(new Event('input'));
        this.input.focus();
      });
    });
  }

  private submit(): void {
    const text = this.input.value.trim();
    if ((!text && this.selectedFiles.length === 0) || this.streaming) return;

    const question = text || '请根据我上传的文件回答。';
    const attachments = this.selectedFiles.map((file) => file.name);
    this.messagesEl.querySelector('.welcome-state')?.remove();

    this.input.value = '';
    this.autoGrow();
    this.sendBtn.disabled = true;

    this.addMessage({
      id: `u_${Date.now()}`,
      role: 'user',
      content: attachments.length > 0 ? `${question}\n\n附件：${attachments.join('、')}` : question,
      citations: [],
    });
    void this.send(question);
  }

  private async send(text: string): Promise<void> {
    this.streaming = true;

    const assistantId = `a_${Date.now()}`;
    const node = this.addMessage({
      id: assistantId,
      role: 'assistant',
      content: '',
      citations: [],
    });
    const bubble = node.querySelector('.bubble') as HTMLDivElement;
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';

    let accumulated = '';
    let citations: Citation[] = [];
    let gateDecision: string | null = null;
    let notice: string | null = null;

    try {
      const images = await this.readImages();
      this.selectedFiles = [];
      this.fileInput.value = '';
      this.renderFileList();
      await this.streamRequest(text, images, {
        onMeta: (meta) => {
          if (meta.conversationId) {
            this.conversationId = meta.conversationId;
            this.persistConversation();
          }
        },
        onDelta: (chunk) => {
          accumulated += chunk;
          bubble.innerHTML = renderMarkdown(accumulated);
          this.scrollToBottom();
        },
        onCitations: (list) => {
          citations = list;
        },
        onDone: (payload) => {
          if (payload.answer) accumulated = payload.answer;
          citations = payload.citations ?? citations;
          gateDecision = payload.gate?.decision ?? null;
          const decision = payload.gate?.decision;
          if (decision === 'no_evidence') notice = 'refusal';
          else if (decision === 'conflict') notice = 'conflict';
          else if (decision === 'partial') notice = 'partial';
          if (payload.messageId) node.dataset.messageId = payload.messageId;
        },
      });
    } catch (error) {
      accumulated = `请求失败：${(error as Error).message}`;
    }

    bubble.innerHTML = renderMarkdown(accumulated || '（未收到内容）');
    node.dataset.content = accumulated;

    // 拒答 / 冲突 / 部分可答需要显式提示，不能只靠正文措辞
    if (notice) {
      const noticeEl = document.createElement('div');
      noticeEl.className = 'notice';
      noticeEl.textContent = NOTICE_TEXT[notice];
      node.insertBefore(noticeEl, node.querySelector('.citations'));
    }

    if (citations.length > 0) {
      this.renderCitations(node, citations);
    }

    const messageId = node.dataset.messageId;
    if (messageId && gateDecision !== 'no_evidence') {
      // 拒答的回答不给点赞入口：没有内容可供认可
      this.renderActions(node, messageId);
    }

    this.streaming = false;
    this.updateSendState();
    this.scrollToBottom();
  }

  private async uploadSelectedFiles(): Promise<void> {
    if (this.selectedFiles.length === 0) return;
    // 图片作为多模态上下文直接发送，不写入知识库。
  }

  private async readImages(): Promise<Array<{ data: string; mimeType: string; name: string }>> {
    return Promise.all(this.selectedFiles.map(async (file) => {
      if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(`读取图片失败：${file.name}`));
        reader.readAsDataURL(file);
      });
      return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: file.type, name: file.name };
    }));
  }

  /** SSE 流式请求；浏览器不支持时自动退化为一次性请求。 */
  private async streamRequest(
    text: string,
    images: Array<{ data: string; mimeType: string; name: string }>,
    handlers: {
      onMeta: (meta: { conversationId?: string }) => void;
      onDelta: (chunk: string) => void;
      onCitations: (citations: Citation[]) => void;
      onDone: (payload: {
        answer?: string;
        citations?: Citation[];
        gate?: { decision?: string };
        messageId?: string;
      }) => void;
    },
  ): Promise<void> {
    const params = new URLSearchParams({ message: text });
    if (this.conversationId) params.set('conversationId', this.conversationId);
    if (this.selectedModel) params.set('model', this.selectedModel);
    const connection = this.connections.get(this.selectedModel);
    // SSE URL 无法安全携带图片内容，图片请求使用同样的非流式 multipart-like JSON 兼容路径。
    if (images.length > 0 || this.connections.has(this.selectedModel)) {
      return this.imageRequest(text, images, handlers);
    }
    const url = `${this.config.apiBase}/api/public/kb/${encodeURIComponent(this.config.kbId)}/chat/stream?${params}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'x-kb-key': this.config.apiKey, accept: 'text/event-stream' },
    });

    if (!response.ok) {
      throw new Error(await describeHttpError(response, this.config));
    }
    if (!response.body) {
      // 不支持流式：退化为非流式接口
      return this.fallbackRequest(text, handlers);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        let eventName = 'message';
        let dataLine = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;

        let payload: any;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }

        switch (eventName) {
          case 'meta':
            handlers.onMeta(payload);
            break;
          case 'delta':
            handlers.onDelta(payload.text ?? '');
            break;
          case 'citations':
            handlers.onCitations(payload);
            break;
          case 'done':
            handlers.onDone(payload);
            break;
          case 'error':
            throw new Error(payload.message ?? '生成失败');
        }
      }
    }
  }

  private async imageRequest(
    text: string,
    images: Array<{ data: string; mimeType: string; name: string }>,
    handlers: { onMeta: (meta: { conversationId?: string }) => void; onDelta: (chunk: string) => void; onCitations: (citations: Citation[]) => void; onDone: (payload: any) => void },
  ): Promise<void> {
    const connection = this.connections.get(this.selectedModel);
    const response = await fetch(`${this.config.apiBase}/api/public/kb/${encodeURIComponent(this.config.kbId)}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kb-key': this.config.apiKey },
      body: JSON.stringify({
        message: text,
        conversationId: this.conversationId,
        model: this.selectedModel || undefined,
        connection: connection ? { provider: connection.provider, model: this.selectedModel, apiKey: connection.apiKey } : undefined,
        images,
      }),
    });
    if (!response.ok) throw new Error(await describeHttpError(response, this.config));
    const payload = await response.json();
    handlers.onMeta({ conversationId: payload.conversationId });
    handlers.onDelta(payload.answer ?? '');
    handlers.onCitations(payload.citations ?? []);
    handlers.onDone(payload);
  }

  private async fallbackRequest(
    text: string,
    handlers: {
      onMeta: (meta: { conversationId?: string }) => void;
      onDelta: (chunk: string) => void;
      onCitations: (citations: Citation[]) => void;
      onDone: (payload: any) => void;
    },
  ): Promise<void> {
    const response = await fetch(
      `${this.config.apiBase}/api/public/kb/${encodeURIComponent(this.config.kbId)}/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kb-key': this.config.apiKey },
        body: JSON.stringify({
          message: text,
          conversationId: this.conversationId,
          model: this.selectedModel || undefined,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(await describeHttpError(response, this.config));
    }

    const payload = await response.json();
    handlers.onMeta({ conversationId: payload.conversationId });
    handlers.onDelta(payload.answer ?? '');
    handlers.onCitations(payload.citations ?? []);
    handlers.onDone(payload);
  }

  private addMessage(message: ChatMessage): HTMLDivElement {
    const node = document.createElement('div');
    node.className = `msg ${message.role}`;
    node.dataset.messageId = message.id;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = renderMarkdown(message.content);
    node.appendChild(bubble);

    const citationsEl = document.createElement('div');
    citationsEl.className = 'citations';
    node.appendChild(citationsEl);

    if (message.citations.length > 0) this.renderCitations(node, message.citations);

    this.messagesEl.appendChild(node);
    this.scrollToBottom();
    return node;
  }

  private renderCitations(node: HTMLDivElement, citations: Citation[]): void {
    const container = node.querySelector('.citations') as HTMLDivElement;
    container.innerHTML = '';

    for (const citation of citations) {
      const button = document.createElement('button');
      button.className = 'citation';
      button.title = describeLocator(citation.locator) || citation.documentTitle;
      button.innerHTML = `<span class="idx">${citation.index}</span><span class="label">${escapeHtml(
        citation.documentTitle,
      )}${escapeHtml(shortLocator(citation.locator))}</span>`;
      button.addEventListener('click', () => this.openCitation(citation));
      container.appendChild(button);
    }
  }

  /** 渲染「有帮助 / 没帮助」反馈入口。 */
  private renderActions(node: HTMLDivElement, messageId: string): void {
    const actions = document.createElement('div');
    actions.className = 'actions';

    const up = document.createElement('button');
    up.className = 'vote';
    up.type = 'button';
    up.innerHTML = '<span class="vote-icon">👍</span><span class="vote-text">有帮助</span>';

    const down = document.createElement('button');
    down.className = 'vote';
    down.type = 'button';
    down.innerHTML = '<span class="vote-icon">👎</span><span class="vote-text">没帮助</span>';

    up.addEventListener('click', () => {
      if (this.votes.has(messageId)) return;
      // 点赞无需补充信息，直接提交并播放粒子反馈
      void this.submitFeedback(messageId, 'up', up).then((ok) => {
        if (ok) this.playLikeBurst(up);
      });
    });

    down.addEventListener('click', () => {
      if (this.votes.has(messageId)) return;
      // 点踩先展开原因选择，提交后才会记录到后台
      this.openFeedbackReasons(node, messageId, down);
    });

    actions.appendChild(up);
    actions.appendChild(down);
    node.appendChild(actions);
  }

  /** 提交反馈；成功时给按钮打上已选状态。 */
  private async submitFeedback(
    messageId: string,
    rating: 'up' | 'down',
    button: HTMLButtonElement,
    detail?: { reason?: string; comment?: string },
  ): Promise<boolean> {
    button.disabled = true;
    try {
      const response = await fetch(`${this.config.apiBase}/api/public/kb/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kb-key': this.config.apiKey },
        body: JSON.stringify({ messageId, rating, reason: detail?.reason, comment: detail?.comment }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);

      this.votes.set(messageId, rating);
      button.classList.add('active');
      button.disabled = true;
      const text = button.querySelector('.vote-text');
      if (text) text.textContent = rating === 'up' ? '已标记有帮助' : '已记录';
      return true;
    } catch (error) {
      button.disabled = false;
      const text = button.querySelector('.vote-text');
      if (text) text.textContent = (error as Error).message.slice(0, 24);
      setTimeout(() => {
        if (text) text.textContent = rating === 'up' ? '有帮助' : '没帮助';
      }, 2200);
      return false;
    }
  }

  /**
   * 「没帮助」的原因选择面板。
   *
   * 让用户勾选而不是面对一个空白输入框：既降低了反馈门槛，
   * 也让后台收到的问题分类可直接用于知识缺口聚类。
   */
  private openFeedbackReasons(node: HTMLDivElement, messageId: string, downButton: HTMLButtonElement): void {
    if (node.querySelector('.feedback-panel')) return;
    downButton.classList.add('active');

    const panel = document.createElement('div');
    panel.className = 'feedback-panel';

    // 选项与后台的 UnresolvedReason 语义对齐，便于维护者按类别复查
    const options = [
      { id: 'no_answer', label: '答非所问' },
      { id: 'incomplete', label: '信息不完整' },
      { id: 'wrong', label: '内容有误' },
      { id: 'no_source', label: '引用不相关' },
      { id: 'outdated', label: '资料已过时' },
    ];

    panel.innerHTML = `
      <div class="feedback-head">
        <span class="feedback-title">哪些地方没帮到你？</span>
        <button class="feedback-dismiss" type="button" aria-label="收起">×</button>
      </div>
      <div class="feedback-options" role="group" aria-label="反馈原因">
        ${options
          .map(
            (option) => `<button class="feedback-option" type="button" data-reason="${option.id}"
              aria-pressed="false">${option.label}</button>`,
          )
          .join('')}
      </div>
      <textarea class="feedback-comment" rows="2"
        placeholder="补充说明（可选）"></textarea>
      <div class="feedback-actions">
        <button class="feedback-submit" type="button" disabled>提交反馈</button>
      </div>
    `;

    const selected = new Set<string>();
    const submit = panel.querySelector('.feedback-submit') as HTMLButtonElement;
    const comment = panel.querySelector('.feedback-comment') as HTMLTextAreaElement;

    const syncSubmit = () => {
      // 至少选一个原因或写点说明，否则提交没有信息量
      submit.disabled = selected.size === 0 && comment.value.trim().length === 0;
    };

    for (const button of Array.from(panel.querySelectorAll('.feedback-option')) as HTMLButtonElement[]) {
      button.addEventListener('click', () => {
        const reason = button.dataset.reason ?? '';
        if (selected.has(reason)) {
          selected.delete(reason);
          button.setAttribute('aria-pressed', 'false');
        } else {
          selected.add(reason);
          button.setAttribute('aria-pressed', 'true');
        }
        syncSubmit();
      });
    }

    comment.addEventListener('input', syncSubmit);

    (panel.querySelector('.feedback-dismiss') as HTMLButtonElement).addEventListener('click', () => {
      panel.remove();
      downButton.classList.remove('active');
    });

    submit.addEventListener('click', async () => {
      submit.disabled = true;
      submit.textContent = '提交中…';

      const ok = await this.submitFeedback(messageId, 'down', downButton, {
        reason: [...selected].join(','),
        comment: comment.value.trim() || undefined,
      });

      if (ok) {
        panel.remove();
      } else {
        submit.textContent = '提交反馈';
        syncSubmit();
      }
    });

    node.appendChild(panel);
    this.scrollToBottom();
  }

  /**
   * 点赞粒子特效。
   *
   * 用 CSS 动画 + 随机角度生成 12 个粒子，播完自动移除。
   * 尊重 prefers-reduced-motion：用户要求减少动效时直接跳过。
   */
  private playLikeBurst(button: HTMLButtonElement): void {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    const burst = document.createElement('span');
    burst.className = 'like-burst';
    const COLORS = ['#22c55e', '#4ade80', '#16a34a', '#86efac', '#facc15'];

    for (let i = 0; i < 12; i++) {
      const particle = document.createElement('i');
      const angle = (Math.PI * 2 * i) / 12 + (Math.random() - 0.5) * 0.5;
      const distance = 22 + Math.random() * 20;
      particle.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
      particle.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
      particle.style.setProperty('--size', `${3 + Math.random() * 3}px`);
      particle.style.background = COLORS[i % COLORS.length];
      particle.style.animationDelay = `${Math.random() * 60}ms`;
      burst.appendChild(particle);
    }

    button.appendChild(burst);
    setTimeout(() => burst.remove(), 900);
  }

  /** 打开引用详情：展示来源文档、定位信息与原文片段。 */
  private async openCitation(citation: Citation): Promise<void> {
    this.drawer.classList.remove('hidden');
    this.drawerBody.innerHTML = '<div class="meta">正在加载…</div>';

    let content = citation.snippet;
    let documentTitle = citation.documentTitle;
    let locator = citation.locator;

    try {
      // 重新拉取最新原文，避免回答时的片段已被更新
      const response = await fetch(
        `${this.config.apiBase}/api/public/kb/${encodeURIComponent(this.config.kbId)}/chunks/${encodeURIComponent(citation.chunkId)}`,
        { headers: { 'x-kb-key': this.config.apiKey } },
      );
      if (response.ok) {
        const detail = await response.json();
        content = detail.content ?? content;
        documentTitle = detail.document?.title ?? documentTitle;
        locator = detail.locator ?? locator;
      }
    } catch {
      // 拉取失败时退化为回答时的片段快照
    }

    const locatorChips = describeLocatorParts(locator)
      .map((part) => `<span class="locator">${escapeHtml(part)}</span>`)
      .join('');

    this.drawerBody.innerHTML = `
      <div class="meta"><strong>${escapeHtml(documentTitle)}</strong></div>
      <div>${locatorChips || '<span class="locator">位置信息不可用</span>'}</div>
      <pre>${escapeHtml(content)}</pre>
    `;
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // --- 会话持久化：刷新页面后仍能延续多轮上下文 ---

  private storageKey(): string {
    return `kb-widget:${this.config.kbId}`;
  }

  private persistConversation(): void {
    try {
      if (this.conversationId) sessionStorage.setItem(this.storageKey(), this.conversationId);
    } catch {
      // 隐私模式下 sessionStorage 可能不可用，忽略即可
    }
  }

  private restoreConversation(): void {
    try {
      const saved = sessionStorage.getItem(this.storageKey());
      if (!saved) return;
      this.conversationId = saved;

      // 拉回历史，保证界面与服务端上下文一致
      void fetch(
        `${this.config.apiBase}/api/public/kb/${encodeURIComponent(this.config.kbId)}/conversations/${encodeURIComponent(saved)}`,
        { headers: { 'x-kb-key': this.config.apiKey } },
      )
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (!payload?.messages) return;
          this.messagesEl.innerHTML = '';
          for (const message of payload.messages) {
            const node = this.addMessage({
              id: message.id,
              role: message.role,
              content: message.content,
              citations: message.citations ?? [],
            });
            if (message.id && message.role === 'assistant') {
              this.renderActions(node, message.id);
            }
          }
        })
        .catch(() => undefined);
    } catch {
      // 同上
    }
  }
}

const NOTICE_TEXT: Record<string, string> = {
  refusal: '知识库中没有找到回答该问题所需的依据，因此不作推断性回答。',
  conflict: '知识库中的多份资料存在不一致，以上并列呈现，未替你做取舍。',
  partial: '以下只覆盖了问题的部分方面，资料未涉及的部分已明确说明。',
};

/**
 * 把 HTTP 错误翻译成可操作的提示。
 *
 * 401/403 是最容易误判的情况：用户往往以为是知识库没内容，
 * 实际是 kb_id 与 public key 不匹配或来源不在白名单。
 */
async function describeHttpError(response: Response, config: WidgetConfig): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: string };
    detail = body.error ?? '';
  } catch {
    detail = '';
  }

  if (response.status === 401) {
    return (
      `鉴权失败（401）${detail ? `：${detail}` : ''}。` +
      `请检查 data-api-key 是否为该知识库的公开 key（形如 pk_xxx）。`
    );
  }
  if (response.status === 403) {
    return (
      `访问被拒绝（403）${detail ? `：${detail}` : ''}。` +
      `常见原因：kb-id 与 api-key 不属于同一个知识库，或当前来源不在该知识库的允许域名列表中。`
    );
  }
  if (response.status === 404) {
    return `接口不存在（404）${detail ? `：${detail}` : ''}。请确认 data-kb-id 与 data-api-base 是否正确。`;
  }
  return detail || `请求失败：HTTP ${response.status}`;
}

function describeLocatorParts(locator: Citation['locator']): string[] {
  const parts: string[] = [];
  if (locator.page !== undefined) {
    parts.push(
      locator.pageEnd && locator.pageEnd !== locator.page
        ? `第 ${locator.page}–${locator.pageEnd} 页`
        : `第 ${locator.page} 页`,
    );
  }
  if (locator.sheet) parts.push(`工作表「${locator.sheet}」`);
  if (locator.cellRange) parts.push(locator.cellRange);
  if (locator.headingPath?.length) parts.push(locator.headingPath.join(' › '));
  if (locator.lineStart !== undefined) {
    parts.push(
      locator.lineEnd && locator.lineEnd !== locator.lineStart
        ? `第 ${locator.lineStart}–${locator.lineEnd} 行`
        : `第 ${locator.lineStart} 行`,
    );
  }
  return parts;
}

function describeLocator(locator: Citation['locator']): string {
  return describeLocatorParts(locator).join('，');
}

function shortLocator(locator: Citation['locator']): string {
  const parts = describeLocatorParts(locator);
  return parts.length > 0 ? ` · ${parts[0]}` : '';
}

/** 极简 Markdown 渲染：只支持加粗、行内代码与换行，避免引入依赖。 */
function renderMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

/**
 * 生成模型菜单的 HTML。
 *
 * 相比原生 <select>，这里能表达「提供商 → 模型 → 连接状态」的层级，
 * 并把已连接的模型标出来，用户不用点开才知道哪个能用。
 */
function modelMenuMarkup(config: WidgetConfig, connections: Map<string, ModelConnection>): string {
  const presets = resolveModelPresets(config);

  // 按提供商分组，保持预设顺序
  const groups = new Map<string, ModelPreset[]>();
  for (const preset of presets) {
    const bucket = groups.get(preset.provider);
    if (bucket) bucket.push(preset);
    else groups.set(preset.provider, [preset]);
  }

  const selected = config.model ?? '';

  const groupHtml = [...groups.entries()]
    .map(([provider, models]) => {
      const items = models
        .map((preset) => {
          const isSelected = preset.model === selected;
          const connected = connections.has(preset.model);
          return `<button class="model-item" type="button" role="option"
                    data-model="${escapeAttr(preset.model)}"
                    aria-selected="${isSelected ? 'true' : 'false'}">
            <span class="meta">
              <span class="title">${escapeHtml(preset.model)}</span>
              <span class="subtitle">${escapeHtml(describePreset(preset))}</span>
            </span>
            ${connected ? '<span class="state connected">已连接</span>' : '<span class="state">未连接</span>'}
            <svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 6 9 17l-5-5"/>
            </svg>
          </button>`;
        })
        .join('');
      return `<div class="model-group">
        <div class="model-menu-label">${escapeHtml(provider)}</div>
        ${items}
      </div>`;
    })
    .join('');

  return `<div class="model-menu-label">选择回答所用模型</div>${groupHtml}`;
}

/** 预设的副标题：说明该模型的定位，帮助用户选择。 */
function describePreset(preset: ModelPreset): string {
  const hints: Record<string, string> = {
    'gpt-4o-mini': '快速、成本低',
    'gpt-4.1-mini': '均衡',
    'gemini-2.0-flash': '快速',
    'claude-3-5-sonnet-latest': '长文本理解强',
    'MiniMax-Text-01': '中文友好',
    'deepseek-chat': '中文友好、性价比高',
    'deepseek-reasoner': '推理增强、较慢',
  };
  return hints[preset.model] ?? preset.provider;
}

/** 解析生效的模型列表：优先用 data-models，否则用内置预设。 */
function resolveModelPresets(config: WidgetConfig): ModelPreset[] {
  if (config.models?.length) {
    return config.models.map((model) => {
      const known = MODEL_PRESETS.find((preset) => preset.model === model);
      return known ?? { provider: '服务端', model };
    });
  }
  return MODEL_PRESETS;
}

/** 模型触发按钮上的显示名：过长时截断，避免撑破工具栏。 */
function shortModelName(model: string): string {
  if (!model) return '选择模型';
  return model.length <= 20 ? model : `${model.slice(0, 18)}…`;
}

/** 从 script 标签读取配置并自动初始化。 */
export function autoInit(): void {
  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    (document.querySelector('script[data-kb-id]') as HTMLScriptElement | null);
  if (!script) {
    console.error('[kb-widget] 未找到带 data-kb-id 的 script 标签');
    return;
  }

  const dataset = script.dataset;
  const start = () => {
    initWidget({
      kbId: dataset.kbId,
      apiKey: dataset.apiKey,
      apiBase: dataset.apiBase || undefined,
      title: dataset.title,
      welcome: dataset.welcome,
      placeholder: dataset.placeholder,
      theme: dataset.theme as WidgetConfig['theme'],
      accent: dataset.accent,
      position: dataset.position as WidgetConfig['position'],
      mode: (dataset.mode as WidgetConfig['mode']) ?? 'shadow',
      layout: (dataset.layout as WidgetConfig['layout']) ?? 'sidebar',
      model: dataset.model || undefined,
      models: dataset.models
        ? dataset.models.split(',').map((item) => item.trim()).filter(Boolean)
        : undefined,
    });
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

export type { WidgetConfig, Citation };
