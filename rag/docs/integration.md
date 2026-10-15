# 集成说明

本文说明如何把知识库助手接入你自己的网站与系统。
核心结论：**宿主只需要一段 `<script>` 标签**，不需要了解任何内部结构。

---

## 零、先配置模型（强烈建议）

未配置模型时系统也能跑，但**检索只有关键词通道**，且回答是检索原文片段而非自然语言。
配置后自动启用混合检索与生成式回答，代码无需改动。

### 最快路径

```bash
cp .env.example .env.local
```

编辑 `.env.local`，至少填这两组：

```ini
# 语义检索
KB_EMBEDDING_MODEL=text-embedding-3-small
KB_EMBEDDING_DIM=1536
KB_EMBEDDING_BASE_URL=https://api.openai.com
KB_EMBEDDING_API_KEY=sk-xxxx

# 生成式回答
KB_LLM_MODEL=deepseek-chat
KB_LLM_BASE_URL=https://api.deepseek.com
KB_LLM_API_KEY=sk-xxxx
```

然后自检：

```bash
npm run cli -- doctor
```

`doctor` 会实际调用一次两个端点，输出类似：

```
模型能力：
  ✔ 语义检索已启用
      模型：text-embedding-3-small
      维度：1536
      端点：https://api.openai.com
  ✔ 生成式回答已启用
      模型：deepseek-chat
      端点：https://api.deepseek.com

连通性探测：
  ✔ embedding 调用成功（312ms，返回 1536 维）
  ✔ 生成模型调用成功（890ms）："ok"
```

任何一项报错都会给出具体原因，不会被静默忽略。

### 配置优先级

```
真实环境变量  >  .env.local  >  .env
```

因此临时用别的模型调试不必改文件：

```bash
KB_LLM_MODEL=deepseek-reasoner npm run cli -- ask mykb "测试问题"
```

### 三个容易踩的坑

**1. 维度必须与模型一致。**
`KB_EMBEDDING_DIM` 填错会导致向量无法比较。`doctor` 会实际调用并比对维度，
不匹配时直接报出期望值与实际值。

**2. 配置 embedding 后必须重建索引。**
已有片段是在没有 embedding 时入库的，没有对应向量。执行一次全量同步：

```bash
npm run cli -- sync mykb ./docs --full
```

之后日常增量同步会自动维护向量。

**3. E5 / BGE 类模型需要指令前缀。**
这类模型文档侧与查询侧要用不同前缀，否则检索质量明显下降：

```ini
# E5 系列
KB_EMBEDDING_DOC_PREFIX=passage: 
KB_EMBEDDING_QUERY_PREFIX=query: 

# BGE 中文
KB_EMBEDDING_QUERY_PREFIX=为这个句子生成表示以用于检索相关文章：
```

OpenAI、通义、智谱的 embedding 模型**不需要前缀，留空即可**。

### 常用供应商配置

```ini
# --- 阿里通义（DashScope 兼容模式）---
KB_EMBEDDING_MODEL=text-embedding-v3
KB_EMBEDDING_DIM=1024
KB_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode
KB_EMBEDDING_API_KEY=sk-xxxx
KB_LLM_MODEL=qwen-plus
KB_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode
KB_LLM_API_KEY=sk-xxxx

# --- 智谱 GLM ---
KB_EMBEDDING_MODEL=embedding-3
KB_EMBEDDING_DIM=2048
KB_EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4
KB_EMBEDDING_API_KEY=xxxx
KB_LLM_MODEL=glm-4-plus
KB_LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
KB_LLM_API_KEY=xxxx

# --- 本地 Ollama（无需密钥，完全离线）---
KB_EMBEDDING_MODEL=nomic-embed-text
KB_EMBEDDING_DIM=768
KB_EMBEDDING_BASE_URL=http://127.0.0.1:11434
KB_EMBEDDING_API_KEY=ollama
KB_LLM_MODEL=qwen2.5:7b
KB_LLM_BASE_URL=http://127.0.0.1:11434
KB_LLM_API_KEY=ollama
```

### 怎么判断配置真的生效了

```bash
npm run cli -- search mykb "你的问题" --top 3
```

看第一行输出：

- `检索模式：hybrid` → 关键词与语义双通道都在工作
- `检索模式：keyword-only（降级：…）` → 只有关键词通道，括号内写明原因

---

## 一、网页插件（推荐方式）

### 1. 准备配置

在服务端创建知识库并拿到两个值：

```bash
kb create mykb --origins "*.your-site.com,localhost:3000"
kb show mykb
```

输出中的 `id` 与 `公开 key` 就是集成所需的两个参数：

```
id：kb_6778ae767cb84862a82b
公开 key：pk_a611413352454c83b6282b51
```

`--origins` 是域名白名单，只有列出的来源才能调用该知识库的公开接口。
留空表示不限制（仅建议开发环境）。

### 2. 加入一行 script 标签

```html
<script src="https://kb.your-host.com/api/public/kb/widget.js"
        data-kb-id="kb_6778ae767cb84862a82b"
        data-api-key="pk_a611413352454c83b6282b51"
        data-title="产品助手"></script>
```

