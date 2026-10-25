import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGold } from '../lib/dialogue.mjs';
import { loadRuleSet } from '../lib/io.mjs';
import { scanText } from '../lib/rules.mjs';
import { FIDELITY_MIN, buildDataLoop, exportHollow, ticSources } from '../lib/data-loop.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadBuilt() {
  const rules = loadRuleSet(join(root, 'tics', 'default.json'));
  const gold = parseGold(readFileSync(join(root, 'examples', 'gold.json'), 'utf8'));
  const consensus = JSON.parse(readFileSync(join(root, 'examples', 'consensus-tic.json'), 'utf8'));
  return { rules, built: buildDataLoop(ticSources(gold, consensus), rules) };
}

test('偏好对只收已修复的虚构口癖句，未命中和残句不进', () => {
  const { rules, built } = loadBuilt();
  assert.equal(built.stats.input, 123);
  assert.equal(built.stats.preference, 85);
  assert.equal(built.stats.sft, 79);
  assert.equal(built.stats.fidelityMinRequired, FIDELITY_MIN);
  assert.ok(built.stats.fidelityMin >= FIDELITY_MIN);

  const g01 = built.pairs.find((pair) => pair.sourceId === 'g01');
  assert.equal(g01.chosen, '他只是看着她。');
  const g03 = built.pairs.find((pair) => pair.sourceId === 'g03');
  assert.equal(g03.chosen, '把话放平。');
  assert.equal(built.pairs.some((pair) => pair.sourceId === 'g07'), false);
  assert.equal(built.pairs.some((pair) => pair.sourceId === 'g22'), false);
  assert.equal(built.pairs.some((pair) => pair.sourceId === 'g47'), false);
  assert.equal(built.pairs.some((pair) => pair.sourceId === 's127'), false);
  assert.equal(exportHollow('他的语气还是那种。'), true);
  assert.equal(exportHollow('带着一种少见的、。'), true);

  const chosen = new Set(built.pairs.map((pair) => pair.chosen));
  const seen = new Set();
  for (const pair of built.pairs) {
    assert.notEqual(pair.chosen, pair.rejected);
    assert.equal(pair.completeness, 1);
    assert.ok(pair.fidelity >= FIDELITY_MIN);
    assert.equal(Object.hasOwn(pair, 'before'), false);
    const key = `${pair.rejected}\0${pair.chosen}`;
    assert.equal(seen.has(key), false);
    seen.add(key);
    const again = scanText(pair.chosen, rules);
    assert.equal(again.hits.some((hit) => hit.verdict === 'tic'), false);
  }
  for (const row of built.sft) {
    assert.equal(chosen.has(row.text), true);
    assert.equal(row.completeness, 1);
  }
  assert.equal(new Set(built.sft.map((row) => row.text)).size, built.sft.length);
});

test('CLI data 写出 JSONL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'koupi-data-'));
  const preference = join(dir, 'preference.jsonl');
  const sft = join(dir, 'sft.jsonl');
  const result = spawnSync(process.execPath, [
    join(root, 'cli.mjs'),
    'data',
    '--gold', 'examples/gold.json',
    '--consensus', 'examples/consensus-tic.json',
    '--preference', preference,
    '--sft', sft,
    '--json',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.preference, 85);
  assert.equal(readFileSync(preference, 'utf8').trim().split('\n').length, 85);
  assert.equal(readFileSync(sft, 'utf8').trim().split('\n').length, 79);
});
