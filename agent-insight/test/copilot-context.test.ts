import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '@/lib/copilot/contracts';

test('copilot routes method consultation away from write workflows', () => {
  const route = classifyIntent('如何基于当前 Trace 创建评测样例？', true);
  assert.equal(route.intent, 'how_to');
  assert.equal(route.action, undefined);
});

test('copilot routes explicit Trace sample creation to preview', () => {
  const route = classifyIntent('基于当前 Trace 创建评测样例', true);
  assert.equal(route.intent, 'workflow_draft');
  assert.equal(route.action, 'trace_to_dataset');
});

test('copilot asks for context before a workflow can be prepared', () => {
  const route = classifyIntent('创建评测样例', false);
  assert.equal(route.intent, 'clarify');
});

test('copilot routes current trace analysis to context mode', () => {
  const route = classifyIntent('这条 Trace 里模型和 Skill 分别做了什么？', true);
  assert.equal(route.intent, 'context_analysis');
});

test('copilot routes Trace listing requests to the read-only Trace tool', () => {
  const route = classifyIntent('查询最近失败的 Trace', false);
  assert.equal(route.intent, 'workflow_draft');
  assert.equal(route.action, 'run_filter');
});
