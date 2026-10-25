import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDialogue, parseGold } from '../lib/dialogue.mjs';
import { evaluateGold } from '../lib/eval.mjs';
import { formatEvalReport } from '../lib/eval-report.mjs';
import { loadRuleSet } from '../lib/io.mjs';
import { buildReport, formatReport, formatScan } from '../lib/report.mjs';
import { minimalRewrite, summarizeRedundancy } from '../lib/rewrite.mjs';
import { economyRewriter } from '../lib/rewriter.mjs';
import { scanText } from '../lib/rules.mjs';
import { scanDialogue } from '../lib/scan.mjs';
import { countChars, perKilo } from '../lib/text.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = loadRuleSet(join(root, 'tics', 'default.json'));

function first(text, before) {
  const { hits, suppressed } = scanText(text, rules, before == null ? {} : { before });
  const template = [...hits, ...suppressed].find((hit) => hit.category === 'template');
  return { hits, suppressed, hit: template, released: suppressed[0] };
}

test('最短改写只留断言', () => {
  const tea = first('不是茶，也不是酒，而是白开水。', '灯还亮着。');
  assert.equal(tea.hit.redundancy.rewrite, '是白开水');
  assert.equal(tea.hit.redundancy.ratio, tea.hit.redundancy.originalChars / tea.hit.redundancy.rewriteChars);
  assert.ok(tea.hit.redundancy.ratio > 1);
  assert.equal(tea.hit.redundancy.redundantChars, tea.hit.redundancy.originalChars - tea.hit.redundancy.rewriteChars);

  assert.equal(first('没有糖，只是白水。', '灯还亮着。').hit.redundancy.rewrite, '只是白水');
  assert.equal(first('不是责备，而是把杯子放下。', '灯还亮着。').hit.redundancy.rewrite, '是把杯子放下');
  assert.equal(first('没有责备，而是把杯子放下。', '灯还亮着。').hit.redundancy.rewrite, '是把杯子放下');
  assert.equal(
    first('没有责备，也没有解释，而是把杯子放下。', '灯还亮着。').hit.redundancy.rewrite,
    '是把杯子放下',
  );
  assert.equal(
    first('没有生气，也没有惊讶，只是看着她。', '灯还亮着。').hit.redundancy.rewrite,
    '只是看着她',
  );

  const empty = first('他没有调侃，也没有笑意。');
  assert.equal(empty.hit.redundancy.rewrite, '');
  assert.equal(empty.hit.redundancy.ratio, null);
  assert.equal(empty.hit.redundancy.redundantChars, empty.hit.redundancy.originalChars);

  const simile = first('像在陈述事实，又像是在念一份结论。');
  assert.equal(simile.hit.redundancy.rewrite, '像是在念一份结论');
  assert.ok(simile.hit.redundancy.ratio > 1);

  const across = first('不是责备。而是把话放平。');
  assert.equal(across.hit.redundancy.rewrite, '是把话放平');
  assert.equal(across.hit.redundancy.ratio, across.hit.redundancy.originalChars / across.hit.redundancy.rewriteChars);
  assert.ok(across.hit.text.includes('。'));

  const stacked = first('没有生气。也没有惊讶。只是看着她。');
  assert.equal(stacked.hit.redundancy.rewrite, '只是看着她');
  const water = first('不是茶。也不是酒。而是白开水。', '灯还亮着。');
  assert.equal(water.hit.redundancy.rewrite, '是白开水');
  const bare = first('这不是茶，也不是酒，而是白开水。');
  assert.equal(bare.hit.redundancy.rewrite, '白开水');
  assert.equal(bare.hit.bareSentence, true);
  assert.equal(economyRewriter('这不是茶，也不是酒，而是白开水。', [{
    ...bare.hit,
    verdict: 'tic',
    rewrite: bare.hit.redundancy.rewrite,
  }]), '白开水。');
  assert.equal(first('这不是茶，也不是酒，而是白开水。', '灯还亮着。').hit.redundancy.rewrite, '是白开水');
  assert.equal(first('这不是茶，也不是酒，而是白开水。', '').hit.redundancy.rewrite, '白开水');
  assert.equal(first('不是责备，也不是安慰，而是把话放平。').hit.redundancy.rewrite, '把话放平');
  assert.equal(first('不是责备，也不是安慰，而是把话放平。', '灯还亮着。').hit.redundancy.rewrite, '是把话放平');
  assert.equal(first('账本在灯下。不是茶，也不是酒，而是白开水。').hit.redundancy.rewrite, '是白开水');
  const wrapped = first('没有茶叶。\n只是一壶白开水。', '灯在桌上。');
  assert.equal(wrapped.hit.redundancy.rewrite, '只是一壶白开水');
});

