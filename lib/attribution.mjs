import { ATTRIBUTION_CANDIDATES } from './defaults.mjs';

function norm(text) {
  return String(text || '').replace(/\s+/g, '').replace(/[，。！？、,.!?]/g, '');
}

function matches(hit, item) {
  const target = item.match || {};
  if (target.ruleId && target.ruleId !== hit.ruleId) return false;
  if (target.turn != null && Number(target.turn) !== hit.turn) return false;
  if (!target.text) return Boolean(target.ruleId);
  const left = norm(hit.text);
  const right = norm(target.text);
  return left === right || left.includes(right) || right.includes(left);
}

export function applyAttributions(hits, annotation) {
  const items = annotation?.items || [];
  for (const item of items) {
    if (!ATTRIBUTION_CANDIDATES.includes(item.attribution)) {
      throw new Error(`未知归因标签：${item.attribution}`);
    }
  }
  return hits.map((hit) => {
    const found = items.find((item) => matches(hit, item));
    return {
      ...hit,
      attribution: {
        candidates: [...ATTRIBUTION_CANDIDATES],
        suggested: 'unknown',
        confirmed: found ? found.attribution : null,
        note: found?.note || null,
      },
    };
  });
}
