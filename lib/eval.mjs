import { scanText } from './rules.mjs';
import { summarizeRedundancy } from './rewrite.mjs';
import { countChars, perKilo } from './text.mjs';

export function predictText(text, ruleSet, options = {}) {
  const { hits } = scanText(text, ruleSet, options);
  if (hits.some((hit) => hit.verdict === 'tic')) return 'positive';
  if (hits.some((hit) => hit.verdict === 'indeterminate')) return 'indeterminate';
  return 'negative';
}

export function summarizeRates(rows) {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  let indeterminateOnTic = 0;
  let indeterminateOnClean = 0;
  let goldUnjudgeable = 0;
  for (const row of rows) {
    if (row.gold === 'unjudgeable') {
      goldUnjudgeable += 1;
      continue;
    }
    if (row.pred === 'indeterminate') {
      if (row.gold === 'tic') indeterminateOnTic += 1;
      else indeterminateOnClean += 1;
      continue;
    }
    if (row.gold === 'tic' && row.pred === 'positive') tp += 1;
    else if (row.gold === 'tic' && row.pred === 'negative') fn += 1;
    else if (row.gold === 'clean' && row.pred === 'positive') fp += 1;
    else if (row.gold === 'clean' && row.pred === 'negative') tn += 1;
  }
  const decidable = tp + fn + fp + tn + indeterminateOnTic + indeterminateOnClean;
  const decidedTic = tp + fn;
  const decidedClean = fp + tn;
  return {
    detectionRate: decidedTic ? tp / decidedTic : null,
    falsePositiveRate: decidedClean ? fp / decidedClean : null,
    indeterminateRate: decidable ? (indeterminateOnTic + indeterminateOnClean) / decidable : null,
    counts: {
      tp,
      fn,
      fp,
      tn,
      indeterminateOnTic,
      indeterminateOnClean,
      decidable,
      goldUnjudgeable,
    },
  };
}

function rewriteRows(list) {
  return list.filter((hit) => hit.redundancy).map((hit) => ({
    ruleId: hit.ruleId,
    verdict: hit.verdict,
    subclass: hit.subclass || null,
    original: hit.redundancy.original,
    rewrite: hit.redundancy.rewrite,
    originalChars: hit.redundancy.originalChars,
    rewriteChars: hit.redundancy.rewriteChars,
    ratio: hit.redundancy.ratio,
    redundantChars: hit.redundancy.redundantChars,
    penalised: hit.verdict === 'tic',
  }));
}

export function summarizeByCategory(items, categories) {
  const decidedClean = items.filter((item) => item.gold === 'clean' && item.pred !== 'indeterminate');
  return (categories || []).map((category) => {
    const positives = items.filter((item) => item.gold === 'tic' && item.category === category.id);
    const decided = positives.filter((item) => item.pred !== 'indeterminate');
    const tp = decided.filter((item) => item.pred === 'positive').length;
    const fn = decided.filter((item) => item.pred === 'negative').length;
    const indeterminate = positives.filter((item) => item.pred === 'indeterminate').length;
    const fp = decidedClean.filter((item) => (item.ticCategories || []).includes(category.id)).length;
    const tn = decidedClean.length - fp;
    return {
      id: category.id,
      title: category.title,
      detectionRate: tp + fn ? tp / (tp + fn) : null,
      falsePositiveRate: fp + tn ? fp / (fp + tn) : null,
      indeterminateRate: positives.length ? indeterminate / positives.length : null,
      counts: { tp, fn, fp, tn, indeterminate, positives: positives.length },
    };
  });
}

export function collectRedundancy(items) {
  const penalised = [];
  const released = [];
  const abstained = [];
  const unscored = [];
  let cleanRedundant = 0;
  for (const item of items) {
    const rows = (item.rewrites || []).map((row) => ({
      id: item.id,
      gold: item.gold,
      note: item.note || '',
      text: item.text,
      ...row,
    }));
    if (item.gold === 'unjudgeable') {
      unscored.push(...rows);
      continue;
    }
    if (item.gold === 'clean') cleanRedundant += item.redundancy?.redundantChars || 0;
    for (const row of rows) {
      if (row.penalised) penalised.push(row);
      else if (row.verdict === 'clean') released.push(row);
      else abstained.push(row);
    }
  }
  const ratios = penalised.map((row) => row.ratio).filter((ratio) => ratio != null && Number.isFinite(ratio));
  const redundantChars = penalised.reduce((sum, row) => sum + row.redundantChars, 0);
  const decidable = items.filter((item) => item.gold !== 'unjudgeable');
  const charsAll = decidable.reduce((sum, item) => sum + (item.chars || 0), 0);
  const charsTic = decidable
    .filter((item) => item.redundancy?.hitCount > 0)
    .reduce((sum, item) => sum + (item.chars || 0), 0);
  return {
    penalised,
    released,
    abstained,
    unscored,
    cleanRedundant,
    hitCount: penalised.length,
    ratioCount: ratios.length,
    mean: ratios.length ? ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length : null,
    max: ratios.length ? Math.max(...ratios) : null,
    min: ratios.length ? Math.min(...ratios) : null,
    redundantChars,
    perKiloAll: perKilo(redundantChars, charsAll),
    perKiloOnTicTexts: perKilo(redundantChars, charsTic),
    charsAll,
    charsTic,
  };
}

