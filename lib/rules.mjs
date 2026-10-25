import { contextFor, judgeGrounding } from './grounding.mjs';
import { classifySlot, isMetaSimile } from './lexicon.mjs';
import { hasUsableRewriteContext, redundancyOf } from './rewrite.mjs';
import { gap, overlaps } from './text.mjs';

const SLOT = '[^，。！？…\\n\\r]';
const TAIL = '[^。！？…\\n\\r]';
/** 一个句界：句号、叹号、问号，或一串省略号。紧跟着的换行算同一次。 */
const BOUNDARY = '(?:[。！？]|…+)';
/** 零件之间可以没有标点、是逗号，或至多一个句界。换行算进 \\s。 */
const JOIN = `(?:[，,、]|${BOUNDARY})?\\s*`;
/** 两段式可以再隔一个无关小句。多出来的这一句不判成口癖，交给调用方弃权。 */
const GAP_CLAUSE = '[^。！？…\\n\\r]{1,30}';
const JOIN_GAP = `(?:[，,、]\\s*|${BOUNDARY}\\s*(?:${GAP_CLAUSE}${BOUNDARY}\\s*)?)?`;

export function countSentenceBoundaries(fragment) {
  const re = /(?:[。！？]|…+)[^\S\n]*\n*|\n+/g;
  let count = 0;
  while (re.exec(fragment || '')) count += 1;
  return count;
}

/**
 * 句式形状写在代码里，是因为要切出否定槽再做启发式。
 * 词表里的 shape 决定哪一条启用；关掉某条就从 JSON 里删掉。
 * 词面规则（情绪抹平、比喻套话）的正则放在 JSON，方便直接加。
 */
const SHAPES = {
  'mei-you-ye-mei-you-zhi-shi': {
    specificity: 3,
    stacked: true,
    kind: 'contrast',
    maxBoundaries: 2,
    source: `(?:并)?没有(${SLOT}{1,30}?)${JOIN}也没有(${SLOT}{1,30}?)${JOIN}只是(${TAIL}{1,40})`,
    slots: (match) => ({ negated: [match[1], match[2]], asserted: [match[3]] }),
  },
  'mei-you-ye-mei-you-er-shi': {
    specificity: 3,
    stacked: true,
    kind: 'contrast',
    maxBoundaries: 2,
    source: `(?:并)?没有(${SLOT}{1,30}?)${JOIN}也没有(${SLOT}{1,30}?)${JOIN}而是(${TAIL}{1,40})`,
    slots: (match) => ({ negated: [match[1], match[2]], asserted: [match[3]] }),
  },
  'bu-shi-ye-bu-shi-er-shi': {
    specificity: 3,
    stacked: true,
    kind: 'contrast',
    maxBoundaries: 2,
    source: `(?:(?:并|却)?不是|并非)(${SLOT}{1,30}?)${JOIN}也不是(${SLOT}{1,30}?)${JOIN}而是(${TAIL}{1,40})`,
    slots: (match) => ({ negated: [match[1], match[2]], asserted: [match[3]] }),
  },
  'mei-you-ye-mei-you': {
    specificity: 2,
    stacked: true,
    kind: 'contrast',
    maxBoundaries: 2,
    tightBoundaries: 1,
    source: `(?:并)?没有(${SLOT}{1,30}?)${JOIN_GAP}也没有(${TAIL}{1,30})`,
    slots: (match) => ({ negated: [match[1], match[2]], asserted: [] }),
  },
  'mei-you-zhi-shi': {
    specificity: 2,
    stacked: false,
    kind: 'contrast',
    maxBoundaries: 2,
    tightBoundaries: 1,
    source: `(?:并)?没有(${SLOT}{1,30}?)${JOIN_GAP}只是(${TAIL}{1,40})`,
    slots: (match) => ({ negated: [match[1]], asserted: [match[2]] }),
  },
  'mei-you-er-shi': {
    specificity: 2,
    stacked: false,
    kind: 'contrast',
    maxBoundaries: 2,
    tightBoundaries: 1,
    source: `(?:并)?没有(${SLOT}{1,30}?)${JOIN_GAP}而是(${TAIL}{1,40})`,
    slots: (match) => ({ negated: [match[1]], asserted: [match[2]] }),
  },
  'bu-shi-er-shi': {
    specificity: 2,
    stacked: false,
    kind: 'contrast',
    maxBoundaries: 2,
    tightBoundaries: 1,
    source: `(?:(?:并|却)?不是|并非)(${SLOT}{1,30}?)${JOIN_GAP}而是(${TAIL}{1,40})`,
    slots: (match) => ({ negated: [match[1]], asserted: [match[2]] }),
  },
  'xiang-zai-you-xiang-zai': {
    specificity: 2,
    stacked: false,
    kind: 'simile',
    source: `(?:像是在|像在|仿佛在|好像在)(${SLOT}{1,24}?)[，,、]?\\s*又(?:像是在|像在|仿佛在)(${TAIL}{1,24})`,
    slots: (match) => ({ negated: [], sides: [match[1], match[2]] }),
  },
};

