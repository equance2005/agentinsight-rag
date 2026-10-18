import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, extractDatasetName, extractEvaluatorName } from '@/lib/copilot/contracts';

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

test('copilot routes blank dataset creation to the Dataset workflow', () => {
  const route = classifyIntent('创建一个新的评测数据集', false);
  assert.equal(route.intent, 'workflow_draft');
  assert.equal(route.action, 'dataset_create');
});

test('copilot routes 新建 dataset requests to the Dataset workflow', () => {
  const route = classifyIntent('新建一个名字叫test的评测数据集', false);
  assert.equal(route.intent, 'workflow_draft');
  assert.equal(route.action, 'dataset_create');
});

test('copilot extracts a requested dataset name for the creation tool', () => {
  assert.equal(extractDatasetName('名称叫test，先建空集'), 'test');
  assert.equal(extractDatasetName('命名为「安全日志集」'), '安全日志集');
  assert.equal(extractDatasetName('删除messages 日志分析（内置示例）这个数据集'), 'messages 日志分析（内置示例）');
});

test('copilot routes Skill modification requests to the Skill workflow', () => {
  const route = classifyIntent('修改当前 Skill 的提示词', true);
  assert.equal(route.intent, 'workflow_draft');
  assert.equal(route.action, 'skill_edit');
});

test('copilot keeps the dataset page context when no dataset card is selected', () => {
  const route = classifyIntent('删除messages 日志分析（内置示例）这个数据集', true);
  assert.equal(route.intent, 'workflow_draft');
  assert.equal(route.action, 'dataset_delete');
});

test('copilot routes custom evaluator deletion and extracts its name', () => {
  assert.equal(classifyIntent('删除日志准确性评估器', true).action, 'evaluator_delete');
  assert.equal(extractEvaluatorName('删除日志准确性评估器'), '日志准确性');
});
