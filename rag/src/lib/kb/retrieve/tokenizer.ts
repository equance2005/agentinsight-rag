/**
 * 关键词检索的文本切分。
 *
 * 问题背景：SQLite FTS5 的 unicode61 分词器不做中文分词 —— 实测
 * 「数据库默认端口是 5432。」只切出 `数据库默认端口是` 和 `5432` 两个词元，
 * 因此查询「数据库」永远命中不了。
 *
 * 解决方式：索引与查询两侧使用同一套切分规则，把文本展开为
 * 「原文 + 中文 bigram」的形式再交给 FTS5。bigram 让中文子串查询可命中，
 * ASCII 词保持原样按词匹配。
 */

/** 判断是否为 CJK 字符（含常用扩展区）。 */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // 基本汉字
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0xac00 && code <= 0xd7af) // 韩文
  );
}

/**
 * 把一段文本展开为可索引的 token 串。
 *
 * 输出同时包含：
 *  - 原文（保留英文词与完整短语，供 phrase 查询）
 *  - 每个中文连续片段的全部 bigram（如「数据库默认」→ 数据 据库 库默 默认）
 */
export function expandForIndex(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const grams: string[] = [];
  // 按非 CJK 字符切段，逐段生成 bigram
  const segments = normalized.split(/([^\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+)/);

  for (const segment of segments) {
    if (!segment) continue;
    if (!isCjk(segment[0])) continue; // 非中文段由原文覆盖

    const chars = [...segment];
    if (chars.length === 1) {
      grams.push(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) {
      grams.push(`${chars[i]}${chars[i + 1]}`);
    }
    // 单字也保留，便于「库」这类单字查询
    for (const ch of chars) grams.push(ch);
  }

  // 英文实体经常在文档中写成 "Agent Insight"，用户却会输入
  // "agentinsight"。保留原文词元的同时，补充相邻 ASCII 词的连写别名，
  // 让两种写法都能走 FTS，而不需要昂贵的全表 LIKE 扫描。
  const asciiWords = normalized.match(/[A-Za-z0-9]+/g) ?? [];
  for (const word of asciiWords) grams.push(word.toLowerCase());
  for (let i = 0; i < asciiWords.length - 1; i++) {
    grams.push(`${asciiWords[i]}${asciiWords[i + 1]}`.toLowerCase());
  }

  return grams.length > 0 ? `${normalized} ${grams.join(' ')}` : normalized;
}

/** FTS5 查询语法中的保留字符需要转义，否则用户输入会被当成操作符。 */
export function quoteForFts(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * 构造查询侧的 MATCH 表达式。
 *
 * 用 OR 连接全部候选词元，任一命中即召回；具体排序由调用方按
 * 命中数与 bm25 综合决定。
 */
export function buildMatchExpression(query: string, maxTerms = 40): string | null {
  const normalized = query.trim();
  if (!normalized) return null;

  const terms = new Set<string>();

  // 1) 完整短语（对英文与短查询最精确）
  const phrase = normalized.replace(/\s+/g, ' ').trim();
  if (phrase.length >= 2) terms.add(quoteForFts(phrase));

  // 2) 展开后的 bigram 与单字
  const expanded = expandForIndex(normalized).split(' ').slice(phrase.split(' ').length);
  for (const term of expanded) {
    // 单个 ASCII 字符区分度太低，跳过
    if (term.length === 1 && !isCjk(term)) continue;
    terms.add(quoteForFts(term));
  }

  // 3) 原始 ASCII 词
  for (const word of normalized.split(/[^\p{L}\p{N}_]+/u)) {
    if (word.length >= 2 && !isCjk(word[0])) {
      terms.add(quoteForFts(word));
      // FTS5 前缀查询覆盖用户尚未输完的英文实体，例如
      // `agentinsig` → 已索引的 `agentinsight` 连写别名。
      if (word.length >= 3) terms.add(`${quoteForFts(word)}*`);
    }
  }

  if (terms.size === 0) return null;
  return [...terms].slice(0, maxTerms).join(' OR ');
}

/** 供测试与调试：返回展开后的词元列表。 */
export function tokenizeForIndex(text: string): string[] {
  const expanded = expandForIndex(text);
  return expanded ? expanded.split(' ') : [];
}
