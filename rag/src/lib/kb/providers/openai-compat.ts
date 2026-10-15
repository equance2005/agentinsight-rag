/**
 * OpenAI 兼容的 Embedding / LLM 提供方。
 *
 * 刻意不依赖任何 SDK，只用 fetch 调 /v1/embeddings 与 /v1/chat/completions，
 * 因此可以对接 DeepSeek、OpenAI、通义、本地 vLLM / Ollama 等任意兼容端点。
 *
 * 未配置时返回 null，引擎自动进入 keyword-only 降级模式。
 */

import type {
  EmbeddingProvider,
  LlmCompletion,
  LlmMessage,
  LlmOptions,
  LlmProvider,
} from '../ports.js';

export interface OpenAiCompatConfig {
  baseUrl: string;
  apiKey: string;
  /** 附加请求头，用于自建网关。 */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface EmbeddingConfig extends OpenAiCompatConfig {
  model: string;
  dim: number;
  /** 部分模型要求文档与查询使用不同前缀。 */
  queryPrefix?: string;
  documentPrefix?: string;
}

export interface ChatConfig extends OpenAiCompatConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function chatEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/openai')
    ? `${normalized}/chat/completions`
    : `${normalizeBaseUrl(normalized)}/v1/chat/completions`;
}

async function postJson(
  url: string,
  body: unknown,
  config: OpenAiCompatConfig,
  signal?: AbortSignal,
  apiKey?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 60_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...((apiKey ?? config.apiKey) ? { authorization: `Bearer ${apiKey ?? config.apiKey}` } : {}),
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dim: number;

  constructor(private readonly config: EmbeddingConfig) {
    this.modelId = config.model;
    this.dim = config.dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const input = this.config.documentPrefix
      ? texts.map((text) => `${this.config.documentPrefix}${text}`)
      : texts;

    const json = (await postJson(
      `${normalizeBaseUrl(this.config.baseUrl)}/v1/embeddings`,
      { model: this.config.model, input },
      this.config,
    )) as { data?: Array<{ embedding?: number[]; index?: number }> };

    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(`embedding 返回数量不匹配：期望 ${texts.length}，实际 ${data.length}`);
    }

    // 按 index 归位，避免服务端乱序返回
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((item) => {
      const values = item.embedding ?? [];
      if (values.length !== this.dim) {
        throw new Error(`embedding 维度不匹配：期望 ${this.dim}，实际 ${values.length}`);
      }
      return Float32Array.from(values);
    });
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embedOne(this.config.queryPrefix ? `${this.config.queryPrefix}${text}` : text);
    return vector;
  }

  private async embedOne(text: string): Promise<Float32Array[]> {
    const json = (await postJson(
      `${normalizeBaseUrl(this.config.baseUrl)}/v1/embeddings`,
      { model: this.config.model, input: [text] },
      this.config,
    )) as { data?: Array<{ embedding?: number[] }> };
    const values = json.data?.[0]?.embedding ?? [];
    if (values.length !== this.dim) {
      throw new Error(`embedding 维度不匹配：期望 ${this.dim}，实际 ${values.length}`);
    }
    return [Float32Array.from(values)];
  }
}

export class OpenAiChatProvider implements LlmProvider {
  readonly modelId: string;

  constructor(private readonly config: ChatConfig) {
    this.modelId = config.model;
  }

