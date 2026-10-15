/**
 * pdf-parse 未随包提供类型声明，这里补齐本项目实际用到的部分。
 */

declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
  }

  function pdfParse(data: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export = pdfParse;
}
