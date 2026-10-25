import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuleSet } from '../lib/io.mjs';
import { scanText } from '../lib/rules.mjs';
import {
  formatCrossModelMarkdown,
  modelSlots,
  renderCrossModelSvg,
  runCrossModel,
  scoreReplies,
} from '../lib/cross-model.mjs';
import { attributeDelta, buildPromptAbTable, formatPromptAbMarkdown } from '../lib/prompt-ab.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = loadRuleSet(join(root, 'tics', 'default.json'));

test('没有密钥时横评留空，不调用模型，也不把空写成 0', async () => {
  let calls = 0;
  const prompts = JSON.parse(readFileSync(join(root, 'examples', 'cross-model-prompts.json'), 'utf8'));
  const systemHits = scanText(prompts.system, rules).hits.filter((hit) => hit.verdict === 'tic');
  assert.equal(systemHits.length, 0);
  const slots = modelSlots({ KOUPI_EVAL_MODELS: 'other' });
  assert.equal(slots.length, 2);
  const result = await runCrossModel({
    slots,
    prompts,
    ruleSet: rules,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('不应调用');
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.temperature, 0);
  assert.equal(result.rows.every((row) => row.ticPerKilo == null), true);
  assert.equal(result.rows.every((row) => row.status === 'no-key'), true);
  const markdown = formatCrossModelMarkdown(result);
  assert.match(markdown, /无密钥/);
  assert.match(markdown, /—/);
  assert.doesNotMatch(markdown, /\| DeepSeek \| 无密钥 \| 0 /);
  const svg = renderCrossModelSvg(result);
  assert.match(svg, /未跑/);
  assert.doesNotMatch(svg, /<rect x=/);

  const scored = scoreReplies(['他语气平淡，听不出什么情绪。'], rules);
  assert.ok(scored.ticCount >= 1);
  assert.ok(scored.ticPerKilo > 0);
});

test('提示归因：没有 runs 是未测；有数字才分提示诱导和无增益', () => {
  const spec = JSON.parse(readFileSync(join(root, 'examples', 'prompt-ab.json'), 'utf8'));
  const rows = buildPromptAbTable(spec, rules);
  assert.equal(rows.length, 3);
  assert.equal(rows.every((row) => row.attribution === '未测'), true);
  assert.equal(rows.every((row) => row.promptHasTic === false), true);
  assert.equal(rows.every((row) => row.ticPerKilo == null), true);
  const markdown = formatPromptAbMarkdown(spec, rules);
  assert.match(markdown, /未测/);
  assert.doesNotMatch(markdown, /无增益 \|/);

  assert.equal(attributeDelta(10, 12, 1), '提示诱导');
  assert.equal(attributeDelta(10, 10.4, 1), '无增益');
  assert.equal(attributeDelta(10, 8, 1), '有下降');
  assert.equal(attributeDelta(null, 8, 1), '未测');

  const planted = buildPromptAbTable({
    baselineId: 'baseline',
    minDeltaPerKilo: 1,
    variants: [
      { id: 'baseline', arm: '生成侧', factor: '无额外提示', system: '你写下一句。' },
      { id: 'style', arm: '生成侧', factor: '风格提示', system: '他语气平淡，听不出什么情绪。' },
    ],
    runs: [
      { id: 'baseline', ticPerKilo: 4, chars: 100 },
      { id: 'style', ticPerKilo: 9, chars: 100 },
    ],
  }, rules);
  assert.equal(planted[0].attribution, '对照');
  assert.equal(planted[1].promptHasTic, true);
  assert.equal(planted[1].attribution, '提示诱导');
});
