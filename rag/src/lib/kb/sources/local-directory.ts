/**
 * 本地目录文档来源。
 *
 * 支持 include / exclude glob 选择目录中的全部或部分文件。
 * 通过 sha256 + mtime 提供变更判据，供增量同步使用。
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { DocumentSource, SourceEntry } from '../ports.js';
import { defaultRegistry, type ParserRegistry } from '../ingest/parsers/registry.js';

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.xlsm': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
};

export interface LocalDirSourceOptions {
  root: string;
  /** 只导入匹配这些 glob 的文件；为空表示全部。 */
  include?: string[];
  /** 排除匹配这些 glob 的文件。 */
  exclude?: string[];
  /** 是否递归子目录。 */
  recursive?: boolean;
  registry?: ParserRegistry;
}

export class LocalDirectorySource implements DocumentSource {
  readonly name = 'local-directory';
  private readonly registry: ParserRegistry;

  constructor(private readonly options: LocalDirSourceOptions) {
    this.registry = options.registry ?? defaultRegistry;
  }

  async list(): Promise<SourceEntry[]> {
    const files = await this.walk(this.options.root);
    const entries: SourceEntry[] = [];

    for (const absolutePath of files) {
      const relativePath = relative(this.options.root, absolutePath).split(sep).join('/');
      if (!this.matches(relativePath)) continue;

      const stats = await stat(absolutePath);
      if (!stats.isFile()) continue;

      entries.push({
        key: absolutePath,
        relativePath,
        title: relativePath,
        mimeType: mimeTypeFor(absolutePath),
        sizeBytes: stats.size,
        mtime: stats.mtime.toISOString(),
      });
    }

    return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async materialize(entry: SourceEntry) {
    return {
      path: entry.key,
      fileName: entry.relativePath,
      mimeType: entry.mimeType,
    };
  }

  /** 计算内容哈希；大文件用流式读取避免一次性载入内存。 */
  async hash(entry: SourceEntry): Promise<string> {
    return hashFile(entry.key);
  }

  private async walk(root: string): Promise<string[]> {
    const results: string[] = [];
    const recursive = this.options.recursive ?? true;

    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const dirent of dirents) {
      const full = join(root, dirent.name);
      if (dirent.isDirectory()) {
        // 跳过常见噪音目录
        if (dirent.name === 'node_modules' || dirent.name === '.git' || dirent.name.startsWith('.')) continue;
        if (recursive) results.push(...(await this.walk(full)));
      } else if (dirent.isFile()) {
        // 跳过 Office 临时/锁文件：Word 打开的文档会生成 ~$xxx.docx，
        // 它不是有效文档，导入会失败并污染「解析失败」统计。
        if (dirent.name.startsWith('~$') || dirent.name.startsWith('.')) continue;
        // 跳过 Office 的其他临时产物
        if (/\.(tmp|bak|swp|crdownload|part)$/i.test(dirent.name)) continue;
        results.push(full);
      }
    }

    return results;
  }

  private matches(relativePath: string): boolean {
    const { include, exclude } = this.options;

    if (exclude && exclude.length > 0 && exclude.some((pattern) => globMatch(pattern, relativePath))) {
      return false;
    }
    if (include && include.length > 0) {
      return include.some((pattern) => globMatch(pattern, relativePath));
    }
    // 默认只导入受支持的格式，避免把图片、压缩包也计入失败统计
    return this.registry.isSupported(relativePath);
  }
}

/** 极简 glob：支持 *、**、?，足以覆盖 include/exclude 的常见用法。 */
export function globMatch(pattern: string, target: string): boolean {
  const normalizedPattern = pattern.split(sep).join('/').replace(/^\.\//, '');
  const normalizedTarget = target.split(sep).join('/');

  // 无通配符时按子串路径或扩展名后缀匹配
  if (!/[*?]/.test(normalizedPattern)) {
    if (normalizedPattern.startsWith('.')) {
      return normalizedTarget.toLowerCase().endsWith(normalizedPattern.toLowerCase());
    }
    return normalizedTarget === normalizedPattern || normalizedTarget.startsWith(`${normalizedPattern}/`);
  }

  // 不含路径分隔符的模式按「任意深度的文件名」匹配，
  // 这样 `--include '*.md'` 才能命中子目录里的文档，符合使用直觉。
  const effective = normalizedPattern.includes('/') ? normalizedPattern : `**/${normalizedPattern}`;

  const regex = new RegExp(
    `^${effective
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0001')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0001/g, '(?:.*/)?')
      .replace(/\u0000/g, '.*')}$`,
    'i',
  );
  return regex.test(normalizedTarget);
}

export function mimeTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function hashBuffer(buffer: Buffer): Promise<string> {
  return createHash('sha256').update(buffer).digest('hex');
}
