/**
 * Reciprocal Rank Fusion（RRF）。
 *
 * 关键词分（bm25）与余弦相似度不可比，直接加权求和需要针对每个语料调参。
 * RRF 只使用名次，天然免调参且稳定，是混合检索的通行做法。
 *
 *   score(d) = Σ_channel weight_ch / (k + rank_ch(d))
 */

export interface RankedList {
  /** 通道名，仅用于调试与审计。 */
  channel: 'keyword' | 'semantic';
  weight: number;
  ids: string[];
}

export const RRF_K = 60;

export function reciprocalRankFusion(lists: RankedList[], k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();

  for (const list of lists) {
    for (let i = 0; i < list.ids.length; i++) {
      const id = list.ids[i];
      const rank = i + 1; // RRF 名次从 1 开始
      const contribution = list.weight / (k + rank);
      fused.set(id, (fused.get(id) ?? 0) + contribution);
    }
  }

  return fused;
}

/** 把融合分归一化到 [0,1]，供阈值门控使用。 */
export function normalizeFusedScores(fused: Map<string, number>): Map<string, number> {
  if (fused.size === 0) return fused;
  let max = 0;
  for (const score of fused.values()) if (score > max) max = score;
  if (max === 0) return fused;

  const normalized = new Map<string, number>();
  for (const [id, score] of fused) normalized.set(id, score / max);
  return normalized;
}

/** 单通道召回时的「相对名次分」，使阈值语义在降级模式下保持一致。 */
export function rankToList(ids: string[]): Map<string, number> {
  const map = new Map<string, number>();
  const n = ids.length;
  for (let i = 0; i < n; i++) {
    // 名次 1 → 1.0，名次 n → 1/n；与 RRF 归一化后的量级相近
    map.set(ids[i], 1 / (1 + i * 0.5));
  }
  return map;
}
