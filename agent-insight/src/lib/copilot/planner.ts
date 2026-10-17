import { randomUUID } from 'node:crypto';
import type { CopilotContextResult, CopilotPlan, CopilotRoute } from './contracts';

type StepInput = {
  title: string;
  tool: string;
  kind: CopilotPlan['steps'][number]['kind'];
  dependsOn?: string[];
  requiresConfirmation?: boolean;
};

function plan(goal: string, steps: StepInput[]): CopilotPlan {
  const ids = steps.map((_, index) => `step-${index + 1}`);
  return {
    id: `plan-${randomUUID()}`,
    goal,
    requiresConfirmation: steps.some(step => step.requiresConfirmation),
    steps: steps.map((step, index) => ({
      id: ids[index],
      title: step.title,
      tool: step.tool,
      kind: step.kind,
      status: 'pending',
      dependsOn: (step.dependsOn ?? []).map(dependency => dependency.startsWith('step-') ? dependency : ids[Number(dependency) - 1]).filter(Boolean),
      requiresConfirmation: step.requiresConfirmation ?? false,
    })),
  };
}

export function buildCopilotPlan(message: string, route: CopilotRoute, context: CopilotContextResult): CopilotPlan {
  const hasContext = context.sources.length > 0;
  if (route.action === 'trace_to_dataset') {
    return plan('把当前 Trace 准备为评测数据集样例', [
      { title: '读取当前 Trace 和交互摘要', tool: 'get_trace_context', kind: 'read' },
      { title: '生成数据集 Case 草稿', tool: 'create_dataset_case_preview', kind: 'write', dependsOn: ['1'], requiresConfirmation: true },
      { title: '确认后写入数据集', tool: 'confirm_dataset_case', kind: 'write', dependsOn: ['2'], requiresConfirmation: true },
    ]);
  }
  if (route.action === 'dataset_create') {
    return plan('创建一个可编辑的评测数据集', [
      { title: '读取当前用户的数据集能力和命名信息', tool: 'get_dataset_context', kind: 'read' },
      { title: '生成数据集定义预览', tool: 'create_dataset_preview', kind: 'write', requiresConfirmation: true },
      { title: '确认后创建数据集', tool: 'confirm_dataset_create', kind: 'write', dependsOn: ['2'], requiresConfirmation: true },
    ]);
  }
  if (route.action === 'evaluator_draft') {
    return plan('创建一个可编辑的评估器草稿', [
      { title: hasContext ? '读取当前对象和可用评估上下文' : '读取当前用户的评估配置', tool: 'get_evaluation_context', kind: 'read' },
      { title: '生成并保存评估器草稿', tool: 'create_evaluator_draft', kind: 'write', dependsOn: ['1'] },
    ]);
  }
  if (route.action === 'run_filter') {
    return plan('使用 Trace 查询工具按条件查找运行记录', [
      { title: '读取当前用户的运行记录', tool: 'list_executions', kind: 'read' },
      { title: '应用筛选条件并返回匹配结果', tool: 'filter_executions', kind: 'analyze', dependsOn: ['1'] },
    ]);
  }
  if (route.action === 'dataset_delete') {
    return plan('删除当前数据集', [
      { title: '读取数据集名称、样例数量和归属', tool: 'get_dataset_context', kind: 'read' },
      { title: '展示删除影响范围和确认提示', tool: 'preview_dataset_delete', kind: 'write', dependsOn: ['1'], requiresConfirmation: true },
      { title: '确认后删除数据集', tool: 'delete_dataset', kind: 'write', dependsOn: ['2'], requiresConfirmation: true },
    ]);
  }
  if (route.action === 'experiment_start') {
    return plan('启动当前实验', [
      { title: '读取实验、Case 和评估器冻结配置', tool: 'get_experiment_config', kind: 'read' },
      { title: '展示执行范围、模型和评估器配置', tool: 'preview_experiment_start', kind: 'analyze', dependsOn: ['1'], requiresConfirmation: true },
      { title: '确认后启动实验运行', tool: 'start_experiment', kind: 'write', dependsOn: ['2'], requiresConfirmation: true },
    ]);
  }
  if (route.action === 'skill_publish') {
    return plan('发布当前 Skill 版本', [
      { title: '读取工作快照、基线版本和质量评估', tool: 'get_skill_publish_context', kind: 'read' },
      { title: '检查静态质量门禁和版本冲突', tool: 'validate_skill_quality_gate', kind: 'analyze', dependsOn: ['1'] },
      { title: '展示版本变更和发布影响', tool: 'preview_skill_publish', kind: 'analyze', dependsOn: ['2'], requiresConfirmation: true },
      { title: '确认后发布 Skill 新版本', tool: 'publish_skill', kind: 'write', dependsOn: ['3'], requiresConfirmation: true },
    ]);
  }
  if (route.intent === 'workflow_draft' && /全流程|闭环|回归实验|端到端|end.?to.?end|regression/i.test(message)) {
    return plan('完成 Trace 到回归实验的跨模块闭环', [
      { title: '读取当前 Trace 和失败证据', tool: 'get_trace_context', kind: 'read' },
      { title: '创建或更新评测数据集样例', tool: 'create_dataset_case_preview', kind: 'write', dependsOn: ['1'], requiresConfirmation: true },
      { title: '创建评估器草稿', tool: 'create_evaluator_draft', kind: 'write', dependsOn: ['2'] },
      { title: '展示实验配置并等待启动确认', tool: 'preview_experiment_start', kind: 'write', dependsOn: ['3'], requiresConfirmation: true },
      { title: '分析实验结果', tool: 'analyze_experiment_result', kind: 'analyze', dependsOn: ['4'] },
      { title: '生成 Skill 修改候选', tool: 'create_skill_candidate', kind: 'write', dependsOn: ['5'], requiresConfirmation: true },
      { title: '发布候选并运行回归实验', tool: 'publish_and_regress_skill', kind: 'write', dependsOn: ['6'], requiresConfirmation: true },
    ]);
  }
  if (route.intent === 'context_analysis') {
    return plan('分析当前页面对象', [
      { title: '读取当前页面对象和关联证据', tool: 'get_page_context', kind: 'read' },
      { title: '基于证据生成分析和下一步建议', tool: 'analyze_context', kind: 'analyze', dependsOn: ['1'] },
    ]);
  }
  if (route.intent === 'how_to') {
    return plan('解释完成当前目标所需的操作步骤', [
      { title: '读取当前页面能力和对象状态', tool: 'get_page_context', kind: 'read' },
      { title: '整理操作顺序、前置条件和注意事项', tool: 'explain_workflow', kind: 'analyze', dependsOn: ['1'] },
    ]);
  }
  if (route.intent === 'clarify') {
    return plan('补齐执行任务所需的信息', [
      { title: '检查当前页面是否有可用对象', tool: 'check_context', kind: 'read' },
      { title: '向用户询问缺失的目标或参数', tool: 'request_clarification', kind: 'analyze', dependsOn: ['1'] },
    ]);
  }
  return plan(message.trim().slice(0, 120), [
    { title: '检索相关知识和当前页面证据', tool: 'retrieve_evidence', kind: 'read' },
    { title: '根据证据生成回答并附带来源', tool: 'answer_with_citations', kind: 'analyze', dependsOn: ['1'] },
  ]);
}
