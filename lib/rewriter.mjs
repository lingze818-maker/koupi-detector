/**
 * 改写器。离线模式不调用模型，只套用检测器已经算好的省力改写。
 * 删完如果句子不成立，就保留那一句，不硬删。
 * llm 模式也只改命中 span：有省力改写就直接套用；没有，或套用后成残句，才把那一截交给模型，再拼回原文。
 * 密钥只从环境变量读。
 */

import { textIncomplete } from './complete.mjs';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** 重叠时先留有省力改写的，再留更长的。只改判定为口癖的命中。 */
export function selectRewriteSpans(feedback) {
  const tics = (feedback || []).filter(
    (item) => item && item.verdict === 'tic' && Number.isInteger(item.start) && Number.isInteger(item.end) && item.end > item.start,
  );
  const ranked = [...tics].sort((a, b) => {
    const rewriteDelta = Number(b.rewrite != null) - Number(a.rewrite != null);
    if (rewriteDelta !== 0) return rewriteDelta;
    return (b.end - b.start) - (a.end - a.start);
  });
  const chosen = [];
  for (const item of ranked) {
    if (chosen.some((other) => overlaps(item, other))) continue;
    chosen.push(item);
  }
  return chosen.sort((a, b) => a.start - b.start || a.end - b.end);
}

function removalBounds(text, start, end, replacement) {
  if (replacement) return [start, end];
  let from = start;
  let to = end;
  const next = text[to];
  const prev = text[from - 1];
  if (next === '，' || next === ',') to += 1;
  else if (prev === '，' || prev === ',') from -= 1;
  return [from, to];
}

export function tidyRewrite(text) {
  let out = String(text ?? '');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/，{2,}/g, '，');
  out = out.replace(/,{2,}/g, ',');
  out = out.replace(/。{2,}/g, '。');
  out = out.replace(/，([。！？])/g, '$1');
  out = out.replace(/,([。！？])/g, '$1');
  out = out.replace(/([。！？])，/g, '$1');
  out = out.replace(/^[，,、\s]+/g, '');
  out = out.replace(/[，,、\s]+$/g, '');
  if (/^[。！？\s]+$/.test(out)) return '';
  return out;
}

/** 单句省力改写不加「是」时，句首的「这 / 那」会剩下。把它一并拿掉，避免「这白开水」。 */
function dropBareDemonstrative(text, from, replacement, category) {
  if (category !== 'template') return from;
  if (!replacement || replacement.startsWith('是') || replacement.startsWith('只是')) return from;
  let cursor = from;
  if (text[cursor - 1] === '个' && (text[cursor - 2] === '这' || text[cursor - 2] === '那')) {
    const boundary = text[cursor - 3];
    if (cursor <= 2 || /[。！？\n]/.test(boundary)) return cursor - 2;
  }
  if (text[cursor - 1] === '这' || text[cursor - 1] === '那') {
    const boundary = text[cursor - 2];
    if (cursor <= 1 || /[。！？\n]/.test(boundary)) return cursor - 1;
  }
  return from;
}

function sentenceRanges(text) {
  const ranges = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '。' || text[i] === '！' || text[i] === '？') {
      ranges.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

/**
 * 直接套用省力改写，不检查句子还成不成立。
 * 句式口癖换成省力改写。没有省力改写的词面命中删掉，并吃掉紧挨着的一个逗号。
 */
export function applyEconomy(text, feedback) {
  const source = String(text ?? '');
  const spans = selectRewriteSpans(feedback);
  if (!spans.length) return source;
  const edits = spans.map((span) => {
    const replacement = span.rewrite == null ? '' : String(span.rewrite);
    let [from, to] = removalBounds(source, span.start, span.end, replacement);
    from = dropBareDemonstrative(source, from, replacement, span.category);
    return { from, to, replacement };
  });
  edits.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 0; i < edits.length - 1; i += 1) {
    if (edits[i].to > edits[i + 1].from) edits[i].to = edits[i + 1].from;
  }
  let out = source;
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i];
    out = out.slice(0, edit.from) + edit.replacement + out.slice(edit.to);
  }
  return tidyRewrite(out);
}

/**
 * 离线改写。整段套用后如果还有残句，就按句回退：
 * 一句删完不成立，这一句留原文，别的成立的句子仍用省力改写。
 * 没有口癖时把原文原样返回。
 */
export function economyRewriter(text, feedback) {
  const source = String(text ?? '');
  const spans = selectRewriteSpans(feedback);
  if (!spans.length) return source;
  const full = applyEconomy(source, spans);
  if (!textIncomplete(full)) return full;
  const ranges = sentenceRanges(source);
  let out = '';
  for (const range of ranges) {
    const local = spans
      .filter((span) => span.start >= range.start && span.end <= range.end)
      .map((span) => ({
        ...span,
        start: span.start - range.start,
        end: span.end - range.start,
      }));
    const raw = source.slice(range.start, range.end);
    if (!local.length) {
      out += raw;
      continue;
    }
    const rewritten = applyEconomy(raw, local);
    out += textIncomplete(rewritten) ? raw : rewritten;
  }
  return out;
}

function stripFence(text) {
  const fenced = text.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  return (fenced ? fenced[1] : text).trim();
}

