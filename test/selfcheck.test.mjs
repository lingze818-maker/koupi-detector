import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuleSet } from '../lib/io.mjs';
import { completenessScore } from '../lib/complete.mjs';
import { createChatRewriter, applyEconomy, economyRewriter, rewriterFromEnv } from '../lib/rewriter.mjs';
import {
  brokenShape,
  evaluateDrafts,
  fidelityScore,
  formatSelfCheckReport,
  parseDrafts,
  selfCheckText,
} from '../lib/selfcheck.mjs';
import { scanText } from '../lib/rules.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = loadRuleSet(join(root, 'tics', 'default.json'));

test('离线改写套用省力改写，无口癖原样返回', () => {
  const flat = selfCheckText('不是责备，也不是安慰，而是把话放平。', rules);
  assert.equal(flat.text, '把话放平。');
  assert.equal(flat.rounds[0].hits[0].rewrite, '把话放平');
  const keptShi = selfCheckText('不是责备，也不是安慰，而是把话放平。', rules, { before: '灯还亮着。' });
  assert.equal(keptShi.text, '是把话放平。');

  const checked = selfCheckText('他没有生气，也没有惊讶，只是看着她。伞还在滴水。', rules);
  assert.equal(checked.text, '他只是看着她。伞还在滴水。');
  assert.equal(checked.after.ticCount, 0);
  assert.equal(checked.rewriteRounds, 1);
  assert.ok(checked.fidelity > 0.99);
  assert.equal(checked.rounds[0].hits[0].rewrite, '只是看着她');

  const clean = '他把伞收好，灯还亮着。';
  const passed = selfCheckText(clean, rules);
  assert.equal(passed.text, clean);
  assert.equal(passed.changed, false);
  assert.equal(passed.rewriteRounds, 0);

  const grounded = selfCheckText('这不是茶，而是白水。', rules, { before: '你是说茶吗？' });
  assert.equal(grounded.text, '这不是茶，而是白水。');
  assert.equal(grounded.changed, false);
});

test('两轮自查会再扫，改写器一次只动一处时用满两轮', () => {
  const text = '他没有生气，也没有惊讶，只是看着她。没有催促，只是把杯子放下。';
  let calls = 0;
  const oneAtATime = (draft, feedback) => {
    calls += 1;
    return economyRewriter(draft, feedback.slice(0, 1));
  };
  const checked = selfCheckText(text, rules, { rewriter: oneAtATime, maxRounds: 2 });
  assert.equal(calls, 2);
  assert.equal(checked.rewriteRounds, 2);
  assert.equal(checked.after.ticCount, 0);
  assert.equal(checked.disposition, 'fixed');
  assert.equal(checked.completeness, 1);
  const stopped = selfCheckText(text, rules, { rewriter: oneAtATime, maxRounds: 1 });
  assert.equal(stopped.rewriteRounds, 1);
  assert.equal(stopped.after.ticCount, 1);
  assert.equal(stopped.disposition, 'needs-model');
});

test('删掉词面套话会残句时保留原句，并标需模型', () => {
  const text = '他语气平淡，听不出什么情绪。';
  const scan = scanText(text, rules);
  const feedback = scan.hits.filter((hit) => hit.verdict === 'tic').map((hit) => ({
    start: hit.start,
    end: hit.end,
    text: hit.text,
    verdict: hit.verdict,
    rewrite: hit.redundancy ? hit.redundancy.rewrite : null,
  }));
  const raw = applyEconomy(text, feedback);
  assert.equal(brokenShape(raw), true);
  assert.equal(completenessScore(raw), 0);
  assert.ok(fidelityScore(text, raw, feedback) > 0.99);
  const checked = selfCheckText(text, rules);
  assert.equal(checked.text, text);
  assert.equal(checked.changed, false);
  assert.equal(checked.needsModel, true);
  assert.equal(checked.disposition, 'needs-model');
  assert.equal(checked.completeness, 1);
  assert.ok(checked.feedback.length >= 2);
  assert.equal(checked.after.ticCount, checked.before.ticCount);
  const mixed = selfCheckText('他没有生气，也没有惊讶，只是看着她。他语气平淡，听不出什么情绪。', rules);
  assert.equal(mixed.text, '他只是看着她。他语气平淡，听不出什么情绪。');
  assert.equal(mixed.completeness, 1);
  assert.equal(mixed.disposition, 'needs-model');
  assert.equal(mixed.after.ticCount > 0, true);
  assert.equal(brokenShape('得。'), true);
  assert.equal(brokenShape('像在做一件的事。'), true);
  assert.equal(brokenShape('一样，他把账本合上。'), true);
  assert.equal(brokenShape('眉眼的弧度显得。'), true);
  assert.equal(brokenShape('他只是看着她。伞还在滴水。'), false);
});

