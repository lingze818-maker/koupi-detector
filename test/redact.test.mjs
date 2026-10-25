import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceNames, windowSnippet } from '../lib/text.mjs';
import { presentHit } from '../lib/present.mjs';
import { toBadcase, toJsonl } from '../lib/badcase.mjs';
import { applyAttributions } from '../lib/attribution.mjs';
import { scanText } from '../lib/rules.mjs';
import { loadRuleSet } from '../lib/io.mjs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = loadRuleSet(join(root, 'tics', 'default.json'));

test('人名按给定顺序替换，长名字优先', () => {
  const replaced = replaceNames('周衡把账本递给林夏，周先生在旁边。', ['林夏', '周衡', '周']);
  assert.equal(replaced.text, '乙把账本递给甲，丙先生在旁边。');
});

test('脱敏只留命中两侧窗口，上下文和说话人里的名字都换掉', () => {
  const text = '林夏站在门口。周衡没有生气，也没有惊讶，只是把账本合上。外面在下雨。';
  const { hits } = scanText(text, rules, { proximity: 0 });
  const hit = hits.find((item) => item.ruleId === 'tpl.mei-you-ye-mei-you-zhi-shi');
  assert.ok(hit);
  const tight = windowSnippet(text, hit.start, hit.end, 0);
  assert.equal(tight.snippet, hit.text);
  assert.equal(tight.snippet.includes('外面在下雨'), false);

  const presented = presentHit(
    { ...hit, id: 't1h1', turn: 1, role: 'assistant', speaker: '周衡' },
    text,
    { redact: true, window: 0, names: ['林夏', '周衡'] },
  );
  assert.equal(presented.redacted, true);
  assert.equal(presented.charWindow, 0);
  assert.equal(presented.speaker, '乙');
  assert.equal(presented.context.includes('林夏'), false);
  assert.equal(presented.context.includes('周衡'), false);
  assert.equal(presented.context.includes('外面在下雨'), false);
  assert.match(presented.context, /^…/);
  assert.match(presented.context, /…$/);

  const wider = presentHit(
    { ...hit, speaker: '周衡' },
    text,
    { redact: true, window: 12, names: ['林夏', '周衡'] },
  );
  assert.equal(wider.context.includes('林夏'), false);
  assert.equal(wider.context.includes('周衡'), false);
  assert.match(wider.context, /乙/);
});

test('badcase JSONL 带复现字段，脱敏后不再出现原名', () => {
  const text = '林夏问了一句。周衡没有生气，也没有惊讶，只是把账本合上。';
  const { hits } = scanText(text, rules, { proximity: 0 });
  const hit = presentHit(
    {
      ...hits.find((item) => item.category === 'template'),
      id: 't2h1',
      turn: 2,
      role: 'assistant',
      speaker: '周衡',
    },
    text,
    { redact: true, window: 8, names: ['林夏', '周衡'] },
  );
  const [annotated] = applyAttributions([hit], {
    items: [
      {
        match: { ruleId: hit.ruleId, text: '没有生气，也没有惊讶，只是把账本合上' },
        attribution: 'alignment-preference',
        note: '虚构',
      },
    ],
  });
  const record = toBadcase(annotated, { source: 'local-only', window: 8 });
  assert.equal(record.attribution, 'alignment-preference');
  assert.equal(record.redacted, true);
  assert.equal(record.charWindow, 8);
  assert.equal(record.turn, 2);
  const line = toJsonl([record]).trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.id, 't2h1');
  assert.equal(JSON.stringify(parsed).includes('林夏'), false);
  assert.equal(JSON.stringify(parsed).includes('周衡'), false);

  const dir = mkdtempSync(join(tmpdir(), 'koupi-'));
  const file = join(dir, 'badcases.jsonl');
  writeFileSync(file, toJsonl([record]));
  const stored = readFileSync(file, 'utf8');
  assert.equal(stored.trim().split('\n').length, 1);
});
