#!/usr/bin/env node
/**
 * 硅基流动长文跨模型口癖横评。
 * 密钥只读 SILICONFLOW_API_KEY，不写日志/文件。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuleSet } from '../../lib/io.mjs';
import { scanText } from '../../lib/rules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;
const BASE = (process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
const KEY = process.env.SILICONFLOW_API_KEY || '';
if (!KEY) {
  console.error('缺少 SILICONFLOW_API_KEY');
  process.exit(1);
}

const RULES = loadRuleSet(join(__dirname, '..', '..', 'tics', 'default.json'));
const promptSpec = JSON.parse(readFileSync(join(OUT, 'prompts-long.json'), 'utf8'));
const SYSTEM = promptSpec.system;
const TEMP = promptSpec.temperature ?? 0;
const PROMPTS = promptSpec.prompts;

const MODELS = [
  { id: 'deepseek-v3.2', model: 'deepseek-ai/DeepSeek-V3.2', wave: 'main', label: 'DeepSeek-V3.2' },
  { id: 'deepseek-r1', model: 'deepseek-ai/DeepSeek-R1', wave: 'main', label: 'DeepSeek-R1' },
  { id: 'glm-5.1', model: 'Pro/zai-org/GLM-5.1', wave: 'main', label: 'GLM-5.1' },
  { id: 'glm-5.2', model: 'zai-org/GLM-5.2', wave: 'main', label: 'GLM-5.2' },
  { id: 'qwen3.6-27b', model: 'Qwen/Qwen3.6-27B', wave: 'main', label: 'Qwen3.6-27B' },
  { id: 'deepseek-v4-pro', model: 'deepseek-ai/DeepSeek-V4-Pro', wave: 'new', label: 'DeepSeek-V4-Pro' },
  { id: 'qwen3.8-27b', model: 'Qwen/Qwen3.8-27B', wave: 'new', label: 'Qwen3.8-27B' },
  { id: 'glm-5.3-flash', model: 'zai-org/GLM-5.3-Flash', wave: 'new', label: 'GLM-5.3-Flash' },
];

const SIMILE_RE = /像|仿佛|宛如|好似/g;

function charLen(s) {
  return [...String(s || '')].length;
}

function countSimile(text) {
  const m = String(text || '').match(SIMILE_RE);
  return m ? m.length : 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractContent(message) {
  if (!message) return { content: '', reasoning: '', reasoning_len: 0 };
  let content = message.content;
  if (Array.isArray(content)) {
    content = content
      .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
      .join('');
  }
  content = typeof content === 'string' ? content : '';
  const reasoning =
    message.reasoning_content ||
    message.reasoning ||
    message.reasoning_text ||
    '';
  const reasoningStr = typeof reasoning === 'string' ? reasoning : '';
  return {
    content: content.trim(),
    reasoning: reasoningStr,
    reasoning_len: charLen(reasoningStr),
  };
}

async function chat(model, userText, attempt = 0) {
  const body = {
    model,
    temperature: TEMP,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userText },
    ],
  };
  let response;
  try {
    response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
  } catch (netErr) {
    if (attempt < 4) {
      const wait = 2000 * (attempt + 1) * (attempt + 1);
      console.error(`  retry ${attempt + 1} after network/timeout: ${String(netErr.message || netErr).slice(0, 120)}, wait ${wait}ms`);
      await sleep(wait);
      return chat(model, userText, attempt + 1);
    }
    throw netErr;
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const status = response.status;
    if ((status === 429 || status >= 500) && attempt < 4) {
      const wait = 1500 * (attempt + 1) * (attempt + 1);
      console.error(`  retry ${attempt + 1} after HTTP ${status}, wait ${wait}ms`);
      await sleep(wait);
      return chat(model, userText, attempt + 1);
    }
    throw new Error(`HTTP ${status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const message = data?.choices?.[0]?.message || {};
  const { content, reasoning_len } = extractContent(message);
  if (!content) {
    if (attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return chat(model, userText, attempt + 1);
    }
    throw new Error('empty content');
  }
  // strip accidental fences
  const cleaned = content.replace(/^```(?:\w+)?\n?/, '').replace(/\n?```$/, '').trim();
  return { content: cleaned, reasoning_len, had_reasoning: reasoning_len > 0 };
}

function scanReply(reply) {
  const { hits } = scanText(reply, RULES);
  const ticHits = (hits || []).filter((h) => h.verdict !== 'clean');
  const byCategory = { template: 0, 'emotion-flat': 0, metaphor: 0 };
  for (const h of ticHits) {
    const c = h.category || 'other';
    byCategory[c] = (byCategory[c] || 0) + 1;
  }
  const chars = charLen(reply);
  const hitsCount = ticHits.length;
  const ticPerKilo = chars ? Math.round((hitsCount / chars) * 1000 * 10) / 10 : 0;
  return {
    chars,
    hits: hitsCount,
    byCategory,
    ticPerKilo,
    hitDetails: ticHits.map((h) => ({
      category: h.category,
      ruleId: h.ruleId || h.id,
      text: h.text,
      verdict: h.verdict,
    })),
    simileRough: countSimile(reply),
  };
}

function loadDoneKeys(modelId) {
  const path = join(OUT, `${modelId}.jsonl`);
  const done = new Set();
  if (!existsSync(path)) return done;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.prompt_id && !row.error) done.add(row.prompt_id);
    } catch {
      /* skip */
    }
  }
  return done;
}

