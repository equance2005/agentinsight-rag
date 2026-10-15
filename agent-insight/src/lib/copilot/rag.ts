import type { CopilotSource } from './contracts';

type RagCitation = {
  index?: number;
  chunkId?: string;
  documentId?: string;
  documentTitle?: string;
  locator?: Record<string, unknown>;
  snippet?: string;
  score?: number;
};

type RagResponse = {
  answer?: string;
  citations?: RagCitation[];
};

export type RagEvidenceResult = {
  configured: boolean;
  sources: CopilotSource[];
  missing: string[];
};

function config() {
  const baseUrl = String(process.env.AGENT_INSIGHT_RAG_BASE_URL || '').trim().replace(/\/$/, '');
  const kbId = String(process.env.AGENT_INSIGHT_RAG_KB_ID || '').trim();
  const apiKey = String(process.env.AGENT_INSIGHT_RAG_API_KEY || '').trim();
  const origin = String(process.env.AGENT_INSIGHT_RAG_ORIGIN || '').trim();
  return { baseUrl, kbId, apiKey, origin };
}

function locatorText(locator: Record<string, unknown> | undefined): string {
  if (!locator) return '';
  return Object.entries(locator).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => `${key}:${Array.isArray(value) ? value.join('/') : String(value)}`).join(', ');
}

export async function searchRagKnowledge(query: string, signal?: AbortSignal): Promise<RagEvidenceResult> {
  const { baseUrl, kbId, apiKey, origin } = config();
  if (!baseUrl && !kbId && !apiKey) return { configured: false, sources: [], missing: [] };
  if (!baseUrl || !kbId || !apiKey) return { configured: false, sources: [], missing: ['RAG 知识库配置不完整，请设置 AGENT_INSIGHT_RAG_BASE_URL、AGENT_INSIGHT_RAG_KB_ID 和 AGENT_INSIGHT_RAG_API_KEY'] };

  try {
    const response = await fetch(`${baseUrl}/api/public/kb/${encodeURIComponent(kbId)}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kb-key': apiKey, ...(origin ? { origin } : {}) },
      body: JSON.stringify({ message: query, topK: 6, claimCheck: false }),
      signal,
    });
    const payload = await response.json().catch(() => ({})) as RagResponse & { error?: string };
    if (!response.ok) throw new Error(payload.error || `RAG 请求失败（${response.status}）`);
    const citations = Array.isArray(payload.citations) ? payload.citations : [];
    const sources = citations.filter(item => typeof item.snippet === 'string' && item.snippet.trim()).slice(0, 6).map((item, index) => ({
      id: `rag-${item.chunkId || item.documentId || index + 1}`,
      kind: 'knowledge',
      label: item.documentTitle || '知识库文档',
      locator: locatorText(item.locator) || `citation:${item.index || index + 1}`,
      href: `${baseUrl}/demo/`,
      content: item.snippet!.slice(0, 7000),
    }));
    if (sources.length > 0) return { configured: true, sources, missing: [] };
    if (payload.answer?.trim()) return { configured: true, sources: [{ id: 'rag-answer', kind: 'knowledge-answer', label: 'RAG 知识库回答', locator: 'rag:answer', content: payload.answer.slice(0, 7000) }], missing: ['RAG 未返回可定位的引用片段，知识库回答仅作为辅助证据'] };
    return { configured: true, sources: [], missing: ['RAG 未返回匹配的知识库证据'] };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { configured: true, sources: [], missing: [`RAG 知识库暂时不可用：${error instanceof Error ? error.message : '未知错误'}`] };
  }
}
