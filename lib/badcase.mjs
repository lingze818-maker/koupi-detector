export function toBadcase(hit, meta) {
  return {
    id: hit.id,
    source: meta.source || null,
    turn: hit.turn ?? null,
    role: hit.role ?? null,
    speaker: hit.speaker ?? null,
    ruleId: hit.ruleId,
    category: hit.category,
    verdict: hit.verdict,
    attribution: hit.attribution?.confirmed || 'unknown',
    attributionNote: hit.attribution?.note || null,
    text: hit.text,
    context: hit.context,
    reasons: hit.reasons,
    start: hit.start,
    end: hit.end,
    redacted: Boolean(hit.redacted),
    charWindow: hit.redacted ? (hit.charWindow ?? meta.window ?? null) : null,
  };
}

export function toJsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}
