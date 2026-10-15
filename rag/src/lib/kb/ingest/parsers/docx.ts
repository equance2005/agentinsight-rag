/**
 * Word (.docx) 解析器。
 *
 * 使用 mammoth 提取纯文本，并按标题样式切块。
 * 定位粒度到段落序号；docx 无稳定页概念，因此不产出页码。
 */

import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import type { DocumentParser, ParserInput } from '../../ports.js';
import type { ParsedBlock, ParseResult } from '../../types.js';

export const docxParser: DocumentParser = {
  name: 'docx',
  extensions: ['.docx'],
  mimeTypes: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],

  async parse(input: ParserInput): Promise<ParseResult> {
    const warnings: string[] = [];
    const buffer = await readFile(input.path);

    const result = await mammoth.convertToHtml(
      { buffer },
      {
        styleMap: [
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "p[style-name='Heading 4'] => h4:fresh",
          "p[style-name='Title'] => h1:fresh",
        ],
      },
    );

    for (const message of result.messages) {
      // mammoth 的 warning 通常指向不支持的样式/元素
      if (message.type === 'warning') {
        warnings.push(`docx 解析告警：${message.message}`);
      } else if (message.type === 'error') {
        warnings.push(`docx 解析错误：${message.message}`);
      }
    }

    const blocks = htmlToBlocks(result.value, warnings);

    if (blocks.length === 0) {
      warnings.push('未从 docx 中解析出任何文本内容；可能是纯图片文档或受保护文档');
    }

    return { blocks, warnings, metadata: { messageCount: result.messages.length } };
  },
};

/** 把 mammoth 产出的简单 HTML 转成带 headingPath 的块序列。 */
function htmlToBlocks(html: string, warnings: string[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const headingStack: string[] = [];

  // mammoth 输出结构简单（p / h1..h6 / ul / ol / table），用标签扫描足够可靠。
  const tokenRe = /<(h[1-6]|p|li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  let tableRowIndex = 0;

  while ((match = tokenRe.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const text = stripTags(match[2]).trim();
    if (!text) continue;

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = text;
      for (let k = 0; k < headingStack.length; k++) {
        if (headingStack[k] === undefined) headingStack.splice(k, 1);
      }
      blocks.push({
        text,
        kind: 'heading',
        headingPath: [...headingStack],
        locator: { blockIndex: blocks.length },
      });
      continue;
    }

    const kind: ParsedBlock['kind'] = tag === 'li' ? 'list' : tag === 'tr' ? 'table' : 'paragraph';
    blocks.push({
      text,
      kind,
      headingPath: headingStack.length ? [...headingStack] : undefined,
      locator: {
        blockIndex: blocks.length,
        ...(tag === 'tr' ? { lineStart: ++tableRowIndex } : {}),
      },
    });
  }

  if (blocks.length === 0 && html.includes('<table')) {
    warnings.push('文档主体为表格，但未提取出行级内容，请检查 docx 结构');
  }

  return blocks;
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
