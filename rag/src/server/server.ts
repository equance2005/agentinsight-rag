/**
 * HTTP 服务。
 *
 * 只依赖 Node 内置模块，不引入 Web 框架 —— 与「可被不同网站复用」的
 * 轻量目标一致，也避免为插件引入一整套服务端依赖。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, relative, resolve } from 'node:path';
import { KnowledgeBaseEngine, defaultDatabasePath } from '../lib/kb/index.js';
import { loadModelProviders } from '../lib/kb/providers/openai-compat.js';
import { registerPublicRoutes, type RouteContext } from './public-api.js';

export interface ServerConfig {
  port: number;
  host: string;
  /** 静态资源根目录（管理台与插件产物）。 */
  publicDir: string;
  /** CLI/网页上传的暂存目录。 */
  uploadDir: string;
  /** 注入已有引擎实例；测试与嵌入场景使用，缺省时按环境变量自建。 */
  engine?: KnowledgeBaseEngine;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    ctx: RouteContext,
  ) => Promise<void> | void;
}

export class KbServer {
  private readonly routes: Route[] = [];
  private readonly server;
  readonly engine: KnowledgeBaseEngine;
  /** 外部注入的引擎由调用方负责关闭。 */
  private readonly ownsEngine: boolean;

  constructor(private readonly config: ServerConfig) {
    if (config.engine) {
      this.engine = config.engine;
      this.ownsEngine = false;
    } else {
      const env = loadModelProviders();
      this.engine = new KnowledgeBaseEngine({
        databasePath: defaultDatabasePath(),
        embedder: env.embedder,
        llm: env.llm,
        llmModels: env.llmModels,
      });
      this.ownsEngine = true;
      for (const note of env.notes) console.log(`[kb] ${note}`);
    }

    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        console.error('[kb] 未捕获的请求错误：', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: '服务器内部错误', detail: (error as Error).message }));
      });
    });
  }

  get context(): RouteContext {
    return {
      engine: this.engine,
      uploadDir: this.config.uploadDir,
      publicDir: this.config.publicDir,
    };
  }

  /** 注册路由；path 支持 `:param` 占位。 */
  route(
    method: string,
    path: string,
    handler: Route['handler'],
  ): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path
        .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
        .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key: string) => {
          keys.push(key);
          return '([^/]+)';
        })}$`,
    );
    this.routes.push({ method: method.toUpperCase(), pattern, keys, handler });
  }

  async listen(): Promise<{ port: number; url: string }> {
    registerPublicRoutes(this);

    await new Promise<void>((resolvePromise) => {
      this.server.listen(this.config.port, this.config.host, () => resolvePromise());
    });

    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.config.port;
    const url = `http://${this.config.host === '0.0.0.0' ? '127.0.0.1' : this.config.host}:${port}`;
    return { port, url };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.close((error) => (error ? reject(error) : resolvePromise()));
    });
    if (this.ownsEngine) this.engine.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // 预检请求：插件可能从任意域名发起
    if (req.method === 'OPTIONS') {
      this.applyCors(res, req, pathname);
      res.writeHead(204);
      res.end();
      return;
    }

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;

      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        params[key] = match[index + 1];
      });

      this.applyCors(res, req, pathname);
      await route.handler(req, res, params, this.context);
      return;
    }

    // 根路径引导到管理台演示页
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(302, { location: '/demo/' });
      res.end();
      return;
    }

    // 静态资源兜底
    if (req.method === 'GET' && (await this.serveStatic(pathname, res))) return;

    this.json(res, 404, { error: '未找到该路径', path: pathname });
  }

  /**
   * CORS 处理。
   *
   * 插件的域名白名单按知识库配置校验（在公开路由内完成）；
   * 这里只负责回显允许的 Origin，使浏览器能读到响应。
   */
  private applyCors(res: ServerResponse, req: IncomingMessage, pathname: string): void {
    const origin = req.headers.origin;
    if (!origin) return;

    // 公开接口允许跨域读取 Origin；具体是否放行由路由按 kb.allowedOrigins 判定
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-kb-key');
    res.setHeader('Access-Control-Max-Age', '600');

    if (pathname.startsWith('/api/public/')) {
      // 流式响应需要禁用代理缓冲
      res.setHeader('X-Accel-Buffering', 'no');
    }
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    // 根路径与以 / 结尾的路径都指向对应目录下的 index.html
    const relativePathname = pathname === '/' || pathname.endsWith('/')
      ? `${pathname}index.html`
      : pathname;

    // 防目录穿越
    const safePath = normalize(relativePathname).replace(/^(\.\.[/\\])+/, '');
    const publicRoot = resolve(this.config.publicDir);
    const filePath = resolve(join(publicRoot, safePath));
    const relativePath = relative(publicRoot, filePath);
    if (relativePath.startsWith('..') || relativePath.includes(':') || relativePath.startsWith('\\')) return false;
    if (!existsSync(filePath)) return false;

    try {
      const content = await readFile(filePath);
      res.writeHead(200, {
        'content-type': contentTypeFor(filePath),
        'cache-control': 'no-cache',
      });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }

  json(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body, null, 2));
  }
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

/** 读取 JSON 请求体。 */
export async function readJsonBody(req: IncomingMessage, limitBytes = 2 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) throw new Error(`请求体超过上限 ${limitBytes} 字节`);
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}