test('保真率要求省力改写留下，换掉断言就下降', () => {
  const text = '这不是茶，也不是酒，而是白开水。';
  const scan = scanText(text, rules, { before: '灯还亮着。' });
  const hit = scan.hits.find((item) => item.verdict === 'tic');
  const feedback = [{
    start: hit.start,
    end: hit.end,
    verdict: 'tic',
    rewrite: hit.redundancy.rewrite,
  }];
  const kept = fidelityScore(text, `这${hit.redundancy.rewrite}。`, feedback);
  const swapped = fidelityScore(text, '这是墨。', feedback);
  assert.ok(kept > 0.99);
  assert.ok(swapped < kept);
  assert.equal(fidelityScore('他把伞收好。', '他把伞收好。', []), 1);
});

test('llm 改写器没有密钥就失败，有密钥时只改命中 span', async () => {
  assert.throws(() => rewriterFromEnv('llm', {}), /KOUPI_LLM_API_KEY/);
  const calls = [];
  const rewriter = createChatRewriter({
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'demo',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, authorization: init.headers.authorization });
      const prompt = body.messages[1].content;
      const hit = prompt.match(/命中：(.+)/);
      const content = hit && hit[1].includes('听不出什么情绪') ? '把伞收好' : '';
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
      };
    },
  });
  const checked = await selfCheckText('他语气平淡，听不出什么情绪。', rules, { rewriter });
  assert.equal(checked.text, '他把伞收好。');
  assert.equal(checked.after.ticCount, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer test-key');
  assert.equal(calls[0].body.model, 'demo');
  assert.equal(calls[0].body.temperature, 0);
  assert.match(calls[0].body.messages[0].content, /未列出/);
  assert.match(calls[0].body.messages[0].content, /他开口/);
  assert.match(calls[0].body.messages[0].content, /白开水/);
  assert.match(calls[0].body.messages[0].content, /不要硬补「他」/);
  const prompts = calls.map((call) => call.body.messages[1].content);
  assert.ok(prompts.some((prompt) => prompt.includes('语气平淡')));
  assert.ok(prompts.some((prompt) => prompt.includes('听不出什么情绪')));
  assert.ok(prompts.every((prompt) => prompt.includes('未列出的字一个都不要动')));
});

test('llm 有省力改写时不调模型，未命中句保持字节级一致', async () => {
  let calls = 0;
  const rewriter = createChatRewriter({
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1;
      throw new Error('不应调用模型');
    },
  });
  const templated = '他没有生气，也没有惊讶，只是看着她。伞还在滴水。';
  const checked = await selfCheckText(templated, rules, { rewriter });
  assert.equal(calls, 0);
  assert.equal(checked.text, '他只是看着她。伞还在滴水。');
  assert.equal(checked.text.slice(-'伞还在滴水。'.length), templated.slice(-'伞还在滴水。'.length));

  const source = '他说，声音很平淡。伞还在滴水。';
  const tail = '伞还在滴水。';
  const lexical = createChatRewriter({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '把话说完' } }] }),
    }),
  });
  const spliced = await selfCheckText(source, rules, { rewriter: lexical });
  assert.equal(source.slice(-tail.length), tail);
  assert.equal(spliced.text.slice(-tail.length), tail);
  assert.notEqual(spliced.text, source);
  assert.equal(spliced.text, `${spliced.text.slice(0, -tail.length)}${tail}`);
});

