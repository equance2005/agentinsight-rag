/**
 * 管理台交互脚本。
 *
 * 只使用知识库的公开契约接口，这样管理台本身就是「通用客户端」的示例 ——
 * 任何外部系统都能照着它接入，不需要了解宿主内部结构。
 */

const state = {
  kbId: '',
  apiKey: '',
  conversationId: '',
  widgetScript: null,
  /** 是否已成功连接知识库；未连接时禁用上传与提问，避免静默失败。 */
  connected: false,
  /** 连接成功后服务端返回的知识库名称，用于在提示里显示目标库。 */
  kbName: '',
};

let askInFlight = false;

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'kb-console-config';

// ---------------------------------------------------------------------------
// 配置存取
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved.kbId) $('kbId').value = saved.kbId;
    if (saved.apiKey) $('apiKey').value = saved.apiKey;
    if (saved.kbId && saved.apiKey) setConfigStatus('已从本机恢复配置，点击「加载配置」验证。', 'warn');
  } catch {
    // 忽略损坏的本地配置
  }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ kbId: state.kbId, apiKey: state.apiKey }));
  setConfigStatus('已保存到本机浏览器。', 'ok');
}

function readForm() {
  state.kbId = $('kbId').value.trim();
  state.apiKey = $('apiKey').value.trim();
}