test('断言槽已经带标记时不重复', () => {
  assert.equal(minimalRewrite({
    category: 'template',
    shape: 'bu-shi-er-shi',
    slots: { asserted: ['是白开水'] },
    text: '不是茶，而是是白开水',
  }), '是白开水');
  assert.equal(minimalRewrite({
    category: 'template',
    shape: 'mei-you-zhi-shi',
    slots: { asserted: ['只是看着她'] },
    text: '没有生气，只是看着她',
  }), '只是看着她');
  assert.equal(minimalRewrite({ category: 'emotion-flat', text: '语气很平' }), null);
});

test('汇总只惩罚判定为口癖的句式', () => {
  const summary = summarizeRedundancy([
    { category: 'template', verdict: 'tic', redundancy: { ratio: 2, redundantChars: 10 } },
    { category: 'template', verdict: 'tic', redundancy: { ratio: 4, redundantChars: 30 } },
    { category: 'template', verdict: 'tic', redundancy: { ratio: null, redundantChars: 8 } },
    { category: 'template', verdict: 'indeterminate', redundancy: { ratio: 9, redundantChars: 100 } },
    { category: 'template', verdict: 'clean', redundancy: { ratio: 9, redundantChars: 100 } },
    { category: 'emotion-flat', verdict: 'tic', redundancy: { ratio: 9, redundantChars: 100 } },
  ], 1000);
  assert.equal(summary.hitCount, 3);
  assert.equal(summary.ratioCount, 2);
  assert.equal(summary.mean, 3);
  assert.equal(summary.max, 4);
  assert.equal(summary.redundantChars, 48);
  assert.equal(summary.redundantPerKilo, perKilo(48, 1000));

  const grounded = first('这不是茶，而是白水。', '这是茶吗？');
  assert.equal(grounded.hits.length, 0);
  assert.equal(grounded.released.redundancy.rewrite, '是白水');
  const ignored = summarizeRedundancy(grounded.hits, countChars('这不是茶，而是白水。'));
  assert.equal(ignored.hitCount, 0);
  assert.equal(ignored.redundantChars, 0);
  assert.equal(ignored.mean, null);
});

test('同一句前文提过就不进报告里的冗余比', () => {
  const dialogue = parseDialogue(JSON.stringify({
    title: '白水',
    turns: [
      { role: 'user', speaker: '林夏', text: '这是茶吗？' },
      { role: 'assistant', speaker: '周衡', text: '这不是茶，而是白水。' },
      { role: 'user', speaker: '林夏', text: '灯还亮着。' },
      { role: 'assistant', speaker: '周衡', text: '不是牛奶，也不是果汁，而是白开水。' },
    ],
  }));
  const scan = scanDialogue(dialogue, rules, {});
  const report = buildReport(scan, dialogue, rules, {});
  assert.equal(report.suppressedCount, 1);
  assert.equal(report.redundancy.hitCount, 1);
  assert.equal(scan.turns[3].hits[0].redundancy.rewrite, '是白开水');
  assert.ok(report.redundancy.mean > 1);
  assert.ok(report.redundancy.redundantPerKilo > 0);
  const text = formatReport(report);
  assert.match(text, /冗余比/);
  assert.match(text, /是白开水/);
  const listed = formatScan({ chars: report.chars, hits: scan.turns.flatMap((turn) => turn.hits), suppressed: scan.turns.flatMap((turn) => turn.suppressed) }, report);
  assert.match(listed, /不计入冗余比/);
  assert.match(listed, /均值/);
});

test('评测报告写出三率、分布和局限', () => {
  const gold = parseGold(readFileSync(join(root, 'examples', 'gold.json'), 'utf8'));
  const result = evaluateGold(gold, rules);
  const holdout = evaluateGold(parseGold(readFileSync(join(root, 'examples', 'holdout.json'), 'utf8')), rules);
  const baseline = JSON.parse(readFileSync(join(root, 'examples', 'baseline-before.json'), 'utf8'));
  const markdown = formatEvalReport(result, {
    holdout,
    holdoutV2: evaluateGold(parseGold(readFileSync(join(root, 'examples', 'holdout-v2.json'), 'utf8')), rules),
    baseline,
  });
  assert.match(markdown, /81\/81 = 1\.000/);
  assert.match(markdown, /0\/66 = 0\.000/);
  assert.match(markdown, /16\/163 = 0\.098/);
  assert.match(markdown, /77\/78 = 0\.987/);
  assert.match(markdown, /22\/22 = 1\.000/);
  assert.match(markdown, /14\/22 = 0\.636/);
  assert.match(markdown, /不是完全干净的估计/);
  assert.match(markdown, /句式模板/);
  assert.match(markdown, /冗余比/);
  assert.match(markdown, /是白开水/);
  assert.match(markdown, /只是白水/);
  assert.match(markdown, /不跨说话人/);
  assert.match(markdown, /已知局限/);
  assert.match(markdown, /没有真实用户对话/);
  assert.equal(result.redundancy.cleanRedundant, 0);
});
