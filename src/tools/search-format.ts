import type { DatabaseSyncInstance } from "../store/db.ts";

export interface FormattedSearchResult {
  displayNodes: any[];
  lines: string[];
  text: string;
  filteredEdges: any[];
  count: number;
  tieredInfo: any[];
}

function normalizeDisplayScores(values: Array<number | null | undefined>): Array<number | null> {
  const numeric = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (numeric.length === 0) return values.map(() => null);
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  return values.map((v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    if (max === min) return 1;
    return (v - min) / (max - min);
  });
}

export function formatGmSearchResult(
  res: { nodes: any[]; edges: any[] },
  options: { db?: DatabaseSyncInstance } = {},
): FormattedSearchResult {
  const displayNodes = res.nodes.filter((n: any) => n.tier !== "filtered");
  const nodeMap = new Map(displayNodes.map((n: any) => [n.id, n]));

  // Semantic scores remain raw; PPR/PR absolute values are normalized for display.
  const normalizedPprScores = normalizeDisplayScores(displayNodes.map((n: any) => n.pprScore));
  const normalizedPagerankScores = normalizeDisplayScores(displayNodes.map((n: any) => n.pagerankScore));

  const lines = displayNodes.map((n: any, i: number) => {
    const tierLabel = n.tier === "hot" ? "【🔥HOT】" : n.tier === "L1" ? "【L1-完整】" : n.tier === "L2" ? "【L2-描述】" : "【L3-名称】";
    const hotFlag = n.flags?.includes("hot") ? " 🔥" : "";
    const scores: string[] = [];
    if (n.semanticScore != null) scores.push(`语义=${n.semanticScore.toFixed(3)}`);
    const displayPpr = normalizedPprScores[i];
    const displayPagerank = normalizedPagerankScores[i];
    if (displayPpr != null) scores.push(`PPR=${displayPpr.toFixed(3)}`);
    if (displayPagerank != null) scores.push(`PR=${displayPagerank.toFixed(3)}`);
    if (n.combinedScore != null) scores.push(`综合=${n.combinedScore.toFixed(3)}`);
    if (n.belief != null) scores.push(`置信度=${n.belief.toFixed(3)}`);
    const scoreStr = scores.length ? ` (${scores.join(", ")})` : "";
    let contentPart = "";
    if (n.tier === "L1") {
      contentPart = `\n${n.description || ""}\n${(n.content || "").slice(0, 300)}`;
    } else if (n.tier === "L2") {
      contentPart = n.description ? `\n描述: ${n.description}` : "";
    }
    return `${tierLabel} [${n.type}] ${n.name}${hotFlag}${scoreStr}${contentPart}`;
  });

  const filteredEdges = res.edges.filter(
    (e: any) => nodeMap.has(e.fromId) && nodeMap.has(e.toId),
  );
  const edgeLines = filteredEdges.map((e: any) => {
    const from = nodeMap.get(e.fromId)?.name ?? e.fromId;
    const to = nodeMap.get(e.toId)?.name ?? e.toId;
    return `  ${from} --[${e.name}]--> ${to}: ${e.description}`;
  });

  const text = [
    `找到 ${displayNodes.length} 个节点：\n`,
    ...lines,
    ...(edgeLines.length ? ["\n关系：", ...edgeLines] : []),
  ].join("\n\n");

  const tieredInfo = displayNodes.map((n: any, i: number) => {
    let belief: number | null = null;
    let successCount: number | null = null;
    let failureCount: number | null = null;
    if (options.db) {
      try {
        const bRow = options.db.prepare("SELECT belief, success_count, failure_count FROM gm_nodes WHERE id=?").get(n.id) as any;
        if (bRow) {
          belief = bRow.belief ?? null;
          successCount = bRow.success_count ?? null;
          failureCount = bRow.failure_count ?? null;
        }
      } catch { /* belief columns may not be available in legacy DBs */ }
    }

    return {
      id: n.id,
      type: n.type,
      name: n.name,
      description: n.description,
      content: n.content,
      status: n.status,
      flags: n.flags ?? [],
      validatedCount: n.validatedCount,
      pagerank: n.pagerank,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      tier: n.tier,
      semanticScore: n.semanticScore ?? null,
      pprScore: n.pprScore ?? null,
      pagerankScore: n.pagerankScore ?? null,
      displayPprScore: normalizedPprScores[i],
      displayPagerankScore: normalizedPagerankScores[i],
      combinedScore: n.combinedScore ?? null,
      belief,
      successCount,
      failureCount,
    };
  });

  return { displayNodes, lines, text, filteredEdges, count: displayNodes.length, tieredInfo };
}
