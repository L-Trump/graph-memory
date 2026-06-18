import type { Recaller, TieredNode } from "./recall.ts";

export interface ParallelRecallOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface ParallelRecallResult {
  nodes: TieredNode[];
  edges: any[];
  pprScores: Record<string, number>;
}

export function tierPriority(tier: string): number {
  const priority: Record<string, number> = {
    scope_hot: 6,
    hot: 5,
    active: 4,
    L1: 3,
    L2: 2,
    L3: 1,
    filtered: 0,
  };
  return priority[tier] ?? 0;
}

/**
 * Recall with both multi-turn history context and the current prompt, then
 * merge duplicate nodes/edges while preserving the strongest tier and PPR score.
 */
export async function parallelRecall(
  recaller: Pick<Recaller, "recallV2">,
  historyQuery: string,
  promptQuery: string,
  options?: ParallelRecallOptions,
): Promise<ParallelRecallResult> {
  const [historyRes, promptRes] = await Promise.all([
    recaller.recallV2(historyQuery, options),
    recaller.recallV2(promptQuery, options),
  ]);

  const nodesMap = new Map<string, TieredNode>();
  for (const n of [...historyRes.nodes, ...promptRes.nodes]) {
    const existing = nodesMap.get(n.name);
    if (!existing || tierPriority(n.tier) > tierPriority(existing.tier)) {
      nodesMap.set(n.name, n);
    }
  }

  const edgesSet = new Set<string>();
  const mergedEdges: any[] = [];
  for (const e of [...historyRes.edges, ...promptRes.edges]) {
    const key = `${e.fromId}-${e.toId}-${e.name}`;
    if (!edgesSet.has(key)) {
      edgesSet.add(key);
      mergedEdges.push(e);
    }
  }

  const pprScores: Record<string, number> = { ...historyRes.pprScores };
  for (const [k, v] of Object.entries(promptRes.pprScores ?? {})) {
    if (!pprScores[k] || v > pprScores[k]) pprScores[k] = v;
  }

  return { nodes: Array.from(nodesMap.values()), edges: mergedEdges, pprScores };
}
