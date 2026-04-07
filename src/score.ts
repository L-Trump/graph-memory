/**
 * graph-memory — 组合评分
 *
 * semantic + PPR + PageRank 三维度归一化后加权求和
 * α (semantic weight) + β (ppr weight) + γ (pagerank weight) = 1
 *
 * 三个维度分别代表：
 * - semantic：节点的直接语义相关性（向量相似度）
 * - ppr：节点的局部关联性（Personalized PageRank，相对于种子的相关性）
 * - pagerank：节点的全局重要性（全局 PageRank，整个图中的重要程度）
 */

export interface Scored<T> {
  item: T;
  combined: number;
  semantic: number;     // 原始语义分数（向量相似度，0-1）
  ppr: number;          // 原始 PPR 分数
  pagerank: number;     // 原始 PageRank 分数（全局重要性）
  belief?: number;     // 原始置信度分数（0-1）
}

/** 归一化到 [0,1]：min-max */
function minMax(scores: number[]): number[] {
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max === min) return scores.map(() => 1);
  return scores.map(s => (s - min) / (max - min));
}

/**
 * 计算组合评分
 * @param items 候选项
 * @param getSemantic 每个候选的语义分数（向量相似度，0-1）
 * @param getPpr 每个候选的 PPR 分数
 * @param getPageRank 每个候选的全局 PageRank 分数
 * @param alpha semantic 权重，默认 0.40
 * @param gamma pagerank 权重，默认 0.20
 * @param getBelief 每个候选的置信度分数（0-1），可选
 * @param delta belief 权重，默认 0.15
 */
export function combinedScore<T>(
  items: T[],
  getSemantic: (item: T) => number,
  getPpr: (item: T) => number,
  getPageRank: (item: T) => number,
  alpha = 0.40,
  gamma = 0.20,
  getBelief?: (item: T) => number,
  delta = 0.15,
): Scored<T>[] {
  const beta = 1 - alpha - gamma - delta;

  // 归一化
  const semScores = items.map(getSemantic);
  const pprScores = items.map(getPpr);
  const prScores = items.map(getPageRank);
  const normSem = minMax(semScores);
  const normPpr = minMax(pprScores);
  const normPr = minMax(prScores);

  if (getBelief) {
    const beliefScores = items.map(getBelief);
    const normBelief = minMax(beliefScores);
    return items.map((item, i) => ({
      item,
      semantic: semScores[i],
      ppr: pprScores[i],
      pagerank: prScores[i],
      combined: alpha * normSem[i] + beta * normPpr[i] + gamma * normPr[i] + delta * normBelief[i],
    }));
  }

  return items.map((item, i) => ({
    item,
    semantic: semScores[i],
    ppr: pprScores[i],
    pagerank: prScores[i],
    combined: alpha * normSem[i] + beta * normPpr[i] + gamma * normPr[i],
  }));
}

/**
 * 按组合评分排序，取 top K
 * @param scored 已排序的评分结果
 * @param kTop top K 上限
 */
export function topK<T>(scored: Scored<T>[], kTop: number): Scored<T>[] {
  return scored
    .filter(s => s.combined > 0 || s.semantic > 0 || s.ppr > 0)
    .sort((a, b) => b.combined - a.combined)
    .slice(0, kTop);
}