test('虚构草稿：含口癖的口癖率下降，不含口癖的原样通过', () => {
  const drafts = parseDrafts(readFileSync(join(root, 'examples', 'selfcheck-drafts.json'), 'utf8'));
  const result = evaluateDrafts(drafts, rules);
  assert.equal(result.summary.tic.count, 12);
  assert.equal(result.summary.tic.withTicBefore, 12);
  assert.equal(result.summary.tic.withTicAfter, 6);
  assert.equal(result.summary.tic.fixed, 6);
  assert.equal(result.summary.tic.needsModel, 6);
  assert.equal(result.summary.tic.passthrough, 0);
  assert.equal(result.summary.tic.completenessMean, 1);
  assert.ok(result.summary.tic.ticPerKiloAfter < result.summary.tic.ticPerKiloBefore);
  assert.ok(result.summary.tic.charDelta < 0);
  assert.equal(result.summary.tic.redundancyAfter, null);
  assert.ok(result.summary.tic.redundancyBefore > 1);
  assert.equal(result.summary.clean.unchanged, result.summary.clean.count);
  assert.equal(result.summary.clean.passthrough, result.summary.clean.count);
  assert.equal(result.summary.clean.fixed, 0);
  assert.equal(result.summary.clean.needsModel, 0);
  assert.equal(result.summary.abstain.unchanged, result.summary.abstain.count);
  assert.equal(result.summary.abstain.passthrough, result.summary.abstain.count);
  assert.equal(result.summary.unseen.unchanged, result.summary.unseen.count);
  assert.equal(result.summary.unseen.passthrough, result.summary.unseen.count);
  assert.equal(result.summary.clean.charDelta, 0);
  assert.equal(result.summary.all.completenessMean, 1);
  const kept = result.items.find((item) => item.id === 'd04');
  assert.equal(kept.text, '他语气平淡，听不出什么情绪。');
  assert.equal(kept.disposition, 'needs-model');
  assert.equal(kept.completeness, 1);
  assert.ok(kept.feedback.length >= 1);
  assert.equal(brokenShape(result.items.find((item) => item.id === 'd01').text), false);
  assert.equal(result.items.find((item) => item.id === 'd01').disposition, 'fixed');
  assert.equal(result.items.filter((item) => item.completeness < 1).length, 0);
  const markdown = formatSelfCheckReport(result, { rewriter: 'offline' });
  assert.match(markdown, /12\/12 = 1\.000/);
  assert.match(markdown, /6\/12 = 0\.500/);
  assert.match(markdown, /平均完整性/);
  assert.match(markdown, /已修复/);
  assert.match(markdown, /需模型/);
  assert.match(markdown, /原样通过/);
  assert.match(markdown, /KOUPI_LLM_API_KEY/);
  assert.match(markdown, /字面 Dice/);
  assert.match(markdown, /d04/);
  assert.match(markdown, /这些草稿都原样通过/);
  assert.match(markdown, /没有这种草稿。/);
});

test('CLI rewrite 写出离线评测', () => {
  const dir = mkdtempSync(join(tmpdir(), 'koupi-selfcheck-'));
  const report = join(dir, 'selfcheck-report.md');
  const cli = join(root, 'cli.mjs');
  const batch = spawnSync(process.execPath, [
    cli, 'rewrite',
    '--drafts', 'examples/selfcheck-drafts.json',
    '--rewriter', 'offline',
    '--report', report,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(batch.status, 0, batch.stderr);
  const markdown = readFileSync(report, 'utf8');
  assert.match(markdown, /回复前自查/);
  assert.match(markdown, /8\/8 = 1\.000/);
  const one = spawnSync(process.execPath, [cli, 'rewrite', 'examples/selfcheck-one.txt'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /他只是看着她/);
  assert.match(one.stdout, /口癖 1 → 0/);
  const missing = spawnSync(process.execPath, [cli, 'rewrite', 'examples/selfcheck-one.txt', '--rewriter', 'llm'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, KOUPI_LLM_API_KEY: '' },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /KOUPI_LLM_API_KEY/);
});
