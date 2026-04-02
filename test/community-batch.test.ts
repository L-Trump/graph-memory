/**
 * 社区摘要批量生成测试
 * 
 * 测试场景：
 * 1. 多个小社区（每社区 1-3 节点）→ 应该合并成一批
 * 2. 多个中等社区（每社区 10-20 节点）→ 按节点数分批
 * 3. 超大社区（>50 节点）→ 单独成批
 * 4. 混合场景 → 验证智能分批逻辑
 */

import { describe, test, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { summarizeCommunities } from "../src/graph/community";
import type { CompleteFn, EmbedFn } from "../src/types";
import { createTestDb, insertNode } from "./helpers.ts";

// 模拟 LLM 调用（返回 mock 摘要）
const mockLlm: CompleteFn = async (system, user) => {
  // 提取所有社区 ID（支持任意格式：c1, c_big, c-123 等）
  const matches = user.match(/### ([^\n]+)/g);
  if (matches) {
    const results: Record<string, string> = {};
    matches.forEach(m => {
      const cid = m.replace(/^### /, "").trim();
      results[cid] = `社区 ${cid} 的摘要`;
    });
    return JSON.stringify(results, null, 2);
  }
  return JSON.stringify({ single: "单个社区摘要" });
};

// 模拟 embedding（返回固定向量）
const mockEmbed: EmbedFn = async (text) => {
  return new Array(1536).fill(0.1);
};

describe("summarizeCommunities - 批量策略", () => {
  let db: DatabaseSyncInstance;

  beforeEach(() => {
    db = createTestDb();
  });

  test("场景 1: 多个小社区（每社区 2 节点）→ 合并成一批", async () => {
    // 50 个小社区，每社区 2 节点 = 100 节点
    const communities = new Map<string, string[]>();
    
    for (let i = 1; i <= 50; i++) {
      const nodeIdA = `n${i}_a`;
      const nodeIdB = `n${i}_b`;
      
      insertNode(db, { id: nodeIdA, name: `节点${i}A`, description: `描述${i}A` });
      insertNode(db, { id: nodeIdB, name: `节点${i}B`, description: `描述${i}B` });
      
      communities.set(`c${i}`, [nodeIdA, nodeIdB]);
    }

    let callCount = 0;
    const countingLlm: CompleteFn = async (system, user) => {
      callCount++;
      return mockLlm(system, user);
    };

    const result = await summarizeCommunities(db, communities, countingLlm, mockEmbed, 50);

    console.log(`  ✓ 50 个小社区（100 节点）→ ${callCount} 次 LLM 调用`);
    expect(callCount).toBeLessThanOrEqual(3); // 最多 2-3 批（100/50=2 批）
    expect(result).toBe(50); // 生成 50 个摘要
  });

  test("场景 2: 超大社区（>50 节点）→ 单独成批", async () => {
    // 1 个超大社区（60 节点）
    const memberIds: string[] = [];
    for (let i = 1; i <= 60; i++) {
      const nodeId = `big_n${i}`;
      insertNode(db, { id: nodeId, name: `大节点${i}`, description: `描述${i}` });
      memberIds.push(nodeId);
    }

    const bigCommunity = new Map<string, string[]>();
    bigCommunity.set("c_big", memberIds);

    let callCount = 0;
    const countingLlm: CompleteFn = async (system, user) => {
      callCount++;
      return mockLlm(system, user);
    };

    const result = await summarizeCommunities(db, bigCommunity, countingLlm, mockEmbed, 50);

    console.log(`  ✓ 1 个超大社区（60 节点）→ ${callCount} 次 LLM 调用`);
    expect(callCount).toBe(1); // 单独成批，1 次调用
    expect(result).toBe(1);
  });

  test("场景 3: 混合场景 → 智能分批", async () => {
    // c1: 10 节点
    const c1Members: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const nodeId = `c1_n${i}`;
      insertNode(db, { id: nodeId, name: `C1 节点${i}`, description: `描述${i}` });
      c1Members.push(nodeId);
    }
    
    // c2: 15 节点
    const c2Members: string[] = [];
    for (let i = 1; i <= 15; i++) {
      const nodeId = `c2_n${i}`;
      insertNode(db, { id: nodeId, name: `C2 节点${i}`, description: `描述${i}` });
      c2Members.push(nodeId);
    }
    
    // c3: 30 节点
    const c3Members: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const nodeId = `c3_n${i}`;
      insertNode(db, { id: nodeId, name: `C3 节点${i}`, description: `描述${i}` });
      c3Members.push(nodeId);
    }
    
    // c4: 60 节点（超大）
    const c4Members: string[] = [];
    for (let i = 1; i <= 60; i++) {
      const nodeId = `c4_n${i}`;
      insertNode(db, { id: nodeId, name: `C4 节点${i}`, description: `描述${i}` });
      c4Members.push(nodeId);
    }

    const communities = new Map<string, string[]>();
    communities.set("c1", c1Members);
    communities.set("c2", c2Members);
    communities.set("c3", c3Members);
    communities.set("c4", c4Members);

    let callCount = 0;
    const countingLlm: CompleteFn = async (system, user) => {
      callCount++;
      const communityCount = (user.match(/### c\d+/g) || []).length;
      console.log(`    批次 ${callCount}: ${communityCount} 个社区`);
      return mockLlm(system, user);
    };

    const result = await summarizeCommunities(db, communities, countingLlm, mockEmbed, 50);

    console.log(`  ✓ 混合场景（10+15+30+60=115 节点）→ ${callCount} 次 LLM 调用`);
    console.log(`    预期分批:`);
    console.log(`      批次 1: c1(10) + c2(15) = 25 节点（加 c3 会超 50）`);
    console.log(`      批次 2: c3(30) = 30 节点`);
    console.log(`      批次 3: c4(60) = 60 节点（超大单独）`);
    
    expect(callCount).toBeLessThanOrEqual(4); // 最多 3-4 批
    expect(result).toBe(4); // 生成 4 个摘要
  });

  test("场景 4: 边界条件 - 节点数正好等于阈值", async () => {
    // c1: 25 节点
    const c1Members: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const nodeId = `c1_n${i}`;
      insertNode(db, { id: nodeId, name: `C1节点${i}`, description: `C1描述${i}` });
      c1Members.push(nodeId);
    }
    
    // c2: 25 节点
    const c2Members: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const nodeId = `c2_n${i}`;
      insertNode(db, { id: nodeId, name: `C2节点${i}`, description: `C2描述${i}` });
      c2Members.push(nodeId);
    }

    const communities = new Map<string, string[]>();
    communities.set("c1", c1Members);
    communities.set("c2", c2Members);

    let callCount = 0;
    const countingLlm: CompleteFn = async (system, user) => {
      callCount++;
      return mockLlm(system, user);
    };

    const result = await summarizeCommunities(db, communities, countingLlm, mockEmbed, 50);

    console.log(`  ✓ 边界条件（25+25=50 节点）→ ${callCount} 次 LLM 调用`);
    expect(callCount).toBe(1); // 正好一批
    expect(result).toBe(2);
  });

  test("场景 5: 空社区过滤", async () => {
    const communities = new Map<string, string[]>();
    communities.set("c_empty", []); // 空社区
    communities.set("c_valid", ["n1"]);

    // 插入 1 个节点
    insertNode(db, { id: "n1", name: "有效节点", description: "描述" });

    let callCount = 0;
    const countingLlm: CompleteFn = async (system, user) => {
      callCount++;
      return mockLlm(system, user);
    };

    const result = await summarizeCommunities(db, communities, countingLlm, mockEmbed, 50);

    console.log(`  ✓ 空社区过滤 → ${callCount} 次 LLM 调用`);
    expect(callCount).toBe(1); // 只处理有效社区
    expect(result).toBe(1);
  });
});

describe("summarizeCommunities - 不同批量阈值对比", () => {
  let db: DatabaseSyncInstance;

  beforeEach(() => {
    db = createTestDb();
  });

  test("阈值对比：50 vs 100 节点/批", async () => {
    // 100 个小社区，每社区 2 节点 = 200 节点
    const communities = new Map<string, string[]>();
    
    for (let i = 1; i <= 100; i++) {
      const nodeIdA = `n${i}_a`;
      const nodeIdB = `n${i}_b`;
      insertNode(db, { id: nodeIdA, name: `节点${i}A`, description: `描述${i}A` });
      insertNode(db, { id: nodeIdB, name: `节点${i}B`, description: `描述${i}B` });
      communities.set(`c${i}`, [nodeIdA, nodeIdB]);
    }

    const testThreshold = async (threshold: number) => {
      let callCount = 0;
      const countingLlm: CompleteFn = async (system, user) => {
        callCount++;
        return mockLlm(system, user);
      };

      await summarizeCommunities(db, communities, countingLlm, mockEmbed, threshold);
      return callCount;
    };

    const calls50 = await testThreshold(50);
    const calls100 = await testThreshold(100);

    console.log(`  ✓ 200 节点，阈值 50 → ${calls50} 次调用`);
    console.log(`  ✓ 200 节点，阈值 100 → ${calls100} 次调用`);
    
    expect(calls50).toBeGreaterThan(calls100); // 阈值越大，调用越少
  });
});