function appendRow(modelId, row) {
  const path = join(OUT, `${modelId}.jsonl`);
  appendFileSync(path, JSON.stringify(row) + '\n');
}

async function runModel(m) {
  const done = loadDoneKeys(m.id);
  console.log(`\n== ${m.label} (${m.model}) done=${done.size}/${PROMPTS.length} ==`);
  for (const p of PROMPTS) {
    if (done.has(p.id)) {
      console.log(`  skip ${p.id}`);
      continue;
    }
    const t0 = Date.now();
    let row;
    try {
      const { content, reasoning_len, had_reasoning } = await chat(m.model, p.user);
      const scored = scanReply(content);
      row = {
        model_id: m.id,
        model: m.model,
        label: m.label,
        wave: m.wave,
        prompt_id: p.id,
        genre: p.genre,
        reply: content,
        chars: scored.chars,
        hits: scored.hits,
        byCategory: scored.byCategory,
        ticPerKilo: scored.ticPerKilo,
        hitDetails: scored.hitDetails,
        simileRough: scored.simileRough,
        had_reasoning,
        reasoning_len,
        elapsed_s: Math.round(((Date.now() - t0) / 1000) * 100) / 100,
        error: null,
      };
      console.log(
        `  ${p.id} chars=${row.chars} hits=${row.hits} simile=${row.simileRough} ${row.elapsed_s}s`,
      );
    } catch (err) {
      row = {
        model_id: m.id,
        model: m.model,
        label: m.label,
        wave: m.wave,
        prompt_id: p.id,
        genre: p.genre,
        reply: '',
        chars: 0,
        hits: 0,
        byCategory: { template: 0, 'emotion-flat': 0, metaphor: 0 },
        ticPerKilo: 0,
        hitDetails: [],
        simileRough: 0,
        had_reasoning: false,
        reasoning_len: 0,
        elapsed_s: Math.round(((Date.now() - t0) / 1000) * 100) / 100,
        error: String(err.message || err).slice(0, 300),
      };
      console.error(`  ${p.id} ERROR: ${row.error}`);
    }
    appendRow(m.id, row);
    await sleep(400);
  }
}

function readModelRows(modelId) {
  const path = join(OUT, `${modelId}.jsonl`);
  if (!existsSync(path)) return [];
  const byPrompt = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      // keep last non-error, else last
      const prev = byPrompt.get(row.prompt_id);
      if (!prev || (!row.error && prev.error) || !row.error) {
        byPrompt.set(row.prompt_id, row);
      }
    } catch {
      /* skip */
    }
  }
  return [...byPrompt.values()];
}

