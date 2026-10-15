/**
 * PDF 解析器。
 *
 * 逐页提取文本，产出页码定位。扫描件（无文本层）会被显式标记为告警，
 * 而不是静默产出一个空文档。
 *
 * 不使用 pdf-parse 包装层：它在当前 Node 运行时下把 Buffer 传给 pdf.js 的
 * 方式会触发 "bad XRef entry"（同样的字节直接喂给 pdf.js 就正常）。
 * 因此这里直接调用 pdf-parse 内置的 pdf.js 构建。
 */

import { readFile } from 'node:fs/promises';
import type { DocumentParser, ParserInput } from '../../ports.js';
import type { ParsedBlock, ParseResult } from '../../types.js';
import { ParseError } from '../../types.js';

interface PdfTextItem {
  str: string;
  transform?: number[];
  hasEOL?: boolean;
}

interface PdfPage {
  getTextContent(options?: Record<string, unknown>): Promise<{ items: PdfTextItem[] }>;
  getViewport(options: { scale: number }): { height: number; width: number };
}

interface PdfDocument {
  numPages: number;
  getPage(index: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocument> };
  version?: string;
}

/**
 * pdf-parse 内置了多个 pdf.js 版本；优先使用较新的构建。
 * 用变量拼接说明符，避免打包器把整条路径静态解析进来。
 */
const PDFJS_CANDIDATES = [
  'pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js',
  'pdf-parse/lib/pdf.js/v1.10.88/build/pdf.js',
  'pdf-parse/lib/pdf.js/v1.9.426/build/pdf.js',
];

async function loadPdfJs(): Promise<PdfJsModule> {
  const failures: string[] = [];
  for (const specifier of PDFJS_CANDIDATES) {
    try {
      const mod = (await import(specifier)) as { default?: PdfJsModule } & PdfJsModule;
      const lib = mod.default ?? mod;
      if (typeof lib.getDocument === 'function') return lib;
      failures.push(`${specifier}: 缺少 getDocument`);
    } catch (error) {
      failures.push(`${specifier}: ${(error as Error).message}`);
    }
  }
  throw new ParseError(`无法加载 pdf.js 运行时：\n  ${failures.join('\n  ')}`);
}

let pdfJsPromise: Promise<PdfJsModule> | null = null;
function getPdfJs(): Promise<PdfJsModule> {
  pdfJsPromise ??= loadPdfJs();
  return pdfJsPromise;
}

export const pdfParser: DocumentParser = {
  name: 'pdf',
  extensions: ['.pdf'],
  mimeTypes: ['application/pdf'],

  async parse(input: ParserInput): Promise<ParseResult> {
    const warnings: string[] = [];
    const buffer = await readFile(input.path);

    if (buffer.length === 0) {
      throw new ParseError('PDF 文件为空', input.fileName);
    }
    if (!buffer.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
      throw new ParseError('文件不是有效的 PDF（缺少 %PDF- 头）', input.fileName);
    }

    const pdfjs = await getPdfJs();

    let doc: PdfDocument;
    try {
      doc = await pdfjs.getDocument({
        // 必须传 Uint8Array：传 Buffer 会触发 bad XRef entry
        data: new Uint8Array(buffer),
        verbosity: 0,
        // 禁用 worker：Node 环境下没有 Worker 实现
        disableWorker: true,
        isEvalSupported: false,
      }).promise;
    } catch (error) {
      throw new ParseError(`PDF 解析失败：${(error as Error).message}`, input.fileName);
    }

    const blocks: ParsedBlock[] = [];
    let emptyPages = 0;

    try {
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent({ normalizeWhitespace: false });

        // 按换行标记与 Y 坐标变化重建行，尽量保留原始版面顺序
        const lines = itemsToLines(content.items ?? []);
        const pageText = lines.filter((line) => line.trim()).join('\n');

        if (!pageText.trim()) {
          emptyPages++;
          continue;
        }

        const paragraphs = splitParagraphs(lines);
        let cursor = 0;

        for (const paragraph of paragraphs) {
          const text = cleanText(paragraph);
          if (!text) {
            cursor += paragraph.length + 2;
            continue;
          }
          blocks.push({
            text,
            kind: 'paragraph',
            locator: {
              page: pageNumber,
              charStart: cursor,
              charEnd: cursor + paragraph.length,
              blockIndex: blocks.length,
            },
          });
          cursor += paragraph.length + 2;
        }
      }
    } finally {
      await doc.destroy().catch(() => undefined);
    }

    if (emptyPages > 0) {
      warnings.push(`共 ${emptyPages} 页未提取到文本（可能是扫描件或缺文本层）`);
    }
    if (blocks.length === 0) {
      warnings.push('整份 PDF 未提取到文本，判定为扫描件或图片型 PDF，需要 OCR 支持');
    }

    return {
      blocks,
      warnings,
      metadata: { numpages: doc.numPages, pdfjsVersion: pdfjs.version ?? 'unknown' },
    };
  },
};

/** 把 pdf.js 的文本项按行重组。 */
function itemsToLines(items: PdfTextItem[]): string[] {
  const lines: string[] = [];
  let current = '';
  let lastY: number | null = null;

  for (const item of items) {
    const y = item.transform ? Math.round(item.transform[5]) : null;

    // Y 变化超过阈值视为换行
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && current.trim()) {
      lines.push(current);
      current = '';
    }
    current += item.str;
    if (item.hasEOL && current.trim()) {
      lines.push(current);
      current = '';
    }
    if (y !== null) lastY = y;
  }

  if (current.trim()) lines.push(current);
  return lines;
}

/**
 * 把行合并成段落。
 *
 * 连续的非空行视为同一段落（PDF 常在段落内硬换行），
 * 空行是段落边界。
 */
function splitParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let buffer: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      if (buffer.length > 0) {
        paragraphs.push(buffer.join('\n'));
        buffer = [];
      }
      continue;
    }
    buffer.push(line);
  }
  if (buffer.length > 0) paragraphs.push(buffer.join('\n'));

  return paragraphs;
}

/** 清理提取文本中的连字符断行与多余空白。 */
function cleanText(text: string): string {
  return text
    // 段落内硬换行合并为空格，保留可读性
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/\n/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
