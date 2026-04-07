/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash } from "crypto";
import type { GmNode, GmEdge, EdgeType, NodeType, Signal } from "../types.ts";

// ─── 工具 ─────────────────────────────────────────────────────

function uid(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function toNode(r: any): GmNode {
  return {
    id: r.id, type: r.type, name: r.name,
    description: r.description ?? "", content: r.content,
    status: r.status, validatedCount: r.validated_count,
    sourceSessions: JSON.parse(r.source_sessions ?? "[]"),
    communityId: r.community_id ?? null,
    pagerank: r.pagerank ?? 0,
    flags: JSON.parse(r.flags ?? "[]"),
    createdAt: r.created_at, updatedAt: r.updated_at,
    // Belief fields (may be undefined in pre-belief dbs)
    belief: r.belief ?? 0.5,
    successCount: r.success_count ?? 0,
    failureCount: r.failure_count ?? 0,
    lastSignalAt: r.last_signal_at ?? 0,
  };
}

function toEdge(r: any): GmEdge {
  return {
    id: r.id,
    fromId: r.from_id,
    toId: r.to_id,
    // 新字段优先，instruction 仅为向后兼容旧数据
    name: r.name ?? r.type ?? "",
    description: r.description ?? r.instruction ?? "",
    sessionId: r.session_id,
    createdAt: r.created_at,
  };
}

/** 标准化 name：全小写，空格转连字符，保留中文 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── 节点 CRUD ───────────────────────────────────────────────

export function findByName(db: DatabaseSyncInstance, name: string): GmNode | null {
  const r = db.prepare("SELECT * FROM gm_nodes WHERE name = ?").get(normalizeName(name)) as any;
  return r ? toNode(r) : null;
}

export function findById(db: DatabaseSyncInstance, id: string): GmNode | null {
  const r = db.prepare("SELECT * FROM gm_nodes WHERE id = ?").get(id) as any;
  return r ? toNode(r) : null;
}

export function allActiveNodes(db: DatabaseSyncInstance): GmNode[] {
  return (db.prepare("SELECT * FROM gm_nodes WHERE status='active'").all() as any[]).map(toNode);
}

/** 获取所有 hot 节点（非 deprecated 且 flags 包含 'hot'） */
export function getHotNodes(db: DatabaseSyncInstance): GmNode[] {
  return (db.prepare(
    "SELECT * FROM gm_nodes WHERE status='active' AND flags LIKE '%\"hot\"%'"
  ).all() as any[]).map(toNode);
}

/** 获取指定节点 IDs 的所有边 */
export function getEdgesForNodes(db: DatabaseSyncInstance, ids: string[]): GmEdge[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return (db.prepare(
    `SELECT * FROM gm_edges WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})`
  ).all(...ids, ...ids) as any[]).map(toEdge);
}

export function allEdges(db: DatabaseSyncInstance): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges").all() as any[]).map(toEdge);
}