function setConfigStatus(text, kind = '') {
  const el = $('configStatus');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${kind}`;
}

// ---------------------------------------------------------------------------
// 1. 连接
// ---------------------------------------------------------------------------

async function connect() {
  readForm();
  if (!state.kbId || !state.apiKey) {
    setConfigStatus('请先填写知识库 ID 与公开 key。', 'err');
    return;
  }

  setConfigStatus('正在验证…');
  try {
    const response = await fetch(`/api/public/kb/${encodeURIComponent(state.kbId)}/config`, {
      headers: { 'x-kb-key': state.apiKey },
    });
    const payload = await response.json();

    if (!response.ok) {
      setConfigStatus(`连接失败：${payload.error || response.status}`, 'err');
      return;
    }

    setConfigStatus(`已连接：${payload.name}（${payload.kbId}）`, 'ok');
    state.connected = true;
    state.kbName = payload.name;
    renderSnippet();
    updateUploadHint();
    updateAskHint();
  } catch (error) {
    setConfigStatus(`连接失败：${error.message}`, 'err');
    state.connected = false;
    updateUploadHint();
    updateAskHint();
  }
}

/**
 * 同步各操作区的可用状态。
 *
 * 之前的问题：没连接知识库时按钮仍可点，上传/提问会静默失败或返回空结果，
 * 让人以为「知识库没覆盖」。这里统一把前置条件显式化。
 */
function updateUploadHint() {
  const hint = $('uploadHint');
  const btn = $('btnUpload');
  const fileInput = $('files');

  if (!state.connected) {
    hint.innerHTML = '<span style="color:var(--err)">请先在上方「连接知识库」并加载成功，再上传文件。</span>';
    btn.disabled = true;
    fileInput.disabled = true;
    return;
  }

  const count = fileInput.files ? fileInput.files.length : 0;
  hint.innerHTML =
    `将导入到 <strong>${escapeHtml(state.kbName || state.kbId)}</strong>。` +
    (count > 0 ? `已选择 <strong>${count}</strong> 个文件。` : '尚未选择文件。');
  btn.disabled = count === 0;
  fileInput.disabled = false;
}

function updateAskHint() {
  const hint = $('askHint');
  const btnStream = $('btnAsk');
  const btnSync = $('btnAskSync');

  if (!state.connected) {
    hint.innerHTML = '<span style="color:var(--err)">请先在上方「连接知识库」并加载成功，再提问。</span>';
    btnStream.disabled = true;
    btnSync.disabled = true;
    return;
  }

  hint.innerHTML = `将在 <strong>${escapeHtml(state.kbName || state.kbId)}</strong> 中检索并回答。`;
  btnStream.disabled = false;
  btnSync.disabled = false;
}

// ---------------------------------------------------------------------------
// 2. 上传
// ---------------------------------------------------------------------------

async function upload() {
  readForm();
  const input = $('files');
  if (!input.files || input.files.length === 0) {
    setStatus('uploadStatus', '请先选择文件。', 'err');
    return;
  }
  if (!state.kbId || !state.apiKey) {
    setStatus('uploadStatus', '请先在上方「连接知识库」填写并加载配置。', 'err');
    return;
  }

  const form = new FormData();
  for (const file of input.files) form.append('files', file, file.name);

  setStatus('uploadStatus', `正在上传 ${input.files.length} 个文件…`);
  $('uploadResult').innerHTML = '';

  try {
    const response = await fetch(`/api/public/kb/${encodeURIComponent(state.kbId)}/upload`, {
      method: 'POST',
      headers: { 'x-kb-key': state.apiKey },
      body: form,
    });
    const payload = await response.json();

    if (!response.ok) {
      setStatus('uploadStatus', `上传失败：${payload.error || response.status}`, 'err');
      return;
    }

    const s = payload.stats;
    setStatus(
      'uploadStatus',
      `完成：新增 ${s.added}，更新 ${s.updated}，未变 ${s.unchanged}，失败 ${s.failed}，` +
        `新建片段 ${s.chunksCreated}，耗时 ${s.durationMs}ms`,
      s.failed > 0 ? 'warn' : 'ok',
    );

    if (payload.failures && payload.failures.length > 0) {
      // 解析失败必须显式呈现，不能只体现在计数里
      $('uploadResult').innerHTML =
        '<div class="status err">以下文件解析失败（已记录原因）：</div><pre class="out">' +
        payload.failures
          .map((f) => `${f.title}\n  ${f.error}`)
          .join('\n\n') +
        '</pre>';
    }
  } catch (error) {
    setStatus('uploadStatus', `上传失败：${error.message}`, 'err');
  }
}

// ---------------------------------------------------------------------------
// 3. 问答
// ---------------------------------------------------------------------------

function renderAskResult(result) {
  const decisionLabels = {
    answerable: '可答',
    partial: '部分可答',
    conflict: '证据冲突',
    no_evidence: '拒答（证据不足）',
  };

  const citations = (result.citations || [])
    .map(
      (c) =>
        `<li>[${c.index}] ${escapeHtml(c.documentTitle)}` +
        `${escapeHtml(describeLocator(c.locator))}` +
        `　<code>${c.chunkId}</code></li>`,
    )
    .join('');

  $('askResult').innerHTML = `
    <div style="margin-top:14px">
      <div class="status ${result.gate.decision === 'answerable' ? 'ok' : 'warn'}">
        裁决：<strong>${decisionLabels[result.gate.decision] || result.gate.decision}</strong>
        　阶段：${result.gate.stage}
        　检索模式：${result.retrieval ? result.retrieval.mode : '-'}
        　命中：${result.retrieval ? result.retrieval.hitCount : '-'} 条
        　耗时：${result.latencyMs}ms
      </div>
      ${renderTimings(result.timings, result.clientMs, result.fastMode)}
      <div class="status">依据：${escapeHtml(result.gate.reason)}</div>
      ${result.gate.suggestions && result.gate.suggestions.length
        ? `<div class="status warn">建议：${result.gate.suggestions.map(escapeHtml).join('；')}</div>`
        : ''}
      ${result.gate.missing && result.gate.missing.length
        ? `<div class="status warn">缺失信息：${result.gate.missing.map(escapeHtml).join('；')}</div>`
        : ''}
      <pre class="out" id="answerBox"></pre>
      ${citations ? `<div style="margin-top:10px"><strong>引用来源</strong><ul class="checklist">${citations}</ul></div>` : ''}
      <div class="status">messageId：<code>${result.messageId || '-'}</code>
        　会话：<code>${result.conversationId || '-'}</code></div>
    </div>
  `;
  $('answerBox').textContent = result.answer;
}

/** 渲染分阶段耗时条，直观看出时间花在哪里。 */
function renderTimings(t, clientMs = null, fastMode = false) {
  if (!t) return '';

  const rows = [
    ['检索（含 query embedding）', Number(t.retrievalMs) || 0],
    ['闸门①本地判定', Number(t.localGateMs) || 0],
    ['闸门②证据判定（LLM）', Number(t.evidenceGateMs) || 0],
    ['生成回答（LLM）', Number(t.generateMs) || 0],
    ['生成后校验（LLM）', Number(t.claimCheckMs) || 0],
    ['上下文装载', Number(t.contextMs) || 0],
  ].filter(([, ms]) => ms > 0);

  const serverTotal = Number(t.totalMs) || 0;
  if (rows.length === 0 && serverTotal === 0) return '';

  const max = Math.max(...rows.map(([, ms]) => ms), 1);
  const slowest = rows.reduce((best, row) => (row[1] > best[1] ? row : best), rows[0] || ['暂无阶段数据', 0]);
  const stageTotal = rows.reduce((sum, [, ms]) => sum + ms, 0);
  const bars = rows
    .map(([label, ms]) => {
      const pct = (ms / max) * 100;
      const color = ms > 3000 ? '#cf222e' : ms > 1000 ? '#9a6700' : '#1a7f37';
      return `<div class="timing-row">
        <span class="timing-label">${label}</span>
        <span class="timing-track"><span class="timing-fill" style="width:${pct.toFixed(1)}%;background:${color}"></span></span>
        <span class="timing-value">${ms}ms</span>
      </div>`;
    })
    .join('');

  const fastNote = fastMode
    ? '快速模式已启用：跳过生成后校验，响应更快，但回答少一道 claim 级一致性检查。'
    : '想缩短响应时间可开启快速模式；默认模式保留完整回答校验。';
  return `<details class="timing-panel" open>
    <summary>查询耗时分解 · 最慢阶段：${slowest[0]}（${slowest[1]}ms）</summary>
    <div class="timing-summary">
      <span class="timing-chip">服务端总耗时：<strong>${serverTotal}ms</strong></span>
      <span class="timing-chip">阶段合计：<strong>${stageTotal}ms</strong></span>
      <span class="timing-chip">LLM：<strong>${Number(t.llmCalls) || 0} 次</strong></span>
      ${clientMs !== null ? `<span class="timing-chip">页面端到端：<strong>${clientMs}ms</strong></span>` : ''}
    </div>
    <div class="timing-bars">${bars || '<span class="timing-note">本次请求没有可计时阶段。</span>'}</div>
    <div class="timing-note">${fastNote} 阶段可能并行执行，因此阶段合计不一定等于总耗时。</div>
  </details>`;
}

async function ask(stream) {
  if (askInFlight) return;
  askInFlight = true;
  $('btnAsk').disabled = true;
  $('btnAskSync').disabled = true;

  try {
  readForm();
  const question = $('question').value.trim();
  if (!question) {
    setStatus('askStatus', '请输入问题。', 'err');
    return;
  }
  if (!state.kbId || !state.apiKey) {
    setStatus('askStatus', '请先在上方「连接知识库」填写并加载配置。', 'err');
    return;
  }

  const topK = Math.min(Math.max(Number($('topK').value) || 6, 1), 50);
  const fastMode = $('fastMode').checked;
  const startedAt = performance.now();
  setStatus('askStatus', stream ? '正在生成（流式）…' : '正在生成…');
  $('askResult').innerHTML = '';

  if (!stream) {
    try {
      const response = await fetch(`/api/public/kb/${encodeURIComponent(state.kbId)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kb-key': state.apiKey },
        body: JSON.stringify({
          message: question,
          conversationId: state.conversationId || undefined,
          topK,
          claimCheck: !fastMode,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setStatus('askStatus', `失败：${payload.error || response.status}`, 'err');
        return;
      }
      state.conversationId = payload.conversationId;
      $('conversationId').value = payload.conversationId;
      setStatus('askStatus', '完成。', 'ok');
      renderAskResult({ ...payload, clientMs: Math.round(performance.now() - startedAt), fastMode });
    } catch (error) {
      setStatus('askStatus', `失败：${error.message}`, 'err');
    }
    return;
  }

  // 流式：逐事件更新正文，验证增量输出
  const params = new URLSearchParams({ message: question, topK: String(topK) });
  params.set('claimCheck', String(!fastMode));
  if (state.conversationId) params.set('conversationId', state.conversationId);

  $('askResult').innerHTML =
    '<div style="margin-top:14px"><div class="status" id="streamGate">连接中…</div>' +
    '<pre class="out" id="streamBox"></pre></div>';

  let text = '';
  let done = null;

  try {
    const response = await fetch(
      `/api/public/kb/${encodeURIComponent(state.kbId)}/chat/stream?${params}`,
      { headers: { 'x-kb-key': state.apiKey } },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setStatus('askStatus', `失败：${payload.error || response.status}`, 'err');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
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

        let payload;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }

        if (eventName === 'meta' && payload.conversationId) {
          state.conversationId = payload.conversationId;
          $('conversationId').value = payload.conversationId;
        } else if (eventName === 'delta') {
          text += payload.text || '';
          $('streamBox').textContent = text;
        } else if (eventName === 'done') {
          done = payload;
        }
      }
    }
  } catch (error) {
    setStatus('askStatus', `流式失败：${error.message}`, 'err');
    return;
  }

  setStatus('askStatus', '完成。', 'ok');
  if (done) {
    // 用最终的权威结果重绘（含闸门裁决与引用）
    renderAskResult({
      answer: done.answer,
      citations: done.citations,
      gate: done.gate,
      retrieval: done.retrieval ?? null,
      latencyMs: done.latencyMs,
      timings: done.timings,
      messageId: done.messageId,
      conversationId: done.conversationId,
      clientMs: Math.round(performance.now() - startedAt),
      fastMode,
    });
  } else {
    $('streamBox').textContent = text;
    setStatus('askStatus', '流式结束但未收到完成事件。', 'warn');
  }
  } finally {
    askInFlight = false;
    updateAskHint();
  }
}

