import { countChars } from './text.mjs';
import { scanText } from './rules.mjs';
import { DEFAULTS } from './defaults.mjs';

export function scanDialogue(dialogue, ruleSet, options = {}) {
  const roles = options.roles?.length ? options.roles : DEFAULTS.roles;
  const contextTurns = options.contextTurns ?? DEFAULTS.contextTurns;
  const turns = [];
  const hits = [];
  const suppressed = [];

  dialogue.turns.forEach((turn, index) => {
    const turnNo = index + 1;
    const scanned = roles.includes(turn.role);
    const previous = contextTurns > 0 ? dialogue.turns.slice(Math.max(0, index - contextTurns), index) : [];
    const before = previous.length ? previous.map((item) => item.text).join('\n') : undefined;
    // 每轮单独扫描。句式可以跨过这一轮内部的句界，不把相邻轮拼在一起。
    const local = scanned
      ? scanText(turn.text, ruleSet, { ...options, before })
      : { hits: [], suppressed: [] };
    const turnHits = local.hits.map((hit, hitIndex) => ({
      ...hit,
      id: `t${turnNo}h${hitIndex + 1}`,
      turn: turnNo,
      role: turn.role,
      speaker: turn.speaker || null,
    }));
    const turnSuppressed = local.suppressed.map((hit, hitIndex) => ({
      ...hit,
      id: `t${turnNo}s${hitIndex + 1}`,
      turn: turnNo,
      role: turn.role,
      speaker: turn.speaker || null,
    }));
    hits.push(...turnHits);
    suppressed.push(...turnSuppressed);
    turns.push({
      turn: turnNo,
      role: turn.role,
      speaker: turn.speaker || null,
      text: turn.text,
      chars: countChars(turn.text),
      scanned,
      hits: turnHits,
      suppressed: turnSuppressed,
    });
  });

  const scannedTurns = turns.filter((turn) => turn.scanned);
  return {
    turns,
    hits,
    suppressed,
    chars: scannedTurns.reduce((sum, turn) => sum + turn.chars, 0),
    scannedTurnCount: scannedTurns.filter((turn) => turn.chars > 0).length,
  };
}
