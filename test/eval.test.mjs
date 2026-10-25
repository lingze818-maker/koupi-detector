import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGold, formatEval, summarizeRates } from '../lib/eval.mjs';
import { parseGold } from '../lib/dialogue.mjs';
import { loadRuleSet } from '../lib/io.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('三率按弃权排除口径计算，误报分子单独可见', () => {
  const result = summarizeRates([
    { gold: 'tic', pred: 'positive' },
    { gold: 'tic', pred: 'positive' },
    { gold: 'tic', pred: 'negative' },
    { gold: 'tic', pred: 'indeterminate' },
    { gold: 'clean', pred: 'positive' },
    { gold: 'clean', pred: 'negative' },
    { gold: 'clean', pred: 'negative' },
    { gold: 'clean', pred: 'indeterminate' },
    { gold: 'unjudgeable', pred: 'positive' },
  ]);
  assert.equal(result.counts.tp, 2);
  assert.equal(result.counts.fn, 1);
  assert.equal(result.counts.fp, 1);
  assert.equal(result.counts.tn, 2);
  assert.equal(result.counts.indeterminateOnTic, 1);
  assert.equal(result.counts.indeterminateOnClean, 1);
  assert.equal(result.counts.goldUnjudgeable, 1);
  assert.equal(result.counts.decidable, 8);
  assert.equal(result.detectionRate, 2 / 3);
  assert.equal(result.falsePositiveRate, 1 / 3);
  assert.equal(result.indeterminateRate, 2 / 8);
  const text = formatEval({ ...result, items: [] });
  assert.match(text, /检出率/);
  assert.match(text, /误报率/);
  assert.match(text, /不可判定率/);
});

test('虚构金标：检出 81/81，误报 0/66，不可判定 16/163', () => {
  const expectPred = {
    g01: 'positive',
    g02: 'positive',
    g03: 'positive',
    g04: 'positive',
    g05: 'positive',
    g06: 'positive',
    g07: 'positive',
    g08: 'positive',
    g09: 'positive',
    g10: 'indeterminate',
    g11: 'positive',
    g12: 'positive',
    g13: 'positive',
    g14: 'positive',
    g15: 'positive',
    g16: 'negative',
    g17: 'negative',
    g18: 'negative',
    g19: 'negative',
    g20: 'indeterminate',
    g21: 'positive',
    g22: 'indeterminate',
    g23: 'negative',
    g24: 'positive',
    g25: 'negative',
    g26: 'positive',
    g27: 'positive',
    g28: 'positive',
    g29: 'positive',
    g30: 'negative',
    g31: 'negative',
    g32: 'indeterminate',
    g33: 'indeterminate',
  };
  const gold = parseGold(readFileSync(join(root, 'examples', 'gold.json'), 'utf8'));
  assert.equal(gold.items.length, 167);
  const rules = loadRuleSet(join(root, 'tics', 'default.json'));
  const result = evaluateGold(gold, rules);
  for (const [id, pred] of Object.entries(expectPred)) {
    const item = result.items.find((row) => row.id === id);
    assert.equal(item.pred, pred, `${id} 期望 ${pred}，实际 ${item.pred}，规则 ${item.ruleIds.join(',')}`);
  }
  assert.equal(result.counts.tp, 81);
  assert.equal(result.counts.fn, 0);
  assert.equal(result.counts.fp, 0);
  assert.equal(result.counts.tn, 66);
  assert.equal(result.counts.indeterminateOnTic, 10);
  assert.equal(result.counts.indeterminateOnClean, 6);
  assert.equal(result.counts.goldUnjudgeable, 4);
  assert.equal(result.detectionRate, 1);
  assert.equal(result.falsePositiveRate, 0);
  assert.equal(result.indeterminateRate, 16 / 163);

  const template = result.byCategory.find((category) => category.id === 'template');
  assert.equal(template.counts.tp, 31);
  assert.equal(template.counts.fn, 0);
  assert.equal(template.counts.indeterminate, 10);
  assert.equal(template.counts.fp, 0);
  assert.equal(template.detectionRate, 1);
  for (const id of ['emotion-flat', 'metaphor']) {
    const category = result.byCategory.find((row) => row.id === id);
    assert.equal(category.counts.positives, 25, id);
    assert.equal(category.counts.tp, 25, id);
    assert.equal(category.counts.fp, 0, id);
  }
  assert.equal(gold.items.filter((item) => item.label === 'clean').length, 72);

  const g09 = result.items.find((item) => item.id === 'g09');
  assert.equal(g09.rewrites.find((row) => row.penalised).rewrite, '是把话放平');
  const g26 = result.items.find((item) => item.id === 'g26');
  assert.equal(g26.rewrites.find((row) => row.penalised).rewrite, '只是看着她');
  const g13 = result.items.find((item) => item.id === 'g13');
  assert.equal(g13.rewrites.find((row) => row.penalised).rewrite, '是白开水');
  const g24 = result.items.find((item) => item.id === 'g24');
  assert.equal(g24.rewrites.find((row) => row.penalised).rewrite, '只是白水');
  assert.ok(g24.redundancy.redundantChars > 0);
  for (const id of ['g23', 'g25']) {
    const item = result.items.find((row) => row.id === id);
    assert.equal(item.redundancy.redundantChars, 0, id);
    assert.equal(item.redundancy.hitCount, 0, id);
    assert.ok(item.rewrites.some((row) => row.verdict === 'clean' && row.penalised === false), id);
  }
  assert.equal(result.redundancy.cleanRedundant, 0);
  assert.equal(result.redundancy.penalised.some((row) => row.id === 'g21'), false);
  assert.ok(result.redundancy.unscored.some((row) => row.id === 'g21'));
  assert.ok(result.redundancy.mean > 1);
  assert.ok(result.redundancy.max >= result.redundancy.mean);
  assert.equal(result.items.find((item) => item.id === 'g95').pred, 'indeterminate');
  assert.equal(result.items.find((item) => item.id === 'g115').pred, 'negative');
  assert.equal(result.items.find((item) => item.id === 'g151').pred, 'negative');
  assert.equal(result.items.find((item) => item.id === 'g157').pred, 'positive');
  assert.equal(result.items.find((item) => item.id === 'g161').pred, 'indeterminate');
  assert.equal(result.items.find((item) => item.id === 'g164').pred, 'negative');
  assert.equal(result.items.find((item) => item.id === 'g165').pred, 'negative');
  assert.equal(result.items.find((item) => item.id === 'g166').pred, 'indeterminate');
});