function buildReports() {
  const allRows = [];
  const scoreRows = [];
  for (const m of MODELS) {
    const rows = readModelRows(m.id);
    allRows.push(...rows);
    const ok = rows.filter((r) => !r.error && r.reply);
    const chars = ok.reduce((s, r) => s + (r.chars || 0), 0);
    const ticCount = ok.reduce((s, r) => s + (r.hits || 0), 0);
    const byCategory = { template: 0, 'emotion-flat': 0, metaphor: 0 };
    const hitDetails = [];
    let simileRough = 0;
    for (const r of ok) {
      for (const [k, v] of Object.entries(r.byCategory || {})) {
        byCategory[k] = (byCategory[k] || 0) + v;
      }
      simileRough += r.simileRough || 0;
      for (const h of r.hitDetails || []) hitDetails.push({ prompt_id: r.prompt_id, ...h });
    }
    const n = ok.length;
    const avg = n ? Math.round((chars / n) * 10) / 10 : 0;
    const ticPerKilo = chars ? Math.round((ticCount / chars) * 1000 * 10) / 10 : 0;
    scoreRows.push({
      model_id: m.id,
      label: m.label,
      model: m.model,
      wave: m.wave,
      n_prompts: PROMPTS.length,
      n_ok: n,
      n_errors: rows.filter((r) => r.error).length,
      chars,
      ticCount,
      ticPerKilo,
      byCategory,
      simileRough,
      avg_reply_chars: avg,
      hitDetails,
    });
  }

  writeFileSync(join(OUT, 'all.jsonl'), allRows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const meta = {
    created: '2026-10-25 Asia/Shanghai',
    provider: 'siliconflow',
    temperature: TEMP,
    system: SYSTEM,
    prompt_file: 'prompts-long.json',
    n_prompts: PROMPTS.length,
    genres: PROMPTS.map((p) => ({ id: p.id, genre: p.genre })),
    models: MODELS.map(({ id, model, wave, label }) => ({ id, model, wave, label })),
    note: '长文段（约400–600字）跨模型口癖横评；规则 scan + 像/仿佛/宛如/好似粗检。虚构场景。',
  };
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  const score = {
    created: '2026-10-25 Asia/Shanghai',
    provider: 'siliconflow',
    prompt_spec: 'prompts-long.json (6 long scenes, temp 0)',
    rows: scoreRows,
  };
  writeFileSync(join(OUT, 'score.json'), JSON.stringify(score, null, 2) + '\n');

  // compare.md
  const lines = [];
  lines.push('# 硅基流动长文跨模型口癖横评（2026-10-25）');
  lines.push('');
  lines.push(
    '同一批虚构长场景（`prompts-long.json`，6 条，要求约 400–600 字正文），temperature=0。规则检测器 `scan`；另计「像/仿佛/宛如/好似」粗检（非正式口癖）。',
  );
  lines.push('');
  lines.push('## 总表');
  lines.push('');
  lines.push('| 波次 | 模型 | 总字数 | 口癖命中 | 每千字 | 句式 | 情绪抹平 | 比喻 | 像类粗检 | 均长 | 失败 |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of scoreRows) {
    lines.push(
      `| ${r.wave} | ${r.label} | ${r.chars} | ${r.ticCount} | ${r.ticPerKilo} | ${r.byCategory.template || 0} | ${r.byCategory['emotion-flat'] || 0} | ${r.byCategory.metaphor || 0} | ${r.simileRough} | ${r.avg_reply_chars} | ${r.n_errors} |`,
    );
  }
  lines.push('');
  lines.push('## 新旧对照（同厂）');
  lines.push('');
  const pairs = [
    ['DeepSeek', 'deepseek-v3.2', 'deepseek-v4-pro'],
    ['Qwen', 'qwen3.6-27b', 'qwen3.8-27b'],
    ['GLM', 'glm-5.2', 'glm-5.3-flash'],
  ];
  for (const [name, oldId, newId] of pairs) {
    const o = scoreRows.find((r) => r.model_id === oldId);
    const n = scoreRows.find((r) => r.model_id === newId);
    lines.push(`### ${name}`);
    if (o) {
      lines.push(
        `- **旧/锚** ${o.label}: 每千字 ${o.ticPerKilo}，均长 ${o.avg_reply_chars}，总字 ${o.chars}，像类 ${o.simileRough}，命中 ${o.ticCount}`,
      );
    }
    if (n) {
      lines.push(
        `- **新** ${n.label}: 每千字 ${n.ticPerKilo}，均长 ${n.avg_reply_chars}，总字 ${n.chars}，像类 ${n.simileRough}，命中 ${n.ticCount}`,
      );
    }
    lines.push('');
  }

  // excerpt same prompt L01
  const excerptId = 'L01';
  lines.push(`## 逐条回复摘录（各模型 ${excerptId}，截断前 120 字）`);
  lines.push('');
  for (const m of MODELS) {
    const rows = readModelRows(m.id);
    const row = rows.find((r) => r.prompt_id === excerptId);
    if (!row || row.error) {
      lines.push(`- **${m.label}**: _(失败: ${row?.error || '无数据'})_`);
      continue;
    }
    const snippet = [...row.reply].slice(0, 120).join('') + ([...row.reply].length > 120 ? '…' : '');
    lines.push(`- **${m.label}**（${row.chars}字 / 命中${row.hits} / 像类${row.simileRough}）: ${snippet}`);
  }
  lines.push('');
  lines.push('## 文件');
  lines.push('');
  lines.push('- 各模型 jsonl / `all.jsonl` / `meta.json` / `score.json` / `prompts-long.json`');
  lines.push('- 本报告：`compare.md`');
  lines.push('');

  writeFileSync(join(OUT, 'compare.md'), lines.join('\n'));
  console.log('\nReports written: compare.md score.json meta.json all.jsonl');
}

const mode = process.argv[2] || 'all';
if (mode === 'report') {
  buildReports();
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(
  join(OUT, 'meta.json'),
  JSON.stringify(
    {
      created: '2026-10-25 Asia/Shanghai',
      provider: 'siliconflow',
      temperature: TEMP,
      system: SYSTEM,
      prompt_file: 'prompts-long.json',
      n_prompts: PROMPTS.length,
      models: MODELS.map(({ id, model, wave, label }) => ({ id, model, wave, label })),
      status: 'running',
    },
    null,
    2,
  ) + '\n',
);

for (const m of MODELS) {
  await runModel(m);
  await sleep(800);
}
buildReports();
console.log('DONE');
