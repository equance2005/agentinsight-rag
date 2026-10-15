/**
 * 网页上传处理。
 *
 * 支持两种模式，对应验收要求的「上传目录中的全部或部分文件」：
 *  - multipart/form-data：浏览器逐个文件上传（用户勾选的部分文件）
 *  - JSON 清单：客户端已把文件落到暂存目录，只提交相对路径列表（整目录上传）
 *
 * 无论哪种模式，最终都经由同一个摄取流水线，保证与 CLI 导入结果一致。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { basename, join, normalize, relative, resolve } from 'node:path';
import type { RouteContext } from './public-api.js';
import type { KbServer } from './server.js';
import { readJsonBody } from './server.js';
import { mimeTypeFor } from '../lib/kb/sources/local-directory.js';

export async function handleUploadRoute(
  server: KbServer,
  req: IncomingMessage,
  res: ServerResponse,
  kbId: string,
  ctx: RouteContext,
): Promise<void> {
  const kb = ctx.engine.getKnowledgeBase(kbId);
  if (!kb) return server.json(res, 404, { error: '知识库不存在' });

  const contentType = req.headers['content-type'] ?? '';

  // 暂存目录按知识库隔离，避免不同知识库的上传互相覆盖
  const stagingDir = join(ctx.uploadDir, kb.id);
  mkdirSync(stagingDir, { recursive: true });

  let uploadedPaths: string[] = [];
  let mode: 'files' | 'manifest' = 'files';
  let include: string[] | undefined;

  try {
    if (contentType.startsWith('multipart/form-data')) {
      const boundary = extractBoundary(contentType);
      if (!boundary) return server.json(res, 400, { error: 'multipart 请求缺少 boundary' });

      const buffer = await readRawBody(req);
      const files = parseMultipart(buffer, boundary);

      if (files.length === 0) {
        return server.json(res, 400, { error: '未在请求中找到文件字段' });
      }

      for (const file of files) {
        // 只取 basename，防止客户端用 ../../ 逃出暂存目录
        const safeName = basename(file.fileName);
        if (!safeName || safeName === '.' || safeName === '..') {
          return server.json(res, 400, { error: `非法文件名：${file.fileName}` });
        }
        const target = join(stagingDir, safeName);
        writeFileSync(target, file.content);
        uploadedPaths.push(target);
      }
    } else {
      // JSON 清单模式
      mode = 'manifest';
      let body: { files?: string[]; include?: string[] };
      try {
        const parsed = await readJsonBody(req);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return server.json(res, 400, { error: '请求体必须是 JSON 对象' });
        }
        body = parsed as typeof body;
      } catch (error) {
        return server.json(res, 400, { error: (error as Error).message });
      }

      if (!Array.isArray(body.files) || body.files.length === 0 || body.files.some((file) => typeof file !== 'string')) {
        return server.json(res, 400, { error: '缺少 files 字段（相对暂存目录的文件路径列表）' });
      }
      if (body.include !== undefined &&
          (!Array.isArray(body.include) || body.include.some((pattern) => typeof pattern !== 'string'))) {
        return server.json(res, 400, { error: 'include 必须是字符串数组' });
      }
      include = body.include;

      for (const relativeFile of body.files) {
        const safe = normalize(relativeFile).replace(/^(\.\.[/\\])+/, '');
        const stagingRoot = resolve(stagingDir);
        const target = resolve(join(stagingRoot, safe));
        const relativeTarget = relative(stagingRoot, target);
        if (relativeTarget.startsWith('..') || relativeTarget.startsWith('\\') || relativeTarget.includes(':')) {
          return server.json(res, 400, { error: `非法路径：${relativeFile}` });
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          return server.json(res, 400, { error: `文件不存在于暂存目录：${relativeFile}` });
        }
        uploadedPaths.push(target);
      }
    }

    // 摄取：与 CLI 导入共用同一流水线
    const result = await ctx.engine.importDirectory({
      kbId: kb.id,
      directory: stagingDir,
      // 只处理本次提交的文件，避免把之前遗留的暂存文件重复算进来
      include: uploadedPaths.length > 0 ? uploadedPaths.map((p) => basename(p)) : include,
      mode: 'incremental',
    });

    const s = result.stats;
    return server.json(res, 200, {
      ok: true,
      mode,
      uploaded: uploadedPaths.length,
      stats: {
        scanned: s.scanned,
        added: s.added,
        updated: s.updated,
        unchanged: s.unchanged,
        failed: s.failed,
        chunksCreated: s.chunksCreated,
        embeddingsComputed: s.embeddingsComputed,
        embeddingsReused: s.embeddingsReused,
        durationMs: s.durationMs,
      },
      // 解析失败必须显式返回，不能静默吞掉
      failures: ctx.engine
        .listDocuments(kb.id)
        .filter((doc) => doc.parseStatus === 'error')
        .map((doc) => ({ title: doc.title, error: doc.parseError })),
    });
  } finally {
    // 暂存文件在摄取完成后清理；解析已把内容落到数据库
    if (mode === 'files') {
      for (const filePath of uploadedPaths) {
        try {
          rmSync(filePath, { force: true });
        } catch {
          // 清理失败不影响本次导入结果
        }
      }
    }
  }
}

function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  return match ? (match[1] ?? match[2]).trim() : null;
}

async function readRawBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) throw new Error(`上传内容超过上限 ${Math.round(limitBytes / 1024 / 1024)}MB`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

interface MultipartFile {
  fieldName: string;
  fileName: string;
  content: Buffer;
}

/**
 * 极简 multipart 解析。
 *
 * 只处理本场景需要的部分：文件字段 + 二进制内容。
 * 不引入 multer/formidable，保持零额外依赖。
 */
export function parseMultipart(buffer: Buffer, boundary: string): MultipartFile[] {
  const files: MultipartFile[] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(buffer, delimiter);

  for (const part of parts) {
    // 跳过结束标记与空段
    if (part.length === 0) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;

    const headerText = part.subarray(0, headerEnd).toString('utf8');
    if (!headerText.includes('Content-Disposition')) continue;

    const disposition = headerText.match(/content-disposition:[^\n]*/i)?.[0] ?? '';
    const nameMatch = disposition.match(/name="([^"]*)"/);
    const fileMatch = disposition.match(/filename="([^"]*)"/);
    if (!fileMatch) continue;

    // 去掉尾部 CRLF
    let content = part.subarray(headerEnd + 4);
    if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
      content = content.subarray(0, content.length - 2);
    }

    files.push({
      fieldName: nameMatch?.[1] ?? 'file',
      fileName: fileMatch[1] || 'unnamed',
      content: Buffer.from(content),
    });
  }

  return files;
}

/** 按分隔符切分 Buffer（Buffer.split 不存在）。 */
function splitBuffer(buffer: Buffer, delimiter: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);

  while (index >= 0) {
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  parts.push(buffer.subarray(start));

  return parts;
}

export { mimeTypeFor };
