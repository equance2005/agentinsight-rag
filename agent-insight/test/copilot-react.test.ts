import assert from 'node:assert/strict';
import test from 'node:test';
import { isTraceDiagnosisRequest } from '../src/lib/copilot/react';

test('bounded diagnosis only routes requests with an execution context', () => {
  assert.equal(isTraceDiagnosisRequest('分析这条 Trace 的失败步骤', { user: 'alice', pageType: 'trace', objectType: 'execution', objectId: 'exec-1' }), true);
  assert.equal(isTraceDiagnosisRequest('分析这条 Trace 的失败步骤', { user: 'alice', pageType: 'dataset', objectType: 'dataset', objectId: 'dataset-1' }), false);
  assert.equal(isTraceDiagnosisRequest('解释当前 Trace', { user: 'alice', pageType: 'trace', objectType: 'execution', objectId: 'exec-1' }), false);
});
