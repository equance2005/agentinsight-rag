/**
 * Markdown 解析器。
 *
 * 按标题层级切块，产出 headingPath 与字符区间，供引用精确定位。
 */

import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';
import type { DocumentParser, ParserInput } from '../../ports.js';
import type { ParsedBlock, ParseResult } from '../../types.js';

/** 匹配 ATX 标题：# 一级 ## 二级 … */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
/** 匹配围栏代码块起始。 */
const FENCE_RE = /^(```|~~~)/;

export function parseMarkdownText(raw: string): ParseResult {
  const blocks: ParsedBlock[] = [];
  const warnings: string[] = [];

  const lines = raw.split(/\r?\n/);
  const headingStack: string[] = [];

  let buffer: string[] = [];
  let bufferStartLine = 0;
  let inFence = false;
  let fenceMarker = '';
  let fenceBuffer: string[] = [];
  let fenceStartLine = 0;

  const pushBuffer = (kind: ParsedBlock['kind'], endLine: number) => {
    const text = buffer.join('\n').trim();
    if (!text) {
      buffer = [];
      return;
    }
    blocks.push({
      text,
      kind,
      headingPath: headingStack.length ? [...headingStack] : undefined,
      locator: {
        lineStart: bufferStartLine + 1,
        lineEnd: endLine + 1,
        blockIndex: blocks.length,
      },
    });
    buffer = [];
  };

  const detectKind = (text: string): ParsedBlock['kind'] => {
    const firstLine = text.split('\n', 1)[0] ?? '';
    if (/^\s*([-*+]|\d+[.)])\s+/.test(firstLine)) return 'list';
    if (/^\s*\|.*\|\s*$/.test(firstLine)) return 'table';
    return 'paragraph';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 围栏代码块：内部不做任何结构解析
    if (inFence) {
      if (line.startsWith(fenceMarker)) {
        fenceBuffer.push(line);
        blocks.push({
          text: fenceBuffer.join('\n'),
          kind: 'code',
          headingPath: headingStack.length ? [...headingStack] : undefined,
          locator: {
            lineStart: fenceStartLine + 1,
            lineEnd: i + 1,
            blockIndex: blocks.length,
          },
        });
        inFence = false;
        fenceBuffer = [];
      } else {
        fenceBuffer.push(line);
      }
      continue;
    }

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      pushBuffer(detectKind(buffer.join('\n')), i - 1);
      inFence = true;
      fenceMarker = fenceMatch[1];
      fenceStartLine = i;
      fenceBuffer = [line];
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      pushBuffer(detectKind(buffer.join('\n')), i - 1);
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = title;
      // 去掉空洞（例如从 ## 直接到 ####）
      for (let k = 0; k < headingStack.length; k++) {
        if (headingStack[k] === undefined) headingStack.splice(k, 1);
      }
      blocks.push({
        text: headingMatch[0],
        kind: 'heading',
        headingPath: [...headingStack],
        locator: { lineStart: i + 1, lineEnd: i + 1, blockIndex: blocks.length },
      });
      continue;
    }

    if (line.trim() === '') {
      pushBuffer(detectKind(buffer.join('\n')), i - 1);
      if (buffer.length === 0) bufferStartLine = i + 1;
      continue;
    }

    if (buffer.length === 0) bufferStartLine = i;
    buffer.push(line);
  }

  if (inFence) {
    warnings.push(`存在未闭合的代码围栏（起始行 ${fenceStartLine + 1}）`);
    blocks.push({
      text: fenceBuffer.join('\n'),
      kind: 'code',
      locator: {
        lineStart: fenceStartLine + 1,
        lineEnd: lines.length,
        blockIndex: blocks.length,
      },
    });
  } else {
    pushBuffer(detectKind(buffer.join('\n')), lines.length - 1);
  }

  return { blocks, warnings, metadata: {} };
}

export const markdownParser: DocumentParser = {
  name: 'markdown',
  extensions: ['.md', '.markdown', '.mdx'],
  mimeTypes: ['text/markdown', 'text/x-markdown'],

  async parse(input: ParserInput): Promise<ParseResult> {
    const raw = await readFile(input.path, 'utf8');
    const { content, data } = matter(raw);
    const result = parseMarkdownText(content);
    return {
      ...result,
      metadata: { frontMatter: data as Record<string, unknown> },
    };
  },
};