放在 `</body>` 之前即可。页面右下角会出现悬浮图标，点击展开对话框。

跨域部署时如果自动推断的服务地址不对，显式指定：

```html
<script src="https://kb.your-host.com/api/public/kb/widget.js"
        data-kb-id="kb_xxx"
        data-api-key="pk_xxx"
        data-api-base="https://kb.your-host.com"
        data-title="产品助手"></script>
```

### 3. 可选配置项

| 属性 | 默认值 | 说明 |
|-|-|-|
| `data-title` | 知识库助手 | 对话框标题 |
| `data-welcome` | 内置文案 | 打开时的欢迎语 |
| `data-placeholder` | 请输入你的问题… | 输入框提示文字 |
| `data-theme` | `auto` | `light` / `dark` / `auto`（跟随系统） |
| `data-accent` | `#4f46e5` | 主色，用于悬浮按钮和引用标签 |
| `data-position` | `bottom-right` | `bottom-right` / `bottom-left` |
| `data-mode` | `shadow` | `shadow` / `iframe` |

### 4. 关于样式隔离

插件把全部 DOM 挂载在 **Shadow DOM** 内，因此：

- 宿主的全局 CSS（包括 `button { ... !important }` 这类激进规则）不会影响插件外观
- 插件不会向宿主注入任何全局样式

如果你的站点 CSP 禁止内联脚本或 `blob:` 样式，改用 iframe 模式：

```html
<script src="https://kb.your-host.com/api/public/kb/widget.js"
        data-kb-id="kb_xxx" data-api-key="pk_xxx"
        data-mode="iframe"></script>
```

iframe 模式会多一次文档加载，视觉上略有差异，非必要不用。

### 5. 验证集成是否正确

打开浏览器开发者工具的网络面板，筛选 `/api/public/kb/`。正常应只出现：

| 请求 | 触发时机 |
|-|-|
| `GET /api/public/kb/widget.js` | 页面加载 |
| `GET /api/public/kb/{kbId}/config` | 插件初始化（如有） |
| `GET /api/public/kb/{kbId}/chat/stream?message=...` | 每次提问 |
| `GET /api/public/kb/{kbId}/chunks/{chunkId}` | 点击引用 |
| `POST /api/public/kb/feedback` | 提交反馈 |

**如果看到任何其他路径，说明集成有问题** —— 插件本应只依赖这组公开接口。

---

## 二、服务端接口

如果需要在自有后端或 App 中集成，可以直接调用公开接口。

### 鉴权

两种方式，任选其一：

```
请求头：x-kb-key: pk_xxxxxxxx
查询参数：?key=pk_xxxxxxxx
```

`public key` 只能访问公开接口；可以调用网页上传接口提交文档，无法读取管理数据或执行 CLI 管理操作。

插件输入区支持图片上传和模型选择。服务端可通过 `KB_LLM_MODELS=model-a,model-b` 暴露模型列表；
也可以在 script 标签上用 `data-models="model-a,model-b"` 缩小显示列表，但所选模型仍必须在服务端列表中。附件会先通过上传接口导入当前知识库，
图片会以多模态内容随问题发送，不会写入知识库；上传接口仍可用于管理台导入文档，并通过 public key 与来源白名单校验。

桌面端打开态默认是贴右侧的全高侧栏，和悬浮球入口分离；如果宿主更适合旧式浮窗，可加 `data-layout="floating"`。

### 查询耗时与快速模式

问答响应和流式 `done` 事件都带有 `timings`，包括检索、上下文、证据闸门、生成、生成后校验、
本地闸门和总耗时。管理台会按阶段展示耗时条，并标出最慢阶段。

默认会执行生成后校验。对延迟敏感的请求可以在 JSON 请求体中传 `claimCheck: false`，或在流式 URL
中传 `claimCheck=false`，减少一次模型调用；这会放弃生成后的一致性校验，应只在明确接受该取舍时使用。

### 问答（非流式）

```bash
curl -X POST https://kb.your-host.com/api/public/kb/kb_xxx/chat \
  -H 'content-type: application/json' \
  -H 'x-kb-key: pk_xxx' \
  -d '{"message":"服务默认端口是多少？","conversationId":"conv_xxx"}'
```

响应：

```json
{
  "conversationId": "conv_123",
  "messageId": "msg_456",
  "answer": "服务默认监听端口为 3000。[1]",
  "citations": [
    {
      "index": 1,
      "chunkId": "chk_789",
      "documentId": "doc_abc",
      "documentTitle": "运维手册",
      "locator": { "headingPath": ["运维手册", "端口配置"], "lineStart": 3, "lineEnd": 5 },
      "snippet": "服务默认监听端口为 3000…",
      "score": 1.0,
      "kind": "chunk"
    }
  ],
  "gate": {
    "decision": "answerable",
    "stage": "evidence",
    "reason": "检索到的片段完整覆盖了问题所需信息",
    "suggestions": []
  },
  "unsupportedClaimCount": 0,
  "latencyMs": 1320
}
```

### 闸门裁决的含义

