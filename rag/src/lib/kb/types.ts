/**
 * 知识库领域类型契约。
 *
 * 通用性硬约束：本文件（及整个 src/lib/kb/**）不得引入任何 Agent Insight 专有模型
 * （Execution / Trace / Run / Experiment / Skill 等）。宿主通过 ports.ts 的接口接入。
 */

// ---------------------------------------------------------------------------
// 知识库与文档
// ---------------------------------------------------------------------------

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  /** 分块与检索配置版本；变更会导致全量重分块。 */
  chunkConfigVersion: string;
  embeddingModel: string | null;
  embeddingDim: number | null;
  /** 站点级公开 key，供嵌入插件使用；只允许调用公开只读/问答路由。 */
  publicKey: string | null;
  /** 允许嵌入的域名白名单；为空表示不限制（仅建议开发环境）。 */
  allowedOrigins: string[];
  widgetConfig: WidgetConfig;
  createdAt: string;
  updatedAt: string;
}

export interface WidgetConfig {
  title: string;
  welcomeMessage: string;
  placeholder: string;
  theme?: 'light' | 'dark' | 'auto';
  accentColor?: string;
  /** 插件挂载位置。 */
  position?: 'bottom-right' | 'bottom-left';
}

export const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  title: '知识库助手',
  welcomeMessage: '你好，我可以基于知识库中的文档回答问题，并给出引用来源。',
  placeholder: '请输入你的问题…',
  theme: 'auto',
  position: 'bottom-right',
};

/** 源文档解析状态。失败必须显式记录，不得静默跳过。 */
export type ParseStatus = 'pending' | 'ok' | 'error' | 'skipped';

