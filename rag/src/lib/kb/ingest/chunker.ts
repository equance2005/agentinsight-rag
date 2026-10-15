/**
 * 结构感知分块器。
 *
 * 目标尺寸 400–800 token，按标题/段落/表格边界切分，相邻块保留重叠。
 * contentHash 只取决于「有效正文内容」，因此：
 *  - 同一内容出现在不同文档 → 同一哈希 → embedding 可跨文档复用
 *  - 文档内改一段落 → 只有受影响块的哈希改变 → 增量重算范围受限
 */

import { createHash } from 'node:crypto';
import type { ChunkDraft, Chunker, ChunkOptions } from '../ports.js';
import type { Locator, ParsedBlock } from '../types.js';

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxChars: 1800,
  overlapChars: 200,
  prependHeadingPath: true,
};

/** 中文按字计，英文按词计，取折中估算。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.0 + rest / 4);
}

/**
 * 计算 chunk 的内容哈希。
 *
 * 只对归一化后的正文取哈希：连续空白折叠、去掉首尾空白。
 * 这样重建索引或改变换行风格不会产生伪「变更」。
 * 标题路径以独立参数参与哈希，避免把展示用前缀混进内容指纹。
 */
export function computeContentHash(content: string, headingPath: string[] | null): string {
  const normalized = normalizeForHash(content);
  const headingKey = headingPath && headingPath.length > 0 ? headingPath.join('\u001f') : '';
  return createHash('sha256').update(headingKey).update('\u001e').update(normalized).digest('hex');
}