export function evaluateGold(gold, ruleSet, options = {}) {
  const items = gold.items.map((item) => {
    const scanOptions = { ...options };
    if (item.hasBefore) scanOptions.before = item.before ?? '';
    else delete scanOptions.before;
    const { hits, suppressed } = scanText(item.text, ruleSet, scanOptions);
    const pred = hits.some((hit) => hit.verdict === 'tic')
      ? 'positive'
      : hits.some((hit) => hit.verdict === 'indeterminate')
        ? 'indeterminate'
        : 'negative';
    const ticHits = hits.filter((hit) => hit.verdict === 'tic');
    const chars = countChars(item.text);
    return {
      id: item.id,
      gold: item.label,
      pred,
      category: item.category,
      text: item.text,
      before: item.hasBefore ? (item.before ?? '') : null,
      chars,
      ruleIds: hits.map((hit) => hit.ruleId),
      verdicts: hits.map((hit) => hit.verdict),
      ticCategories: [...new Set(ticHits.map((hit) => hit.category))],
      suppressed: suppressed.map((hit) => hit.ruleId),
      note: item.note,
      rewrites: [...rewriteRows(hits), ...rewriteRows(suppressed)],
      redundancy: summarizeRedundancy(ticHits, chars),
    };
  });
  return {
    items,
    ...summarizeRates(items.map((item) => ({ gold: item.gold, pred: item.pred }))),
    byCategory: summarizeByCategory(items, ruleSet.categories),
    redundancy: collectRedundancy(items),
  };
}

function formatRate(rate, numerator, denominator) {
  if (rate == null || denominator === 0) return '无法计算';
  return `${numerator}/${denominator} = ${rate.toFixed(3)}`;
}

export function summarizeSubset(result, keep) {
  const items = result.items.filter(keep);
  const categories = (result.byCategory || []).map((category) => ({ id: category.id, title: category.title }));
  return {
    items,
    ...summarizeRates(items.map((item) => ({ gold: item.gold, pred: item.pred }))),
    byCategory: summarizeByCategory(items, categories),
  };
}

export function datasetProfile(items) {
  const labels = { tic: 0, clean: 0, unjudgeable: 0 };
  const ticByCategory = {};
  let withBefore = 0;
  for (const item of items) {
    const label = item.label || item.gold;
    if (labels[label] == null) labels[label] = 0;
    labels[label] += 1;
    if (label === 'tic') {
      const category = item.category || 'none';
      ticByCategory[category] = (ticByCategory[category] || 0) + 1;
    }
    if (item.hasBefore || item.before) withBefore += 1;
  }
  return { total: items.length, labels, ticByCategory, withBefore };
}

export function formatEval(result, title = '金标评测') {
  const counts = result.counts;
  const lines = [];
  lines.push(title);
  lines.push(
    `样本 ${result.items.length}（可判定 ${counts.decidable}，人工不可判定 ${counts.goldUnjudgeable}）`,
  );
  lines.push(`检出率     ${formatRate(result.detectionRate, counts.tp, counts.tp + counts.fn)}`);
  lines.push(`误报率     ${formatRate(result.falsePositiveRate, counts.fp, counts.fp + counts.tn)}`);
  lines.push(
    `不可判定率 ${formatRate(result.indeterminateRate, counts.indeterminateOnTic + counts.indeterminateOnClean, counts.decidable)}`,
  );
  lines.push('');
  lines.push('口径：系统标成不可判定的样本，不进检出率和误报率的分子、分母。');
  lines.push('检出率 = 判成口癖的金标口癖 / 系统作出了判定的金标口癖。');
  lines.push('误报率 = 被判成口癖的金标非口癖 / 系统作出了判定的金标非口癖。');
  lines.push('不可判定率 = 系统不可判定 / 人工可判定的金标。人工自己标了 unjudgeable 的不进这三项。');

  const redundancy = result.redundancy;
  if (redundancy) {
    const mean = redundancy.mean == null ? '—' : redundancy.mean.toFixed(2);
    const max = redundancy.max == null ? '—' : redundancy.max.toFixed(2);
    lines.push('');
    lines.push(`冗余比     计入 ${redundancy.hitCount} 处，均值 ${mean}，最大 ${max}，冗余字 ${redundancy.perKiloAll} /千字（相对人工可判定的文本）`);
    lines.push('口径：只计判定为口癖的句式。前文放行的否定不计入。没有断言可留的命中不进均值，冗余字照计。');
  }

  const misses = result.items.filter((item) => item.gold === 'tic' && item.pred === 'negative');
  const alarms = result.items.filter((item) => item.gold === 'clean' && item.pred === 'positive');
  const held = result.items.filter((item) => item.pred === 'indeterminate' && item.gold !== 'unjudgeable');
  if (misses.length) {
    lines.push('');
    lines.push('漏检');
    for (const item of misses) lines.push(`  ${item.id}　${item.note || ''}`);
  }
  if (alarms.length) {
    lines.push('');
    lines.push('误报');
    for (const item of alarms) lines.push(`  ${item.id}　${item.note || ''}`);
  }
  if (held.length) {
    lines.push('');
    lines.push('系统不可判定');
    for (const item of held) lines.push(`  ${item.id}　金标 ${item.gold}　${item.note || ''}`);
  }
  return `${lines.join('\n')}\n`;
}