test('留出集和金标分开计三率，文本不重复', () => {
  const gold = parseGold(readFileSync(join(root, 'examples', 'gold.json'), 'utf8'));
  const holdout = parseGold(readFileSync(join(root, 'examples', 'holdout.json'), 'utf8'));
  assert.equal(holdout.items.length, 52);
  const goldKeys = new Set(gold.items.map((item) => `${item.before || ''}\n${item.text}`));
  for (const item of holdout.items) {
    assert.equal(goldKeys.has(`${item.before || ''}\n${item.text}`), false, item.id);
    assert.equal(gold.items.some((row) => row.id === item.id), false, item.id);
  }
  assert.equal(holdout.items.filter((item) => item.label === 'tic' && item.category === 'emotion-flat').length, 8);
  assert.equal(holdout.items.filter((item) => item.label === 'tic' && item.category === 'metaphor').length, 8);
  assert.ok(holdout.items.filter((item) => item.label === 'clean').length >= 20);
  const rules = loadRuleSet(join(root, 'tics', 'default.json'));
  const result = evaluateGold(holdout, rules);
  assert.equal(result.counts.tp, 22);
  assert.equal(result.counts.fn, 0);
  assert.equal(result.counts.fp, 0);
  assert.equal(result.counts.tn, 23);
  assert.equal(result.counts.indeterminateOnTic, 4);
  assert.equal(result.counts.indeterminateOnClean, 2);
  assert.equal(result.detectionRate, 1);
  assert.equal(result.falsePositiveRate, 0);
  assert.equal(result.indeterminateRate, 6 / 51);
  assert.equal(result.items.find((item) => item.id === 'h30').pred, 'negative');
  assert.equal(result.items.find((item) => item.id === 'h26').pred, 'indeterminate');
  assert.equal(result.items.find((item) => item.id === 'h37').pred, 'negative');
});

test('留出集 v2 定稿后只记这一次的三率', () => {
  const v2 = parseGold(readFileSync(join(root, 'examples', 'holdout-v2.json'), 'utf8'));
  assert.equal(v2.items.length, 52);
  assert.equal(v2.items.filter((item) => item.label === 'tic' && item.category === 'emotion-flat').length, 8);
  assert.equal(v2.items.filter((item) => item.label === 'tic' && item.category === 'metaphor').length, 8);
  const rules = loadRuleSet(join(root, 'tics', 'default.json'));
  const result = evaluateGold(v2, rules);
  assert.equal(result.counts.tp, 14);
  assert.equal(result.counts.fn, 8);
  assert.equal(result.counts.fp, 0);
  assert.equal(result.counts.tn, 23);
  assert.equal(result.counts.indeterminateOnTic, 4);
  assert.equal(result.counts.indeterminateOnClean, 2);
  assert.equal(result.detectionRate, 14 / 22);
  assert.equal(result.falsePositiveRate, 0);
  assert.equal(result.indeterminateRate, 6 / 51);
  for (const id of ['v05', 'v06', 'v07', 'v08', 'v13', 'v14', 'v15', 'v16']) {
    assert.equal(result.items.find((item) => item.id === id).pred, 'negative', id);
  }
  assert.equal(result.items.find((item) => item.id === 'v28').pred, 'negative');
  assert.equal(result.items.find((item) => item.id === 'v21').pred, 'indeterminate');
});
