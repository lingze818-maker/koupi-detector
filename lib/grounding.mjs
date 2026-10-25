import { normalizeSlot } from './lexicon.mjs';

const SINGLE_STOP = new Set([
  '是', '在', '把', '将', '这', '那', '个', '些', '很', '更', '还', '就', '只', '又', '也', '和', '与', '或', '了', '的', '着', '过',
]);

/** 槽位开头的介词。剥掉之后才拿名词去对前文。 */
const LEADING_PREP = new Set(['从', '对', '被', '为', '向', '往', '朝', '由', '在', '把', '将', '给', '跟', '同', '与', '和']);

/**
 * 这些词以介词字开头，但本身不是「介词 + 名词」。
 * 整槽就是这个词，或更长的说法仍以它起头时，不剥。
 */
const NOT_PREP = /^(?:被单|被窝|被子|被动|被告|为什么|对于|对待|对象|从而|从事|从来|从此|从容|从头|向来|向导|往后|往来|为人|为止|为难|以为)/;

const VAGUE_CORE = new Set([
  '什么', '这个', '那个', '这些', '那些', '这样', '那样', '别的', '其他', '其它', '如此', '怎么', '怎样', '这里', '那里', '别人', '自己', '如何',
]);

function addCore(cores, piece) {
  if (!piece || VAGUE_CORE.has(piece)) return;
  if (piece.length >= 2 || (piece.length === 1 && !SINGLE_STOP.has(piece))) cores.add(piece);
}

/**
 * 介词开头时，另存去掉介词后的说法，以及稍长时的前两字。
 * 「从石阶上来」对得上前文里的「石阶」；「从前」「对方」「被单」不剥。
 */
function prepositionCores(raw, cleaned) {
  if (!cleaned || !raw || NOT_PREP.test(raw) || NOT_PREP.test(cleaned)) return [];
  const prep = raw[0];
  if (!LEADING_PREP.has(prep)) return [];
  let residue = cleaned;
  if (LEADING_PREP.has(residue[0])) residue = residue.slice(1);
  const found = [];
  if (residue.length >= 2 && !VAGUE_CORE.has(residue)) found.push(residue);
  // 被/给/跟/对/为 后面常是名词加动词。从/向/往靠趋向补语把名词留全，不再切前两字，免得「图书馆」被切成「图书」。
  if ('被给跟对为'.includes(prep) && residue.length >= 3) {
    const head = residue.slice(0, 2);
    if (!VAGUE_CORE.has(head)) found.push(head);
  }
  return found;
}

/** 从否定槽里抽出可在前文里检索的说法。单字虚词丢掉，单字实词（茶、酒）保留。 */
export function contentCores(slot) {
  const raw = String(slot || '').replace(/\s+/g, '');
  let text = normalizeSlot(slot);
  text = text.replace(/[的了着过呢吧啊呀嘛]/g, '');
  text = text.replace(/^(?:这个|那个|这些|那些)/, '');
  text = text.replace(/(?:过来|过去|上来|上去|下来|下去|进来|进去|出来|出去|回来|回去|起来)$/g, '');
  text = text.replace(/(?:里面|里边|外面|上边|下边|里|外|上|下|中|内|边|来|去)+$/g, '');
  text = text.replace(/^(?:很|太|更|还|就|只|已经|刚才|方才|一个|一些)+/, '');
  if (!text && !raw) return [];
  const pieces = text.split(/[是在把将与和或]/).map((part) => part.trim()).filter(Boolean);
  const cores = new Set();
  for (const piece of [text, ...pieces]) addCore(cores, piece);
  for (const piece of prepositionCores(raw, text)) addCore(cores, piece);
  return [...cores];
}

export function foldForMention(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[的了着过呢吧啊呀嘛，。！？、,.!?\n\r「」『』“”"'']/g, '');
}

/** true 前文出现过，false 没出现，null 槽位抽不出可检索的说法。 */
export function slotMentioned(slot, prior) {
  const folded = foldForMention(prior);
  const cores = contentCores(slot);
  if (!cores.length) return null;
  return cores.some((core) => folded.includes(foldForMention(core)));
}

/**
 * before === undefined：调用方没提供对话窗口，只能看同轮命中之前的文字。
 * before 是字符串（含空串）：窗口已知，空窗口表示前文没人说过这些选项。
 */
export function contextFor(source, start, before) {
  const prefix = source.slice(0, start);
  const prefixKnown = /[。！？\n]/.test(prefix) || foldForMention(prefix).length >= 6;
  if (before == null) return { text: prefix, known: prefixKnown };
  return { text: `${before}\n${prefix}`, known: true };
}

export function judgeGrounding(negated, context) {
  if (!context.known) {
    return {
      verdict: 'indeterminate',
      confidence: 0.34,
      reasons: ['no-prior-context'],
      subclass: null,
    };
  }
  const states = negated.map((slot) => slotMentioned(slot, context.text));
  if (states.some((state) => state == null)) {
    return {
      verdict: 'indeterminate',
      confidence: 0.36,
      reasons: ['no-prior-context'],
      subclass: null,
    };
  }
  const mentioned = states.filter(Boolean).length;
  if (mentioned === states.length) {
    return {
      verdict: 'clean',
      confidence: 0.74,
      reasons: ['grounded-contrast'],
      subclass: null,
    };
  }
  if (mentioned === 0) {
    return {
      verdict: 'tic',
      confidence: 0.74,
      reasons: ['detour-negation'],
      subclass: 'detour-negation',
    };
  }
  return {
    verdict: 'indeterminate',
    confidence: 0.42,
    reasons: ['detour-partial'],
    subclass: null,
  };
}
