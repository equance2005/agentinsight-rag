/**
 * 解析器注册表：按扩展名 / MIME 分派。
 *
 * 无法解析的文件必须显式报错（ParseError），不得静默跳过 —
 * 否则验收时「五种格式都解析成功」可能是跳过了失败文件的假象。
 */

import { extname } from 'node:path';
import type { DocumentParser, ParserInput } from '../../ports.js';
import type { ParseResult } from '../../types.js';
import { ParseError } from '../../types.js';
import { markdownParser } from './markdown.js';
import { textParser } from './text.js';
import { docxParser } from './docx.js';
import { xlsxParser } from './xlsx.js';
import { pdfParser } from './pdf.js';

export const DEFAULT_PARSERS: DocumentParser[] = [
  markdownParser,
  textParser,
  docxParser,
  xlsxParser,
  pdfParser,
];

export class ParserRegistry {
  private readonly byExtension = new Map<string, DocumentParser>();
  private readonly byMimeType = new Map<string, DocumentParser>();

  constructor(private readonly parsers: DocumentParser[] = DEFAULT_PARSERS) {
    for (const parser of parsers) {
      for (const ext of parser.extensions) {
        this.byExtension.set(ext.toLowerCase(), parser);
      }
      for (const mime of parser.mimeTypes) {
        this.byMimeType.set(mime.toLowerCase(), parser);
      }
    }
  }

  /** 返回支持的扩展名集合，用于 UI 提示与导入过滤。 */
  supportedExtensions(): string[] {
    return [...this.byExtension.keys()].sort();
  }

  isSupported(fileName: string, mimeType?: string): boolean {
    return this.resolve(fileName, mimeType) !== null;
  }

  resolve(fileName: string, mimeType?: string): DocumentParser | null {
    const ext = extname(fileName).toLowerCase();
    const byExt = this.byExtension.get(ext);
    if (byExt) return byExt;
    if (mimeType) {
      const byMime = this.byMimeType.get(mimeType.toLowerCase());
      if (byMime) return byMime;
    }
    return null;
  }

  async parse(input: ParserInput): Promise<ParseResult> {
    const parser = this.resolve(input.fileName, input.mimeType);
    if (!parser) {
      throw new ParseError(
        `不支持的文件格式：${input.fileName}`,
        `支持的扩展名：${this.supportedExtensions().join(', ')}`,
      );
    }
    return parser.parse(input);
  }
}

export const defaultRegistry = new ParserRegistry();
