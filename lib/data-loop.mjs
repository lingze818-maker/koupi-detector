/**
 * 从金标和共识 tic 的虚构句导出偏好对和清洗版 SFT。
 * 只走离线省力改写。残句、仍含口癖、保真不够的不进文件。
 */

import { completenessScore, contentChars } from './complete.mjs';
import { scanText } from './rules.mjs';
import { fidelityScore, selfCheckText } from './selfcheck.mjs';
import { economyRewriter } from './rewriter.mjs';

/**
 * 字面保真低于这条的改写不进偏好对，也不进 SFT。
 * 0.85 而不是 0.9：句首「那」被一并拿掉时，Dice 大约是 0.889，这仍是约定内的省力改写。
 */
export const FIDELITY_MIN = 0.85;

const HOLLOW_TAIL = /(?:那种|一种|少见的|还是)$/;

/** 完整性函数放行、但导出仍不收的残句。不改检测和自查用的完整性。 */
export function exportHollow(text) {
  const body = String(text ?? '').replace(/[。！？\s]+$/g, '');
  if (/[、，,]$/.test(body)) return true;
  if (HOLLOW_TAIL.test(contentChars(body))) return true;
  return false;
}

function fold(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export function ticSources(gold, consensus) {
  const rows = [];
  for (const item of gold?.items || []) {
    if (item.label !== 'tic') continue;
    rows.push({
      source: 'gold',
      sourceId: item.id,
      text: item.text,
      category: item.category || null,
      hasBefore: Boolean(item.hasBefore),
      before: item.hasBefore ? item.before : undefined,
    });
  }
  for (const item of consensus?.items || []) {
    if (item.label && item.label !== 'tic') continue;
    if (!item.text || !String(item.text).trim()) continue;
    rows.push({
      source: 'consensus',
      sourceId: item.id,
      text: item.text,
      category: item.category || null,
      hasBefore: false,
    });
  }
  return rows;
}

function bump(bag, key) {
  bag[key] = (bag[key] || 0) + 1;
}

/**
 * chosen 必须是离线自查已修复的文本：和原文不同、完整性为 1、再扫没有口癖、保真不低于门槛。
 * 同一对原文和改写只留第一次。SFT 再按清洗后的正文去重。
 */
export function buildDataLoop(rows, ruleSet) {
  const pairs = [];
  const sft = [];
  const dropped = [];
  const seenPair = new Set();
  const seenSft = new Set();
  const reasons = {};

  for (const row of rows) {
    const options = { rewriter: economyRewriter, maxRounds: 2 };
    if (row.hasBefore) options.before = row.before ?? '';
    const checked = selfCheckText(row.text, ruleSet, options);
    const base = {
      source: row.source,
      sourceId: row.sourceId,
      category: row.category,
      rejected: row.text,
    };
    if (checked.disposition !== 'fixed') {
      bump(reasons, checked.disposition);
      dropped.push({ ...base, reason: checked.disposition });
      continue;
    }
    const chosen = checked.text;
    if (!chosen.trim() || fold(chosen) === fold(row.text)) {
      bump(reasons, 'unchanged');
      dropped.push({ ...base, reason: 'unchanged' });
      continue;
    }
    const completeness = completenessScore(chosen);
    if (completeness !== 1 || exportHollow(chosen)) {
      bump(reasons, 'incomplete');
      dropped.push({ ...base, reason: 'incomplete' });
      continue;
    }
    const again = scanText(chosen, ruleSet, row.hasBefore ? { before: row.before ?? '' } : {});
    if (again.hits.some((hit) => hit.verdict === 'tic')) {
      bump(reasons, 'still-tic');
      dropped.push({ ...base, reason: 'still-tic' });
      continue;
    }
    const fidelity = fidelityScore(row.text, chosen, checked.rounds[0].hits);
    if (fidelity < FIDELITY_MIN) {
      bump(reasons, 'low-fidelity');
      dropped.push({ ...base, reason: 'low-fidelity', fidelity: round3(fidelity) });
      continue;
    }
    const pairKey = `${fold(row.text)}\0${fold(chosen)}`;
    if (seenPair.has(pairKey)) {
      bump(reasons, 'duplicate');
      dropped.push({ ...base, reason: 'duplicate' });
      continue;
    }
    seenPair.add(pairKey);
    const pair = {
      id: `${row.source}:${row.sourceId}`,
      source: row.source,
      sourceId: row.sourceId,
      category: row.category,
      rejected: row.text,
      chosen,
      fidelity: round3(fidelity),
      completeness: 1,
    };
    pairs.push(pair);
    const sftKey = fold(chosen);
    if (seenSft.has(sftKey)) continue;
    seenSft.add(sftKey);
    sft.push({
      id: `sft:${row.source}:${row.sourceId}`,
      source: row.source,
      sourceId: row.sourceId,
      category: row.category,
      text: chosen,
      completeness: 1,
    });
  }

  const fidelities = pairs.map((pair) => pair.fidelity);
  return {
    pairs,
    sft,
    dropped,
    stats: {
      input: rows.length,
      preference: pairs.length,
      sft: sft.length,
      fidelityMin: fidelities.length ? Math.min(...fidelities) : null,
      fidelityMax: fidelities.length ? Math.max(...fidelities) : null,
      fidelityMinRequired: FIDELITY_MIN,
      dropped: reasons,
    },
  };
}

export function toJsonl(rows) {
  if (!rows.length) return '';
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}
