import { replaceNames, sentenceAround, windowSnippet } from './text.mjs';

function maskText(value, names) {
  if (value == null) return value;
  return replaceNames(String(value), names).text;
}

function maskSlots(slots, names) {
  if (!slots) return slots;
  const mask = (list) => (list || []).map((item) => maskText(item, names));
  return {
    negated: mask(slots.negated),
    asserted: mask(slots.asserted),
    sides: mask(slots.sides),
  };
}

export function presentHit(hit, turnText, options) {
  const names = options.names || [];
  if (!options.redact) {
    return {
      ...hit,
      context: sentenceAround(turnText, hit.start, hit.end),
      redacted: false,
    };
  }
  const window = options.window ?? 24;
  const snippet = windowSnippet(turnText, hit.start, hit.end, window);
  const body = maskText(snippet.snippet, names);
  const prefix = snippet.truncatedBefore ? '…' : '';
  const suffix = snippet.truncatedAfter ? '…' : '';
  return {
    ...hit,
    text: maskText(hit.text, names),
    speaker: hit.speaker ? maskText(hit.speaker, names) : hit.speaker,
    slots: maskSlots(hit.slots, names),
    context: `${prefix}${body}${suffix}`,
    redacted: true,
    charWindow: window,
  };
}

export function presentScan(scan, options) {
  const names = options.names || [];
  const turnText = new Map(scan.turns.map((turn) => [turn.turn, turn.text]));
  const apply = (hit) => presentHit(hit, turnText.get(hit.turn) || '', options);
  const maskSpeaker = (speaker) => {
    if (!options.redact || !speaker) return speaker;
    return replaceNames(speaker, names).text;
  };
  return {
    ...scan,
    hits: scan.hits.map(apply),
    suppressed: scan.suppressed.map(apply),
    turns: scan.turns.map((turn) => ({
      ...turn,
      speaker: maskSpeaker(turn.speaker),
      text: options.redact ? '' : turn.text,
      hits: turn.hits.map((hit) => apply(hit)),
      suppressed: turn.suppressed.map((hit) => apply(hit)),
    })),
  };
}

export function collectNames(dialogue, extra = []) {
  const names = [];
  const push = (name) => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const name of extra) push(name);
  push(dialogue?.character?.name);
  for (const turn of dialogue?.turns || []) push(turn.speaker);
  return names;
}
