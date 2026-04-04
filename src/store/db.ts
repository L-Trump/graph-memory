/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

export { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";

let _db: DatabaseSyncInstance | null = null;

export function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

export function getDb(dbPath: string): DatabaseSyncInstance {
  if (_db) return _db;
  const resolved = resolvePath(dbPath);
  
  // 修复：同时处理 Windows 和 Unix 路径分隔符
  const lastSeparator = Math.max(
    resolved.lastIndexOf("/"),
    resolved.lastIndexOf("\\")
  );
  
  if (lastSeparator > 0) {
    const dirPath = resolved.substring(0, lastSeparator);
    mkdirSync(dirPath, { recursive: true });
  } else if (lastSeparator === 0) {
    // 路径像是 "/file.db" 或 "C:file.db"
    // 在根目录或驱动器根目录，不需要创建目录
  } else {
    // lastSeparator === -1，路径没有分隔符
    // 像是 "file.db"，使用当前目录，不需要创建目录
  }

  _db = new DatabaseSync(resolved);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  migrate(_db);
  return _db;
}

/** 仅用于测试：关闭并重置单例 */
export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}

function migrate(db: DatabaseSyncInstance): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL)`);
  const cur = (db.prepare("SELECT MAX(v) as v FROM _migrations").get() as any)?.v ?? 0;
  const steps = [m1_core, m2_messages, m3_signals, m4_fts5, m5_vectors, m6_communities, m7_edge_flexible, m8_flags, m9_topic_nodes, m10_belief];
function m10_belief(db: DatabaseSyncInstance): void {
  try {
    db.prepare("SELECT belief FROM gm_nodes LIMIT 1").get();
    return; // already migrated
  } catch { /* column doesn't exist */ }

  db.exec(`
    ALTER TABLE gm_nodes ADD COLUMN belief REAL NOT NULL DEFAULT 0.5;
    ALTER TABLE gm_nodes ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE gm_nodes ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE gm_nodes ADD COLUMN last_signal_at INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS gm_belief_signals (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      node_name TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      context TEXT NOT NULL DEFAULT '{}',
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_belief_sig_node ON gm_belief_signals(node_id, created_at);
    CREATE INDEX IF NOT EXISTS ix_belief_sig_session ON gm_belief_signals(session_id);
  `);
}
  for (let i = cur; i < steps.length; i++) {
    steps[i](db);
    db.prepare("INSERT INTO _migrations (v,at) VALUES (?,?)").run(i + 1, Date.now());
  }
}

// ─── 核心表：节点 + 边 ──────────────────────────────────────

function m1_core(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_nodes (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT','KNOWLEDGE','STATUS')),
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
      validated_count INTEGER NOT NULL DEFAULT 1,
      source_sessions TEXT NOT NULL DEFAULT '[]',
      community_id    TEXT,
      pagerank        REAL NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_gm_nodes_name ON gm_nodes(name);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_type_status ON gm_nodes(type, status);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_community ON gm_nodes(community_id);

    CREATE TABLE IF NOT EXISTS gm_edges (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL REFERENCES gm_nodes(id),
      to_id       TEXT NOT NULL REFERENCES gm_nodes(id),
      type        TEXT NOT NULL CHECK(type IN ('USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH')),
      instruction TEXT NOT NULL,
      condition   TEXT,
      session_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_edges_from ON gm_edges(from_id);
    CREATE INDEX IF NOT EXISTS ix_gm_edges_to   ON gm_edges(to_id);
  `);
}

// ─── 消息存储 ────────────────────────────────────────────────

function m2_messages(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      extracted   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_msg_session ON gm_messages(session_id, turn_index);
  `);
}

// ─── 信号存储 ────────────────────────────────────────────────

function m3_signals(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_signals (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      type        TEXT NOT NULL,
      data        TEXT NOT NULL DEFAULT '{}',
      processed   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_sig_session ON gm_signals(session_id, processed);
  `);
}

// ─── FTS5 全文索引 ───────────────────────────────────────────

function m4_fts5(db: DatabaseSyncInstance): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS gm_nodes_fts USING fts5(
        name,
        description,
        content,
        content=gm_nodes,
        content_rowid=rowid
      );
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS gm_nodes_ai AFTER INSERT ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(rowid, name, description, content)
        VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gm_nodes_ad AFTER DELETE ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(gm_nodes_fts, rowid, name, description, content)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gm_nodes_au AFTER UPDATE ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(gm_nodes_fts, rowid, name, description, content)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content);
        INSERT INTO gm_nodes_fts(rowid, name, description, content)
        VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content);
      END;
    `);
  } catch {
    // FTS5 不可用时静默降级到 LIKE 搜索
  }
}

// ─── 向量存储 ────────────────────────────────────────────────

function m5_vectors(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_vectors (
      node_id      TEXT PRIMARY KEY REFERENCES gm_nodes(id),
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL
    );
  `);
}

