/**
 * 引擎端口（ports）。
 *
 * 所有外部能力都通过这里的接口注入，引擎本身不直接依赖任何具体实现，
 * 因此可以在不同宿主、不同存储后端、不同模型供应商之间复用。
 */

import type { Chunk, Locator, ParseResult, RetrievedChunk } from './types.js';

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export interface DocumentParser {
  /** 唯一名称，写入 parseVersion 参与增量判定。 */
  readonly name: string;
  /** 支持的扩展名（小写，含点）。 */
  readonly extensions: string[];
  /** 支持的 MIME 类型。 */
  readonly mimeTypes: string[];
  parse(input: ParserInput): Promise<ParseResult>;
}

export interface ParserInput {
  /** 文件绝对路径；网页上传场景为暂存路径。 */
  path: string;
  /** 逻辑文件名，用于报错与标题推断。 */
  fileName: string;
  mimeType: string;
  /** 大文件保护：超过该字节数应拒绝或降级。 */
  maxBytes?: number;
}

// ---------------------------------------------------------------------------
// 分块
// ---------------------------------------------------------------------------

export interface Chunker {
  readonly name: string;
  /** 配置指纹，变更后触发全量重分块。 */
  readonly version: string;
  /** options 为覆盖项；实现应使用自身默认值补齐缺省字段。 */
  chunk(blocks: ParseResult['blocks'], options?: Partial<ChunkOptions>): ChunkDraft[];
}

export interface ChunkOptions {
  maxChars: number;
  overlapChars: number;
  /** 是否把标题路径拼进正文，提升检索命中率。 */
  prependHeadingPath: boolean;
}

export interface ChunkDraft {
  content: string;
  locator: Locator;
  headingPath: string[] | null;
  tokenCount: number;
  /** 是否与上一个 chunk 重叠产生，用于增量差异的稳定比对。 */
  ordinal: number;
}

// ---------------------------------------------------------------------------
// 向量存储
// ---------------------------------------------------------------------------

/**
 * 向量存储抽象。
 *
 * 默认实现为 SQLite（Float32 BLOB + 内存缓存 + 暴力余弦），
 * 在 Postgres 部署下切换为 pgvector 实现，两者接口一致。
 */
export interface VectorStore {
  readonly name: string;
  /** 该实现的适用规模上限提示，用于文档与告警。 */
  readonly recommendedMaxVectors: number;

  upsert(items: VectorItem[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  deleteByDocument(documentId: string): Promise<void>;
  deleteByKb(kbId: string): Promise<void>;
  search(query: VectorSearchQuery): Promise<VectorHit[]>;
  count(kbId: string): Promise<number>;
}

export interface VectorItem {
  id: string;
  kbId: string;
  documentId: string | null;
  vector: Float32Array;
  /** 元数据过滤用，避免检索后再回表。 */
  meta: { kind: 'chunk' | 'qa'; model: string; dim: number };
}

export interface VectorSearchQuery {
  kbId: string;
  vector: Float32Array;
  topK: number;
  /** 只与同一 embedding 模型的向量比较。 */
  model: string;
  /** 只在这些文档内检索。 */
  documentIds?: string[];
  minScore?: number;
}

export interface VectorHit {
  id: string;
  score: number;
  kind: 'chunk' | 'qa';
}

// ---------------------------------------------------------------------------
// 模型能力
// ---------------------------------------------------------------------------

/**
 * Embedding 提供方。
 *
 * 未配置时引擎进入 keyword-only 降级模式，功能不中断。
 */
export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dim: number;
  /** 批量嵌入；实现应处理分批与重试。 */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** 单条查询嵌入，可与文档嵌入使用不同指令前缀。 */
  embedQuery(text: string): Promise<Float32Array>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletion {
  text: string;
  usage: { input: number; output: number } | null;
}

export interface LlmProvider {
  readonly modelId: string;
  complete(messages: LlmMessage[], options?: LlmOptions): Promise<LlmCompletion>;
  /** 流式生成；用于插件的增量呈现。 */
  stream(messages: LlmMessage[], options?: LlmOptions): AsyncIterable<string>;
}

export interface LlmOptions {
  /** 请求级模型覆盖；未提供时使用提供方默认模型。 */
  model?: string;
  /** 由插件连接提供的临时凭证与兼容端点。 */
  apiKey?: string;
  baseUrl?: string;
  images?: ImageAttachment[];
  temperature?: number;
  maxTokens?: number;
  /** 强制 JSON 输出，用于闸门与 claim 校验的结构化判定。 */
  json?: boolean;
  signal?: AbortSignal;
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
  name?: string;
}

/**
 * 重排器。未配置时按融合顺序截断。
 */
export interface Reranker {
  readonly name: string;
  rerank(query: string, candidates: RetrievedChunk[], topN: number): Promise<RetrievedChunk[]>;
}

// ---------------------------------------------------------------------------
// 知识来源（宿主接入点）
// ---------------------------------------------------------------------------

/**
 * 宿主提供文档来源的接入点。
 *
 * 通用实现为「本地目录」与「网页上传暂存目录」；
 * 宿主扩展（例如 Agent Insight）可实现为「从内部对象生成文档」。
 */
export interface DocumentSource {
  readonly name: string;
  /** 枚举当前可见的文档，用于增量同步时的差异比对。 */
  list(): Promise<SourceEntry[]>;
  /** 读取单个文档内容到临时路径，返回可解析的本地文件。 */
  materialize(entry: SourceEntry): Promise<MaterializedDocument>;
}

export interface SourceEntry {
  /** 稳定标识：本地目录为绝对路径，宿主扩展为对象 ID。 */
  key: string;
  /** 逻辑相对路径，用于展示与 include/exclude 匹配。 */
  relativePath: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  mtime: string;
  sha256?: string;
}

export interface MaterializedDocument {
  path: string;
  fileName: string;
  mimeType: string;
  /** 由 materialize 创建的临时文件需要在使用后清理。 */
  cleanup?: () => Promise<void>;
}
