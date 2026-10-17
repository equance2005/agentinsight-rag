/**
 * 公开契约路由。
 *
 * 这些是插件与外部系统唯一依赖的接口：只涉及知识库自身资源，
 * 不出现任何宿主专有概念（Trace / Run / Execution / Skill）。
 *
 * 鉴权：站点级 public key + 域名白名单。公开问答、管理台文档摄取与文档维护
 * 共用这套校验；更广泛的知识库和维护者操作仍不在公开契约中。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeBaseEngine } from '../lib/kb/index.js';
import type { ImageAttachment } from '../lib/kb/ports.js';
import { createConnectedProvider, parseConnection, validateImages } from '../lib/kb/providers/user-connection.js';
import type { KbServer } from './server.js';
import { readJsonBody } from './server.js';
import { handleUploadRoute } from './upload.js';

export interface RouteContext {
  engine: KnowledgeBaseEngine;
  uploadDir: string;
  publicDir: string;
}

interface AuthResult {
  ok: boolean;
  status: number;
  error?: string;
  kbId?: string;
}

/**
 * 校验公开接口调用方。
 *
 * 允许两种方式：
 *  1. `x-kb-key` 头（推荐，插件默认使用）
 *  2. `?key=` 查询参数（便于纯静态页面快速验证）
 */
function authorizePublic(
  engine: KnowledgeBaseEngine,
  req: IncomingMessage,
  url: URL,
  kbIdFromPath: string,
): AuthResult {
  const key = (req.headers['x-kb-key'] as string | undefined) ?? url.searchParams.get('key') ?? '';
  if (!key) {
    return { ok: false, status: 401, error: '缺少 public key（请在请求头 x-kb-key 中提供）' };
  }

  const kb = engine.getKnowledgeBaseByPublicKey(key);
  if (!kb) {
    // 常见误填：把文档里的 <占位符> 尖括号一起复制、误填成知识库 id、或误填成模型密钥。
    // 回显实际收到的值并给出针对性提示，比只说「无效」有用得多。
    const hint = describeKeyProblem(key);
    return {
      ok: false,
      status: 401,
      error: `public key 无效：收到 "${truncateForMessage(key)}"。${hint}`,
    };
  }

  // 路径里的 kbId 必须与 key 对应的知识库一致，防止越权访问其他知识库
  if (kbIdFromPath !== kb.id && kbIdFromPath !== kb.name) {
    return {
      ok: false,
      status: 403,
      error:
        `public key 与目标知识库不匹配：该 key 属于「${kb.name}」(${kb.id})，` +
        `但请求的是「${kbIdFromPath}」。请确认 kb_id 与 public key 来自同一个知识库。`,
    };
  }

  // 域名白名单
  if (kb.allowedOrigins.length > 0) {
    const origin = req.headers.origin ?? req.headers.referer ?? '';
    const allowed = kb.allowedOrigins.some((pattern) => originMatches(pattern, origin));
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        error: `来源 ${origin || '(未知)'} 不在该知识库的允许域名列表中`,
      };
    }
  }

  return { ok: true, status: 200, kbId: kb.id };
}