// ─── 社区描述存储 ────────────────────────────────────────────

function m6_communities(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_communities (
      id          TEXT PRIMARY KEY,
      summary     TEXT NOT NULL,
      node_count  INTEGER NOT NULL DEFAULT 0,
      embedding   BLOB,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
}

// ─── 边灵活性迁移：type → name，instruction → description ────

function m7_edge_flexible(db: DatabaseSyncInstance): void {
  // 检查是否已有 name 列（幂等）
  try {
    db.prepare("SELECT name FROM gm_edges LIMIT 1").get();
    return; // 已迁移
  } catch { /* 列不存在，继续 */ }

  // 重建表：保留数据，改为新 schema（name + description）
  db.exec(`
    -- 处理可能的残留旧表
    DROP TABLE IF EXISTS gm_edges_old;
    -- 备份旧表数据
    ALTER TABLE gm_edges RENAME TO gm_edges_old;

    -- 创建新表（无 type 列，新增 name + description）
    CREATE TABLE gm_edges (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL REFERENCES gm_nodes(id),
      to_id       TEXT NOT NULL REFERENCES gm_nodes(id),
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      session_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_edges_from ON gm_edges(from_id);
    CREATE INDEX IF NOT EXISTS ix_gm_edges_to   ON gm_edges(to_id);

    -- 迁移旧数据：type → name，instruction → description
    INSERT INTO gm_edges (id, from_id, to_id, name, description, session_id, created_at)
    SELECT
      id,
      from_id,
      to_id,
      CASE type
        WHEN 'USED_SKILL'     THEN '使用'
        WHEN 'SOLVED_BY'      THEN '解决'
        WHEN 'REQUIRES'       THEN '依赖'
        WHEN 'PATCHES'        THEN '扩展'
        WHEN 'CONFLICTS_WITH' THEN '冲突'
        ELSE type
      END,
      COALESCE(instruction, ''),
      session_id,
      created_at
    FROM gm_edges_old;

    -- 删除旧表
    DROP TABLE gm_edges_old;
  `);
}

// ─── flags 字段迁移 ─────────────────────────────────────────

function m8_flags(db: DatabaseSyncInstance): void {
  try {
    db.prepare("SELECT flags FROM gm_nodes LIMIT 1").get();
    return; // 已迁移
  } catch { /* 列不存在，继续 */ }

  db.exec(`
    ALTER TABLE gm_nodes ADD COLUMN flags TEXT NOT NULL DEFAULT '[]';
  `);
}

// ─── TOPIC 节点类型迁移 ──────────────────────────────────────

function m9_topic_nodes(db: DatabaseSyncInstance): void {
  // 更新 CHECK 约束，允许 TOPIC 类型
  // SQLite 不支持 ALTER TABLE CHECK，需要重建表
  try {
    // 检查当前 CHECK 是否已包含 TOPIC
    const colInfo = db.prepare("PRAGMA table_info(gm_nodes)").all() as any[];
    // 如果 type 列没有 CHECK 约束包含 TOPIC，则重建表
    db.exec(`
      ALTER TABLE gm_nodes RENAME TO gm_nodes_old;

      CREATE TABLE gm_nodes (
        id              TEXT PRIMARY KEY,
        type            TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT','KNOWLEDGE','STATUS','TOPIC')),
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        content         TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
        validated_count INTEGER NOT NULL DEFAULT 1,
        source_sessions TEXT NOT NULL DEFAULT '[]',
        community_id    TEXT,
        pagerank        REAL NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        flags           TEXT NOT NULL DEFAULT '[]'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_gm_nodes_name ON gm_nodes(name);
      CREATE INDEX IF NOT EXISTS ix_gm_nodes_type_status ON gm_nodes(type, status);
      CREATE INDEX IF NOT EXISTS ix_gm_nodes_community ON gm_nodes(community_id);

      INSERT INTO gm_nodes SELECT * FROM gm_nodes_old;
      DROP TABLE gm_nodes_old;
    `);
  } catch { /* 已经是最新 schema */ }
}
