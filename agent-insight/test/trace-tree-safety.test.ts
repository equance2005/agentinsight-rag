import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, walkTree, type AgentNode } from '../src/lib/engine/observability/agent-trace';

function node(id: string): AgentNode {
  return {
    id,
    agentName: id,
    subagentType: null,
    sessionId: id,
    parentId: null,
    depth: 0,
    events: [],
    children: [],
    interactionIndices: [],
    stats: {
      interactions: 0,
      llmCalls: 0,
      toolCalls: 0,
      skillCalls: 0,
      taskCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  };
}

test('trace tree traversal terminates for malformed cyclic display trees', () => {
  const root = node('root');
  const child = node('child');
  root.children.push(child);
  child.children.push(root);

  const visited: string[] = [];
  walkTree(root, current => visited.push(current.id));

  assert.deepEqual(visited, ['root', 'child']);
  assert.equal(findNode(root, 'child'), child);
  assert.equal(findNode(root, 'missing'), null);
});