export interface SourceDocument {
  id: string;
  kbId: string;
  title: string;
  /** 本地导入时的绝对路径。 */
  sourcePath: string | null;
  /** 网页上传时的逻辑路径（相对于上传根目录）。 */
  sourceUrl: string | null;
  mimeType: string;
  sizeBytes: number;
  /** 内容哈希，增量同步的首要判据。 */
  sha256: string;
  mtime: string;
  parseStatus: ParseStatus;
  /** 解析失败原因（parseStatus=error 时）。 */
  parseError: string | null;
  /**
   * 解析告警：非致命问题，例如 docx 缺少样式定义、PDF 部分页面无文本层。
   * 与 parseError 分开存储 —— 混在一起会让人把「有告警」误读成「解析失败」。
   */
  parseWarnings: string[];
  parseVersion: string;
  chunkConfigVersion: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 分块与定位
// ---------------------------------------------------------------------------

/**
 * 片段在源文档中的位置。
 * 必须在解析阶段一次产出，后续不允许补算。
 */
export interface Locator {
  /** PDF / docx 页码（1 起）。 */
  page?: number;
  /** 片段跨页时的结束页码。 */
  pageEnd?: number;
  /** Excel 工作表名。跨 sheet 的片段不写该字段。 */
  sheet?: string;
  /** 片段跨越多个 sheet 时的全部工作表名。 */
  sheets?: string[];
  /** Excel 单元格范围，如 "A1:D20"。 */
  cellRange?: string;
  /** Markdown / docx 标题路径，如 ["安装", "Windows"]。 */
  headingPath?: string[];
  /** 纯文本字符区间 [start, end)。 */
  charStart?: number;
  charEnd?: number;
  /** 文档内块序号，用于同页多块的稳定排序。 */
  blockIndex?: number;
  /** 行号区间（1 起），用于表格与代码类内容。 */
  lineStart?: number;
  lineEnd?: number;
}

export interface Chunk {
  id: string;
  kbId: string;
  documentId: string;
  /** 文档内顺序。 */
  ordinal: number;
  content: string;
  /** 内容哈希，增量同步与 embedding 缓存的键。 */
  contentHash: string;
  tokenCount: number;
  locator: Locator;
  headingPath: string[] | null;
  embeddingModel: string | null;
  embeddingDim: number | null;
  createdAt: string;
}

/** 手工录入的问答对：独立记录类型，不经过解析与分块。 */
export interface QaPair {
  id: string;
  kbId: string;
  question: string;
  answer: string;
  contentHash: string;
  tags: string[];
  embeddingModel: string | null;
  embeddingDim: number | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 摄取
// ---------------------------------------------------------------------------

export type IngestMode = 'full' | 'incremental';
export type IngestStatus = 'running' | 'ok' | 'error';

export interface IngestStats {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  failed: number;
  chunksCreated: number;
  chunksDeleted: number;
  embeddingsComputed: number;
  embeddingsReused: number;
  durationMs: number;
}

export interface IngestJob {
  id: string;
  kbId: string;
  mode: IngestMode;
  status: IngestStatus;
  stats: IngestStats | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 解析器输出：纯文本 + 块级定位信息。 */
export interface ParsedBlock {
  text: string;
  locator: Locator;
  headingPath?: string[];
  /** 块类型影响分块策略与上下文拼接方式。 */
  kind: 'heading' | 'paragraph' | 'table' | 'list' | 'code';
}

export interface ParseResult {
  blocks: ParsedBlock[];
  /** 解析期的质量告警，例如"第 3 页扫描件无文本层"。 */
  warnings: string[];
  metadata: Record<string, unknown>;
}

export class ParseError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

export type RetrievalMode = 'hybrid' | 'keyword-only';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  locator: Locator;
  headingPath: string[] | null;
  /** 融合后的排序分。 */
  score: number;
  /** 各召回通道的原始名次，便于事后审计。 */
  ranks: { keyword?: number; semantic?: number; fused?: number };
  /** 记录该条命中的来源类型，用于区分文档片段与问答对。 */
  kind: 'chunk' | 'qa';
}

export interface RetrievalResult {
  mode: RetrievalMode;
  hits: RetrievedChunk[];
  /** 归一化后的最高融合分，供检索闸门使用。 */
  topScore: number;
  /** 语义通道是否因未配置或失败而降级。 */
  semanticDegraded: boolean;
  semanticDegradeReason: string | null;
  queryRewrite: string | null;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// 闸门与回答
// ---------------------------------------------------------------------------

/**
 * 闸门裁决。这是拒答能力的核心状态机。
 * - answerable：存在高置信且一致的证据
 * - partial：部分子问题有证据，其余缺失
 * - conflict：多份证据互相矛盾
 * - no_evidence：无有效证据，应当拒答
 */
export type GateDecision = 'answerable' | 'partial' | 'conflict' | 'no_evidence';

export type GateStage = 'retrieval' | 'evidence' | 'post-check';

export interface GateResult {
  decision: GateDecision;
  stage: GateStage;
  reason: string;
  /** 触发拒答时的可操作提示：告诉用户该补充什么。 */
  suggestions: string[];
  /** 证据冲突时并列呈现的冲突组。 */
  conflicts?: ConflictGroup[];
  /** 部分可答时标注的缺失点。 */
  missing?: string[];
}

export interface ConflictGroup {
  topic: string;
  claims: Array<{ text: string; citations: Citation[] }>;
}

export interface Citation {
  /** 引用编号，从 1 开始，与答案正文中的标记对应。 */
  index: number;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  locator: Locator;
  /** 命中片段原文摘录，供前端预览。 */
  snippet: string;
  score: number;
  kind: 'chunk' | 'qa';
}

/** claim 级校验结论，复用 Agent Insight 已有的忠实度裁决口径。 */
export type ClaimVerdict = 'supported' | 'contradicted' | 'not_covered';

export interface ClaimCheck {
  claim: string;
  verdict: ClaimVerdict;
  citationIndexes: number[];
}

/**
 * 分阶段耗时。
 *
 * 用于定位「查询慢在哪一段」。检索与三次 LLM 调用（证据闸门、生成、claim 校验）
 * 分别计时，避免只看总耗时无法判断瓶颈。
 */
export interface StageTimings {
  /** 检索：含 query embedding 调用与关键词/向量双通道。 */
  retrievalMs: number;
  /** 多轮上下文与消息落库。 */
  contextMs: number;
  /** 证据闸门（LLM 调用 1）。 */
  evidenceGateMs: number;
  /** 生成回答（LLM 调用 2）。 */
  generateMs: number;
  /** claim 级忠实度校验（LLM 调用 3）。 */
  claimCheckMs: number;
  /** 闸门①的本地判定，不调用模型。 */
  localGateMs: number;
  /** 端到端总耗时。 */
  totalMs: number;
  /** LLM 调用次数，用于确认拒答路径为 0。 */
  llmCalls: number;
  /** 送入模型的总输入字符数，用于发现上下文过大。 */
  inputChars: number;
}

export interface AnswerResult {
  conversationId: string;
  messageId: string;
  answer: string;
  citations: Citation[];
  gate: GateResult;
  retrieval: RetrievalResult;
  claimChecks: ClaimCheck[];
  /** 无引用支撑的陈述句数量；验收要求该值为 0。 */
  unsupportedClaimCount: number;
  modelId: string | null;
  tokenUsage: { input: number; output: number } | null;
  latencyMs: number;
  /** 分阶段耗时明细。 */
  timings: StageTimings;
}

// ---------------------------------------------------------------------------
// 对话与反馈
// ---------------------------------------------------------------------------

export interface Conversation {
  id: string;
  kbId: string;
  /** 宿主站点标识，用于区分嵌入来源。 */
  siteKey: string;
  createdAt: string;
}

export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  gateDecision: GateDecision | null;
  modelId: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export type FeedbackRating = 'up' | 'down';
export type FeedbackStatus = 'open' | 'handled';

export interface Feedback {
  id: string;
  messageId: string;
  rating: FeedbackRating;
  reason: string | null;
  comment: string | null;
  status: FeedbackStatus;
  createdAt: string;
}

/** 未解决问题类别，决定维护者的处理方式。 */
export type UnresolvedReason = 'no_recall' | 'low_evidence' | 'contradiction' | 'user_downvote';

export type UnresolvedStatus = 'open' | 'handled' | 'dismissed';

export interface UnresolvedIssue {
  id: string;
  kbId: string;
  query: string;
  reason: UnresolvedReason;
  /** 失败时的检索与闸门证据快照，供复查。 */
  evidence: Record<string, unknown>;
  status: UnresolvedStatus;
  /** 处理后关联的问答对，用于闭环验证。 */
  resolvedByQaPairId: string | null;
  createdAt: string;
  updatedAt: string;
}
