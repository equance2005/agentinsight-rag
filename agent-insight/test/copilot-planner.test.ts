import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCopilotPlan } from '../src/lib/copilot/planner';
import type { CopilotContextResult } from '../src/lib/copilot/contracts';

const context: CopilotContextResult = {
  envelope: { user: 'alice', pageType: 'trace', objectType: 'execution', objectId: 'exec-1' },
  sources: [{ id: 'exec-1', kind: 'trace', label: 'Trace exec-1', locator: 'execution:exec-1', content: 'trace' }],
  facts: { executionId: 'exec-1' },
  missing: [],
};

test('Copilot planner creates a confirmation-gated dataset workflow', () => {
  const plan = buildCopilotPlan(
    '把这条 Trace 做成评测数据集',
    { intent: 'workflow_draft', action: 'trace_to_dataset', reason: 'test' },
    context,
  );

  assert.equal(plan.requiresConfirmation, true);
  assert.deepEqual(plan.steps.map(step => step.tool), [
    'get_trace_context',
    'create_dataset_case_preview',
    'confirm_dataset_case',
  ]);
  assert.deepEqual(plan.steps[2].dependsOn, ['step-2']);
});

test('Copilot planner keeps knowledge questions read-only', () => {
  const plan = buildCopilotPlan('端口是多少？', { intent: 'knowledge', reason: 'test' }, { ...context, sources: [] });
  assert.equal(plan.requiresConfirmation, false);
  assert.deepEqual(plan.steps.map(step => step.kind), ['read', 'analyze']);
});
