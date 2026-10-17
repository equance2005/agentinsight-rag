import { prismaRaw } from '@/lib/storage/prisma';
import type { CopilotPlan } from './contracts';

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

export async function createCopilotRun(user: string, plan: CopilotPlan) {
  const created = await (prismaRaw as any).copilotRun.create({
    data: {
      user,
      goal: plan.goal,
      status: plan.requiresConfirmation ? 'awaiting_confirmation' : 'pending',
      planJson: JSON.stringify(plan),
      steps: {
        create: plan.steps.map((step, ordinal) => ({
          stepKey: step.id,
          ordinal,
          title: step.title,
          tool: step.tool,
          kind: step.kind,
          status: step.status,
          dependsOnJson: JSON.stringify(step.dependsOn),
          requiresConfirmation: step.requiresConfirmation,
        })),
      },
    },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  });
  return serializeRun(created);
}

export async function getCopilotRun(user: string, id: string) {
  const row = await (prismaRaw as any).copilotRun.findFirst({
    where: { id, user },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  });
  return row ? serializeRun(row) : null;
}

export async function updateCopilotRunStep(input: {
  user: string;
  runId: string;
  stepId: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  result?: unknown;
  errorMessage?: string | null;
}) {
  const run = await (prismaRaw as any).copilotRun.findFirst({ where: { id: input.runId, user: input.user }, select: { id: true } });
  if (!run) return null;
  const current = await (prismaRaw as any).copilotRunStep.findFirst({
    where: { id: input.stepId, runId: input.runId },
    select: { id: true, stepKey: true, dependsOnJson: true },
  });
  if (!current) return null;
  if (input.status === 'in_progress' || input.status === 'done') {
    let dependencyKeys: string[] = [];
    try {
      const parsed = JSON.parse(current.dependsOnJson || '[]');
      dependencyKeys = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      dependencyKeys = [];
    }
    if (dependencyKeys.length > 0) {
      const dependencies = await (prismaRaw as any).copilotRunStep.findMany({
        where: { runId: input.runId, stepKey: { in: dependencyKeys } },
        select: { stepKey: true, status: true },
      });
      const statusByKey = new Map(dependencies.map((step: any) => [step.stepKey, step.status]));
      const unfinished = dependencyKeys.filter(key => statusByKey.get(key) !== 'done');
      if (unfinished.length > 0) throw new Error(`步骤依赖尚未完成：${unfinished.join('、')}`);
    }
  }
  const step = await (prismaRaw as any).copilotRunStep.updateMany({
    where: { id: input.stepId, runId: input.runId },
    data: {
      status: input.status,
      resultJson: input.result === undefined ? undefined : JSON.stringify(input.result),
      errorMessage: input.errorMessage ?? null,
    },
  });
  if (step.count === 0) return null;
  const steps = await (prismaRaw as any).copilotRunStep.findMany({ where: { runId: input.runId }, select: { status: true } });
  const nextStatus = steps.some((item: any) => item.status === 'blocked')
    ? 'blocked'
    : steps.every((item: any) => item.status === 'done')
      ? 'done'
      : steps.some((item: any) => item.status === 'in_progress')
        ? 'running'
        : 'awaiting_confirmation';
  await (prismaRaw as any).copilotRun.update({ where: { id: input.runId }, data: { status: nextStatus } });
  return getCopilotRun(input.user, input.runId);
}

function serializeRun(row: any) {
  return {
    id: row.id,
    user: row.user,
    goal: row.goal,
    status: row.status,
    plan: parseJson(row.planJson, {}),
    result: parseJson(row.resultJson, null),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    steps: (row.steps || []).map((step: any) => ({
      id: step.id,
      stepKey: step.stepKey,
      ordinal: step.ordinal,
      title: step.title,
      tool: step.tool,
      kind: step.kind,
      status: step.status,
      dependsOn: parseJson(step.dependsOnJson, []),
      requiresConfirmation: step.requiresConfirmation,
      result: parseJson(step.resultJson, null),
      errorMessage: step.errorMessage,
    })),
  };
}
