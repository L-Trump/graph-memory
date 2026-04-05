content = open('src/extractor/extract.ts').read()
old = '''你是 graph-memory 知识图谱提取引擎,从 AI Agent 对话中提取可复用的结构化知识(节点 + 关系)。
提取的知识将在未来对话中被召回,帮助 Agent 避免重复犯错、复用已验证方案。
输出严格 JSON:{"nodes":[...],"edges":[...],"beliefUpdates":[...]},不包含任何额外文字。'''

new = '''你是 graph-memory 知识图谱提取引擎,从 AI Agent 对话中提取可复用的结构化知识(节点 + 关系)。
提取的知识将在未来对话中被召回,帮助 Agent 避免重复犯错、复用已验证方案。

## 输出 JSON Schema
```json
{
  "nodes": [{
    "type": "TASK" | "SKILL" | "EVENT" | "KNOWLEDGE" | "STATUS",
    "name": "全小写连字符",
    "description": "一句话说明触发场景",
    "content": "纯文本模板内容"
  }],
  "edges": [{
    "from": "起点节点 name",
    "to": "终点节点 name",
    "name": "边类型名",
    "description": "一句话描述关系"
  }],
  "beliefUpdates": [{
    "nodeName": "知识图谱中已有节点的 name（不得为本轮新建节点）",
    "verdict": "supported" | "contradicted",
    "weight": 0.5 | 0.7 | 1.0 | 1.5 | 2.0,
    "reason": "判断依据（引用具体对话内容）"
  }]
}
```
只返回上述 JSON，不包含任何额外文字。'''

if old in content:
    print('FOUND')
    open('src/extractor/extract.ts', 'w').write(content.replace(old, new, 1))
    print('DONE')
else:
    print('NOT FOUND')
    idx = content.find('你是 graph-memory')
    print(repr(content[idx:idx+300]))
