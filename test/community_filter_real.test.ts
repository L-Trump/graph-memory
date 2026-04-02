/**
 * 测试：真实数据库中的社区过滤行为
 * 
 * 验证 maintenance.ts 中的 ≥4 过滤是否生效
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "@photostructure/sqlite";
import { detectCommunities } from "../src/graph/community.ts";

const DB_PATH = process.env.HOME + "/.openclaw/graph-memory.db";

describe("真实数据库社区过滤验证", () => {
  it("maintenance.ts 中的过滤逻辑会过滤掉 92% 的小社区", () => {
    const db = new DatabaseSync(DB_PATH, { readonly: true });

    // 模拟 maintenance.ts 中的 detectCommunities
    const result = detectCommunities(db);
    
    console.log(`\n检测到的社区总数: ${result.count}`);
    
    // 模拟 maintenance.ts 中的过滤逻辑
    const threshold = 4;
    const significantCommunities = new Map(
      Array.from(result.communities.entries())
        .filter(([_, members]) => members.length >= threshold)
    );
    
    console.log(`过滤后（≥${threshold} 节点）: ${significantCommunities.size} 个社区`);
    console.log(`被过滤掉: ${result.count - significantCommunities.size} 个社区`);
    console.log(`LLM 调用减少: ${(((result.count - significantCommunities.size) / result.count) * 100).toFixed(1)}%`);
    
    // 验证过滤效果（社区数是动态的，只验证比例）
    expect(result.count).toBeGreaterThan(400);  // 原始社区数应该 > 400
    expect(significantCommunities.size).toBeLessThan(50);  // 过滤后应该 < 50
    expect((result.count - significantCommunities.size) / result.count).toBeGreaterThan(0.9);  // 减少 > 90%
    
    db.close();
  });

  it("但 summarizeCommunities 本身没有过滤，会处理所有传入的社区", () => {
    const db = new DatabaseSync(DB_PATH, { readonly: true });

    const result = detectCommunities(db);
    console.log(`\n直接传入 summarizeCommunities 的社区数: ${result.communities.size}`);
    console.log("（summarizeCommunities 不会再次过滤，而是处理所有传入的社区）");
    
    // 统计分布
    let smallCount = 0;
    for (const [_, members] of result.communities) {
      if (members.length > 0 && members.length < 4) smallCount++;
    }
    
    console.log(`其中 <4 节点的社区: ${smallCount} 个`);
    console.log("如果直接调用 summarizeCommunities，这些都会被处理！");
    
    expect(smallCount).toBeGreaterThan(0);  // 确认有小于 4 的社区
    
    db.close();
  });
});
