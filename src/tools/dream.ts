export interface DreamSeed {
  id: string;
  name: string;
  type: string;
  description?: string;
  content?: string;
  lastAccessedAt?: number;
  accessCount?: number;
  combinedScore?: number;
}

export interface DreamSubgraph {
  seed: string;
  nodes: any[];
  edges: any[];
}

export function exponentialDecayPick<T extends Record<string, unknown>>(
  candidates: T[],
  timeField: keyof T,
  lambda = 0.33,
): T | null {
  if (!candidates.length) return null;
  const now = Date.now();
  const msPerDay = 86_400_000;
  const withWeights = candidates.map(c => {
    const t = Number(c[timeField]) ?? 0;
    const days = Math.max(0, (now - t) / msPerDay);
    return { item: c, weight: Math.exp(-lambda * days) };
  });
  const totalWeight = withWeights.reduce((s, w) => s + w.weight, 0);
  if (totalWeight <= 0) return candidates[0];
  let r = Math.random() * totalWeight;
  for (const { item, weight } of withWeights) {
    r -= weight;
    if (r <= 0) return item;
  }
  return withWeights[withWeights.length - 1].item;
}

export function buildSubgraphResult(
  roots: any[],
  nodes: any[],
  edges: any[],
): { seeds: DreamSeed[]; subgraphs: DreamSubgraph[] } {
  const tieredNodes = nodes.filter((n: any) => n.tier === "L1");
  const nodeIds = new Set(tieredNodes.map((n: any) => n.id));
  const filteredEdges = edges.filter(
    (e: any) => nodeIds.has(e.fromId) && nodeIds.has(e.toId),
  );

  const allNodes = tieredNodes;
  const allNodeIds = new Set(allNodes.map((n: any) => n.id));
  const subgraphEdges = filteredEdges.filter(
    (e: any) => allNodeIds.has(e.fromId) && allNodeIds.has(e.toId),
  );

  const subgraphs = roots.map((root: any) => ({ seed: root.name, nodes: allNodes, edges: subgraphEdges }));

  return {
    seeds: roots.map((r: any) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      description: r.description ?? "",
      content: r.content ?? "",
      lastAccessedAt: r.lastAccessedAt ?? 0,
      accessCount: r.accessCount ?? 0,
      combinedScore: r.combinedScore ?? 1.0,
    })),
    subgraphs,
  };
}

export function formatSubgraphForLLM(seeds: any[], subgraphs: DreamSubgraph[]): string {
  const lines: string[] = [];

  for (const sg of subgraphs) {
    lines.push(`== 关联记忆 ==`);

    const seed = seeds.find((s: any) => s.name === sg.seed);
    const lastAccessed = seed?.lastAccessedAt
      ? new Date(seed.lastAccessedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
      : "从未";
    lines.push(`【种子】${seed?.name || sg.seed}`);
    lines.push(`  类型: ${seed?.type || "?"} | 置信度: ${(seed?.belief ?? 0.5).toFixed(3)} | 访问: ${lastAccessed}`);
    if (seed?.description) lines.push(`  简介: ${seed.description}`);
    lines.push(`  内容: ${seed?.content || "(无)"}`);
    lines.push("");

    const relatedNodes = sg.nodes.filter((n: any) => n.id !== seed?.id && (n.tier === "L1" || n.tier === "active"));
    for (const n of relatedNodes) {
      const nodeLastAccessed = n.lastAccessedAt
        ? new Date(n.lastAccessedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
        : "从未";
      lines.push(`【关联】${n.name}`);
      lines.push(`  类型: ${n.type} | 置信度: ${(n.belief ?? 0.5).toFixed(3)} | 访问: ${nodeLastAccessed}`);
      if (n.description) lines.push(`  简介: ${n.description}`);
      lines.push(`  内容: ${n.content || "(无)"}`);
      lines.push("");
    }

    if (sg.edges.length > 0) {
      lines.push(`--- 关联 (${sg.edges.length} 条) ---`);
      for (const e of sg.edges) {
        const fromName = e.fromName || e.fromId;
        const toName = e.toName || e.toId;
        const desc = e.description ? ` — ${e.description}` : "";
        lines.push(`  ${fromName} --[${e.name}]--> ${toName}${desc}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
