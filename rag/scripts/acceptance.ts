/**
 * 六组验收场景的自动化验证。
 *
 * 覆盖 C / D / F 组中需要 HTTP 层与插件契约的部分，
 * 输出可直接引用的结果记录。
 *
 * 用法：node --experimental-transform-types --import ./scripts/register.mjs scripts/acceptance.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KbServer } from '../src/server/server.ts';
import { KnowledgeBaseEngine } from '../src/lib/kb/index.ts';
import type { EmbeddingProvider, LlmProvider, LlmMessage, LlmOptions } from '../src/lib/kb/ports.ts';

// ---------------------------------------------------------------------------
// 确定性假模型：让验收可重复，不依赖外部 API
// ---------------------------------------------------------------------------

class FakeEmbedder implements EmbeddingProvider {
  readonly modelId = 'acceptance-embed';
  readonly dim = 64;

  private vec(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const ch of text) v[ch.codePointAt(0)! % this.dim] += 1;
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }

  async embed(texts: string[]) {
    return texts.map((t) => this.vec(t));
  }
  async embedQuery(text: string) {
    return this.vec(text);
  }
}

/**
 * 假生成模型：根据检索到的片段合成带引用的回答。
 *
 * 这里刻意实现「只看片段」的行为，用来验证引用回填链路，
 * 而不是检验某个真实模型的能力。
 */
class ExtractiveLlm implements LlmProvider {
  readonly modelId = 'acceptance-llm';
  calls = 0;
  models: string[] = [];

  async complete(messages: LlmMessage[], _options?: LlmOptions) {
    this.calls++;
    if (_options?.model) this.models.push(_options.model);
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';

    if (system.includes('证据充分性判定器')) {
      return { text: JSON.stringify({ decision: 'answerable', reason: '片段直接覆盖问题', missing: [] }), usage: null };
    }
    if (system.includes('忠实度校验器')) {
      return { text: JSON.stringify({ claims: [] }), usage: null };
    }

    // 从片段中挑出与问题重合度最高的句子，标注其编号
    const blocks = [...user.matchAll(/\[(\d+)\][^\n]*\n([\s\S]*?)(?=\n\n---|$)/g)];
    const parts: string[] = [];
    for (const block of blocks.slice(0, 3)) {
      const index = block[1];
      const text = block[2].replace(/\s+/g, ' ').trim();
      if (text) parts.push(`${text.slice(0, 120)} [${index}]`);
    }
    return { text: parts.join('\n\n') || '（没有可用片段）', usage: { input: 100, output: 50 } };
  }

  async *stream(messages: LlmMessage[], options?: LlmOptions) {
    const result = await this.complete(messages, options);
    for (const chunk of result.text.match(/.{1,12}/gs) ?? []) yield chunk;
  }
}

// ---------------------------------------------------------------------------
// 验收执行
// ---------------------------------------------------------------------------

