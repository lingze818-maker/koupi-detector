/**
 * 生成侧提示 A/B 的归因表。
 * 有落盘指标才比较每千字口癖率。没有 runs 就写未测，不把「无增益」当成已经测过。
 * 提示文本自己被检测器打中时，另记一列，表示有提示诱导的风险。
 */

import { scanText } from './rules.mjs';

export function attributeDelta(baselinePerKilo, armPerKilo, minDelta = 1) {
  if (baselinePerKilo == null || armPerKilo == null) return '未测';
  const delta = armPerKilo - baselinePerKilo;
  if (delta >= minDelta) return '提示诱导';
  if (delta <= -minDelta) return '有下降';
  return '无增益';
}

function promptTicCount(text, ruleSet) {
  if (!text || !ruleSet) return 0;
  return scanText(text, ruleSet).hits.filter((hit) => hit.verdict === 'tic').length;
}

export function buildPromptAbTable(spec, ruleSet) {
  const minDelta = spec.minDeltaPerKilo ?? 1;
  const runs = new Map((spec.runs || []).map((run) => [run.id, run]));
  const baselineId = spec.baselineId || 'baseline';
  const baseline = runs.get(baselineId);
  return (spec.variants || []).map((variant) => {
    const run = runs.get(variant.id) || null;
    const ticCount = promptTicCount(variant.system, ruleSet);
    const attribution = variant.id === baselineId
      ? (run ? '对照' : '未测')
      : attributeDelta(baseline?.ticPerKilo ?? null, run?.ticPerKilo ?? null, minDelta);
    return {
      id: variant.id,
      arm: variant.arm || '生成侧',
      factor: variant.factor,
      promptHasTic: ticCount > 0,
      promptTicCount: ticCount,
      ticPerKilo: run ? run.ticPerKilo ?? null : null,
      chars: run ? run.chars ?? null : null,
      attribution,
    };
  });
}

function cell(value) {
  return value == null ? '—' : String(value);
}

export function formatPromptAbMarkdown(spec, ruleSet) {
  const rows = buildPromptAbTable(spec, ruleSet);
  const lines = [
    '# 提示 A/B 归因',
    '',
    '项目：koupi-detector（口癖检测器）。',
    '',
    '生成侧的风格提示、ADHD 短提示和对照，用同一套门槛比较每千字口癖率。比对照高出门槛记为提示诱导，变化落在门槛内记为无增益，明显下降记为有下降。没有落盘 runs 时写未测。提示文本自己含口癖时单独标出，这不等同于已经跑过生成。',
    '',
  ];
  if (spec.note) {
    lines.push(spec.note);
    lines.push('');
  }
  lines.push('| 变量 | 位置 | 提示文本含口癖 | 每千字口癖率 | 归因 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(`| ${row.factor} | ${row.arm} | ${row.promptHasTic ? '是' : '否'} | ${cell(row.ticPerKilo)} | ${row.attribution} |`);
  }
  lines.push('');
  lines.push('检测侧只在回复写完后扫描，不写进这些 system。本表不把它算成一次生成实验。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