export function upsertNode(
  db: DatabaseSyncInstance,
  c: { type: NodeType; name: string; description: string; content: string; flags?: string[] },
  sessionId: string,
): { node: GmNode; isNew: boolean } {
  const name = normalizeName(c.name);
  const ex = findByName(db, name);

  if (ex) {
    const sessions = JSON.stringify(Array.from(new Set([...ex.sourceSessions, sessionId])));
    // 新内容优先：LLM 在合并/纠正场景下写的是完整合并内容，应直接覆盖旧内容
    const content = c.content;
    const desc = c.description;
    const count = ex.validatedCount + 1;
    // flags 合并：已有 flags 保留，与新传入的 flags 做 union
    const mergedFlags = JSON.stringify(
      Array.from(new Set([...ex.flags, ...(c.flags ?? [])]))
    );
    // deprecated 节点被重新引用时自动复活
    const status = ex.status === 'deprecated' ? 'active' : ex.status;
    db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
      source_sessions=?, flags=?, status=?, updated_at=? WHERE id=?`)
      .run(content, desc, count, sessions, mergedFlags, status, Date.now(), ex.id);
    return { node: { ...ex, content, description: desc, validatedCount: count, status, flags: JSON.parse(mergedFlags) }, isNew: false };
  }

  const id = uid("n");
  const flags = JSON.stringify(c.flags ?? []);
  db.prepare(`INSERT INTO gm_nodes
    (id, type, name, description, content, status, validated_count, source_sessions, flags, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, c.type, name, c.description, c.content, 'active', 1, JSON.stringify([sessionId]), flags, Date.now(), Date.now());
  return { node: findByName(db, name)!, isNew: true };
}

export function deprecate(db: DatabaseSyncInstance, nodeId: string): void {
  db.prepare("UPDATE gm_nodes SET status='deprecated', updated_at=? WHERE id=?")
    .run(Date.now(), nodeId);
}

/** 设置节点的 flags（覆盖而非追加） */
export function setNodeFlags(db: DatabaseSyncInstance, nodeId: string, flags: string[]): boolean {
  const node = findById(db, nodeId);
  if (!node) return false;
  // deprecated 节点设 flags 时自动复活
  const status = node.status === 'deprecated' ? 'active' : node.status;
  db.prepare("UPDATE gm_nodes SET flags=?, status=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(flags), status, Date.now(), nodeId);
  return true;
}

/** 合并两个节点：keepId 保留，mergeId 标记 deprecated，边迁移 */
export function mergeNodes(db: DatabaseSyncInstance, keepId: string, mergeId: string): void {
  const keep = findById(db, keepId);
  const merge = findById(db, mergeId);
  if (!keep || !merge) return;

  // 合并 validatedCount + sourceSessions + flags
  const sessions = JSON.stringify(
    Array.from(new Set([...keep.sourceSessions, ...merge.sourceSessions]))
  );
  const flags = JSON.stringify(
    Array.from(new Set([...keep.flags, ...merge.flags]))
  );
  const count = keep.validatedCount + merge.validatedCount;
  const content = keep.content.length >= merge.content.length ? keep.content : merge.content;
  const desc = keep.description.length >= merge.description.length ? keep.description : merge.description;

  // 合并 belief 信号
  const keepBelief = getBeliefInfo(db, keepId);
  const mergeBelief = getBeliefInfo(db, mergeId);
  const totalSuccess = (keepBelief?.successCount ?? 0) + (mergeBelief?.successCount ?? 0);
  const totalFailure = (keepBelief?.failureCount ?? 0) + (mergeBelief?.failureCount ?? 0);
  const mergedBelief = totalSuccess + totalFailure > 0
    ? computeBeliefA(totalSuccess, totalFailure)
    : keep.belief ?? 0.5;

  db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
    source_sessions=?, flags=?, belief=?, success_count=?, failure_count=?, updated_at=? WHERE id=?`)
    .run(content, desc, count, sessions, flags, mergedBelief, totalSuccess, totalFailure, Date.now(), keepId);

  // 迁移边：mergeId 的边指向 keepId
  db.prepare("UPDATE gm_edges SET from_id=? WHERE from_id=?").run(keepId, mergeId);
  db.prepare("UPDATE gm_edges SET to_id=? WHERE to_id=?").run(keepId, mergeId);

  // 删除自环（合并后可能出现 keepId → keepId）
  db.prepare("DELETE FROM gm_edges WHERE from_id = to_id").run();

  // 删除重复边（同 from+to+name 只保留一条）
  db.prepare(`
    DELETE FROM gm_edges WHERE id NOT IN (
      SELECT MIN(id) FROM gm_edges GROUP BY from_id, to_id, name
    )
  `).run();

  deprecate(db, mergeId);
}

/** 批量更新 PageRank 分数 */
export function updatePageranks(db: DatabaseSyncInstance, scores: Map<string, number>): void {
  const stmt = db.prepare("UPDATE gm_nodes SET pagerank=? WHERE id=?");
  db.exec("BEGIN");
  try {
    for (const [id, score] of scores) {
      stmt.run(score, id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 批量更新社区 ID */
export function updateCommunities(db: DatabaseSyncInstance, labels: Map<string, string>): void {
  const stmt = db.prepare("UPDATE gm_nodes SET community_id=? WHERE id=?");
  db.exec("BEGIN");
  try {
    for (const [id, cid] of labels) {
      stmt.run(cid, id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ─── 边 CRUD ─────────────────────────────────────────────────

export function upsertEdge(
  db: DatabaseSyncInstance,
  e: { fromId: string; toId: string; name: string; description: string; sessionId: string },
): void {
  // 跳过连接到 deprecated 节点的边
  const fromNode = db.prepare("SELECT status FROM gm_nodes WHERE id=?").get(e.fromId) as any;
  const toNode = db.prepare("SELECT status FROM gm_nodes WHERE id=?").get(e.toId) as any;
  if (!fromNode || !toNode || fromNode.status === "deprecated" || toNode.status === "deprecated") return;

  // 灵活边：同 from+to+name 即视为重复（不用 type 列）
  const ex = db.prepare("SELECT id FROM gm_edges WHERE from_id=? AND to_id=? AND name=?")
    .get(e.fromId, e.toId, e.name) as any;
  if (ex) {
    db.prepare("UPDATE gm_edges SET description=? WHERE id=?")
      .run(e.description, ex.id);
    return;
  }
  db.prepare(`INSERT INTO gm_edges (id, from_id, to_id, name, description, session_id, created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(uid("e"), e.fromId, e.toId, e.name, e.description, e.sessionId, Date.now());
}

export function edgesFrom(db: DatabaseSyncInstance, id: string): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges WHERE from_id=?").all(id) as any[]).map(toEdge);
}

export function edgesTo(db: DatabaseSyncInstance, id: string): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges WHERE to_id=?").all(id) as any[]).map(toEdge);
}

// ─── FTS5 搜索 ───────────────────────────────────────────────

let _fts5Available: boolean | null = null;

function fts5Available(db: DatabaseSyncInstance): boolean {
  if (_fts5Available !== null) return _fts5Available;
  try {
    db.prepare("SELECT * FROM gm_nodes_fts LIMIT 0").all();
    _fts5Available = true;
  } catch {
    _fts5Available = false;
  }
  return _fts5Available;
}

export function searchNodes(db: DatabaseSyncInstance, query: string, limit = 6): GmNode[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return topNodes(db, limit);

  if (fts5Available(db)) {
    try {
      const ftsQuery = terms.map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");
      const rows = db.prepare(`
        SELECT n.*, rank FROM gm_nodes_fts fts
        JOIN gm_nodes n ON n.rowid = fts.rowid
        WHERE gm_nodes_fts MATCH ? AND n.status = 'active'
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, limit) as any[];
      if (rows.length > 0) return rows.map(toNode);
    } catch { /* FTS 查询失败，降级 */ }
  }

  const where = terms.map(() => "(name LIKE ? OR description LIKE ? OR content LIKE ?)").join(" OR ");
  const likes = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);
  return (db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active' AND (${where})
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(...likes, limit) as any[]).map(toNode);
}

/** 热门节点：综合 pagerank + validatedCount 排序 */
export function topNodes(db: DatabaseSyncInstance, limit = 6): GmNode[] {
  return (db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active'
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(limit) as any[]).map(toNode);
}

// ─── 递归 CTE 图遍历 ────────────────────────────────────────

export function graphWalk(
  db: DatabaseSyncInstance,
  seedIds: string[],
  maxDepth: number,
): { nodes: GmNode[]; edges: GmEdge[] } {
  if (!seedIds.length) return { nodes: [], edges: [] };

  const placeholders = seedIds.map(() => "?").join(",");

  const walkRows = db.prepare(`
    WITH RECURSIVE walk(node_id, depth) AS (
      SELECT id, 0 FROM gm_nodes WHERE id IN (${placeholders}) AND status='active'
      UNION
      SELECT
        CASE WHEN e.from_id = w.node_id THEN e.to_id ELSE e.from_id END,
        w.depth + 1
      FROM walk w
      JOIN gm_edges e ON (e.from_id = w.node_id OR e.to_id = w.node_id)
      WHERE w.depth < ?
    )
    SELECT DISTINCT node_id FROM walk
  `).all(...seedIds, maxDepth) as any[];

  const nodeIds = walkRows.map((r: any) => r.node_id);
  if (!nodeIds.length) return { nodes: [], edges: [] };

  const np = nodeIds.map(() => "?").join(",");
  const nodes = (db.prepare(`
    SELECT * FROM gm_nodes WHERE id IN (${np}) AND status='active'
  `).all(...nodeIds) as any[]).map(toNode);

  const edges = (db.prepare(`
    SELECT * FROM gm_edges WHERE from_id IN (${np}) AND to_id IN (${np})
  `).all(...nodeIds, ...nodeIds) as any[]).map(toEdge);

  return { nodes, edges };
}

// ─── 按 session 查询 ────────────────────────────────────────

export function getBySession(db: DatabaseSyncInstance, sessionId: string): GmNode[] {
  return (db.prepare(`
    SELECT DISTINCT n.* FROM gm_nodes n, json_each(n.source_sessions) j
    WHERE j.value = ? AND n.status = 'active'
  `).all(sessionId) as any[]).map(toNode);
}

// ─── 消息 CRUD ───────────────────────────────────────────────

export function saveMessage(
  db: DatabaseSyncInstance, sid: string, turn: number, role: string, content: unknown
): void {
  db.prepare(`INSERT OR IGNORE INTO gm_messages (id, session_id, turn_index, role, content, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid("m"), sid, turn, role, JSON.stringify(content), Date.now());
}

export function getMessages(db: DatabaseSyncInstance, sid: string, limit?: number): any[] {
  if (limit) {
    return db.prepare("SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index DESC LIMIT ?")
      .all(sid, limit) as any[];
  }
  return db.prepare("SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index")
    .all(sid) as any[];
}

export function getUnextracted(db: DatabaseSyncInstance, sid: string, limit: number): any[] {
  return db.prepare("SELECT * FROM gm_messages WHERE session_id=? AND extracted=0 ORDER BY turn_index LIMIT ?")
    .all(sid, limit) as any[];
}

/**
 * 获取最近 N 轮已提取消息（以 user 消息为边界）。
 * 从最近一条已提取消息向前追溯，收集最多 recentTurns 轮的消息。
 * 返回的消息按 turn_index 升序排列。
 */
export function getRecentExtractedMessages(
  db: DatabaseSyncInstance,
  sid: string,
  recentTurns: number,
): any[] {
  if (recentTurns <= 0) return [];

  // 找到最近一条已提取消息的 turn_index
  const lastExtracted = db
    .prepare("SELECT MAX(turn_index) as maxTurn FROM gm_messages WHERE session_id=? AND extracted=1")
    .get(sid) as any;
  if (!lastExtracted?.maxTurn) return [];

  // 向前取足够的已提取消息（每轮假设最多 20 条，recentTurns * 20 是安全上限）
  const rows = db
    .prepare(
      "SELECT * FROM gm_messages WHERE session_id=? AND extracted=1 AND turn_index<=? ORDER BY turn_index DESC LIMIT ?",
    )
    .all(sid, lastExtracted.maxTurn, recentTurns * 20) as any[];

  if (!rows.length) return [];

  // 按 user 边界分组，取最近 recentTurns 轮
  const turns: any[][] = [];
  let currentTurn: any[] = [];

  // 倒序遍历（从老到新），逐条收集
  for (let i = rows.length - 1; i >= 0; i--) {
    const msg = rows[i];
    currentTurn.push(msg);
    if (msg.role === "user") {
      turns.push(currentTurn.reverse()); // 这一轮收集完了，反转使其按时间升序
      currentTurn = [];
      if (turns.length >= recentTurns) break;
    }
  }
  // 如果还有剩余未成一轮的，加入最后一轮
  if (currentTurn.length > 0 && turns.length < recentTurns) {
    turns.push(currentTurn.reverse());
  }

  // 合并所有轮次的消息（升序）
  const result: any[] = [];
  for (const turn of turns) {
    result.push(...turn);
  }
  return result;
}

export function markExtracted(db: DatabaseSyncInstance, sid: string, upToTurn: number): void {
  db.prepare("UPDATE gm_messages SET extracted=1 WHERE session_id=? AND turn_index<=?")
    .run(sid, upToTurn);
}

/**
 * 溯源选拉：按 session 拉取 user/assistant 核心对话（跳过 tool/toolResult）
 * 用于 assemble 时补充三元组的原始上下文
 *
 * @param nearTime  优先取时间最接近的消息（节点的 updatedAt）
 * @param maxChars  总字符上限
 */
export function getEpisodicMessages(
  db: DatabaseSyncInstance,
  sessionIds: string[],
  nearTime: number,
  maxChars: number = 1500,
): Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> {
  if (!sessionIds.length) return [];

  const results: Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> = [];
  let usedChars = 0;

  // 按 session 逐个拉，优先最近的 session
  for (const sid of sessionIds) {
    if (usedChars >= maxChars) break;

    // 只拉 user 和 assistant，按时间距离 nearTime 最近排序
    const rows = db.prepare(`
      SELECT turn_index, role, content, created_at FROM gm_messages
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY ABS(created_at - ?) ASC
      LIMIT 6
    `).all(sid, nearTime) as any[];

    for (const r of rows) {
      if (usedChars >= maxChars) break;
      let text = "";
      try {
        const parsed = JSON.parse(r.content);
        if (typeof parsed === "string") {
          text = parsed;
        } else if (typeof parsed?.content === "string") {
          text = parsed.content;
        } else if (Array.isArray(parsed)) {
          text = parsed
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text ?? "")
            .join("\n");
        } else {
          text = String(parsed).slice(0, 300);
        }
      } catch {
        text = String(r.content).slice(0, 300);
      }

      if (!text.trim()) continue;
      const truncated = text.slice(0, Math.min(text.length, maxChars - usedChars));
      results.push({
        sessionId: sid,
        turnIndex: r.turn_index,
        role: r.role,
        text: truncated,
        createdAt: r.created_at,
      });
      usedChars += truncated.length;
    }
  }

  return results;
}

// ─── 信号 CRUD ───────────────────────────────────────────────

export function saveSignal(db: DatabaseSyncInstance, sid: string, s: Signal): void {
  db.prepare(`INSERT INTO gm_signals (id, session_id, turn_index, type, data, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid("s"), sid, s.turnIndex, s.type, JSON.stringify(s.data), Date.now());
}

export function pendingSignals(db: DatabaseSyncInstance, sid: string): Signal[] {
  return (db.prepare("SELECT * FROM gm_signals WHERE session_id=? AND processed=0 ORDER BY turn_index")
    .all(sid) as any[])
    .map(r => ({ type: r.type, turnIndex: r.turn_index, data: JSON.parse(r.data) }));
}

export function markSignalsDone(db: DatabaseSyncInstance, sid: string): void {
  db.prepare("UPDATE gm_signals SET processed=1 WHERE session_id=?").run(sid);
}

// ─── 统计 ────────────────────────────────────────────────────

export function getStats(db: DatabaseSyncInstance): {
  totalNodes: number;
  byType: Record<string, number>;
  totalEdges: number;
  byEdgeType: Record<string, number>;
  communities: number;
  hotNodes: number;
} {
  const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM gm_nodes WHERE status='active'").get() as any).c;
  const byType: Record<string, number> = {};
  for (const r of db.prepare("SELECT type, COUNT(*) as c FROM gm_nodes WHERE status='active' GROUP BY type").all() as any[]) {
    byType[r.type] = r.c;
  }
  const totalEdges = (db.prepare("SELECT COUNT(*) as c FROM gm_edges").get() as any).c;
  const byEdgeType: Record<string, number> = {};
  // 兼容旧列名：新表用 name（旧数据仍在 type 列）
  try {
    for (const r of db.prepare("SELECT name, COUNT(*) as c FROM gm_edges GROUP BY name").all() as any[]) {
      byEdgeType[r.name] = r.c;
    }
  } catch {
    for (const r of db.prepare("SELECT type, COUNT(*) as c FROM gm_edges GROUP BY type").all() as any[]) {
      byEdgeType[r.type] = r.c;
    }
  }
  const communities = (db.prepare(
    "SELECT COUNT(DISTINCT community_id) as c FROM gm_nodes WHERE status='active' AND community_id IS NOT NULL"
  ).get() as any).c;
  const hotNodes = (db.prepare(
    "SELECT COUNT(*) as c FROM gm_nodes WHERE status='active' AND flags LIKE '%\"hot\"%'"
  ).get() as any).c;
  return { totalNodes, byType, totalEdges, byEdgeType, communities, hotNodes };
}

// ─── 向量存储 + 搜索 ────────────────────────────────────────

export function saveVector(db: DatabaseSyncInstance, nodeId: string, content: string, vec: number[]): void {
  const hash = createHash("md5").update(content).digest("hex");
  const f32 = new Float32Array(vec);
  const blob = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  db.prepare(`INSERT INTO gm_vectors (node_id, content_hash, embedding) VALUES (?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET content_hash=excluded.content_hash, embedding=excluded.embedding`)
    .run(nodeId, hash, blob);
}

export function getVectorHash(db: DatabaseSyncInstance, nodeId: string): string | null {
  return (db.prepare("SELECT content_hash FROM gm_vectors WHERE node_id=?").get(nodeId) as any)?.content_hash ?? null;
}

/** 获取所有向量（供去重/聚类用） */
export function getAllVectors(db: DatabaseSyncInstance): Array<{ nodeId: string; embedding: Float32Array }> {
  const rows = db.prepare(`
    SELECT v.node_id, v.embedding FROM gm_vectors v
    JOIN gm_nodes n ON n.id = v.node_id WHERE n.status = 'active'
  `).all() as any[];
  return rows.map(r => {
    const raw = r.embedding as Uint8Array;
    return {
      nodeId: r.node_id,
      embedding: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
    };
  });
}

export type ScoredNode = { node: GmNode; score: number };

export function vectorSearchWithScore(db: DatabaseSyncInstance, queryVec: number[], limit: number, minScore = 0.35): ScoredNode[] {
  const rows = db.prepare(`
    SELECT v.node_id, v.embedding, n.*
    FROM gm_vectors v JOIN gm_nodes n ON n.id = v.node_id
    WHERE n.status = 'active'
  `).all() as any[];

  if (!rows.length) return [];

  const q = new Float32Array(queryVec);
  const qNorm = Math.sqrt(q.reduce((s, x) => s + x * x, 0));
  if (qNorm === 0) return [];

  return rows
    .map(row => {
      const raw = row.embedding as Uint8Array;
      const v = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      let dot = 0, vNorm = 0;
      const len = Math.min(v.length, q.length);
      for (let i = 0; i < len; i++) {
        dot += v[i] * q[i];
        vNorm += v[i] * v[i];
      }
      return { score: dot / (Math.sqrt(vNorm) * qNorm + 1e-9), node: toNode(row) };
    })
    .filter(s => s.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 兼容旧接口 */
export function vectorSearch(db: DatabaseSyncInstance, queryVec: number[], limit: number, minScore = 0.35): GmNode[] {
  return vectorSearchWithScore(db, queryVec, limit, minScore).map(s => s.node);
}

/**
 * 社区代表节点：每个社区取最近更新的 topN 个节点
 * 用于泛化召回 —— 用户问"做了哪些工作"时按领域返回概览
 */
export function communityRepresentatives(db: DatabaseSyncInstance, perCommunity = 2): GmNode[] {
  const rows = db.prepare(`
    SELECT * FROM gm_nodes
    WHERE status = 'active' AND community_id IS NOT NULL
    ORDER BY community_id, updated_at DESC
  `).all() as any[];

  const byCommunity = new Map<string, GmNode[]>();
  for (const r of rows) {
    const node = toNode(r);
    const cid = r.community_id as string;
    if (!byCommunity.has(cid)) byCommunity.set(cid, []);
    const list = byCommunity.get(cid)!;
    if (list.length < perCommunity) list.push(node);
  }

  // 社区按最新更新时间排序
  const communities = Array.from(byCommunity.entries())
    .sort((a, b) => {
      const aTime = Math.max(...a[1].map(n => n.updatedAt));
      const bTime = Math.max(...b[1].map(n => n.updatedAt));
      return bTime - aTime;
    });

  const result: GmNode[] = [];
  for (const [, nodes] of communities) {
    result.push(...nodes);
  }
  return result;
}

// ─── 社区描述 CRUD ──────────────────────────────────────────

export interface CommunitySummary {
  id: string;
  summary: string;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

export function upsertCommunitySummary(
  db: DatabaseSyncInstance, id: string, summary: string, nodeCount: number, embedding?: number[],
): void {
  const now = Date.now();
  const blob = embedding ? new Uint8Array(new Float32Array(embedding).buffer) : null;
  const ex = db.prepare("SELECT id FROM gm_communities WHERE id=?").get(id) as any;
  if (ex) {
    if (blob) {
      db.prepare("UPDATE gm_communities SET summary=?, node_count=?, embedding=?, updated_at=? WHERE id=?")
        .run(summary, nodeCount, blob, now, id);
    } else {
      db.prepare("UPDATE gm_communities SET summary=?, node_count=?, updated_at=? WHERE id=?")
        .run(summary, nodeCount, now, id);
    }
  } else {
    db.prepare("INSERT INTO gm_communities (id, summary, node_count, embedding, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run(id, summary, nodeCount, blob, now, now);
  }
}

export function getCommunitySummary(db: DatabaseSyncInstance, id: string): CommunitySummary | null {
  const r = db.prepare("SELECT * FROM gm_communities WHERE id=?").get(id) as any;
  if (!r) return null;
  return { id: r.id, summary: r.summary, nodeCount: r.node_count, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function getAllCommunitySummaries(db: DatabaseSyncInstance): CommunitySummary[] {
  return (db.prepare("SELECT * FROM gm_communities ORDER BY node_count DESC").all() as any[])
    .map(r => ({ id: r.id, summary: r.summary, nodeCount: r.node_count, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export type ScoredCommunity = { id: string; summary: string; score: number; nodeCount: number };

/**
 * 社区向量搜索：用 query 向量匹配社区 embedding，返回按相似度排序的社区
 */
export function communityVectorSearch(db: DatabaseSyncInstance, queryVec: number[], minScore = 0.15): ScoredCommunity[] {
  const rows = db.prepare(
    "SELECT id, summary, node_count, embedding FROM gm_communities WHERE embedding IS NOT NULL"
  ).all() as any[];

  if (!rows.length) return [];

  const q = new Float32Array(queryVec);
  const qNorm = Math.sqrt(q.reduce((s, x) => s + x * x, 0));
  if (qNorm === 0) return [];

  return rows
    .map(r => {
      const raw = r.embedding as Uint8Array;
      const v = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      let dot = 0, vNorm = 0;
      const len = Math.min(v.length, q.length);
      for (let i = 0; i < len; i++) {
        dot += v[i] * q[i];
        vNorm += v[i] * v[i];
      }
      return {
        id: r.id as string,
        summary: r.summary as string,
        score: dot / (Math.sqrt(vNorm) * qNorm + 1e-9),
        nodeCount: r.node_count as number,
      };
    })
    .filter(s => s.score > minScore)
    .sort((a, b) => b.score - a.score);
}

/**
 * 按社区 ID 列表获取成员节点（按时间倒序）
 */
export function nodesByCommunityIds(db: DatabaseSyncInstance, communityIds: string[], perCommunity = 3): GmNode[] {
  if (!communityIds.length) return [];
  const placeholders = communityIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM gm_nodes
    WHERE community_id IN (${placeholders}) AND status='active'
    ORDER BY community_id, updated_at DESC
  `).all(...communityIds) as any[];

  const byCommunity = new Map<string, GmNode[]>();
  for (const r of rows) {
    const node = toNode(r);
    const cid = r.community_id as string;
    if (!byCommunity.has(cid)) byCommunity.set(cid, []);
    const list = byCommunity.get(cid)!;
    if (list.length < perCommunity) list.push(node);
  }

  const result: GmNode[] = [];
  for (const cid of communityIds) {
    const members = byCommunity.get(cid);
    if (members) result.push(...members);
  }
  return result;
}

/** 清除已不存在的社区描述 */
export function pruneCommunitySummaries(db: DatabaseSyncInstance): number {
  const result = db.prepare(`
    DELETE FROM gm_communities WHERE id NOT IN (
      SELECT DISTINCT community_id FROM gm_nodes WHERE community_id IS NOT NULL AND status='active'
    )
  `).run();
  return result.changes;
}

// ─── TOPIC 节点查询 ─────────────────────────────────────────

const SEMANTIC_TYPES = new Set(["TASK", "SKILL", "EVENT", "KNOWLEDGE", "STATUS"]);

/**
 * 获取所有 TOPIC 类型的节点（排除 deprecated）
 */
export function getTopicNodes(db: DatabaseSyncInstance): GmNode[] {
  const rows = db.prepare(
    "SELECT * FROM gm_nodes WHERE type='TOPIC' AND status='active'"
  ).all() as any[];
  return rows.map(toNode);
}

// ─── Belief System ─────────────────────────────────────────────


/**
 * Beta-Bayesian belief computation.
 * belief = (α + successes) / (α + β + successes + failures)
 * With α=1, β=1 (uniform prior): belief = (1+s)/(2+s+f)
 */
export function computeBeliefA(successCount: number, failureCount: number): number {
  const α = 1, β = 1;
  return (α + successCount) / (α + β + successCount + failureCount);
}


/**
 * Record a belief signal for a node.
 */
function beliefUid(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function recordBeliefSignal(
  db: DatabaseSyncInstance,
  nodeId: string,
  nodeName: string,
  verdict: "supported" | "contradicted",
  sessionId: string,
  weight = 1.0,
  context: Record<string, unknown> = {},
): void {
  try {
    db.prepare(`
      INSERT INTO gm_belief_signals (id, node_id, node_name, signal_type, weight, context, session_id, created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      beliefUid("bsig"), nodeId, nodeName, verdict, weight, JSON.stringify(context), sessionId, Date.now(),
    );
  } catch {
    // gm_belief_signals may not exist in pre-belief databases
  }
}

/**
 * Update a node's belief score using the Beta-Bayesian scheme.
 * Returns the update result or null if node not found.
 */
export interface BeliefUpdateResult {
  beliefBefore: number;
  beliefAfter: number;
  delta: number;
  successCount: number;
  failureCount: number;
}

export function updateNodeBelief(
  db: DatabaseSyncInstance,
  nodeId: string,
  verdict?: "supported" | "contradicted",
  signalWeight = 1.0,  // LLM 给出的权重 0.5-2.0，直接累加
): BeliefUpdateResult | null {
  const row = db.prepare(
    "SELECT belief, success_count, failure_count FROM gm_nodes WHERE id=?"
  ).get(nodeId) as any;
  if (!row) return null;

  const beliefBefore = row.belief ?? 0.5;
  let successCount = row.success_count ?? 0;
  let failureCount = row.failure_count ?? 0;

  if (verdict === "supported") {
    successCount += signalWeight;
  } else if (verdict === "contradicted") {
    failureCount += signalWeight;
  }

  const beliefAfter = computeBeliefA(successCount, failureCount);

  try {
    db.prepare(`
      UPDATE gm_nodes
      SET belief=?, success_count=?, failure_count=?, last_signal_at=?, updated_at=?
      WHERE id=?
    `).run(beliefAfter, successCount, failureCount, Date.now(), Date.now(), nodeId);
  } catch {
    // Belief columns may not exist in pre-belief databases — silent fail
  }

  return {
    beliefBefore,
    beliefAfter,
    delta: beliefAfter - beliefBefore,
    successCount,
    failureCount,
  };
}

/**
 * Get belief info for a node.
 */
export function getBeliefInfo(
  db: DatabaseSyncInstance,
  nodeId: string,
): { belief: number; successCount: number; failureCount: number } | null {
  const row = db.prepare(
    "SELECT belief, success_count, failure_count FROM gm_nodes WHERE id=?"
  ).get(nodeId) as any;
  return row ? { belief: row.belief ?? 0.5, successCount: row.success_count ?? 0, failureCount: row.failure_count ?? 0 } : null;
}

/**
 * Get belief history (recent signals) for a node.
 */
export function getBeliefHistory(
  db: DatabaseSyncInstance,
  nodeId: string,
  limit = 20,
): Array<{ verdict: "supported" | "contradicted"; weight: number; createdAt: number }> {
  try {
    return (db.prepare(
      "SELECT signal_type, weight, created_at FROM gm_belief_signals WHERE node_id=? ORDER BY created_at DESC LIMIT ?"
    ).all(nodeId, limit) as any[]).map(r => ({
      verdict: r.signal_type as "supported" | "contradicted",
      weight: r.weight,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

// ─── Scope 管理 ──────────────────────────────────────────────

/**
 * 设置 session 的 scope（覆盖式：先删再插）。
 * scopeNames 为空数组时 = 清除该 session 的所有 scope。
 */
export function setScopesForSession(db: DatabaseSyncInstance, sessionId: string, scopeNames: string[]): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM gm_scopes WHERE session_id = ?").run(sessionId);
    const now = Date.now();
    for (const name of scopeNames) {
      if (name.trim()) {
        db.prepare(
          "INSERT OR IGNORE INTO gm_scopes (scope_name, session_id, created_at) VALUES (?, ?, ?)"
        ).run(name.trim(), sessionId, now);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 获取 session 绑定的所有 scope。
 */
export function getScopesForSession(db: DatabaseSyncInstance, sessionId: string): string[] {
  const rows = db.prepare(
    "SELECT scope_name FROM gm_scopes WHERE session_id = ? ORDER BY scope_name"
  ).all(sessionId) as any[];
  return rows.map(r => r.scope_name);
}

/**
 * 获取拥有 scope_hot:xxx flag 的节点（匹配任一 given scopeNames）。
 * flags 存储为 JSON 数组 like `["hot", "scope_hot:gm开发"]`，
 * 所以匹配 `"scope_hot:xxx"` 这个完整的字符串即可。
 */
export function getScopeHotNodes(db: DatabaseSyncInstance, scopeNames: string[]): GmNode[] {
  if (!scopeNames.length) return [];
  const conditions = scopeNames.map(() => 'flags LIKE ?').join(' OR ');
  const args = scopeNames.map(s => `%"scope_hot:${s}"%`);
  const rows = db.prepare(
    `SELECT * FROM gm_nodes WHERE status='active' AND (${conditions})`
  ).all(...args) as any[];
  return rows.map(toNode);
}

/**
 * 列出所有 scope 及其绑定 session 数量。
 */
export function listScopes(db: DatabaseSyncInstance): Array<{ scopeName: string; sessionCount: number }> {
  const rows = db.prepare(
    "SELECT scope_name, COUNT(*) as session_count FROM gm_scopes GROUP BY scope_name ORDER BY scope_name"
  ).all() as any[];
  return rows.map(r => ({ scopeName: r.scope_name, sessionCount: Number(r.session_count) }));
}

/**
 * 获取节点的完整信息：节点本身 + 所有出边/入边 + Belief 历史信号。
 */
export function getNodeFullInfo(
  db: DatabaseSyncInstance,
  name: string,
): {
  node: GmNode | null;
  edgesFrom: GmEdge[];
  edgesTo: GmEdge[];
  beliefHistory: Array<{ verdict: "supported" | "contradicted"; weight: number; createdAt: number }>;
} {
  const node = findByName(db, name);
  if (!node) return { node: null, edgesFrom: [], edgesTo: [], beliefHistory: [] };
  const edgesF = edgesFrom(db, node.id);
  const edgesT = edgesTo(db, node.id);
  const beliefHistory = getBeliefHistory(db, node.id);
  return { node, edgesFrom: edgesF, edgesTo: edgesT, beliefHistory };
}

/**
 * 直接更新节点的 description 和/或 content（覆盖式，不做合并）。
 * 返回更新后的节点，或 null（节点不存在）。
 */
export function updateNodeFields(
  db: DatabaseSyncInstance,
  name: string,
  fields: { description?: string; content?: string },
): GmNode | null {
  const node = findByName(db, name);
  if (!node) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.description !== undefined) {
    sets.push("description = ?");
    vals.push(fields.description);
  }
  if (fields.content !== undefined) {
    sets.push("content = ?");
    vals.push(fields.content);
  }
  if (!sets.length) return node;
  sets.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(node.id);
  db.prepare(`UPDATE gm_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return findByName(db, name);
}

/**
 * 获取 topic → topic 边（两端都是 TOPIC 节点，且两端都是 active 的边）
 */
export function getTopicToTopicEdges(db: DatabaseSyncInstance): GmEdge[] {
  const rows = db.prepare(`
    SELECT e.* FROM gm_edges e
    JOIN gm_nodes f ON f.id = e.from_id
    JOIN gm_nodes t ON t.id = e.to_id
    WHERE f.type = 'TOPIC' AND t.type = 'TOPIC'
      AND f.status = 'active' AND t.status = 'active'
  `).all() as any[];
  return rows.map(toEdge);
}

/**
 * 获取 semantic → topic 边（从非 TOPIC 节点指向 active TOPIC 节点的边）
 */
export function getSemanticToTopicEdges(db: DatabaseSyncInstance): GmEdge[] {
  const rows = db.prepare(`
    SELECT e.* FROM gm_edges e
    JOIN gm_nodes f ON f.id = e.from_id
    JOIN gm_nodes t ON t.id = e.to_id
    WHERE f.type != 'TOPIC' AND t.type = 'TOPIC'
      AND f.status = 'active' AND t.status = 'active'
  `).all() as any[];
  return rows.map(toEdge);
}

/**
 * 获取所有 semantic 类型的节点（KNOWLEDGE/SKILL/TASK/EVENT/STATUS，排除 deprecated）
 */
export function getSemanticNodes(db: DatabaseSyncInstance): GmNode[] {
  const rows = db.prepare(
    "SELECT * FROM gm_nodes WHERE type IN ('TASK','SKILL','EVENT','KNOWLEDGE','STATUS') AND status='active'"
  ).all() as any[];
  return rows.map(toNode);
}
/**
 * 保存当前轮次召回的节点到 gm_recalled 表（过滤掉 filtered 节点）
 */
export function saveRecalledNodes(
  db: DatabaseSyncInstance,
  sessionId: string,
  turnIndex: number,
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    tier: string;
    semanticScore?: number;
    pprScore?: number;
    combinedScore?: number;
  }>
): void {
  // 过滤掉 filtered 节点
  const displayNodes = nodes.filter(n => n.tier !== "filtered");
  if (!displayNodes.length) return;

  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO gm_recalled (id, session_id, turn_index, node_id, node_name, node_type, tier, semantic, ppr, combined, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const n of displayNodes) {
    insert.run(
      `recalled-${now}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      turnIndex,
      n.id,
      n.name,
      n.type,
      n.tier,
      n.semanticScore ?? null,
      n.pprScore ?? null,
      n.combinedScore ?? null,
      now,
    );
  }
}

/**
 * 查询某 session 某 turn 召回的节点
 */
export function getRecalledNodes(
  db: DatabaseSyncInstance,
  sessionId: string,
  turnIndex: number
): Array<{ nodeId: string; nodeName: string; nodeType: string; tier: string; semantic: number; ppr: number; combined: number }> {
  const rows = db.prepare(
    "SELECT node_id, node_name, node_type, tier, semantic, ppr, combined FROM gm_recalled WHERE session_id=? AND turn_index=?"
  ).all(sessionId, turnIndex) as any[];
  return rows.map(r => ({
    nodeId: r.node_id,
    nodeName: r.node_name,
    nodeType: r.node_type,
    tier: r.tier,
    semantic: r.semantic ?? 0,
    ppr: r.ppr ?? 0,
    combined: r.combined ?? 0,
  }));
}