interface Check {
  group: string;
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
const record = (group: string, name: string, pass: boolean, detail: string) =>
  checks.push({ group, name, pass, detail });

/** 统一的接口调用助手，避免层层嵌套的 await。 */
async function api(
  url: string,
  kbId: string,
  key: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; ok: boolean; headers: Headers; body: any }> {
  const response = await fetch(`${url}/api/public/kb/${kbId}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-kb-key': key,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, headers: response.headers, body };
}

/** 发起一次问答。 */
function ask(
  url: string,
  kbId: string,
  key: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return api(url, kbId, key, '/chat', {
    method: 'POST',
    body: JSON.stringify({ message, ...extra }),
  });
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'kb-accept-'));
  const docDir = join(workDir, 'docs');
  mkdirSync(docDir, { recursive: true });
  const embedder = new FakeEmbedder();
  const llm = new ExtractiveLlm();

  const engine = new KnowledgeBaseEngine({
    databasePath: join(workDir, 'kb.db'),
    embedder,
    llm,
  });

  const server = new KbServer({
    port: 0,
    host: '127.0.0.1',
    publicDir: join(process.cwd(), 'public'),
    uploadDir: join(workDir, 'uploads'),
    engine,
  });

  const { url } = await server.listen();
  console.log(`验收服务已启动：${url}\n`);

  try {
    // --- 准备知识库内容 ---
    writeFileSync(
      join(docDir, 'deploy.md'),
      [
        '# 部署手册',
        '',
        '## 端口配置',
        '',
        '服务默认监听端口为 3000，可以通过配置文件修改。',
        '',
        '## 数据库',
        '',
        '数据库默认端口是 5432，连接池上限为 20。',
        '',
      ].join('\n'),
      'utf8',
    );

    const kb = engine.createKnowledgeBase({ name: 'acceptance', description: '验收用知识库' });
    await engine.importDirectory({ kbId: kb.id, directory: docDir, include: ['*.md'] });

    const key = kb.publicKey!;
    const auth = { 'x-kb-key': key };

    // =====================================================================
    // C 组：通用插件集成
    // =====================================================================

    {
      // 插件产物可被独立获取
      const widget = await fetch(`${url}/api/public/kb/widget.js`);
      const widgetCode = await widget.text();
      record(
        'C',
        '插件产物可独立获取',
        widget.ok && widgetCode.includes('attachShadow'),
        `HTTP ${widget.status}，${(widgetCode.length / 1024).toFixed(1)}KB，含 Shadow DOM 隔离`,
      );

      // 插件产物不得引用任何 Agent Insight 专有接口
      const forbidden = [
        '/api/trace',
        '/api/execution',
        'executionId',
        '/api/skills',
        '/api/experiments',
        'agent-insight',
        'AgentInsight',
      ];
      const found = forbidden.filter((token) => widgetCode.includes(token));
      record(
        'C',
        '插件不依赖宿主专有接口',
        found.length === 0,
        found.length === 0 ? '未出现任何专有接口/标识' : `发现专有引用：${found.join(', ')}`,
      );

      // 插件只调用公开契约
      const publicCalls = [...widgetCode.matchAll(/\/api\/public\/kb[\w/{}$.-]*/g)].map((m) => m[0]);
      record(
        'C',
        '插件仅调用公开契约路径',
        publicCalls.length > 0 && publicCalls.every((p) => p.startsWith('/api/public/kb')),
        `调用路径：${[...new Set(publicCalls)].join(', ')}`,
      );
    }

    {
      // 外部站点（不同 Origin）能正常完成问答
      const response = await fetch(`${url}/api/public/kb/${kb.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth, origin: 'https://example.com' },
        body: JSON.stringify({ message: '服务默认端口是多少？' }),
      });
      const payload = await response.json();
      record(
        'C',
        '外部站点可完成普通文档问答',
        response.ok && payload.answer && payload.citations?.length > 0,
        `HTTP ${response.status}，回答 ${payload.answer?.length ?? 0} 字，引用 ${payload.citations?.length ?? 0} 条`,
      );
      record(
        'C',
        '跨域响应带 CORS 头',
        response.headers.get('access-control-allow-origin') === 'https://example.com',
        `Access-Control-Allow-Origin: ${response.headers.get('access-control-allow-origin')}`,
      );
    }

    {
      // 同一份插件在两种宿主下调用相同接口，通过站点标识区分来源
      const hostA = await fetch(`${url}/api/public/kb/${kb.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth, origin: 'https://host-a.test' },
        body: JSON.stringify({ message: '端口是多少' }),
      }).then((r) => r.json());

      const hostB = await fetch(`${url}/api/public/kb/${kb.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth, origin: 'https://host-b.test' },
        body: JSON.stringify({ message: '端口是多少' }),
      }).then((r) => r.json());

      const convA = engine.getConversation(hostA.conversationId);
      const convB = engine.getConversation(hostB.conversationId);

      record(
        'C',
        '双宿主行为一致（仅站点标识不同）',
        convA?.siteKey === 'host-a.test' && convB?.siteKey === 'host-b.test',
        `站点标识：${convA?.siteKey} / ${convB?.siteKey}；两条请求走同一接口与同一份数据`,
      );
    }

    // =====================================================================
    // D 组：多轮与交互
    // =====================================================================

    {
      const first = await ask(url, kb.id, key, '数据库默认端口是多少？');
      const second = await ask(url, kb.id, key, '那连接池上限呢？', {
        conversationId: first.body.conversationId,
      });

      record(
        'D',
        '多轮上下文由服务端维护',
        first.body.conversationId === second.body.conversationId && !!second.body.conversationId,
        `同一 conversationId：${second.body.conversationId}`,
      );

      const history = engine.getMessages(first.body.conversationId, 20);
      record('D', '会话历史完整落库', history.length === 4, `共 ${history.length} 条消息（2 轮问答）`);
    }

    {
      // SSE 流式：应收到 meta / delta / citations / done 事件
      const response = await fetch(
        `${url}/api/public/kb/${kb.id}/chat/stream?message=${encodeURIComponent('服务默认端口是多少')}`,
        { headers: auth },
      );
      const text = await response.text();
      const events = [...text.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
      const deltaCount = events.filter((e) => e === 'delta').length;
      const doneLine = text.match(/event: done\ndata: ([^\n]+)/);
      const donePayload = doneLine ? JSON.parse(doneLine[1]) as { retrieval?: { mode?: string }; timings?: { totalMs?: number } } : null;

      record(
        'D',
        'SSE 流式输出可用',
        response.ok && events.includes('delta') && events.includes('done'),
        `事件序列：${[...new Set(events)].join(' → ')}（delta ×${deltaCount}）`,
      );
      record(
        'D',
        '流式响应头正确',
        (response.headers.get('content-type') ?? '').includes('text/event-stream'),
        `Content-Type: ${response.headers.get('content-type')}`,
      );
      record(
        'D',
        '流式结果带回检索摘要与耗时',
        donePayload?.retrieval?.mode !== undefined && (donePayload.timings?.totalMs ?? 0) >= 0,
        `检索模式：${donePayload?.retrieval?.mode ?? '-'}；服务端总耗时：${donePayload?.timings?.totalMs ?? '-'}ms`,
      );
    }

    // =====================================================================
    // E 组：依据与拒答（HTTP 层复核）
    // =====================================================================

    {
      const cases: Array<{ q: string; expect: string; label: string }> = [
        { q: '服务默认端口是多少？', expect: 'answerable', label: '有明确答案' },
        { q: '如何申请火星移民签证的面试预约？', expect: 'no_evidence', label: '知识库未覆盖' },
      ];

      for (const item of cases) {
        const result = await ask(url, kb.id, key, item.q);
        record(
          'E',
          `${item.label} → ${item.expect}`,
          result.body.gate?.decision === item.expect,
          `实际裁决 ${result.body.gate?.decision}；引用 ${result.body.citations?.length ?? 0} 条`,
        );
      }
    }

    {
      // 引用可定位：按 chunkId 拉取详情，应带出文档与位置
      const answered = await ask(url, kb.id, key, '服务默认端口是多少？');
      const citation = answered.body.citations?.[0];
      const detail = await api(url, kb.id, key, `/chunks/${citation.chunkId}`, { method: 'GET' });

      const locatable =
        detail.body.document?.title === 'deploy.md' &&
        Array.isArray(detail.body.locator?.headingPath) &&
        detail.body.locator.headingPath.includes('端口配置');

      record(
        'E',
        '引用可点击并定位到文档与位置',
        locatable,
        `文档：${detail.body.document?.title}；定位：${JSON.stringify(detail.body.locator)}`,
      );
    }

    // =====================================================================
    // F 组：反馈闭环
    // =====================================================================

    let downvoteMessageId = '';
    {
      // 先问一个知识库没覆盖的问题，确认它进入 backlog
      await ask(url, kb.id, key, '如何申请火星移民签证？');

      const issuesBefore = engine.listUnresolvedIssues(kb.id, { status: 'open' });
      const hasMars = issuesBefore.some((i) => i.query.includes('火星'));
      record(
        'F',
        '无法回答的问题被记录',
        hasMars,
        `backlog 中 ${issuesBefore.length} 条，含「火星」相关：${hasMars}`,
      );

      // 对一条正常回答点不认可
      const answered = await ask(url, kb.id, key, '数据库默认端口是多少？');
      downvoteMessageId = answered.body.messageId;

      const feedback = await fetch(`${url}/api/public/kb/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kb-key': key },
        body: JSON.stringify({
          messageId: answered.body.messageId,
          rating: 'down',
          reason: '答案没有覆盖我关心的场景',
        }),
      }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json() }));

      record(
        'F',
        '不认可反馈被接受并落库',
        feedback.ok && feedback.body.ok === true,
        `HTTP ${feedback.status}，feedbackId=${feedback.body.feedbackId}`,
      );

      const issuesAfter = engine.listUnresolvedIssues(kb.id, { status: 'open' });
      const downvotes = issuesAfter.filter((i) => i.reason === 'user_downvote').length;
      record('F', '不认可反馈进入维护者 backlog', downvotes > 0, `user_downvote 条目：${downvotes}`);
    }

    {
      // 反馈闭环：补录知识后同一问题转为可回答
      const report = engine.knowledgeGapReport(kb.id);
      const target = report.topQueries.find((item) => item.query.includes('火星'));
      record(
        'F',
        '知识缺口报告可聚类未解决问题',
        !!target && target.ids.length > 0,
        target ? `聚类到「${target.query}」，${target.count} 次，原因 ${target.reasons.join(',')}` : '未聚类到目标问题',
      );

      if (target) {
        const { resolvedCount } = await engine.resolveIssueWithQaPair({
          kbId: kb.id,
          issueIds: target.ids,
          question: '如何申请火星移民签证？',
          answer: '火星移民签证目前不在本知识库的业务范围内，请联系星际事务办公室。',
        });

        // 复验：同一问题现在应当可答
        const retry = await ask(url, kb.id, key, '如何申请火星移民签证？');

        record(
          'F',
          '补录知识后同一问题转为可回答',
          retry.body.gate?.decision !== 'no_evidence' && resolvedCount > 0,
          `关闭 ${resolvedCount} 条 issue，复验裁决 ${retry.body.gate?.decision}，引用 ${retry.body.citations?.length ?? 0} 条`,
        );

        const remaining = engine.listUnresolvedIssues(kb.id, { status: 'open' });
        record(
          'F',
          '已闭环问题从待办中移除',
          !remaining.some((i) => i.id === target.ids[0]),
          `剩余待办 ${remaining.length} 条`,
        );
      }
    }

    {
      // 反馈与未解决问题对维护者可见
      const feedbackList = engine.listFeedback({ limit: 20 });
      const openIssues = engine.listUnresolvedIssues(kb.id, { status: 'open' });
      record(
        'F',
        '维护者可查看反馈与待办',
        feedbackList.length > 0,
        `反馈记录 ${feedbackList.length} 条，未解决 ${openIssues.length} 条`,
      );
    }

    // =====================================================================
    // 通用性边界（静态检查）
    // ---------------------------------------------------------------------

    {
      const { readdirSync, readFileSync, statSync } = await import('node:fs');
      const forbiddenPatterns = [
        /\bExecution\b/,
        /\bExperimentCase\b/,
        /\bTraceEvaluation\b/,
        /\bSkillWorkbenchSession\b/,
        /from\s+['"]@\/lib\/trace/,
        /\bprisma\b/i,
      ];

      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else if (entry.endsWith('.ts')) files.push(full);
        }
      };
      walk(join(process.cwd(), 'src', 'lib', 'kb'));

      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        // 跳过纯注释行，避免把「不得引入 X」的说明误判为违规
        const code = content
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
          .join('\n');
        for (const pattern of forbiddenPatterns) {
          if (pattern.test(code)) violations.push(`${file.replace(process.cwd(), '')} → ${pattern}`);
        }
      }

      record(
        '通用性',
        '知识库引擎与宿主专有模型解耦',
        violations.length === 0,
        violations.length === 0
          ? `检查 ${files.length} 个源文件，未发现专有模型引用`
          : `违规：${violations.join('; ')}`,
      );
    }

    // =====================================================================
    // 公开接口边界：这些检查走真实 HTTP，补足单元测试无法覆盖的鉴权链路。
    // =====================================================================
    {
      const other = engine.createKnowledgeBase({ name: 'boundary-other' });
      const conversation = engine.repo.createConversation(kb.id, 'allowed.test');
      const before = engine.getMessages(conversation.id).length;
      const foreignHistory = await api(url, other.id, other.publicKey!, `/conversations/${conversation.id}`);
      const foreignChat = await ask(url, other.id, other.publicKey!, '端口是多少', { conversationId: conversation.id });
      record('安全', '跨知识库会话不能读取或追加',
        foreignHistory.status === 404 && foreignChat.status === 404 && engine.getMessages(conversation.id).length === before,
        `历史 HTTP ${foreignHistory.status}，问答 HTTP ${foreignChat.status}，原会话消息未变化`);

      const crossSiteHistory = await api(url, kb.id, key, `/conversations/${conversation.id}`,
        { headers: { origin: 'https://other.test' } });
      const crossSiteChat = await api(url, kb.id, key, '/chat', {
        method: 'POST', headers: { origin: 'https://other.test' },
        body: JSON.stringify({ message: '端口是多少', conversationId: conversation.id }),
      });
      const validHistory = await api(url, kb.id, key, `/conversations/${conversation.id}`,
        { headers: { origin: 'https://allowed.test' } });
      record('安全', '会话按站点隔离且同站点可恢复',
        crossSiteHistory.status === 403 && crossSiteChat.status === 403 && validHistory.status === 200,
        `跨站历史/问答 HTTP ${crossSiteHistory.status}/${crossSiteChat.status}，同站 HTTP ${validHistory.status}`);

      const invalidTopK = await ask(url, kb.id, key, '端口是多少', { topK: -1 });
      const invalidStream = await api(url, kb.id, key, '/chat/stream?message=hello&topK=Infinity');
      const invalidBody = await api(url, kb.id, key, '/chat', { method: 'POST', body: 'null' });
      record('安全', '非法参数在生成前返回 400',
        invalidTopK.status === 400 && invalidStream.status === 400 && invalidBody.status === 400,
        `topK HTTP ${invalidTopK.status}，SSE HTTP ${invalidStream.status}，空对象 HTTP ${invalidBody.status}`);

      const callsBeforeFast = llm.calls;
      const fastResult = await ask(url, kb.id, key, '服务默认端口是多少？', { claimCheck: false });
      const fastCalls = llm.calls - callsBeforeFast;
      record('性能', '快速模式减少一次模型调用',
        fastResult.ok && fastResult.body.timings?.claimCheckMs === 0 && fastCalls === 2,
        `LLM 调用 ${fastCalls} 次，生成后校验耗时 ${fastResult.body.timings?.claimCheckMs ?? '-'}ms`);

      const selectedModel = await ask(url, kb.id, key, '服务默认端口是多少？', { model: 'acceptance-llm' });
      record('性能', '插件选择的模型会传到生成链路',
        selectedModel.ok && llm.models.slice(-3).every((model) => model === 'acceptance-llm'),
        `最近模型调用：${llm.models.slice(-3).join(',') || '无'}`);

      const guarded = engine.createKnowledgeBase({ name: 'guarded-upload', allowedOrigins: ['allowed.test'] });
      const missingKey = await api(url, guarded.id, '', '/upload', { method: 'POST', body: '{}' });
      const badOrigin = await api(url, guarded.id, guarded.publicKey!, '/upload', {
        method: 'POST', headers: { origin: 'https://evil.test' }, body: '{}',
      });
      const upload = new FormData();
      upload.append('file', new Blob(['# 上传验证\n\n上传后的内容可以检索。']), 'upload.md');
      const accepted = await fetch(`${url}/api/public/kb/${guarded.id}/upload`, {
        method: 'POST', headers: { 'x-kb-key': guarded.publicKey!, origin: 'https://allowed.test' }, body: upload,
      });
      const uploadResult = await accepted.json() as { stats?: { added?: number } };
      record('安全', '上传需要 key 与合法来源，合法文件可摄取',
        missingKey.status === 401 && badOrigin.status === 403 && accepted.status === 200 && uploadResult.stats?.added === 1,
        `缺 key HTTP ${missingKey.status}，非法来源 HTTP ${badOrigin.status}，合法上传 HTTP ${accepted.status}`);

      const listed = await api(url, guarded.id, guarded.publicKey!, '/documents', {
        headers: { origin: 'https://allowed.test' },
      });
      const uploadedDocument = listed.body.documents?.find((document: { title?: string }) => document.title === 'upload.md');
      const deleted = uploadedDocument
        ? await api(url, guarded.id, guarded.publicKey!, `/documents/${uploadedDocument.id}`, {
            method: 'DELETE', headers: { origin: 'https://allowed.test' },
          })
        : { status: 0, ok: false, body: {} };
      const listedAfterDelete = await api(url, guarded.id, guarded.publicKey!, '/documents', {
        headers: { origin: 'https://allowed.test' },
      });
      record('安全', '管理台可列出并删除文档，且校验知识库归属',
        listed.status === 200 && uploadedDocument !== undefined && deleted.status === 200 &&
          listedAfterDelete.status === 200 &&
          !listedAfterDelete.body.documents?.some((document: { id?: string }) => document.id === uploadedDocument.id),
        `列表 HTTP ${listed.status}，删除 HTTP ${deleted.status}，删除后列表 HTTP ${listedAfterDelete.status}`);
    }

    // =====================================================================
    // 汇总
    // =====================================================================

    console.log('='.repeat(78));
    console.log('第一步验收结果');
    console.log('='.repeat(78));

    const groups = ['C', 'D', 'E', 'F', '通用性', '安全', '性能'];
    for (const group of groups) {
      const items = checks.filter((c) => c.group === group);
      if (items.length === 0) continue;
      console.log(`\n【${group} 组】`);
      for (const item of items) {
        console.log(`  ${item.pass ? '✔' : '✖'} ${item.name}`);
        console.log(`      ${item.detail}`);
      }
    }

    const passed = checks.filter((c) => c.pass).length;
    const failed = checks.length - passed;
    console.log(`\n${'='.repeat(78)}`);
    console.log(`通过：${passed}    失败：${failed}`);

    if (failed > 0) {
      console.log('\n失败项：');
      for (const item of checks.filter((c) => !c.pass)) {
        console.log(`  ✖ [${item.group}] ${item.name}：${item.detail}`);
      }
    }

    void downvoteMessageId;
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    await server.close();
    // server.close 只在拥有引擎时才关闭它；这里引擎由本脚本创建，需显式关闭，
    // 否则 SQLite 的文件句柄会让临时目录删除失败（Windows 下表现为 EPERM）。
    engine.close();
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响验收结论
    }
  }
}

main()
  .then(() => {
    // Windows 下 SQLite 的 WAL 句柄释放有延迟，临时目录删除可能失败。
    // 验收结论已在上方输出，这里不让清理失败影响退出码。
  })
  .catch((error) => {
    console.error('验收执行失败：', error);
    process.exit(1);
  });