/** 支持 `*` 通配的域名匹配。 */
export function originMatches(pattern: string, origin: string): boolean {
  const target = pattern.toLowerCase().trim().replace(/^\/\//, '');
  if (target === '*') return true;
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  // 支持文档中常用的 "localhost:3000" 和 "*.example.com" 写法，
  // 同时避免 includes() 把 evil.com/example.com 误判为合法来源。
  if (target.startsWith('*.')) {
    const [hostname, port] = splitHostPort(target.slice(2).split('/')[0]);
    return (
      parsedOrigin.hostname.endsWith(`.${hostname}`) &&
      parsedOrigin.hostname !== hostname &&
      (port === '' || parsedOrigin.port === port)
    );
  }

  if (target.includes('://')) {
    try {
      return parsedOrigin.origin === new URL(target).origin;
    } catch {
      return false;
    }
  }

  const [hostname, port] = splitHostPort(target.split('/')[0]);
  return parsedOrigin.hostname === hostname && (port === '' || parsedOrigin.port === port);
}

function splitHostPort(value: string): [string, string] {
  const match = value.match(/^(.+?)(?::(\d+))?$/);
  return [match?.[1] ?? value, match?.[2] ?? ''];
}

/** 截断过长的值，避免把密钥完整回显到响应里。 */
function truncateForMessage(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 20)}…(${value.length} 字符)`;
}

/**
 * 针对常见误填给出具体提示。
 *
 * 实测最常踩的三个坑：从文档里复制时把 <占位符> 的尖括号一起带上、
 * 把知识库 id 当成 key、把模型密钥当成 key。
 */
function describeKeyProblem(key: string): string {
  const trimmed = key.trim();

  if (trimmed !== key) {
    return '值首尾含有空白字符，请去掉后重试。';
  }
  if (/^[<【「"']/.test(trimmed) || /[>】」"']$/.test(trimmed)) {
    return '值首尾含有 < > 【 】 或引号等标记，多半是连占位符的尖括号一起复制了，请只保留 pk_ 开头的部分。';
  }
  if (trimmed.startsWith('kb_')) {
    return '这看起来是知识库 id（kb_ 开头），而 public key 应以 pk_ 开头，请核对 `kb show <知识库>` 的两行输出。';
  }
  if (trimmed.startsWith('sk-')) {
    return '这看起来是模型 API 密钥（sk- 开头），不是知识库的 public key。';
  }
  if (trimmed.startsWith('pk_')) {
    return '格式正确但服务端查不到该 key，可能是知识库已被删除，或该 key 属于另一个数据库实例。';
  }
  return 'public key 应以 pk_ 开头，请在 `kb show <知识库>` 的输出中确认。';
}

/**
 * 解析路径参数中的知识库。
 *
 * 同时接受 id 与名称（便于人工验证），但**查不到时必须报错** ——
 * 早期实现直接把 kbId 交给检索引擎，查不到会静默返回 0 条，
 * 再被检索闸门包装成「证据不足」，把「配置填错」误导成「知识库未覆盖」。
 */
function resolveKb(
  engine: KnowledgeBaseEngine,
  kbIdOrName: string,
): { ok: true; kb: ReturnType<KnowledgeBaseEngine['getKnowledgeBase']> & object } | { ok: false; status: number; error: string } {
  const kb = engine.getKnowledgeBase(kbIdOrName);
  if (!kb) {
    return {
      ok: false,
      status: 404,
      error:
        `知识库不存在：${kbIdOrName}。` +
        `请确认填的是知识库 id（形如 kb_xxxxxxxx）或名称；` +
        `可用 \`kb ls\` 查看全部知识库。`,
    };
  }
  return { ok: true, kb };
}