function normalizeForHash(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

export class StructureAwareChunker implements Chunker {
  readonly name = 'structure-aware';
  readonly version = 'v1';

  constructor(private readonly defaults: ChunkOptions = DEFAULT_CHUNK_OPTIONS) {}

  chunk(blocks: ParsedBlock[], options: Partial<ChunkOptions> = {}): ChunkDraft[] {
    const opts: ChunkOptions = { ...this.defaults, ...options };
    const drafts: ChunkDraft[] = [];

    // 把块按「同一标题路径的连续块」聚合，标题变化时强制断开，
    // 避免一个 chunk 跨越两个主题导致检索语义混杂。
    const groups = this.groupByHeading(blocks);

    let ordinal = 0;
    for (const group of groups) {
      const headingPath = group.headingPath;
      const prefix =
        opts.prependHeadingPath && headingPath && headingPath.length > 0
          ? `${headingPath.join(' > ')}\n`
          : '';

      let buffer: { text: string; locator: Locator; kind: ParsedBlock['kind'] }[] = [];
      let bufferChars = 0;

      const flush = () => {
        if (buffer.length === 0) return;
        const body = buffer.map((item) => item.text).join('\n\n');
        const content = prefix + body;
        const locator = mergeLocators(buffer.map((item) => item.locator));
        drafts.push({
          content,
          locator,
          headingPath: headingPath ? [...headingPath] : null,
          tokenCount: estimateTokens(content),
          ordinal: ordinal++,
        });

        // 重叠：保留尾部若干块作为下一个 chunk 的开头
        const overlap: typeof buffer = [];
        let overlapChars = 0;
        for (let i = buffer.length - 1; i >= 0; i--) {
          const item = buffer[i];
          if (overlapChars + item.text.length > opts.overlapChars && overlap.length > 0) break;
          overlap.unshift(item);
          overlapChars += item.text.length;
        }
        // 全部块都被重用时不再另起新 chunk，避免死循环
        if (overlap.length === buffer.length) {
          buffer = [];
          bufferChars = 0;
        } else {
          buffer = overlap;
          bufferChars = overlapChars;
        }
      };

      for (const block of group.blocks) {
        const blockChars = block.text.length;

        // 单个块自身超限：先冲刷已有缓冲，再对该块做硬切分
        if (blockChars > opts.maxChars) {
          buffer = [];
          bufferChars = 0;
          for (const piece of hardSplit(block, opts)) {
            const content = prefix + piece.text;
            drafts.push({
              content,
              locator: piece.locator,
              headingPath: headingPath ? [...headingPath] : null,
              tokenCount: estimateTokens(content),
              ordinal: ordinal++,
            });
          }
          continue;
        }

        if (bufferChars + blockChars > opts.maxChars && buffer.length > 0) {
          flush();
        }
        buffer.push({ text: block.text, locator: block.locator, kind: block.kind });
        bufferChars += blockChars;
      }

      flush();
    }

    return drafts.filter((draft) => draft.content.trim().length > 0);
  }

  private groupByHeading(
    blocks: ParsedBlock[],
  ): Array<{ headingPath: string[] | null; blocks: ParsedBlock[] }> {
    const groups: Array<{ headingPath: string[] | null; blocks: ParsedBlock[] }> = [];
    let current: { headingPath: string[] | null; blocks: ParsedBlock[] } | null = null;

    for (const block of blocks) {
      const path = block.headingPath ?? null;
      const key = path ? path.join('\u001f') : '';
      const currentKey = current?.headingPath ? current.headingPath.join('\u001f') : '';

      if (!current || key !== currentKey) {
        current = { headingPath: path, blocks: [] };
        groups.push(current);
      }
      current.blocks.push(block);
    }

    return groups;
  }
}

/** 单块超长时的硬切分：优先在换行处断开。 */
function hardSplit(
  block: ParsedBlock,
  opts: ChunkOptions,
): Array<{ text: string; locator: Locator }> {
  const pieces: Array<{ text: string; locator: Locator }> = [];
  const lines = block.text.split('\n');
  const baseStartLine = block.locator.lineStart;
  const baseCharStart = block.locator.charStart;

  let buffer: string[] = [];
  let bufferChars = 0;
  let pieceStart = 0;
  let charCursor = 0;

  const flush = (endLine: number, endChar: number) => {
    const text = buffer.join('\n');
    if (!text.trim()) {
      buffer = [];
      return;
    }
    pieces.push({
      text,
      locator: {
        ...block.locator,
        blockIndex: undefined,
        ...(baseStartLine !== undefined
          ? { lineStart: baseStartLine + pieceStart, lineEnd: baseStartLine + endLine }
          : {}),
        ...(baseCharStart !== undefined
          ? { charStart: baseCharStart + charCursor, charEnd: baseCharStart + endChar }
          : {}),
      },
    });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (bufferChars + line.length > opts.maxChars && buffer.length > 0) {
      flush(i - 1, charCursor);
      pieceStart = i;
      charCursor += line.length + 1;
    }
    buffer.push(line);
    bufferChars += line.length + 1;
    charCursor += line.length + 1;
  }
  flush(lines.length - 1, charCursor);

  // 极端情况：单行就超限，只能按字符切
  if (pieces.length === 0) {
    for (let offset = 0; offset < block.text.length; offset += opts.maxChars) {
      pieces.push({
        text: block.text.slice(offset, offset + opts.maxChars),
        locator: {
          ...block.locator,
          ...(baseCharStart !== undefined
            ? {
                charStart: baseCharStart + offset,
                charEnd: baseCharStart + Math.min(offset + opts.maxChars, block.text.length),
              }
            : {}),
        },
      });
    }
  }

  return pieces;
}

/** 合并一组块的定位信息，取并集范围。 */
function mergeLocators(locators: Locator[]): Locator {
  const first = locators[0] ?? {};
  const last = locators[locators.length - 1] ?? {};
  const merged: Locator = { ...first };

  if (first.lineStart !== undefined && last.lineEnd !== undefined) {
    merged.lineStart = first.lineStart;
    merged.lineEnd = last.lineEnd;
  }
  if (first.charStart !== undefined && last.charEnd !== undefined) {
    merged.charStart = first.charStart;
    merged.charEnd = last.charEnd;
  }
  // 跨页/跨 sheet 时不写单值，避免产生误导性定位
  const pages = locators.map((l) => l.page).filter((p): p is number => p !== undefined);
  if (pages.length > 0) {
    merged.page = pages[0];
    merged.pageEnd = pages[pages.length - 1];
  }
  const sheets = locators.map((l) => l.sheet).filter((s): s is string => s !== undefined);
  if (sheets.length > 0 && new Set(sheets).size === 1) {
    merged.sheet = sheets[0];
  } else if (sheets.length > 0) {
    delete merged.sheet;
    merged.sheets = [...new Set(sheets)];
  }

  return merged;
}

export const defaultChunker = new StructureAwareChunker();
