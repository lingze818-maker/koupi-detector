import { foldForMention } from './grounding.mjs';
import { countChars, perKilo } from './text.mjs';

/**
 * 最短改写只留断言。不调用模型。
 * 「不是…而是…」默认收成「是 + 断言」。
 * 整段命中落在同一句、而且没有可用前文时，断言前不加「是」：
 * 「这不是茶，也不是酒，而是白开水」收成「白开水」。
 * 有前文，或命中本身跨了句界，仍保留「是」，用来接上谓词。
 * 「没有 A，也没有 B」没有断言可留，改写是空串。
 * 「像在 A，又像是在 B」没有断言之分，只留后一侧。
 */
const SHI = new Set([
  'bu-shi-er-shi',
  'bu-shi-ye-bu-shi-er-shi',
  'mei-you-er-shi',
  'mei-you-ye-mei-you-er-shi',
]);

const ZHI = new Set([
  'mei-you-zhi-shi',
  'mei-you-ye-mei-you-zhi-shi',
]);

function cleanSlot(value) {
  return String(value || '')
    .trim()
    .replace(/^[，,、；;：:\s]+/u, '')
    .replace(/[。！？!?，,、；;\s]+$/u, '');
}

function withMarker(marker, body) {
  const text = cleanSlot(body);
  if (!text) return '';
  if (text.startsWith(marker)) return text;
  return `${marker}${text}`;
}

const BARE_SUBJECT = /^(?:这|那|他|她|我|其|这个|那个|这些|那些)$/;

/** 命中前面有没有能把「是」接上去的前文。光杆的「这 / 那 / 他」不算。 */
export function hasUsableRewriteContext(source, start, before) {
  const prefix = String(source || '').slice(0, Math.max(0, start || 0));
  const prior = before == null ? prefix : `${before}\n${prefix}`;
  const folded = foldForMention(prior);
  if (!folded || BARE_SUBJECT.test(folded)) return false;
  return true;
}

export function minimalRewrite(hit) {
  if (!hit || hit.category !== 'template') return null;
  const slots = hit.slots || {};
  if (SHI.has(hit.shape)) {
    const body = (slots.asserted || [])[0];
    if (hit.bareSentence) return cleanSlot(body);
    return withMarker('是', body);
  }
  if (ZHI.has(hit.shape)) return withMarker('只是', (slots.asserted || [])[0]);
  if (hit.shape === 'mei-you-ye-mei-you') return '';
  if (hit.shape === 'xiang-zai-you-xiang-zai') {
    const sides = slots.sides || [];
    const side = cleanSlot(sides[1] || sides[0] || '');
    if (!side) return '';
    if (side.startsWith('像')) return side;
    return `像是在${side}`;
  }
  return null;
}

export function redundancyOf(hit) {
  const rewrite = minimalRewrite(hit);
  if (rewrite == null) return null;
  const originalChars = countChars(hit.text);
  const rewriteChars = countChars(rewrite);
  return {
    original: hit.text,
    rewrite,
    originalChars,
    rewriteChars,
    redundantChars: Math.max(0, originalChars - rewriteChars),
    ratio: rewriteChars > 0 ? originalChars / rewriteChars : null,
  };
}

/** 只统计判定为口癖的句式。放行和不可判定不进均值、最大值、每千字。 */
export function summarizeRedundancy(hits, textChars) {
  const scored = (hits || []).filter(
    (hit) => hit && hit.category === 'template' && hit.verdict === 'tic' && hit.redundancy,
  );
  const ratios = scored
    .map((hit) => hit.redundancy.ratio)
    .filter((ratio) => ratio != null && Number.isFinite(ratio));
  const redundantChars = scored.reduce((sum, hit) => sum + hit.redundancy.redundantChars, 0);
  return {
    hitCount: scored.length,
    ratioCount: ratios.length,
    mean: ratios.length ? ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length : null,
    max: ratios.length ? Math.max(...ratios) : null,
    redundantChars,
    redundantPerKilo: perKilo(redundantChars, textChars),
  };
}