/** 模型若把整句或句外的字一并吐回，就不能当成这一截的替换。 */
function acceptSpanReplacement(sentence, span, replacement) {
  if (replacement === sentence.trim()) return span.text;
  const outside = [
    sentence.slice(0, span.start),
    sentence.slice(span.end),
  ].map((part) => part.replace(/[\s，,。！？、]/g, '')).filter((part) => part.length >= 2);
  if (outside.some((part) => replacement.includes(part))) return span.text;
  return replacement;
}

export function rewritePrompt(span, sentence) {
  const suggestion = span.rewrite == null
    ? '这一截没有省力改写。去掉套话即可，不要补情绪，也不要另起情节。可以输出空字符串。'
    : `离线套用「${span.rewrite || '（删去）'}」后句子不成立。只改这一截，让句子成立。`;
  return [
    '只改下面这一处命中。未列出的字一个都不要动。',
    '不要补情绪，不要补主语，不要加「是」，不要新增情节。',
    '只输出这一截的替换文本，不要输出整句，不要解释。允许空字符串。',
    '',
    `所在句：${sentence}`,
    `命中：${span.text}`,
    `类别：${span.category || '未知'}，规则：${span.ruleId || '未知'}`,
    suggestion,
  ].join('\n');
}

export const REWRITE_SYSTEM = [
  '只替换给出的那一截口癖。未列出的字一个都不要动，调用方会把替换拼回原文。',
  '「他开口。」一类留白算合格人话，不要补情绪。',
  '可以省略主语，不要硬补「他」或「她」。',
  '单句又没有前文时不要加「是」，写成「白开水。」，不要写成「是白开水。」。',
  '不要新增情节。只输出这一截的替换，允许空字符串。',
].join('');

export function createChatRewriter({
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  apiKey = '',
  model = DEFAULT_MODEL,
  timeoutMs = 30000,
} = {}) {
  if (!apiKey) {
    throw new Error('llm 改写器需要环境变量 KOUPI_LLM_API_KEY。没有密钥时用 --rewriter offline。');
  }
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch');
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');

  async function requestReplacement(span, sentence) {
    const response = await fetchImpl(`${root}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: REWRITE_SYSTEM },
          { role: 'user', content: rewritePrompt(span, sentence) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`改写接口返回 ${response.status}`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('改写接口没有返回文本');
    return acceptSpanReplacement(sentence, span, stripFence(content));
  }

  async function rewriteSentence(raw, local) {
    const pending = local.filter((span) => span.rewrite == null);
    const economy = local.filter((span) => span.rewrite != null);
    const economyBroken = economy.length > 0 && textIncomplete(applyEconomy(raw, economy));
    if (!pending.length && !economyBroken) return applyEconomy(raw, local);
    const ask = new Set(pending);
    if (economyBroken) {
      for (const span of economy) ask.add(span);
    }
    const merged = [];
    for (const span of local) {
      if (!ask.has(span)) {
        merged.push(span);
        continue;
      }
      merged.push({ ...span, rewrite: await requestReplacement(span, raw) });
    }
    const rewritten = applyEconomy(raw, merged);
    return textIncomplete(rewritten) ? raw : rewritten;
  }

  return async function chatRewriter(text, feedback) {
    const source = String(text ?? '');
    const spans = selectRewriteSpans(feedback);
    if (!spans.length) return source;
    if (spans.every((span) => span.rewrite != null)) {
      const full = applyEconomy(source, spans);
      if (!textIncomplete(full)) return full;
    }
    const ranges = sentenceRanges(source);
    let out = '';
    const consumed = new Set();
    for (const range of ranges) {
      const raw = source.slice(range.start, range.end);
      const local = spans.filter((span) => span.start >= range.start && span.end <= range.end);
      for (const span of local) consumed.add(span);
      if (!local.length) {
        out += raw;
        continue;
      }
      const shifted = local.map((span) => ({
        ...span,
        start: span.start - range.start,
        end: span.end - range.start,
      }));
      out += await rewriteSentence(raw, shifted);
    }
    const crossing = spans.filter((span) => !consumed.has(span));
    if (!crossing.length || out !== source) return out;
    const economyBroken = textIncomplete(applyEconomy(source, spans));
    const merged = [];
    for (const span of spans) {
      const needsModel = crossing.includes(span) && (span.rewrite == null || economyBroken);
      if (!needsModel) {
        merged.push(span);
        continue;
      }
      merged.push({ ...span, rewrite: await requestReplacement(span, source) });
    }
    const applied = applyEconomy(source, merged);
    return textIncomplete(applied) ? source : applied;
  };
}

export function rewriterFromEnv(mode, env = process.env, options = {}) {
  const name = mode || 'offline';
  if (name === 'offline' || name === 'economy') return economyRewriter;
  if (name === 'llm') {
    return createChatRewriter({
      fetchImpl: options.fetchImpl,
      baseUrl: env.KOUPI_LLM_BASE_URL || DEFAULT_BASE_URL,
      apiKey: env.KOUPI_LLM_API_KEY || '',
      model: env.KOUPI_LLM_MODEL || DEFAULT_MODEL,
      timeoutMs: options.timeoutMs,
    });
  }
  throw new Error(`未知改写器 ${name}。可用 offline 或 llm。`);
}
