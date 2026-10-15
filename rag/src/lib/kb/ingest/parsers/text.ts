/**
 * 纯文本解析器：按空行分段，产出行号区间与字符区间。
 */

import { readFile } from 'node:fs/promises';
import type { DocumentParser, ParserInput } from '../../ports.js';
import type { ParsedBlock, ParseResult } from '../../types.js';

export function parsePlainText(raw: string): ParseResult {
  const blocks: ParsedBlock[] = [];
  const warnings: string[] = [];
  const lines = raw.split(/\r?\n/);

  let buffer: string[] = [];
  let startLine = 0;
  let charCursor = 0;
  let blockStartChar = 0;

  const flush = (endLine: number, endChar: number) => {
    const text = buffer.join('\n').trim();
    if (text) {
      blocks.push({
        text,
        kind: /^\s*([-*+]|\d+[.)])\s+/m.test(text) ? 'list' : 'paragraph',
        locator: {
          lineStart: startLine + 1,
          lineEnd: endLine + 1,
          charStart: blockStartChar,
          charEnd: endChar,
          blockIndex: blocks.length,
        },
      });
    }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLength = line.length + 1; // +1 为换行符
    if (line.trim() === '') {
      flush(i - 1, charCursor);
      charCursor += lineLength;
      blockStartChar = charCursor;
      startLine = i + 1;
      continue;
    }
    if (buffer.length === 0) {
      startLine = i;
      blockStartChar = charCursor;
    }
    buffer.push(line);
    charCursor += lineLength;
  }
  flush(lines.length - 1, charCursor);

  if (raw.length > 0 && raw.replace(/\s/g, '').length === 0) {
    warnings.push('文件仅包含空白字符，未解析出有效内容');
  }

  return { blocks, warnings, metadata: { charLength: raw.length, lineCount: lines.length } };
}

/** 多编码兜底：优先 UTF-8，失败则按 latin1 读出并给出告警。 */
export async function readTextFile(path: string): Promise<{ text: string; warnings: string[] }> {
  const buf = await readFile(path);
  const warnings: string[] = [];
  const utf8 = buf.toString('utf8');
  // U+FFFD 过多说明不是有效 UTF-8
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacementCount > 0 && replacementCount > utf8.length * 0.01) {
    warnings.push('文件不是有效 UTF-8 编码，已按 latin1 回退读取，可能出现乱码');
    return { text: buf.toString('latin1'), warnings };
  }
  return { text: utf8, warnings };
}

export const textParser: DocumentParser = {
  name: 'text',
  extensions: ['.txt', '.text', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml'],
  mimeTypes: ['text/plain', 'text/csv', 'application/json'],

  async parse(input: ParserInput): Promise<ParseResult> {
    const { text, warnings } = await readTextFile(input.path);
    const result = parsePlainText(text);
    return { ...result, warnings: [...warnings, ...result.warnings] };
  },
};
