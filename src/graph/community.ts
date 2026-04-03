/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * 社区检测 — Label Propagation Algorithm
 *
 * 原理：每个节点初始自成一个社区，迭代中每个节点采纳邻居中最频繁的社区标签。
 *       收敛后自然形成社区划分。
 *
 * 为什么选 Label Propagation 而不是 Louvain：
 *   - 实现简单（50 行核心逻辑）
 *   - 不需要外部库
 *   - 对小图（< 10000 节点）效果够好
 *   - O(iterations * edges)，几千节点 < 5ms
 *
 * 用途：
 *   - 发现知识域（Docker 相关技能自动聚成一组）
 *   - recall 时可以拉整个社区的节点
 *   - assemble 时同社区节点放一起，上下文更连贯
 *   - kg_stats 展示社区分布
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { updateCommunities } from "../store/store.ts";

export interface CommunityResult {
  labels: Map<string, string>;
  /** 社区 ID → 成员节点 ID 列表 */
  communities: Map<string, string[]>;
  count: number;
}

/**
 * 运行 Label Propagation 并写回 gm_nodes.community_id
 *
 * 把有向边当无向边处理（知识关联不分方向）
 */
export function detectCommunities(db: DatabaseSyncInstance, maxIter = 50): CommunityResult {
  // 读取活跃节点
  const nodeRows = db.prepare(
    "SELECT id FROM gm_nodes WHERE status='active'"
  ).all() as any[];

  if (nodeRows.length === 0) {
    return { labels: new Map(), communities: new Map(), count: 0 };
  }

  const nodeIds = nodeRows.map((r: any) => r.id);

  // 读取边，构建无向邻接表
  const edgeRows = db.prepare("SELECT from_id, to_id FROM gm_edges").all() as any[];
  const nodeSet = new Set(nodeIds);
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) adj.set(id, []);

  for (const e of edgeRows) {
    if (!nodeSet.has(e.from_id) || !nodeSet.has(e.to_id)) continue;
    adj.get(e.from_id)!.push(e.to_id);
    adj.get(e.to_id)!.push(e.from_id);
  }

  // 初始标签：每个节点 = 自己的 ID
  const label = new Map<string, string>();
  for (const id of nodeIds) label.set(id, id);

  // 迭代
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // 随机打乱遍历顺序（减少震荡）
    const shuffled = [...nodeIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (const nodeId of shuffled) {
      const neighbors = adj.get(nodeId) || [];
      if (neighbors.length === 0) continue;

      // 统计邻居标签频次
      const freq = new Map<string, number>();
      for (const nb of neighbors) {
        const l = label.get(nb)!;
        freq.set(l, (freq.get(l) || 0) + 1);
      }

      // 取频次最高的标签（相同频次取字典序最小，保证确定性）
      let bestLabel = label.get(nodeId)!;
      let bestCount = 0;
      for (const [l, c] of freq) {
        if (c > bestCount || (c === bestCount && l < bestLabel)) {
          bestLabel = l;
          bestCount = c;
        }
      }

      if (label.get(nodeId) !== bestLabel) {
        label.set(nodeId, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // 构建社区映射
  const communities = new Map<string, string[]>();
  for (const [nodeId, communityId] of label) {
    if (!communities.has(communityId)) communities.set(communityId, []);
    communities.get(communityId)!.push(nodeId);
  }

  // 给社区编号（用最大成员数排序，编号 c-1, c-2, ...）
  const sorted = Array.from(communities.entries())
    .sort((a, b) => b[1].length - a[1].length);

  const renameMap = new Map<string, string>();
  sorted.forEach(([oldId], i) => renameMap.set(oldId, `c-${i + 1}`));

  // 重命名标签
  const finalLabels = new Map<string, string>();
  for (const [nodeId, oldLabel] of label) {
    finalLabels.set(nodeId, renameMap.get(oldLabel) || oldLabel);
  }

  const finalCommunities = new Map<string, string[]>();
  for (const [oldId, members] of communities) {
    const newId = renameMap.get(oldId) || oldId;
    finalCommunities.set(newId, members);
  }

  // 写回数据库
  updateCommunities(db, finalLabels);

  return {
    labels: finalLabels,
    communities: finalCommunities,
    count: finalCommunities.size,
  };
}

/**
 * 获取同社区的节点 ID 列表
 * recall 时用：找到种子节点 → 拉同社区的其他节点作为补充
 */
export function getCommunityPeers(db: DatabaseSyncInstance, nodeId: string, limit = 5): string[] {
  const row = db.prepare(
    "SELECT community_id FROM gm_nodes WHERE id=? AND status='active'"
  ).get(nodeId) as any;

  if (!row?.community_id) return [];

  return (db.prepare(`
    SELECT id FROM gm_nodes
    WHERE community_id=? AND id!=? AND status='active'
    ORDER BY validated_count DESC, updated_at DESC
    LIMIT ?
  `).all(row.community_id, nodeId, limit) as any[]).map(r => r.id);
}

// ─── 社区描述生成 ────────────────────────────────────────────

import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { upsertCommunitySummary, pruneCommunitySummaries } from "../store/store.ts";

const COMMUNITY_SUMMARY_SYS = `你是知识图谱摘要引擎。根据节点列表，用简短的描述概括这组节点的主题领域。
要求：
- 只返回短语本身，不要解释
- 描述涵盖的工具/技术/任务领域
- 不要使用"社区"这个词`;

const BATCH_SUMMARY_SYS = `你是知识图谱摘要引擎。根据多组节点列表，为每个社区生成简短的描述概括其主题领域。

## 输入格式
输入包含多个社区块，每个社区以 "### 社区ID" 开头，后跟该社区的所有节点。每个节点占一行，格式为：
  类型:节点名称 — 节点描述

例如：
  ### c-1
  SKILL:用户偏好记忆 — 记录用户的偏好设置和习惯
  TASK:生日提醒设置 — 设置提醒的自动化任务
  KNOWLEDGE:NixOS系统配置 — NixOS 相关配置经验

  ### c-2
  EVENT:Gateway重启 — 网关服务重启事件

## 输出要求
- 输出严格的 JSON 对象，键是社区 ID（如 c-1），值是该社区的简短摘要
- 每个摘要只返回短语本身，不要解释
- 描述涵盖的工具/技术/任务领域
- 不要使用"社区"这个词
- 必须为每个输入的社区都生成一个摘要`;

interface BatchCommunity {
  id: string;
  members: any[];
  memberIds: string[];
}

/**
 * 提取社区成员信息（带缓存）
 */
function getCommunityMembers(db: DatabaseSyncInstance, communityId: string, memberIds: string[]): any[] {
  if (memberIds.length === 0) return [];
  
  const placeholders = memberIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT name, type, description FROM gm_nodes
    WHERE id IN (${placeholders}) AND status='active'
    ORDER BY validated_count DESC
    LIMIT 10
  `).all(...memberIds) as any[];
}

/**
 * 清理 LLM 返回的摘要
 */
function cleanSummary(summary: string): string {
  return summary
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, "")  // 去掉思维链
    .replace(/<think>[\s\S]*/gi, "")              // 去掉未闭合的 <think>
    .replace(/^["'「」]|["'「」]$/g, "")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 100);
}

/**
 * 处理单个社区（降级用）
 */
async function processSingleCommunity(
  db: DatabaseSyncInstance,
  communityId: string,
  memberIds: string[],
  llm: CompleteFn,
  embedFn?: EmbedFn,
): Promise<boolean> {
  if (memberIds.length === 0) return false;
  
  const members = getCommunityMembers(db, communityId, memberIds);
  if (members.length === 0) return false;
  
  const memberText = members
    .map((m: any) => `${m.type}:${m.name} — ${m.description}`)
    .join("\n");
  
  try {
    const summary = await llm(
      COMMUNITY_SUMMARY_SYS,
      `社区成员：\n${memberText}`,
    );
    
    const cleaned = cleanSummary(summary);
    if (cleaned.length === 0) return false;
    
    // 生成 embedding
    let embedding: number[] | undefined;
    if (embedFn) {
      try {
        const embedText = `${cleaned}\n${members.map((m: any) => m.name).join(", ")}`;
        embedding = await embedFn(embedText);
      } catch {
        if (process.env.GM_DEBUG) {
          console.log(`  [DEBUG] community embedding failed for ${communityId}`);
        }
      }
    }
    
    upsertCommunitySummary(db, communityId, cleaned, memberIds.length, embedding);
    return true;
  } catch (err) {
    console.log(`  [WARN] community summary failed for ${communityId}: ${err}`);
    return false;
  }
}

/**
 * 批量处理多个社区（一次 LLM 调用）
 */
async function processBatch(
  db: DatabaseSyncInstance,
  batch: BatchCommunity[],
  llm: CompleteFn,
  embedFn?: EmbedFn,
): Promise<number> {
  if (batch.length === 0) return 0;
  
  // 构建批量输入
  const batchInput = batch.map(c => {
    const memberText = c.members
      .map((m: any) => `${m.type}:${m.name} — ${m.description}`)
      .join("\n");
    return `### ${c.id}\n${memberText}`;
  }).join("\n\n");
  
  try {
    const response = await llm(BATCH_SUMMARY_SYS, batchInput);
    
    // 尝试解析 JSON
    let summaries: Record<string, string>;
    try {
      summaries = JSON.parse(response);
    } catch {
      // JSON 解析失败，降级为单个处理
      if (process.env.GM_DEBUG) {
        console.log(`  [DEBUG] batch JSON parse failed, falling back to single processing`);
      }
      let success = 0;
      for (const c of batch) {
        if (await processSingleCommunity(db, c.id, c.memberIds, llm, embedFn)) {
          success++;
        }
      }
      return success;
    }
    
    // 处理每个社区的摘要
    let success = 0;
    for (const c of batch) {
      const rawSummary = summaries[c.id];
      if (!rawSummary) continue;
      
      const cleaned = cleanSummary(rawSummary);
      if (cleaned.length === 0) continue;
      
      // 生成 embedding
      let embedding: number[] | undefined;
      if (embedFn) {
        try {
          const embedText = `${cleaned}\n${c.members.map((m: any) => m.name).join(", ")}`;
          embedding = await embedFn(embedText);
        } catch {
          if (process.env.GM_DEBUG) {
            console.log(`  [DEBUG] community embedding failed for ${c.id}`);
          }
        }
      }
      
      upsertCommunitySummary(db, c.id, cleaned, c.memberIds.length, embedding);
      success++;
    }
    
    return success;
  } catch (err) {
    console.log(`  [WARN] batch processing failed: ${err}`);
    // 降级为单个处理
    let success = 0;
    for (const c of batch) {
      if (await processSingleCommunity(db, c.id, c.memberIds, llm, embedFn)) {
        success++;
      }
    }
    return success;
  }
}

/**
 * 为所有社区生成 LLM 摘要描述 + embedding 向量
 * 
 * 批量策略：
 * - maxNodesPerBatch: 每批最多节点数（默认 50，最多 100）
 * - 按节点数分批，而非按社区数
 * - 智能跳过：加入社区后超限，则跳过该社区，开始批量执行
 * - 超大社区（>maxNodesPerBatch）：单独处理
 *
 * 调用时机：runMaintenance → detectCommunities 之后
 */
export async function summarizeCommunities(
  db: DatabaseSyncInstance,
  communities: Map<string, string[]>,
  llm: CompleteFn,
  embedFn?: EmbedFn,
  maxNodesPerBatch = 50,
): Promise<number> {
  // [DISABLED] 社区太稀疏，社区数过多，summarize 会导致 LLM 调用爆炸，暂返 0
  return 0;
  // 限制最大批次大小
  maxNodesPerBatch = Math.min(maxNodesPerBatch, 100);
  
  pruneCommunitySummaries(db);
  
  // 预处理：获取所有社区的成员信息
  const communityData: BatchCommunity[] = [];
  for (const [communityId, memberIds] of communities) {
    if (memberIds.length === 0) continue;
    const members = getCommunityMembers(db, communityId, memberIds);
    if (members.length === 0) continue;
    communityData.push({ id: communityId, members, memberIds });
  }
  
  // 分批处理
  const batches: BatchCommunity[][] = [];
  let currentBatch: BatchCommunity[] = [];
  let currentNodeCount = 0;
  
  for (const c of communityData) {
    const nodeCount = c.memberIds.length; // 用 memberIds.length 而非 members.length（LIMIT 会截断 members）
    
    // 超大社区（>maxNodesPerBatch）：单独成批
    if (nodeCount > maxNodesPerBatch) {
      // 先处理当前批次
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentNodeCount = 0;
      }
      // 这个超大社区单独成批
      batches.push([c]);
      continue;
    }
    
    // 加入后超限：开始当前批次，跳过这个社区
    if (currentNodeCount + nodeCount > maxNodesPerBatch) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = [c];
      currentNodeCount = nodeCount;
      continue;
    }
    
    // 正常加入批次
    currentBatch.push(c);
    currentNodeCount += nodeCount;
  }
  
  // 处理最后的批次
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  if (process.env.GM_DEBUG) {
    console.log(`  [DEBUG] community summarization: ${communityData.length} communities → ${batches.length} batches`);
  }
  
  // 执行批量处理
  let generated = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchNodeCount = batch.reduce((sum, c) => sum + c.memberIds.length, 0);
    
    if (process.env.GM_DEBUG) {
      console.log(`  [DEBUG] batch ${i + 1}: ${batch.length} communities, ${batchNodeCount} nodes`);
    }
    
    const success = await processBatch(db, batch, llm, embedFn);
    generated += success;
  }
  
  return generated;
}