// ---------------------------------------------------------------------------
// 4. 插件集成
// ---------------------------------------------------------------------------

function renderSnippet() {
  const code =
    `<script src="${location.origin}/api/public/kb/widget.js"\n` +
    `        data-kb-id="${state.kbId}"\n` +
    `        data-api-key="${state.apiKey}"\n` +
    `        data-title="知识库助手"><\/script>`;
  $('embedSnippet').textContent = code;
}

function mountWidget() {
  readForm();
  if (!state.kbId || !state.apiKey) {
    setStatus('widgetStatus', '请先填写知识库 ID 与 key。', 'err');
    return;
  }
  if (document.getElementById('kb-widget-host')) {
    setStatus('widgetStatus', '插件已挂载（见右下角悬浮图标）。', 'warn');
    return;
  }

  // 与外部站点完全相同的集成方式：只加一个 script 标签
  const script = document.createElement('script');
  script.src = '/api/public/kb/widget.js';
  script.dataset.kbId = state.kbId;
  script.dataset.apiKey = state.apiKey;
  script.dataset.apiBase = location.origin;
  script.dataset.title = '知识库助手';
  script.dataset.accent = '#4f46e5';
  document.body.appendChild(script);
  state.widgetScript = script;

  setStatus('widgetStatus', '已挂载，请点击右下角悬浮图标开始问答。', 'ok');
}