function compilePattern(source) {
  const normalized = source.replaceAll('⏎', '\n\r');
  return new RegExp(normalized, 'g');
}

function matchAll(re, text) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const copy = new RegExp(re.source, flags);
  const found = [];
  let match = copy.exec(text);
  while (match) {
    if (match[0] === '') copy.lastIndex += 1;
    else found.push(match);
    match = copy.exec(text);
  }
  return found;
}

function glued(parts) {
  return parts.some((part) => /也没有|也不是|而是|只是/.test(part));
}

function judgeContrast(negated, { stacked }) {
  const kinds = negated.map((slot) => classifySlot(slot));
  const reasons = [];
  if (kinds.includes('emotion')) reasons.push('negated-slot-emotion');
  if (kinds.includes('speech')) reasons.push('negated-slot-speech-act');
  if (kinds.includes('vague')) reasons.push('negated-slot-vague');
  if (stacked) reasons.push('stacked-negation');

  const emptyCount = kinds.filter((kind) => kind === 'emotion' || kind === 'speech' || kind === 'vague').length;
  const mixedCount = kinds.filter((kind) => kind === 'mixed').length;
  const contentCount = kinds.filter((kind) => kind === 'content').length;

  if (mixedCount > 0 || (emptyCount > 0 && contentCount > 0)) {
    if (!reasons.includes('mixed-slots')) reasons.push('mixed-slots');
    return { verdict: 'indeterminate', confidence: 0.4, reasons };
  }
  if (emptyCount === kinds.length && kinds.length > 0) {
    return { verdict: 'tic', confidence: stacked ? 0.9 : 0.78, reasons, subclass: null };
  }
  return { needsGrounding: true };
}

function judgeSimile(left, right) {
  const metaLeft = isMetaSimile(left);
  const metaRight = isMetaSimile(right);
  if (metaLeft && metaRight) {
    return { verdict: 'tic', confidence: 0.84, reasons: ['simile-meta'], subclass: null };
  }
  if (metaLeft || metaRight) {
    return { verdict: 'indeterminate', confidence: 0.4, reasons: ['simile-partial-meta'], subclass: null };
  }
  const leftKind = classifySlot(left);
  const rightKind = classifySlot(right);
  if (leftKind === 'content' && rightKind === 'content' && (left.length >= 9 || right.length >= 9)) {
    return { verdict: 'clean', confidence: 0.6, reasons: ['simile-concrete'], subclass: null };
  }
  if (leftKind === 'content' && rightKind === 'content') {
    return { verdict: 'indeterminate', confidence: 0.36, reasons: ['simile-short-parallel'], subclass: null };
  }
  return { verdict: 'indeterminate', confidence: 0.38, reasons: ['simile-specific'], subclass: null };
}

function scanShape(rule, text, options) {
  const shape = SHAPES[rule.shape];
  const found = [];
  for (const match of matchAll(shape.re, text)) {
    const parts = shape.slots(match);
    const negated = (parts.negated || []).map((slot) => slot.trim());
    const sides = (parts.sides || []).map((slot) => slot.trim());
    if (negated.some((slot) => !slot) || sides.some((slot) => !slot)) continue;
    const gaps = countSentenceBoundaries(match[0]);
    if (shape.maxBoundaries != null && gaps > shape.maxBoundaries) continue;
    const isGlued = glued(negated);
    let judged;
    if (shape.kind === 'simile') judged = judgeSimile(sides[0], sides[1]);
    else {
      const preliminary = judgeContrast(negated, { stacked: shape.stacked });
      judged = preliminary.needsGrounding
        ? judgeGrounding(negated, contextFor(text, match.index, options.before))
        : preliminary;
      if (shape.tightBoundaries != null && gaps > shape.tightBoundaries && judged.verdict !== 'clean') {
        judged = {
          verdict: 'indeterminate',
          confidence: 0.38,
          reasons: ['cross-sentence-gap'],
          subclass: null,
        };
      }
    }
    found.push({
      ruleId: rule.id,
      category: rule.category,
      title: rule.title,
      description: rule.description,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      verdict: judged.verdict,
      confidence: judged.confidence,
      reasons: gaps > 0 && !judged.reasons.includes('cross-sentence')
        ? [...judged.reasons, 'cross-sentence']
        : judged.reasons,
      subclass: judged.subclass || null,
      specificity: isGlued ? 0 : shape.specificity,
      priority: rule.priority,
      shape: rule.shape,
      slots: { negated, asserted: parts.asserted || [], sides },
      bareSentence: gaps === 0 && !hasUsableRewriteContext(text, match.index, options.before),
    });
  }
  return found;
}

