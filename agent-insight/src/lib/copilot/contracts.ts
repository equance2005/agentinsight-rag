import { z } from 'zod';

export const contextSchema = z.object({
  pageType: z.enum(['trace', 'diagnosis', 'dataset', 'evaluation', 'skill', 'unknown']).default('unknown'),
  objectType: z.enum(['execution', 'task', 'dataset', 'case', 'evaluation', 'skillVersion', 'unknown']).default('unknown'),
  objectId: z.string().trim().min(1).max(240).optional(),
  sessionId: z.string().trim().min(1).max(240).optional(),
  version: z.number().int().nonnegative().optional(),
  caseId: z.string().min(1).max(240).optional(),
  snapshot: z.object({ title: z.string().max(240).optional(), summary: z.string().max(1500).optional() }).optional(),
});
export type CopilotPageContext = z.infer<typeof contextSchema>;
export type CopilotContextEnvelope = CopilotPageContext & { user: string };
export interface CopilotSource { id: string; kind: string; label: string; locator: string; href?: string; content: string }
export interface CopilotContextResult {
  envelope: CopilotContextEnvelope;
  sources: CopilotSource[];
  facts: Record<string, unknown>;
  missing: string[];
}
export type WorkflowAction = 'trace_to_dataset' | 'evaluator_draft' | 'run_filter' | 'dataset_delete' | 'experiment_start' | 'skill_publish';
export type CopilotIntent = 'knowledge' | 'context_analysis' | 'how_to' | 'workflow_draft' | 'clarify';
export interface CopilotRoute { intent: CopilotIntent; action?: WorkflowAction; reason: string }
export type CopilotPlanStepKind = 'read' | 'write' | 'analyze';
export type CopilotPlanStepStatus = 'pending' | 'in_progress' | 'done' | 'blocked';
export interface CopilotPlanStep {
  id: string;
  title: string;
  tool: string;
  kind: CopilotPlanStepKind;
  status: CopilotPlanStepStatus;
  dependsOn: string[];
  requiresConfirmation: boolean;
}
export interface CopilotPlan {
  id: string;
  goal: string;
  steps: CopilotPlanStep[];
  requiresConfirmation: boolean;
}
export const workflowInputSchema = z.object({
  datasetId: z.string().max(240).optional(),
  datasetName: z.string().max(120).optional(),
  experimentId: z.string().max(240).optional(),
  sessionId: z.string().max(240).optional(),
  recordId: z.string().max(240).optional(),
  skillName: z.string().max(240).optional(),
  publishKind: z.enum(['workbench', 'optimization']).optional(),
  referenceOutput: z.string().max(16000).optional(),
  evaluatorName: z.string().max(64).optional(),
  evaluatorId: z.string().max(240).optional(),
  instructions: z.string().trim().min(1).max(6000).optional(),
  sampleCaseId: z.string().max(240).optional(),
  systemPrompt: z.string().trim().min(1).max(14000).optional(),
  userPrompt: z.string().max(14000).optional(),
});
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export interface WorkflowPreview {
  previewId: string; action: WorkflowAction; target: string; changes: Record<string, unknown>;
  sources: Omit<CopilotSource, 'content'>[]; missing: string[];
  expiresAt: string; confirmationToken: string;
}

export function classifyIntent(message: string, hasContext: boolean): CopilotRoute {
  const text = message.trim();
  const howTo = /如何|怎么(?:样)?|怎样|是否|能否|可以.*[吗么]|how (?:to|do|can)|what is/i.test(text);
  const sample = /(?:样例|样本|sample|example|评测集|数据集|dataset)/i.test(text);
  const evaluator = /evaluator|评估器|评测器/i.test(text);
  const deleteDataset = /(?:删除|delete).*(?:数据集|评测集|dataset)/i.test(text);
  const startExperiment = /(?:启动|运行|开始|start|run).*(?:实验|评测|experiment)/i.test(text);
  const publishSkill = /(?:发布|publish).*(?:skill|技能)/i.test(text);
  const filter = /筛选|查找.*(?:运行|trace)|找出.*(?:运行|trace)|filter.*(?:run|trace)|find.*(?:run|trace)/i.test(text);
  const command = /创建|生成|起草|调整|修改|准备|帮.*(?:做|写)|create|draft|generate|update/i.test(text);
  const negated = /不要.*(?:创建|生成|修改)|不.*执行|do not|don't/i.test(text);
  if (howTo) return { intent: 'how_to', reason: '方法咨询，只解释操作步骤' };
  if (negated) return { intent: hasContext ? 'context_analysis' : 'knowledge', reason: '用户没有授权工作流操作' };
  if (deleteDataset) return { intent: 'workflow_draft', action: 'dataset_delete', reason: '删除数据集属于破坏性操作，必须预览并确认' };
  if (startExperiment) return { intent: 'workflow_draft', action: 'experiment_start', reason: '启动实验前展示冻结配置并等待确认' };
  if (publishSkill) return { intent: 'workflow_draft', action: 'skill_publish', reason: '发布 Skill 前必须通过质量门禁并等待确认' };
  if (filter) return { intent: 'workflow_draft', action: 'run_filter', reason: '执行可回查的只读运行筛选' };
  if (command && sample && evaluator) return { intent: 'clarify', reason: '请先选择创建样例或起草评估器中的一个操作' };
  if (command && sample) return { intent: hasContext ? 'workflow_draft' : 'clarify', action: 'trace_to_dataset', reason: '先准备 Trace 样例草稿，确认后保存' };
  if (command && evaluator) return { intent: 'workflow_draft', action: 'evaluator_draft', reason: '准备可编辑的评估器草稿' };
  if (/当前|这条|这个|这次|此处|它|这里|诊断|失败|trace|dataset|skill|代码|模型|工具|评测结果|结果|总结|概括|分析|this|current/i.test(text)) {
    return { intent: hasContext ? 'context_analysis' : 'clarify', reason: hasContext ? '分析当前宿主明确选择的对象' : '请先选择需要分析的对象' };
  }
  return { intent: 'knowledge', reason: '查询通用文档知识库' };
}