function unmountWidget() {
  const host = document.getElementById('kb-widget-host');
  if (host) host.remove();
  if (state.widgetScript) state.widgetScript.remove();
  state.widgetScript = null;
  setStatus('widgetStatus', '已卸载。刷新页面可重新加载插件。', '');
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function describeLocator(locator) {
  if (!locator) return '';
  const parts = [];
  if (locator.page !== undefined) {
    parts.push(
      locator.pageEnd && locator.pageEnd !== locator.page
        ? `第${locator.page}-${locator.pageEnd}页`
        : `第${locator.page}页`,
    );
  }
  if (locator.sheet) parts.push(`工作表「${locator.sheet}」`);
  if (locator.cellRange) parts.push(locator.cellRange);
  if (locator.headingPath && locator.headingPath.length) parts.push(locator.headingPath.join(' › '));
  if (locator.lineStart !== undefined) {
    parts.push(
      locator.lineEnd && locator.lineEnd !== locator.lineStart
        ? `第${locator.lineStart}-${locator.lineEnd}行`
        : `第${locator.lineStart}行`,
    );
  }
  return parts.length ? `（${parts.join('，')}）` : '';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 轻量的 spotlight / parallax：不依赖额外框架，保持管理台零构建成本。
for (const panel of document.querySelectorAll('.panel')) {
  panel.addEventListener('pointermove', (event) => {
    const rect = panel.getBoundingClientRect();
    panel.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    panel.style.setProperty('--my', `${event.clientY - rect.top}px`);
  });
}

const header = document.querySelector('header');
window.addEventListener('scroll', () => {
  if (!header) return;
  const progress = Math.min(window.scrollY / 420, 1);
  header.style.setProperty('--scroll-opacity', String(1 - progress * .25));
  header.style.setProperty('--scroll-shift', `${progress * -3}px`);
}, { passive: true });

// ---------------------------------------------------------------------------
// 绑定
// ---------------------------------------------------------------------------

$('btnConnect').addEventListener('click', connect);
$('btnSave').addEventListener('click', () => {
  readForm();
  saveConfig();
});
$('btnClear').addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  $('kbId').value = '';
  $('apiKey').value = '';
  state.kbId = '';
  state.apiKey = '';
  state.connected = false;
  state.kbName = '';
  setConfigStatus('已清除本机配置。', '');
  updateUploadHint();
  updateAskHint();
});
$('btnUpload').addEventListener('click', upload);
$('files').addEventListener('change', updateUploadHint);
$('btnAsk').addEventListener('click', () => ask(true));
$('btnAskSync').addEventListener('click', () => ask(false));
$('btnReset').addEventListener('click', () => {
  state.conversationId = '';
  $('conversationId').value = '';
  setStatus('askStatus', '已开始新会话。', '');
});
$('btnMount').addEventListener('click', mountWidget);
$('btnUnmount').addEventListener('click', unmountWidget);

// 支持用 URL 参数预填，便于脚本化验收
const params = new URLSearchParams(location.search);
if (params.get('kb')) $('kbId').value = params.get('kb');
if (params.get('key')) $('apiKey').value = params.get('key');

loadConfig();
updateUploadHint();
updateAskHint();
