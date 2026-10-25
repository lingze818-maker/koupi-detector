import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perKilo } from '../lib/text.mjs';
import { buildReport, formatReport, reportToCsv } from '../lib/report.mjs';

const ruleSet = {
  categories: [
    { id: 'template', title: '句式模板 / 无意义转折', primary: true, description: '' },
    { id: 'emotion-flat', title: '情绪抹平', primary: false, description: '' },
    { id: 'metaphor', title: '比喻套话', primary: false, description: '' },
  ],
};

function scanWith(turns) {
  return { turns };
}

test('每千字密度', () => {
  assert.equal(perKilo(2, 100), 20);
  assert.equal(perKilo(1, 3), 333.3);
  assert.equal(perKilo(0, 0), 0);
});

test('句式模板单独计密度，不可判定不计入也不单独把短轮打成密度告警', () => {
  const report = buildReport(
    scanWith([
      {
        turn: 1,
        role: 'assistant',
        speaker: '周衡',
        text: '先把灯点上。账本在灯下。',
        chars: 100,
        scanned: true,
        hits: [
          { category: 'template', verdict: 'tic' },
          { category: 'template', verdict: 'tic' },
          { category: 'template', verdict: 'indeterminate' },
          { category: 'emotion-flat', verdict: 'tic' },
        ],
        suppressed: [{ category: 'template', verdict: 'clean' }],
      },
    ]),
    {
      title: '测试',
      character: { name: '周衡', keywords: ['账本', '铁盒'], catchphrases: ['先把灯点上'] },
    },
    ruleSet,
    { roles: ['assistant'], templateThreshold: 4, turnThreshold: 10, minTurnChars: 30 },
  );
  assert.equal(report.template.ticCount, 2);
  assert.equal(report.template.indeterminateCount, 1);
  assert.equal(report.template.perKilo, 20);
  assert.equal(report.template.perTurn, 2);
  assert.equal(report.template.alert, true);
  assert.equal(report.template.globalAlert, true);
  assert.deepEqual(report.template.alertTurns, [1]);
  assert.equal(report.suppressedCount, 1);
  assert.deepEqual(report.persona.missingKeywords, ['铁盒']);
  assert.equal(report.persona.retentionRate, 2 / 3);
  const text = formatReport(report);
  assert.match(text, /【首要】句式模板/);
  assert.match(text, /20\.0 \/千字/);
  assert.match(text, /告警/);
  assert.match(text, /不可判定/);
  const csv = reportToCsv(report);
  assert.match(csv, /template_tics,template_per_kilo/);
  assert.match(csv, /^1,assistant,100,2,20,1,1,0,1$/m);
});

test('两处堆叠会告警；单处短轮在全篇阈值很高时不告警', () => {
  const options = { roles: ['assistant'], templateThreshold: 1000, turnThreshold: 10, minTurnChars: 30 };
  const quiet = buildReport(
    scanWith([
      {
        turn: 1,
        role: 'assistant',
        speaker: null,
        text: '短',
        chars: 29,
        scanned: true,
        hits: [{ category: 'template', verdict: 'tic' }],
        suppressed: [],
      },
    ]),
    { character: null },
    ruleSet,
    options,
  );
  assert.equal(quiet.template.alert, false);

  const longEnough = buildReport(
    scanWith([
      {
        turn: 2,
        role: 'assistant',
        speaker: null,
        text: '刚好三十个字的一轮，用来测单轮密度。',
        chars: 30,
        scanned: true,
        hits: [{ category: 'template', verdict: 'tic' }],
        suppressed: [],
      },
    ]),
    { character: null },
    ruleSet,
    options,
  );
  assert.equal(longEnough.template.perKilo, perKilo(1, 30));
  assert.equal(longEnough.template.alert, true);

  const stacked = buildReport(
    scanWith([
      {
        turn: 3,
        role: 'assistant',
        speaker: null,
        text: '很短',
        chars: 10,
        scanned: true,
        hits: [
          { category: 'template', verdict: 'tic' },
          { category: 'template', verdict: 'tic' },
        ],
        suppressed: [],
      },
    ]),
    { character: null },
    ruleSet,
    options,
  );
  assert.equal(stacked.template.globalAlert, false);
  assert.deepEqual(stacked.template.alertTurns, [3]);
});
