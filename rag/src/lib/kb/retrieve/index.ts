/**
 * 统一检索入口：关键词 + 语义 → RRF 融合 →（可选）重排。
 *
 * 降级保证：未配置 embedding 或调用失败时，自动退化为纯关键词模式，
 * 功能不中断，并在结果中标注 retrievalMode 与降级原因。
 */

import type { EmbeddingProvider, Reranker, VectorStore } from '../ports.js';
import type { RetrievalResult, RetrievedChunk } from '../types.js';
import { KnowledgeBaseRepository } from '../store/repository.js';
import { KeywordRetriever } from './keyword.js';
import { normalizeFusedScores, rankToList, reciprocalRankFusion, type RankedList } from './fusion.js';

/**
 * Remove common Chinese question framing before the lexical query is built.
 * The original query is still sent to the semantic channel and the answer
 * gates, so this only prevents FTS from spending its limited term budget on
 * words such as "在哪里" and "分别是什么".
 */
export function rewriteQueryForRetrieval(query: string): string {
  return query
    .toLowerCase()
    .replace(/在哪里|何处|是什么|是多少|多少|多久|如何|怎么|怎样|哪个|哪些|是否|应该|需要|能否|可以|存放|存储|位置|路径|期限|多长|时间|要求|条件|材料|准备|流程|方案|方式|限制|内容|分别|周期|策略/g, ' ')
    .replace(/[？?。！!，,、；;：:""''（）()【】\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RetrieveOptions {
  kbId: string;
  query: string;
  topK: number;
  /** 语义通道候选数，通常大于 topK。 */
  candidateK?: number;
  documentIds?: string[];
  /** 关键词与语义通道的融合权重。 */
  keywordWeight?: number;
  semanticWeight?: number;
  /** 是否允许在语义不可用时降级；false 时抛错（用于验收断言）。 */
  allowKeywordFallback?: boolean;
}

export class Retriever {
  private readonly keyword: KeywordRetriever;

  constructor(
    private readonly repo: KnowledgeBaseRepository,
    private readonly vectorStore: VectorStore,
    private readonly embedder: EmbeddingProvider | null,
    private readonly reranker: Reranker | null = null,
  ) {
    this.keyword = new KeywordRetriever(repo.raw());
  }

  async retrieve(options: RetrieveOptions): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const candidateK = options.candidateK ?? Math.max(options.topK * 4, 20);
    const keywordQuery = rewriteQueryForRetrieval(options.query);
    // --- 关键词通道 ---
    const keywordHits = this.keyword.search({
      kbId: options.kbId,
      query: keywordQuery || options.query,
      topK: candidateK,
      documentIds: options.documentIds,
    });

    // --- 语义通道 ---
    let semanticHits: Array<{ id: string; score: number; kind: 'chunk' | 'qa' }> = [];
    let semanticDegraded = false;
    let degradeReason: string | null = null;

    if (!this.embedder) {
      semanticDegraded = true;
      degradeReason = '未配置 embedding 模型，已降级为纯关键词检索';
    } else {
      try {
        const vector = await this.embedder.embedQuery(options.query);
        semanticHits = await this.vectorStore.search({
          kbId: options.kbId,
          vector,
          topK: candidateK,
          model: this.embedder.modelId,
          documentIds: options.documentIds,
        });
        if (semanticHits.length === 0) {
          // 索引为空不算故障，但要在结果里说明，避免误判为「检索失败」
          degradeReason = '向量索引为空，语义通道未返回结果';
        }
      } catch (error) {
        if (options.allowKeywordFallback === false) throw error;
        semanticDegraded = true;
        degradeReason = `语义检索失败，已降级为纯关键词检索：${(error as Error).message}`;
        semanticHits = [];
      }
    }

    const semanticUsable = !semanticDegraded && semanticHits.length > 0;
    const mode = semanticUsable ? 'hybrid' : 'keyword-only';

    // --- 融合 ---
    const keywordIds = keywordHits.map((hit) => hit.id);
    const semanticIds = semanticHits.map((hit) => hit.id);
    const kinds = new Map<string, 'chunk' | 'qa'>();
    for (const hit of keywordHits) kinds.set(hit.id, hit.kind);
    for (const hit of semanticHits) kinds.set(hit.id, hit.kind);

    let fused: Map<string, number>;
    let ranksByChannel: Map<string, { keyword?: number; semantic?: number }>;

    if (mode === 'hybrid') {
      const lists: RankedList[] = [
        { channel: 'keyword', weight: options.keywordWeight ?? 1.0, ids: keywordIds },
        { channel: 'semantic', weight: options.semanticWeight ?? 1.0, ids: semanticIds },
      ];
      fused = normalizeFusedScores(reciprocalRankFusion(lists));
      ranksByChannel = buildRanks(keywordIds, semanticIds);
    } else {
      // 降级模式：用「相对名次分」保持阈值语义一致
      fused = rankToList(keywordIds);
      ranksByChannel = buildRanks(keywordIds, []);
    }

    // --- 装载命中详情 ---
    const orderedIds = [...fused.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([id]) => id);

    let hits = this.hydrate(options.kbId, orderedIds, fused, ranksByChannel, kinds);

    // --- 可选重排 ---
    if (this.reranker && hits.length > 0 && mode === 'hybrid') {
      try {
        hits = await this.reranker.rerank(options.query, hits, options.topK);
      } catch {
        // 重排失败不致命：保留融合顺序
        hits = hits.slice(0, options.topK);
      }
    } else {
      hits = hits.slice(0, options.topK);
    }

    return {
      mode,
      hits,
      topScore: hits.length > 0 ? hits[0].score : 0,
      semanticDegraded,
      semanticDegradeReason: degradeReason,
      queryRewrite: keywordQuery && keywordQuery !== options.query ? keywordQuery : null,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /** 按 ID 装载 chunk / qa 详情，保持融合后的顺序。 */
  private hydrate(
    kbId: string,
    orderedIds: string[],
    scores: Map<string, number>,
    ranks: Map<string, { keyword?: number; semantic?: number }>,
    kinds: Map<string, 'chunk' | 'qa'>,
  ): RetrievedChunk[] {
    const chunkIds = orderedIds.filter((id) => kinds.get(id) !== 'qa');
    const qaIds = orderedIds.filter((id) => kinds.get(id) === 'qa');

    const chunkById = new Map(this.repo.findChunks(chunkIds).map((c) => [c.id, c]));
    const qaById = new Map(this.repo.findQaPairs(qaIds).map((q) => [q.id, q]));
    const docTitles = new Map(
      this.repo.listDocuments(kbId).map((doc) => [doc.id, doc.title]),
    );

    const result: RetrievedChunk[] = [];
    for (const id of orderedIds) {
      const score = scores.get(id) ?? 0;
      const rank = ranks.get(id) ?? {};

      if (kinds.get(id) === 'qa') {
        const qa = qaById.get(id);
        if (!qa) continue;
        result.push({
          chunkId: qa.id,
          documentId: '',
          documentTitle: `问答对：${truncate(qa.question, 60)}`,
          content: `问：${qa.question}\n答：${qa.answer}`,
          locator: {},
          headingPath: null,
          score,
          ranks: { ...rank, fused: result.length + 1 },
          kind: 'qa',
        });
        continue;
      }

      const chunk = chunkById.get(id);
      if (!chunk) continue;
      result.push({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        documentTitle: docTitles.get(chunk.documentId) ?? '(未知文档)',
        content: chunk.content,
        // headingPath 同时放进 locator，保证引用只带一个定位对象就能还原位置
        locator: chunk.headingPath?.length
          ? { ...chunk.locator, headingPath: chunk.headingPath }
          : chunk.locator,
        headingPath: chunk.headingPath,
        score,
        ranks: { ...rank, fused: result.length + 1 },
        kind: 'chunk',
      });
    }

    return result;
  }
}

function buildRanks(
  keywordIds: string[],
  semanticIds: string[],
): Map<string, { keyword?: number; semantic?: number }> {
  const ranks = new Map<string, { keyword?: number; semantic?: number }>();
  keywordIds.forEach((id, i) => {
    const entry = ranks.get(id) ?? {};
    entry.keyword = i + 1;
    ranks.set(id, entry);
  });
  semanticIds.forEach((id, i) => {
    const entry = ranks.get(id) ?? {};
    entry.semantic = i + 1;
    ranks.set(id, entry);
  });
  return ranks;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 重排器实现：按与查询的词汇重叠度排序，作为无外部模型时的本地兜底。 */
export class LexicalOverlapReranker implements Reranker {
  readonly name = 'lexical-overlap';

  async rerank(query: string, candidates: RetrievedChunk[], topN: number): Promise<RetrievedChunk[]> {
    const queryTerms = new Set(
      query
        .toLowerCase()
        .split(/[\s，。！？；：、（）【】《》"'']+/)
        .filter((term) => term.length >= 2),
    );
    // 中文按 bigram 补充
    const cjk = [...query].filter((ch) => /[\u4e00-\u9fff]/.test(ch));
    for (let i = 0; i < cjk.length - 1; i++) queryTerms.add(`${cjk[i]}${cjk[i + 1]}`);

    const scored = candidates.map((candidate) => {
      const content = candidate.content.toLowerCase();
      let overlap = 0;
      for (const term of queryTerms) {
        if (content.includes(term)) overlap += 1;
      }
      const coverage = queryTerms.size === 0 ? 0 : overlap / queryTerms.size;
      // 与融合分线性组合，保留原始排序信息
      return { candidate, blended: candidate.score * 0.5 + coverage * 0.5 };
    });

    return scored
      .sort((a, b) => b.blended - a.blended)
      .slice(0, topN)
      .map((item, index) => ({
        ...item.candidate,
        score: item.blended,
        ranks: { ...item.candidate.ranks, fused: index + 1 },
      }));
  }
}
