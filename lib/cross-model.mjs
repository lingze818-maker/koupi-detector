/**
 * 同一批虚构 prompt、同一温度，按模型量口癖率。
 * 没有密钥的模型留空，不写成 0。
 */

import { scanText } from './rules.mjs';
import { countChars, perKilo } from './text.mjs';

export const CROSS_MODEL_TEMPERATURE = 0;

const CATEGORIES = [
  ['template', '句式模板'],
  ['emotion-flat', '情绪抹平'],
  ['metaphor', '比喻套话'],
];

export function modelSlots(env = process.env) {
  const slots = [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      baseUrl: env.KOUPI_LLM_BASE_URL || 'https://api.deepseek.com/v1',
      model: env.KOUPI_LLM_MODEL || 'deepseek-chat',
      apiKey: env.KOUPI_LLM_API_KEY || '',
    },
  ];
  const names = String(env.KOUPI_EVAL_MODELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const name of names) {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    slots.push({
      id: name,
      label: name,
      baseUrl: env[`KOUPI_EVAL_${key}_BASE_URL`] || '',
      model: env[`KOUPI_EVAL_${key}_MODEL`] || '',
      apiKey: env[`KOUPI_EVAL_${key}_API_KEY`] || '',
    });
  }
  return slots;
}

export function slotStatus(slot) {
  if (!slot.apiKey) return 'no-key';
  if (!slot.baseUrl || !slot.model) return 'incomplete';
  return 'ready';
}

export function scoreReplies(replies, ruleSet) {
  let chars = 0;
  let ticCount = 0;
  const byCategory = { template: 0, 'emotion-flat': 0, metaphor: 0 };
  for (const text of replies) {
    chars += countChars(text);
    const scan = scanText(text, ruleSet);
    for (const hit of scan.hits) {
      if (hit.verdict !== 'tic') continue;
      ticCount += 1;
      if (Object.prototype.hasOwnProperty.call(byCategory, hit.category)) {
        byCategory[hit.category] += 1;
      }
    }
  }
  return {
    chars,
    ticCount,
    ticPerKilo: chars ? perKilo(ticCount, chars) : null,
    byCategory,
  };
}

function emptyMetrics() {
  return {
    chars: null,
    ticCount: null,
    ticPerKilo: null,
    byCategory: { template: null, 'emotion-flat': null, metaphor: null },
  };
}

async function completeOne(slot, system, user, fetchImpl, temperature, timeoutMs) {
  const root = String(slot.baseUrl).replace(/\/$/, '');
  const response = await fetchImpl(`${root}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${slot.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: slot.model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`接口返回 ${response.status}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('接口没有返回文本');
  return content.trim();
}

/**
 * 只对 ready 的模型发请求。no-key / incomplete 的指标全部是 null。
 */
export async function runCrossModel({
  slots,
  prompts,
  ruleSet,
  fetchImpl = globalThis.fetch,
  temperature = CROSS_MODEL_TEMPERATURE,
  timeoutMs = 30000,
}) {
  const system = prompts.system || '';
  const items = prompts.prompts || prompts.items || [];
  const rows = [];
  for (const slot of slots) {
    const status = slotStatus(slot);
    if (status !== 'ready') {
      rows.push({
        id: slot.id,
        label: slot.label,
        model: slot.model || null,
        status,
        temperature,
        replies: [],
        ...emptyMetrics(),
      });
      continue;
    }
    const replies = [];
    try {
      for (const prompt of items) {
        replies.push(await completeOne(slot, system, prompt.user, fetchImpl, temperature, timeoutMs));
      }
      rows.push({
        id: slot.id,
        label: slot.label,
        model: slot.model,
        status: 'ran',
        temperature,
        replies,
        ...scoreReplies(replies, ruleSet),
      });
    } catch (error) {
      rows.push({
        id: slot.id,
        label: slot.label,
        model: slot.model,
        status: 'error',
        error: error.message,
        temperature,
        replies: [],
        ...emptyMetrics(),
      });
    }
  }
  return { temperature, rows };
}

function cell(value) {
  return value == null ? '—' : String(value);
}

export function formatCrossModelMarkdown(result) {
  const lines = [
    '# 跨模型口癖率',
    '',
    `温度 ${result.temperature}。没有密钥或请求失败的模型不填数字。— 不是 0。`,
    '',
    '| 模型 | 状态 | 每千字口癖率 | 句式模板 | 情绪抹平 | 比喻套话 | 字数 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of result.rows) {
    const status = row.status === 'no-key' ? '无密钥' : row.status === 'ran' ? '已跑' : row.status === 'error' ? '失败' : row.status;
    lines.push(`| ${row.label} | ${status} | ${cell(row.ticPerKilo)} | ${cell(row.byCategory.template)} | ${cell(row.byCategory['emotion-flat'])} | ${cell(row.byCategory.metaphor)} | ${cell(row.chars)} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function renderCrossModelSvg(result) {
  const width = 640;
  const height = 280;
  const ran = result.rows.filter((row) => row.status === 'ran' && row.ticPerKilo != null);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#f7f4ee"/>',
    '<text x="24" y="32" font-family="sans-serif" font-size="16" fill="#1c1917">每千字口癖率</text>',
    `<text x="24" y="52" font-family="sans-serif" font-size="12" fill="#57534e">温度 ${result.temperature}。无密钥的模型不画柱。</text>`,
  ];
  if (!ran.length) {
    parts.push('<text x="24" y="140" font-family="sans-serif" font-size="14" fill="#57534e">没有密钥，未跑。这里不填 0。</text>');
  } else {
    const max = Math.max(...ran.map((row) => row.ticPerKilo), 1);
    const barWidth = 48;
    ran.forEach((row, index) => {
      const barHeight = Math.round((row.ticPerKilo / max) * 140);
      const x = 48 + index * 120;
      const y = 210 - barHeight;
      parts.push(`<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="#9a3412"/>`);
      parts.push(`<text x="${x}" y="230" font-family="sans-serif" font-size="12" fill="#1c1917">${row.label}</text>`);
      parts.push(`<text x="${x}" y="${y - 6}" font-family="sans-serif" font-size="12" fill="#1c1917">${row.ticPerKilo}</text>`);
    });
  }
  const missing = result.rows.filter((row) => row.status !== 'ran').map((row) => row.label);
  if (missing.length) {
    parts.push(`<text x="24" y="262" font-family="sans-serif" font-size="12" fill="#57534e">留空：${missing.join('、')}</text>`);
  }
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

export { CATEGORIES };