  async complete(messages: LlmMessage[], options: LlmOptions = {}): Promise<LlmCompletion> {
    const json = (await postJson(
      chatEndpoint(options.baseUrl ?? this.config.baseUrl),
      {
        model: options.model ?? this.config.model,
        messages: messagesForRequest(messages, options.images),
        temperature: options.temperature ?? this.config.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? this.config.maxTokens,
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      },
      this.config,
      options.signal,
      options.apiKey,
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text,
      usage: json.usage
        ? {
            input: json.usage.prompt_tokens ?? 0,
            output: json.usage.completion_tokens ?? 0,
          }
        : null,
    };
  }

  async *stream(messages: LlmMessage[], options: LlmOptions = {}): AsyncIterable<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 120_000);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(chatEndpoint(options.baseUrl ?? this.config.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...((options.apiKey ?? this.config.apiKey) ? { authorization: `Bearer ${options.apiKey ?? this.config.apiKey}` } : {}),
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify({
          model: options.model ?? this.config.model,
          messages: messagesForRequest(messages, options.images),
          temperature: options.temperature ?? this.config.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? this.config.maxTokens,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
      }
      if (!response.body) throw new Error('流式响应缺少 body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分隔事件
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');

          for (const line of rawEvent.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') return;
            if (!payload) continue;
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) yield delta;
            } catch {
              // 单条 SSE 解析失败不应中断整个流
            }
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

function messagesForRequest(messages: LlmMessage[], images?: Array<{ data: string; mimeType: string }>): unknown[] {
  if (!images || images.length === 0) return messages;
  const lastUser = [...messages].map((message, index) => ({ message, index })).reverse().find((item) => item.message.role === 'user');
  if (!lastUser) return messages;
  return messages.map((message, index) => index === lastUser.index
    ? {
        ...message,
        content: [
          { type: 'text', text: message.content },
          ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
        ],
      }
    : message);
}

// ---------------------------------------------------------------------------
// 从环境变量构造
// ---------------------------------------------------------------------------

export interface ModelEnvironment {
  embedder: EmbeddingProvider | null;
  llm: LlmProvider | null;
  llmModels: string[];
  /** 未配置的原因，供 CLI 与日志说明。 */
  notes: string[];
}

/**
 * 从环境变量构造模型提供方。
 *
 * KB_EMBEDDING_* 未配置时 embedder 为 null，引擎进入 keyword-only 模式 ——
 * 这是有意设计：知识库检索不应因为缺少向量服务而完全不可用。
 */
export function loadModelProviders(env: NodeJS.ProcessEnv = process.env): ModelEnvironment {
  const notes: string[] = [];

  let embedder: EmbeddingProvider | null = null;
  const embeddingModel = env.KB_EMBEDDING_MODEL;
  if (embeddingModel) {
    const dim = Number(env.KB_EMBEDDING_DIM ?? '0');
    if (!dim || Number.isNaN(dim)) {
      notes.push('KB_EMBEDDING_MODEL 已设置但 KB_EMBEDDING_DIM 无效，语义检索不可用');
    } else {
      embedder = new OpenAiEmbeddingProvider({
        model: embeddingModel,
        dim,
        baseUrl: env.KB_EMBEDDING_BASE_URL ?? 'https://api.openai.com',
        apiKey: env.KB_EMBEDDING_API_KEY ?? '',
        queryPrefix: env.KB_EMBEDDING_QUERY_PREFIX,
        documentPrefix: env.KB_EMBEDDING_DOC_PREFIX,
      });
    }
  } else {
    notes.push('未配置 KB_EMBEDDING_MODEL，语义检索关闭，使用纯关键词检索');
  }

  let llm: LlmProvider | null = null;
  const chatModel = env.KB_LLM_MODEL;
  if (chatModel) {
    llm = new OpenAiChatProvider({
      model: chatModel,
      baseUrl: env.KB_LLM_BASE_URL ?? 'https://api.openai.com',
      apiKey: env.KB_LLM_API_KEY ?? '',
      temperature: env.KB_LLM_TEMPERATURE ? Number(env.KB_LLM_TEMPERATURE) : undefined,
      maxTokens: env.KB_LLM_MAX_TOKENS ? Number(env.KB_LLM_MAX_TOKENS) : undefined,
    });
  } else {
    notes.push('未配置 KB_LLM_MODEL，将返回检索原文而非生成式回答');
  }

  const llmModels = [...new Set(
    (env.KB_LLM_MODELS ?? '').split(',').map((model) => model.trim()).filter(Boolean),
  )];
  if (chatModel && !llmModels.includes(chatModel)) llmModels.unshift(chatModel);
  return { embedder, llm, llmModels, notes };
}