`gate.decision` 决定你该如何呈现回答：

| 取值 | 含义 | 建议的处理 |
|-|-|-|
| `answerable` | 证据完整且一致 | 正常展示回答与引用 |
| `partial` | 只覆盖部分方面 | 展示回答，同时高亮 `gate.missing` |
| `conflict` | 多份资料互相矛盾 | 并列展示 `gate.conflicts`，不要替用户选择 |
| `no_evidence` | 证据不足 | 不要展示为答案；展示 `gate.reason` 与 `gate.suggestions` |

**重要**：`no_evidence` 时 `answer` 字段本身就是一段说明「无法可靠回答」的文案，
而不是模型编造的内容。这个判定在调用模型之前就完成了，因此不存在编造的可能。

### 流式问答

```javascript
const params = new URLSearchParams({ message: '服务默认端口是多少？' });
const response = await fetch(
  `https://kb.your-host.com/api/public/kb/kb_xxx/chat/stream?${params}`,
  { headers: { 'x-kb-key': 'pk_xxx' } },
);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  let boundary = buffer.indexOf('\n\n');
  while (boundary >= 0) {
    const raw = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    boundary = buffer.indexOf('\n\n');

    let eventName = 'message';
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;

    const payload = JSON.parse(data);
    if (eventName === 'meta') conversationId = payload.conversationId;
    else if (eventName === 'delta') appendText(payload.text);
    else if (eventName === 'citations') renderCitations(payload);
    else if (eventName === 'done') finish(payload);
    else if (eventName === 'error') handleError(payload);
  }
}
```

事件顺序固定为 `meta → delta* → citations → done → end`。

### 多轮对话

把首次响应中的 `conversationId` 在后续请求中原样回传即可。
上下文由**服务端**维护，客户端只需持有这个标识 ——
刷新页面或换设备都不会丢失会话连续性。

### 引用定位

拿到 `citations[].chunkId` 后：

```bash
curl https://kb.your-host.com/api/public/kb/kb_xxx/chunks/chk_789 \
  -H 'x-kb-key: pk_xxx'
```

响应含完整原文与 `locator`，据此可以定位到：

- PDF：`page` / `pageEnd`
- Excel：`sheet` / `cellRange`
- Markdown、docx：`headingPath`
- 纯文本：`lineStart` / `lineEnd` / `charStart` / `charEnd`

### 反馈

```bash
curl -X POST https://kb.your-host.com/api/public/kb/feedback \
  -H 'content-type: application/json' \
  -H 'x-kb-key: pk_xxx' \
  -d '{"messageId":"msg_456","rating":"down","reason":"答案没有覆盖我关心的场景"}'
```

`rating` 为 `down` 时，该问题会**自动进入未解决问题 backlog**，
知识维护者可在 `kb feedback <kb> --issues` 或 `kb gaps <kb>` 中看到。

---

## 三、把自有内容接入知识库

除了导入文件，你还可以把系统内部的对象作为知识来源。
实现 `DocumentSource` 接口即可：

```typescript
import type { DocumentSource, SourceEntry } from './src/lib/kb/ports.ts';

export class MySystemSource implements DocumentSource {
  readonly name = 'my-system';

  async list(): Promise<SourceEntry[]> {
    // 返回当前可见的全部条目，用于增量同步的差异比对
    return myObjects.map((obj) => ({
      key: obj.id,                       // 稳定标识
      relativePath: `${obj.type}/${obj.id}.md`,
      title: obj.title,
      mimeType: 'text/markdown',
      sizeBytes: obj.content.length,
      mtime: obj.updatedAt,
    }));
  }

  async materialize(entry: SourceEntry) {
    // 把对象内容落成临时文件，供解析器读取
    const path = writeTempFile(entry.key, renderMarkdown(entry.key));
    return {
      path,
      fileName: `${entry.key}.md`,
      mimeType: 'text/markdown',
      cleanup: async () => removeTempFile(path),
    };
  }
}

// 摄取
await engine.ingest({ kbId, source: new MySystemSource() });
```

引擎不关心来源是文件系统还是数据库；
`list()` + `materialize()` 两个方法就足以接入任意数据源。

---

## 四、常见问题

**插件没有出现？**
检查浏览器控制台是否有 `[kb-widget]` 开头的错误。最常见的原因是缺少
`data-kb-id` 或 `data-api-key`。

**调用返回 401？**
`public key` 不正确，或请求头名称写错（应为 `x-kb-key`）。

**调用返回 403？**
该知识库配置了域名白名单，而你的来源不在列表中。
用 `kb show <kb>` 查看当前白名单。

**回答质量不理想？**
先看 `gate.decision` 与 `retrieval` 信息：

- 大量 `no_evidence`：知识库覆盖不足，用 `kb gaps <kb>` 看缺口
- `keyword-only` 模式：未配置 embedding 模型，语义检索关闭
- 引用不准确：检查文档解析质量（`kb docs <kb>` 会列出解析失败的文档）

**如何提升检索效果？**
配置 embedding 模型启用混合检索，这是提升最明显的一步。
纯关键词模式对措辞差异较大的提问命中率有限。
