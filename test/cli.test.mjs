import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDialogue } from '../lib/dialogue.mjs';
import { loadRuleSet } from '../lib/io.mjs';
import { scanDialogue } from '../lib/scan.mjs';
import { buildReport } from '../lib/report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'cli.mjs');

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return result;
}

test('示例报告：口癖样本告警，对照样本不告警且对比被抑制', () => {
  const rules = loadRuleSet(join(root, 'tics', 'default.json'));
  const tics = parseDialogue(readFileSync(join(root, 'examples', 'dialogue-tics.json'), 'utf8'));
  const clean = parseDialogue(readFileSync(join(root, 'examples', 'dialogue-clean.json'), 'utf8'));
  const mixed = parseDialogue(readFileSync(join(root, 'examples', 'dialogue-mixed.md'), 'utf8'));
  const ticsReport = buildReport(scanDialogue(tics, rules), tics, rules);
  const cleanReport = buildReport(scanDialogue(clean, rules), clean, rules);
  const mixedReport = buildReport(scanDialogue(mixed, rules), mixed, rules);

  assert.ok(ticsReport.template.ticCount >= 5);
  assert.ok(ticsReport.template.detourCount >= 1);
  assert.equal(ticsReport.template.alert, true);
  assert.ok(ticsReport.template.perKilo >= 4);
  assert.ok(ticsReport.indeterminateCount >= 1);
  assert.ok(ticsReport.persona.retentionRate < 1);
  assert.ok(ticsReport.persona.missingKeywords.includes('铁盒'));

  assert.equal(cleanReport.template.ticCount, 0);
  assert.equal(cleanReport.template.alert, false);
  assert.ok(cleanReport.suppressedCount >= 3);
  assert.equal(cleanReport.persona.retentionRate, 1);

  assert.ok(mixedReport.curve.some((point) => point.templateTics === 0));
  assert.ok(mixedReport.curve.some((point) => point.alert));
  assert.equal(mixed.character.catchphrases[0], '先把灯点上');
});

test('CLI scan / report / eval / rules', () => {
  const scan = run([
    'scan',
    'examples/dialogue-tics.json',
    '--annotate',
    'examples/attributions.sample.json',
    '--json',
  ]);
  assert.equal(scan.status, 0, scan.stderr);
  const scanJson = JSON.parse(scan.stdout);
  const confirmed = scanJson.hits.find((hit) => hit.attribution?.confirmed === 'training-data');
  assert.ok(confirmed);
  assert.ok(scanJson.hits.some((hit) => hit.attribution.suggested === 'unknown' && !hit.attribution.confirmed));

  const report = run(['report', 'examples/dialogue-tics.json']);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /【首要】句式模板/);
  assert.match(report.stdout, /告警/);
  assert.match(report.stdout, /\/千字/);

  const strict = run(['report', 'examples/dialogue-tics.json', '--strict', '--json']);
  assert.equal(strict.status, 2, strict.stderr);
  assert.equal(JSON.parse(strict.stdout).template.alert, true);

  const calm = run(['report', 'examples/dialogue-clean.json', '--strict']);
  assert.equal(calm.status, 0, calm.stderr);
  assert.match(calm.stdout, /未超过/);

  const dir = mkdtempSync(join(tmpdir(), 'koupi-cli-'));
  const csv = join(dir, 'curve.csv');
  const bad = join(dir, 'bad.jsonl');
  const saved = run([
    'report',
    'examples/dialogue-tics.json',
    '--csv',
    csv,
    '--save-badcases',
    bad,
    '--redact',
    '--names',
    '林夏,周衡',
    '--window',
    '6',
  ]);
  assert.equal(saved.status, 0, saved.stderr);
  const curve = readFileSync(csv, 'utf8');
  assert.match(curve, /template_per_kilo/);
  const lines = readFileSync(bad, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 5);
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.equal(row.redacted, true);
    assert.equal(row.charWindow, 6);
    assert.equal(JSON.stringify(row).includes('林夏'), false);
    assert.equal(JSON.stringify(row).includes('周衡'), false);
  }

  const evalRun = run(['eval', '--gold', 'examples/gold.json']);
  assert.equal(evalRun.status, 0, evalRun.stderr);
  assert.match(evalRun.stdout, /检出率\s+81\/81/);
  assert.match(evalRun.stdout, /误报率\s+0\/66/);
  assert.match(evalRun.stdout, /不可判定率\s+16\/163/);
  assert.match(evalRun.stdout, /冗余比/);

  const reportFile = join(dir, 'eval-report.md');
  const reported = run([
    'eval',
    '--gold', 'examples/gold.json',
    '--holdout', 'examples/holdout.json',
    '--holdout-v2', 'examples/holdout-v2.json',
    '--baseline', 'examples/baseline-before.json',
    '--report', reportFile,
  ]);
  assert.equal(reported.status, 0, reported.stderr);
  assert.match(reported.stderr, /已写入/);
  const markdown = readFileSync(reportFile, 'utf8');
  assert.match(markdown, /检出率/);
  assert.match(markdown, /误报率/);
  assert.match(markdown, /不可判定率/);
  assert.match(markdown, /冗余比/);
  assert.match(markdown, /是白开水/);
  assert.match(markdown, /不跨说话人/);
  assert.match(markdown, /留出集 v2/);
  assert.match(markdown, /不是完全干净的估计/);
  assert.match(markdown, /77\/78 = 0\.987/);
  assert.match(markdown, /22\/22 = 1\.000/);
  assert.match(markdown, /14\/22 = 0\.636/);
  assert.match(markdown, /6\/51 = 0\.118/);
  assert.match(markdown, /只是白水/);

  const listed = run(['rules']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /tpl\.bu-shi-er-shi/);
  assert.match(listed.stdout, /【首要】/);
});
