#!/usr/bin/env python3
import sqlite3, os, json
db_path = os.path.expanduser("~/.openclaw/graph-memory.db")
con = sqlite3.connect(db_path)
cur = con.cursor()

# Export nodes
cur.execute("""
    SELECT id, type, name, description, content, status, validated_count,
           source_sessions, community_id, pagerank, flags, created_at, updated_at
    FROM gm_nodes
""")
nodes = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]
print(f"Nodes: {len(nodes)}")

# Export edges
cur.execute("SELECT id, from_id, to_id, name, description, session_id, created_at FROM gm_edges")
edges = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]
print(f"Edges: {len(edges)}")

# Export messages (recent 5000)
cur.execute("""
    SELECT id, session_id, turn_index, role, content, extracted, created_at
    FROM gm_messages ORDER BY created_at DESC LIMIT 5000
""")
messages = [dict(zip([d[0] for d in cur.description], row)) for row in cur.fetchall()]
print(f"Messages: {len(messages)}")

# Save to JSON
data = {"nodes": nodes, "edges": edges, "messages": messages}
with open("/tmp/gm-export.json", "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)
print("Saved to /tmp/gm-export.json")

con.close()