export function registerPublicRoutes(server: KbServer): void {
  const { engine } = server;

  server.route('POST', '/api/public/kb/:kbId/models/validate', async (req, res, params, ctx) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = authorizePublic(ctx.engine, req, url, params.kbId);
    if (!auth.ok) return server.json(res, auth.status, { error: auth.error });
    try {
      const body = await readJsonBody(req);
      const connection = parseConnection(body);
      const provider = createConnectedProvider(connection);
      await provider.complete([{ role: 'user', content: 'Reply with OK.' }], { maxTokens: 4 });
      return server.json(res, 200, { ok: true, provider: connection.provider, model: connection.model });
    } catch (error) {
      return server.json(res, 400, { error: `模型连接失败：${(error as Error).message}` });
    }
  });

  // -------------------------------------------------------------------------
  // 插件产物
  // -------------------------------------------------------------------------

  // 注意：该路由必须在 /api/public/kb/:kbId/* 之前注册，
  // 否则 "widget.js" 会被当成 kbId 匹配掉。
  server.route('GET', '/api/public/kb/widget.js', async (_req, res, _params, ctx) => {
    const scriptPath = join(ctx.publicDir, 'kb-widget.js');
    try {
      const code = await readFile(scriptPath, 'utf8');
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        // 插件会被跨域加载，必须允许任意来源读取
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=300',
      });
      res.end(code);
    } catch {
      server.json(res, 404, {
        error: '插件产物不存在，请先运行 npm run build:widget',
        path: scriptPath,
      });
    }
  });

  // -------------------------------------------------------------------------
  // 插件配置
  // -------------------------------------------------------------------------

  server.route('GET', '/api/public/kb/:kbId/config', async (req, res, params, ctx) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = authorizePublic(ctx.engine, req, url, params.kbId);
    if (!auth.ok) return server.json(res, auth.status, { error: auth.error });

    const resolved = resolveKb(ctx.engine, params.kbId);
    if (!resolved.ok) return server.json(res, resolved.status, { error: resolved.error });
    const kb = resolved.kb;

    server.json(res, 200, {
      kbId: kb.id,
      name: kb.name,
      widget: kb.widgetConfig,
      capabilities: {
        streaming: true,
        feedback: true,
        citations: true,
        models: ctx.engine.availableLlmModels(),
      },
    });
  });

  // -------------------------------------------------------------------------
  // 问答（非流式）
  // -------------------------------------------------------------------------

  server.route('POST', '/api/public/kb/:kbId/chat', async (req, res, params, ctx) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = authorizePublic(ctx.engine, req, url, params.kbId);
    if (!auth.ok) return server.json(res, auth.status, { error: auth.error });

    let body: {
      message?: string;
      conversationId?: string;
      stream?: boolean;
      topK?: number;
      documentIds?: string[];
      claimCheck?: boolean;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      images?: ImageAttachment[];
      connection?: { provider?: string; model?: string; apiKey?: string };
    };
    try {
      const parsed = await readJsonBody(req, 16 * 1024 * 1024);
      if (!isJsonObject(parsed)) return server.json(res, 400, { error: '请求体必须是 JSON 对象' });
      body = parsed as typeof body;
    } catch (error) {
      return server.json(res, 400, { error: (error as Error).message });
    }

    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return server.json(res, 400, { error: '缺少 message 字段' });
    const topK = parseTopK(body.topK);
    if (topK.error) return server.json(res, 400, { error: topK.error });
    if (body.documentIds !== undefined &&
        (!Array.isArray(body.documentIds) || body.documentIds.some((id) => typeof id !== 'string'))) {
      return server.json(res, 400, { error: 'documentIds 必须是字符串数组' });
    }
    if (body.conversationId !== undefined && typeof body.conversationId !== 'string') {
      return server.json(res, 400, { error: 'conversationId 必须是字符串' });
    }
    if (body.claimCheck !== undefined && typeof body.claimCheck !== 'boolean') {
      return server.json(res, 400, { error: 'claimCheck 必须是布尔值' });
    }
    if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length > 120)) {
      return server.json(res, 400, { error: 'model 必须是长度不超过 120 的字符串' });
    }
    if (body.model && !ctx.engine.availableLlmModels().includes(body.model)) {
      if (!body.apiKey && !body.connection?.apiKey) return server.json(res, 400, { error: `模型不可用：${body.model}；请先提供该模型的 API Key` });
    }
    if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 512)) {
      return server.json(res, 400, { error: 'apiKey 长度无效' });
    }
    if (body.baseUrl !== undefined && (typeof body.baseUrl !== 'string' || body.baseUrl.length > 500 || !/^https?:\/\//i.test(body.baseUrl))) {
      return server.json(res, 400, { error: 'baseUrl 必须是合法的 http(s) 地址' });
    }
    let images: ImageAttachment[] | undefined;
    try { images = validateImages(body.images); } catch (error) { return server.json(res, 400, { error: (error as Error).message }); }
    let requestLlm;
    if (body.connection !== undefined) {
      try { requestLlm = createConnectedProvider(parseConnection(body.connection)); }
      catch (error) { return server.json(res, 400, { error: (error as Error).message }); }
    }

    const resolved = resolveKb(ctx.engine, params.kbId);
    if (!resolved.ok) return server.json(res, resolved.status, { error: resolved.error });
    const kb = resolved.kb;

    const siteKey = deriveSiteKey(req);
    const conversationError = validateConversationAccess(ctx.engine, body.conversationId, kb.id, siteKey);
    if (conversationError) return server.json(res, conversationError.status, { error: conversationError.error });

    if (body.stream) {
      return streamChat(ctx.engine, req, res, {
        kbId: kb.id,
        message,
        conversationId: body.conversationId,
        siteKey,
        topK: topK.value,
        documentIds: body.documentIds,
        claimCheck: body.claimCheck,
        model: body.model,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        images,
        llm: requestLlm,
      });
    }

    const result = await ctx.engine.ask({
      kbId: kb.id,
      query: message,
      conversationId: body.conversationId,
      siteKey,
      topK: topK.value,
      documentIds: body.documentIds,
      claimCheck: body.claimCheck,
      model: body.model,
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      images,
      llm: requestLlm,
    });

    server.json(res, 200, {
      conversationId: result.conversationId,
      messageId: result.messageId,
      answer: result.answer,
      citations: result.citations,
      gate: result.gate,
      retrieval: {
        mode: result.retrieval.mode,
        topScore: result.retrieval.topScore,
        hitCount: result.retrieval.hits.length,
        semanticDegraded: result.retrieval.semanticDegraded,
      },
      unsupportedClaimCount: result.unsupportedClaimCount,
      latencyMs: result.latencyMs,
      // 分阶段耗时：便于前端展示与排查慢查询
      timings: result.timings,
    });
  });

  // -------------------------------------------------------------------------
  // 问答（SSE 流式）
  // -------------------------------------------------------------------------

  server.route('GET', '/api/public/kb/:kbId/chat/stream', async (req, res, params, ctx) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = authorizePublic(ctx.engine, req, url, params.kbId);
    if (!auth.ok) return server.json(res, auth.status, { error: auth.error });

    const message = (url.searchParams.get('message') ?? '').trim();
    if (!message) return server.json(res, 400, { error: '缺少 message 查询参数' });
    const topK = parseTopK(url.searchParams.get('topK') ?? undefined);
    if (topK.error) return server.json(res, 400, { error: topK.error });
    const claimCheck = parseBooleanQuery(url.searchParams.get('claimCheck'));
    if (claimCheck.error) return server.json(res, 400, { error: claimCheck.error });
  const model = url.searchParams.get('model') ?? undefined;
    if (model && model.length > 120) return server.json(res, 400, { error: 'model 长度不能超过 120' });
    if (model && !ctx.engine.availableLlmModels().includes(model)) {
      return server.json(res, 400, { error: `模型不可用：${model}` });
    }

    const resolved = resolveKb(ctx.engine, params.kbId);
    if (!resolved.ok) return server.json(res, resolved.status, { error: resolved.error });
    const kb = resolved.kb;

    const siteKey = deriveSiteKey(req);
    const conversationId = url.searchParams.get('conversationId') ?? undefined;
    const conversationError = validateConversationAccess(ctx.engine, conversationId, kb.id, siteKey);
    if (conversationError) return server.json(res, conversationError.status, { error: conversationError.error });

    return streamChat(ctx.engine, req, res, {
      kbId: kb.id,
      message,
      conversationId,
      siteKey,
      topK: topK.value,
      claimCheck: claimCheck.value,
      model,
    });
  });

  // -------------------------------------------------------------------------
  // 反馈
  // -------------------------------------------------------------------------

  server.route('POST', '/api/public/kb/feedback', async (req, res, _params, ctx) => {
    let body: { messageId?: string; rating?: string; reason?: string; comment?: string };
    try {
      const parsed = await readJsonBody(req);
      if (!isJsonObject(parsed)) return server.json(res, 400, { error: '请求体必须是 JSON 对象' });
      body = parsed as typeof body;
    } catch (error) {
      return server.json(res, 400, { error: (error as Error).message });
    }

    if (typeof body.messageId !== 'string' || !body.messageId) {
      return server.json(res, 400, { error: '缺少 messageId' });
    }
    if (body.rating !== 'up' && body.rating !== 'down') {
      return server.json(res, 400, { error: 'rating 必须是 up 或 down' });
    }

    // 反馈必须指向真实存在的消息，避免脏数据进入 backlog
    const message = ctx.engine.getMessage(body.messageId);
    if (!message) return server.json(res, 404, { error: '消息不存在' });

    const conversation = ctx.engine.getConversation(message.conversationId);
    if (conversation) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const auth = authorizePublic(ctx.engine, req, url, conversation.kbId);
      if (!auth.ok) return server.json(res, auth.status, { error: auth.error });
    }

    const feedback = ctx.engine.submitFeedback({
      messageId: body.messageId,
      rating: body.rating,
      reason: body.reason,
      comment: body.comment,
    });

    server.json(res, 200, { ok: true, feedbackId: feedback.id });
  });

  // -------------------------------------------------------------------------
  // 引用定位：按 chunkId 取原文与定位信息
  // -------------------------------------------------------------------------

  server.route('GET', '/api/public/kb/:kbId/chunks/:chunkId', async (req, res, params, ctx) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = authorizePublic(ctx.engine, req, url, params.kbId);
    if (!auth.ok) return server.json(res, auth.status, { error: auth.error });

    const detail = ctx.engine.getChunkWithSource(params.chunkId);
    if (!detail) return server.json(res, 404, { error: '片段不存在' });
    if (detail.chunk.kbId !== params.kbId && detail.chunk.kbId !== ctx.engine.getKnowledgeBase(params.kbId)?.id) {
      return server.json(res, 403, { error: '片段不属于该知识库' });
    }

    server.json(res, 200, {
      chunkId: detail.chunk.id,
      content: detail.chunk.content,
      locator: detail.locator,
      headingPath: detail.chunk.headingPath,
      document: detail.document
        ? {
            id: detail.document.id,
            title: detail.document.title,
            sourcePath: detail.document.sourcePath,
            sourceUrl: detail.document.sourceUrl,
            mimeType: detail.document.mimeType,
          }
        : null,
    });
  });

  // -------------------------------------------------------------------------
  // 单会话历史（插件重连后恢复上下文）
  // -------------------------------------------------------------------------

  server.route('GET', '/api/public/kb/:kbId/conversations/:conversationId', async (req, res, params, ctx) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = authorizePublic(ctx.engine, req, url, params.kbId);
    if (!auth.ok) return server.json(res, auth.status, { error: auth.error });

    const resolved = resolveKb(ctx.engine, params.kbId);
    if (!resolved.ok) return server.json(res, resolved.status, { error: resolved.error });

    const conversation = ctx.engine.getConversation(params.conversationId);
    if (!conversation) return server.json(res, 404, { error: '会话不存在' });
    if (conversation.kbId !== resolved.kb.id) return server.json(res, 404, { error: '会话不存在' });
    if (conversation.siteKey !== deriveSiteKey(req)) {
      return server.json(res, 403, { error: '会话不属于当前站点' });
    }

    const messages = ctx.engine.getMessages(conversation.id, 100);
    server.json(res, 200, {
      conversationId: conversation.id,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        citations: message.citations,
        gateDecision: message.gateDecision,
        createdAt: message.createdAt,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // 文档上传（验收 A 组：网页上传全部或部分文件）
  // -------------------------------------------------------------------------

  server.route('POST', '/api/public/kb/:kbId/upload', (req, res, params, ctx) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = authorizePublic(ctx.engine, req, url, params.kbId);
    if (!auth.ok) return server.json(res, auth.status, { error: auth.error });
    return handleUploadRoute(server, req, res, params.kbId, ctx);
  });

  // -------------------------------------------------------------------------
  // 文档管理（管理台使用；仍沿用知识库 public key 与来源白名单）
  // -------------------------------------------------------------------------

  server.route('GET', '/api/public/kb/:kbId/documents', async (req, res, params, ctx) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = authorizePublic(ctx.engine, req, url, params.kbId);
    if (!auth.ok) return server.json(res, auth.status, { error: auth.error });

    const resolved = resolveKb(ctx.engine, params.kbId);
    if (!resolved.ok) return server.json(res, resolved.status, { error: resolved.error });

    // 不返回 sourcePath：本地导入时它可能包含服务端绝对路径。
    const documents = ctx.engine.listDocuments(resolved.kb.id).map((document) => ({
      id: document.id,
      title: document.title,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      parseStatus: document.parseStatus,
      parseError: document.parseError,
      parseWarnings: document.parseWarnings,
      chunkCount: document.chunkCount,
      updatedAt: document.updatedAt,
    }));

    return server.json(res, 200, { documents });
  });

  server.route('DELETE', '/api/public/kb/:kbId/documents/:documentId', async (req, res, params, ctx) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = authorizePublic(ctx.engine, req, url, params.kbId);
    if (!auth.ok) return server.json(res, auth.status, { error: auth.error });

    const resolved = resolveKb(ctx.engine, params.kbId);
    if (!resolved.ok) return server.json(res, resolved.status, { error: resolved.error });

    const document = ctx.engine.getDocument(params.documentId);
    if (!document || document.kbId !== resolved.kb.id) {
      return server.json(res, 404, { error: '文档不存在' });
    }

    if (!ctx.engine.deleteDocument(document.id)) {
      return server.json(res, 404, { error: '文档不存在' });
    }

    return server.json(res, 200, { ok: true, documentId: document.id });
  });
}

