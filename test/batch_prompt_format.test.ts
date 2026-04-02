/**
 * 测试 BATCH_SUMMARY_SYS 提示词格式
 * 验证输入格式说明是否正确：### 社区ID + 类型:名称 — 描述
 */

import { describe, test, expect, beforeEach } from "vitest";
import { summarizeCommunities } from "../src/graph/community";
import type { CompleteFn } from "../src/engine/llm";
import type { EmbedFn } from "../src/engine/embed";
import { createTestDb, insertNode } from "./helpers.ts";

describe('BATCH_SUMMARY_SYS 提示词格式验证', () => {
  let db: ReturnType<typeof createTestDb>;
  let llmCalls: { system: string; user: string }[] = [];
  
  const mockLlm: CompleteFn = async (system, user) => {
    llmCalls.push({ system, user });
    
    // 提取社区 ID
    const communityIds = [...user.matchAll(/### (c-\S+)/g)].map(m => m[1]);
    const result: Record<string, string> = {};
    for (const id of communityIds) {
      result[id] = `测试摘要 ${id}`;
    }
    return JSON.stringify(result);
  };
  
  const mockEmbed: EmbedFn = async () => new Array(384).fill(0);

  beforeEach(() => {
    db = createTestDb();
    llmCalls = [];
  });

  test('验证输入格式包含 ### 社区ID 头和类型:名称 — 描述格式', async () => {
    // 插入测试节点
    insertNode(db, { id: 'n1', type: 'SKILL', name: 'NixOS配置', description: 'NixOS系统配置经验' });
    insertNode(db, { id: 'n2', type: 'KNOWLEDGE', name: 'Home Manager', description: '用户配置管理' });
    insertNode(db, { id: 'n3', type: 'TASK', name: 'Nixpkgs打包', description: '软件包构建' });
    
    const communities = new Map([['c-prompt-test', ['n1', 'n2', 'n3']]]);
    
    await summarizeCommunities(db, communities, mockLlm, mockEmbed, 50);
    
    expect(llmCalls.length).toBe(1);
    const { system, user } = llmCalls[0];
    
    // 验证 system prompt 包含格式说明
    expect(system).toContain('### 社区ID');  // 格式说明
    expect(system).toContain('类型:节点名称 — 节点描述');  // 节点格式说明
    expect(system).toContain('JSON 对象');  // 输出格式说明
    
    // 验证 user input 格式正确
    expect(user).toContain('### c-prompt-test');  // 社区 ID 头
    expect(user).toMatch(/\w+:[^\n]+ — [^\n]+/);  // 节点格式
    expect(user).toContain('SKILL:NixOS配置 — NixOS系统配置经验');  // 完整节点行
  });

  test('验证批量处理时每个社区都有正确的分隔', async () => {
    insertNode(db, { id: 'n1', type: 'SKILL', name: '节点1', description: '描述1' });
    insertNode(db, { id: 'n2', type: 'KNOWLEDGE', name: '节点2', description: '描述2' });
    insertNode(db, { id: 'n3', type: 'EVENT', name: '节点3', description: '描述3' });
    insertNode(db, { id: 'n4', type: 'TASK', name: '节点4', description: '描述4' });
    
    const communities = new Map([
      ['c-batch-a', ['n1', 'n2']],
      ['c-batch-b', ['n3', 'n4']],
    ]);
    
    await summarizeCommunities(db, communities, mockLlm, mockEmbed, 50);
    
    // 两个小社区应该合并成一批
    expect(llmCalls.length).toBe(1);
    
    const { user } = llmCalls[0];
    expect(user).toContain('### c-batch-a');
    expect(user).toContain('### c-batch-b');
    
    // 验证每个社区都有正确的节点格式
    expect(user).toMatch(/\w+:[^\n]+ — [^\n]+/);
  });

  test('验证 system prompt 包含完整的格式示例', async () => {
    insertNode(db, { id: 'n1', type: 'SKILL', name: '用户偏好', description: '记录用户偏好' });
    
    const communities = new Map([['c-example', ['n1']]]);
    
    await summarizeCommunities(db, communities, mockLlm, mockEmbed, 50);
    
    const { system } = llmCalls[0];
    
    // 验证包含格式示例
    expect(system).toContain('## 输入格式');
    expect(system).toContain('### 社区ID');
    expect(system).toContain('类型:节点名称 — 节点描述');
    expect(system).toContain('### c-1');
    expect(system).toContain('SKILL:用户偏好记忆 — 记录用户的偏好设置');
    
    // 验证输出要求
    expect(system).toContain('## 输出要求');
    expect(system).toContain('JSON 对象');
    expect(system).toContain('不要使用"社区"这个词');
  });
});
