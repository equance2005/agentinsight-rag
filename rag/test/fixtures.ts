/**
 * 测试夹具：构造带定位信息的样例文档，覆盖五种格式。
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import XLSX from 'xlsx';
import JSZip from 'jszip';

export interface FixturePaths {
  root: string;
  markdown: string;
  text: string;
  docx: string;
  xlsx: string;
  pdf: string;
  unsupported: string;
}

export async function createFixtures(root: string): Promise<FixturePaths> {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const markdown = join(root, 'guide.md');
  writeFileSync(
    markdown,
    [
      '---',
      'title: 部署指南',
      '---',
      '',
      '# 部署指南',
      '',
      '## 安装',
      '',
      '安装前需要确认运行环境满足最低要求。',
      '生产环境建议使用 **4 核 8G** 以上配置。',
      '',
      '### Windows 安装',
      '',
      '在 Windows 上使用安装包完成部署，默认端口为 3000。',
      '',
      '### Linux 安装',
      '',
      '在 Linux 上使用命令行安装，需要 root 权限。',
      '',
      '```bash',
      'kb install --port 8080',
      '```',
      '',
      '## 配置',
      '',
      '配置文件位于 conf/app.yaml。超时时间默认 30 秒。',
      '',
      '- 端口：默认 3000',
      '- 超时：默认 30 秒',
      '',
      '| 参数 | 默认值 |',
      '| --- | --- |',
      '| port | 3000 |',
      '| timeout | 30 |',
      '',
    ].join('\n'),
    'utf8',
  );

  const text = join(root, 'notes.txt');
  writeFileSync(
    text,
    [
      '运维速记',
      '',
      '数据库默认端口是 5432。',
      '日志目录默认在 /var/log/kb 下。',
      '',
      '扩容流程：先备份，再调整副本数，最后灰度验证。',
      '',
    ].join('\n'),
    'utf8',
  );

  const docx = join(root, 'manual.docx');
  writeFileSync(docx, await buildDocxBuffer());

  const xlsx = join(root, 'metrics.xlsx');
  writeFileSync(xlsx, buildXlsxBuffer());

  const pdf = join(root, 'spec.pdf');
  writeFileSync(pdf, buildPdfBuffer());

  // 一个不受支持的格式，用于验证「失败必须显式记录」
  const unsupported = join(root, 'archive.zip');
  writeFileSync(unsupported, Buffer.from('PK\u0003\u0004fake-zip-content'));

  return { root, markdown, text, docx, xlsx, pdf, unsupported };
}

/**
 * 用 JSZip 直接构造一个最小 .docx。
 *
 * 不引入 docx 生成库：mammoth 已带 jszip 作为依赖，
 * 手写 OOXML 让夹具内容完全可控，也避免多一个开发依赖。
 */
async function buildDocxBuffer(): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );

  zip.folder('_rels')?.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  zip.folder('word')?.file(
    '_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );

  // 样式定义：mammoth 依赖 styleId 识别标题
  zip.folder('word')?.file(
    'styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`,
  );

  const para = (text: string, styleId?: string) =>
    `<w:p>${styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : ''}` +
    `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;

  const body = [
    para('产品手册', 'Heading1'),
    para('第一章 计费说明', 'Heading2'),
    para('标准版按年计费，每年 9800 元，包含 5 个并发席位。'),
    para('第二章 退款政策', 'Heading2'),
    para('购买后 7 天内可以无理由退款，超过 7 天不予退款。'),
    para('退款申请需要提供订单号。'),
  ].join('');

  zip.folder('word')?.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`,
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildXlsxBuffer(): Buffer {
  const workbook = XLSX.utils.book_new();

  const sheet1 = XLSX.utils.aoa_to_sheet([
    ['区域', '负责人', '月度目标', '达成率'],
    ['华东', '张伟', 1200, '92%'],
    ['华南', '李娜', 980, '105%'],
    ['华北', '王强', 760, '88%'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet1, '销售目标');

  const sheet2 = XLSX.utils.aoa_to_sheet([
    ['指标', '数值', '说明'],
    ['可用性', '99.95%', '过去 30 天'],
    ['平均延迟', '180ms', 'P95'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet2, '服务水平');

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * 构造一个最小但合法的 PDF。
 *
 * 手写而非依赖生成库：内容与偏移完全可控，便于断言页码定位。
 * 注意 xref 偏移必须按字节计算（ASCII 内容下与字符数一致）。
 */
function buildPdfBuffer(): Buffer {
  const page1Lines = ['Security Spec', '', 'Page 1 content: all secrets must be stored in the key management service.'];
  const page2Lines = ['Page 2 content: audit logs are retained for 180 days.'];

  const makeContent = (lines: string[]) =>
    lines
      .map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 20} Td (${line.replace(/[\\()]/g, '\\$&')}) Tj ET`)
      .join('\n');

  const contents = [makeContent(page1Lines), makeContent(page2Lines)];

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${contents[0].length} >>\nstream\n${contents[0]}\nendstream`,
    `<< /Length ${contents[1].length} >>\nstream\n${contents[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  // 逐字节累积，确保 xref 偏移准确
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (text: string) => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    offset += buf.length;
    return offset;
  };

  push('%PDF-1.4\n');

  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
  }

  const xrefOffset = offset;
  // xref 条目固定 20 字节："nnnnnnnnnn ggggg n\r\n" 或 "… n \n"。
  // 条目必须以 2 字节行结束符收尾，否则 pdf.js 会报 bad XRef entry。
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f\r\n';
  for (const objOffset of offsets) {
    xref += `${String(objOffset).padStart(10, '0')} 00000 n\r\n`;
  }
  push(xref);

  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/** 构造一个「证据冲突」用的第二份文档。 */
export function writeConflictingDoc(path: string): void {
  writeFileSync(
    path,
    [
      '# 运维速记（旧版）',
      '',
      '数据库默认端口是 3306。',
      '',
      '注意：本条记录来自旧版文档，与新版不一致。',
      '',
    ].join('\n'),
    'utf8',
  );
}

/** 构造一个 Q&A 补充后应可回答的主题文档。 */
export function writeGapDoc(path: string): void {
  writeFileSync(
    path,
    ['# 常见问题', '', '## 如何申请试用', '', '在控制台点击「申请试用」，填写企业信息后 1 个工作日内开通。', ''].join('\n'),
    'utf8',
  );
}