function deriveSiteKey(req: IncomingMessage): string {
  const origin = req.headers.origin ?? req.headers.referer ?? '';
  if (!origin) return 'default';
  try {
    return new URL(origin).host;
  } catch {
    return 'default';
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_PUBLIC_TOP_K = 50;

function parseTopK(value: number | string | undefined): { value?: number; error?: string } {
  if (value === undefined || value === '') return {};
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PUBLIC_TOP_K) {
    return { error: `topK 必须是 1 到 ${MAX_PUBLIC_TOP_K} 之间的整数` };
  }
  return { value: parsed };
}

function parseBooleanQuery(value: string | null): { value?: boolean; error?: string } {
  if (value === null || value === '') return {};
  if (value === 'true' || value === '1') return { value: true };
  if (value === 'false' || value === '0') return { value: false };
  return { error: 'claimCheck 必须是 true 或 false' };
}

function validateConversationAccess(
  engine: KnowledgeBaseEngine,
  conversationId: string | undefined,
  kbId: string,
  siteKey: string,
): { status: number; error: string } | null {
  if (!conversationId) return null;
  const conversation = engine.getConversation(conversationId);
  if (!conversation || conversation.kbId !== kbId) {
    return { status: 404, error: '会话不存在' };
  }
  if (conversation.siteKey !== siteKey) {
    return { status: 403, error: '会话不属于当前站点' };
  }
  return null;
}

/** SSE 流式问答。 */
async function streamChat(
  engine: KnowledgeBaseEngine,
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    kbId: string;
    message: string;
    conversationId?: string;
    siteKey: string;
    topK?: number;
    documentIds?: string[];
    claimCheck?: boolean;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    images?: ImageAttachment[];
    llm?: import('../lib/kb/ports.js').LlmProvider;
  },
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 客户端断开时中止生成，避免继续消耗模型配额
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    for await (const event of engine.askStream({
      kbId: options.kbId,
      query: options.message,
      conversationId: options.conversationId,
      siteKey: options.siteKey,
      topK: options.topK,
      documentIds: options.documentIds,
      claimCheck: options.claimCheck,
      model: options.model,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      images: options.images,
      llm: options.llm,
      signal: controller.signal,
    })) {
      switch (event.type) {
        case 'gate':
          send('meta', event.data);
          break;
        case 'delta':
          send('delta', { text: event.data });
          break;
        case 'citations':
          send('citations', event.data);
          break;
        case 'error':
          send('error', event.data);
          break;
        case 'done':
          send('done', event.data);
          break;
      }
    }
  } catch (error) {
    send('error', { message: (error as Error).message });
  } finally {
    res.write('event: end\ndata: {}\n\n');
    res.end();
  }
}
