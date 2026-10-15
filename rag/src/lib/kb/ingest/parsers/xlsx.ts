/**
 * Excel (.xlsx/.xls) 解析器。
 *
 * 按「工作表 → 表头 → 数据行分组」切块，产出 sheet 与 cellRange 定位。
 * 合并单元格通过回填左上角值展平，避免下游读到空洞。
 */

import XLSX from 'xlsx';
import type { DocumentParser, ParserInput } from '../../ports.js';
import type { Locator, ParsedBlock, ParseResult } from '../../types.js';

/** 每个块包含的最大数据行数，避免整张表挤进一个 chunk。 */
const ROWS_PER_BLOCK = 30;

export function parseWorkbook(workbook: XLSX.WorkBook, warnings: string[]): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let globalBlockIndex = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
    if (!range) {
      warnings.push(`工作表「${sheetName}」为空，已跳过`);
      continue;
    }

    // 展平合并单元格：把左上角的值回填到整个合并区域
    const merges = sheet['!merges'] ?? [];
    for (const merge of merges) {
      const topLeft = sheet[XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })];
      if (!topLeft) continue;
      for (let r = merge.s.r; r <= merge.e.r; r++) {
        for (let c = merge.s.c; c <= merge.e.c; c++) {
          if (r === merge.s.r && c === merge.s.c) continue;
          const addr = XLSX.utils.encode_cell({ r, c });
          if (!sheet[addr]) {
            sheet[addr] = { ...topLeft, t: topLeft.t, v: topLeft.v, w: topLeft.w };
          }
        }
      }
    }

    const rows: string[][] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells: string[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        cells.push(cell ? formatCell(cell) : '');
      }
      rows.push(cells);
    }

    // 去掉全空行，但保留原始行号用于 cellRange 计算
    const nonEmpty = rows
      .map((cells, idx) => ({ cells, rowIndex: range.s.r + idx }))
      .filter((row) => row.cells.some((cell) => cell.trim() !== ''));

    if (nonEmpty.length === 0) {
      warnings.push(`工作表「${sheetName}」无有效数据行，已跳过`);
      continue;
    }

    const headerRow = nonEmpty[0];
    const headerCells = headerRow.cells.map((cell, idx) => cell.trim() || `列${columnName(range.s.c + idx)}`);
    const headerText = headerCells.join(' | ');

    // 表头独立成块，便于「这一列是什么含义」类问题命中。
    // 定位只覆盖表头行本身，不要写成整表范围，否则引用定位会误导用户。
    const headerRange = `${XLSX.utils.encode_cell({ r: headerRow.rowIndex, c: range.s.c })}:${XLSX.utils.encode_cell({ r: headerRow.rowIndex, c: range.e.c })}`;
    blocks.push({
      text: `工作表：${sheetName}\n表头：${headerText}`,
      kind: 'heading',
      headingPath: [sheetName],
      locator: {
        sheet: sheetName,
        cellRange: headerRange,
        lineStart: headerRow.rowIndex + 1,
        lineEnd: headerRow.rowIndex + 1,
        blockIndex: globalBlockIndex++,
      },
    });

    const dataRows = nonEmpty.slice(1);
    for (let i = 0; i < dataRows.length; i += ROWS_PER_BLOCK) {
      const slice = dataRows.slice(i, i + ROWS_PER_BLOCK);
      const first = slice[0];
      const last = slice[slice.length - 1];

      const lines = slice.map((row) => {
        const pairs = row.cells
          .map((cell, idx) => (cell.trim() ? `${headerCells[idx]}=${cell.trim()}` : null))
          .filter((pair): pair is string => pair !== null);
        return `第${row.rowIndex + 1}行: ${pairs.join('; ')}`;
      });

      const locator: Locator = {
        sheet: sheetName,
        cellRange: `${XLSX.utils.encode_cell({ r: first.rowIndex, c: range.s.c })}:${XLSX.utils.encode_cell({ r: last.rowIndex, c: range.e.c })}`,
        lineStart: first.rowIndex + 1,
        lineEnd: last.rowIndex + 1,
        blockIndex: globalBlockIndex++,
      };

      blocks.push({
        text: lines.join('\n'),
        kind: 'table',
        headingPath: [sheetName],
        locator,
      });
    }

    if (merges.length > 0) {
      warnings.push(`工作表「${sheetName}」包含 ${merges.length} 处合并单元格，已按左上角值展平`);
    }
  }

  return blocks;
}

function formatCell(cell: XLSX.CellObject): string {
  if (cell.w !== undefined) return String(cell.w);
  if (cell.v === undefined || cell.v === null) return '';
  if (cell.v instanceof Date) return cell.v.toISOString();
  return String(cell.v);
}

function columnName(index: number): string {
  let n = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

export const xlsxParser: DocumentParser = {
  name: 'xlsx',
  extensions: ['.xlsx', '.xls', '.xlsm'],
  mimeTypes: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ],

  async parse(input: ParserInput): Promise<ParseResult> {
    const warnings: string[] = [];
    const workbook = XLSX.readFile(input.path, { cellDates: true, cellText: true });
    const blocks = parseWorkbook(workbook, warnings);

    if (blocks.length === 0) {
      warnings.push('未从工作簿中解析出任何数据行');
    }

    return {
      blocks,
      warnings,
      metadata: { sheets: workbook.SheetNames, sheetCount: workbook.SheetNames.length },
    };
  },
};