function scanLexical(rule, text) {
  const found = [];
  for (const match of matchAll(rule.re, text)) {
    found.push({
      ruleId: rule.id,
      category: rule.category,
      title: rule.title,
      description: rule.description,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      verdict: 'tic',
      confidence: 0.8,
      reasons: ['lexical'],
      subclass: null,
      specificity: 1,
      priority: rule.priority,
      shape: null,
      slots: null,
    });
  }
  return found;
}

function resolveOverlaps(matches) {
  const groups = new Map();
  for (const match of matches) {
    if (!groups.has(match.category)) groups.set(match.category, []);
    groups.get(match.category).push(match);
  }
  const kept = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      const lengthDelta = (b.end - b.start) - (a.end - a.start);
      if (lengthDelta !== 0) return lengthDelta;
      return a.priority - b.priority;
    });
    const chosen = [];
    for (const match of ranked) {
      if (chosen.some((item) => overlaps(item, match))) continue;
      chosen.push(match);
    }
    kept.push(...chosen);
  }
  kept.sort((a, b) => a.start - b.start || a.end - b.end || a.priority - b.priority);
  return kept;
}

function applyProximity(matches, window) {
  if (!window) return matches;
  const templates = matches.filter((match) => match.category === 'template');
  return matches.map((match) => {
    if (match.category !== 'template' || match.verdict !== 'indeterminate') return match;
    if (match.reasons.includes('no-prior-context') || match.reasons.includes('cross-sentence-gap')) return match;
    const near = templates.some(
      (other) => other !== match && other.verdict !== 'clean' && gap(match, other) <= window,
    );
    if (!near) return match;
    return {
      ...match,
      verdict: 'tic',
      confidence: 0.55,
      reasons: match.reasons.includes('nearby-stack-upgrade')
        ? match.reasons
        : [...match.reasons, 'nearby-stack-upgrade'],
    };
  });
}

export function compileRuleSet(data) {
  if (!data || !Array.isArray(data.rules)) throw new Error('词表需要 rules 数组');
  const categories = new Map();
  for (const category of data.categories || []) {
    if (!category?.id) throw new Error('类别缺少 id');
    categories.set(category.id, category);
  }
  const seen = new Set();
  const shapes = new Set();
  const rules = data.rules.map((rule, index) => {
    if (!rule.id || seen.has(rule.id)) throw new Error(`规则 id 重复或缺失：${rule.id}`);
    seen.add(rule.id);
    if (!categories.has(rule.category)) throw new Error(`规则 ${rule.id} 的类别未定义：${rule.category}`);
    if (!Array.isArray(rule.examples) || rule.examples.length === 0) {
      throw new Error(`规则 ${rule.id} 至少要有一条示例`);
    }
    const compiled = {
      ...rule,
      priority: index,
      title: categories.get(rule.category).title,
    };
    if (rule.kind === 'template') {
      const shape = SHAPES[rule.shape];
      if (!shape) throw new Error(`规则 ${rule.id} 使用了未知句式形状 ${rule.shape}`);
      if (shapes.has(rule.shape)) throw new Error(`句式形状重复：${rule.shape}`);
      shapes.add(rule.shape);
      shape.re = compilePattern(shape.source);
      return compiled;
    }
    if (rule.kind === 'regex') {
      if (!rule.pattern) throw new Error(`规则 ${rule.id} 缺少 pattern`);
      try {
        compiled.re = compilePattern(rule.pattern);
      } catch (error) {
        throw new Error(`规则 ${rule.id} 的正则无法编译：${error.message}`);
      }
      return compiled;
    }
    throw new Error(`规则 ${rule.id} 的 kind 必须是 template 或 regex`);
  });
  return {
    version: data.version || 1,
    name: data.name || 'custom',
    categories: [...categories.values()],
    rules,
  };
}

export function scanText(text, ruleSet, options = {}) {
  const source = text || '';
  const proximity = options.proximity ?? 80;
  const raw = [];
  for (const rule of ruleSet.rules) {
    if (rule.kind === 'template') raw.push(...scanShape(rule, source, options));
    else raw.push(...scanLexical(rule, source));
  }
  const resolved = applyProximity(resolveOverlaps(raw), proximity);
  const hits = [];
  const suppressed = [];
  for (const match of resolved) {
    const view = { ...match };
    delete view.specificity;
    delete view.priority;
    const redundancy = redundancyOf(view);
    if (redundancy) view.redundancy = redundancy;
    if (view.verdict === 'clean') suppressed.push(view);
    else hits.push(view);
  }
  return { hits, suppressed };
}

export function categoryTitle(ruleSet, id) {
  return ruleSet.categories.find((category) => category.id === id)?.title || id;
}
