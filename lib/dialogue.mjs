import { stripBom } from './text.mjs';

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function emptyToNull(character) {
  if (!character) return null;
  const keywords = character.keywords || [];
  const catchphrases = character.catchphrases || [];
  if (!character.name && keywords.length === 0 && catchphrases.length === 0) return null;
  return { name: character.name || null, keywords, catchphrases };
}

function normalizeDialogue(data, format) {
  if (!Array.isArray(data.turns)) throw new Error('对话 JSON 需要 turns 数组');
  const turns = data.turns.map((turn, index) => {
    if (!turn || typeof turn.text !== 'string') throw new Error(`第 ${index + 1} 轮缺少 text`);
    const role = turn.role || 'assistant';
    if (!['user', 'assistant', 'narration'].includes(role)) {
      throw new Error(`第 ${index + 1} 轮的 role 必须是 user、assistant 或 narration`);
    }
    return { role, speaker: turn.speaker || null, text: turn.text };
  });
  const character = data.character
    ? {
        name: data.character.name || null,
        keywords: data.character.keywords || [],
        catchphrases: data.character.catchphrases || [],
      }
    : null;
  return {
    id: data.id || null,
    title: data.title || null,
    character: emptyToNull(character),
    turns,
    format,
  };
}

function parseFrontMatter(block) {
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim();
  }
  return meta;
}

function parseMarkdown(text) {
  let body = text;
  let meta = {};
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) {
      meta = parseFrontMatter(body.slice(3, end).trim());
      body = body.slice(end + 4).replace(/^\r?\n/, '');
    }
  }
  const turns = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const textValue = current.lines.join('\n').trim();
    if (textValue) {
      turns.push({ role: current.role, speaker: current.speaker, text: textValue });
    }
    current = null;
  };
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^(user|assistant|narration|旁白)(?:[ \t]+(\S+))?[：:]\s*(.*)$/);
    if (match) {
      flush();
      current = {
        role: match[1] === '旁白' ? 'narration' : match[1],
        speaker: match[2] || null,
        lines: [match[3]],
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  if (!turns.length) throw new Error('Markdown 里没有识别到轮次。用「assistant 名字: 正文」这种行首。');
  return {
    id: meta.id || null,
    title: meta.title || null,
    character: emptyToNull({
      name: meta.character || null,
      keywords: splitList(meta.keywords),
      catchphrases: splitList(meta.catchphrases),
    }),
    turns,
    format: 'markdown',
  };
}

export function parseDialogue(raw, filename = '') {
  const text = stripBom(raw).trim();
  if (!text) throw new Error('输入是空的');
  if (text.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`JSON 解析失败：${error.message}`);
    }
    if (Array.isArray(data.items) && !Array.isArray(data.turns)) {
      throw new Error('这看起来是金标文件。评测请用 eval --gold。');
    }
    return normalizeDialogue(data, 'json');
  }
  if (
    text.startsWith('---')
    || /^(user|assistant|narration|旁白)(?:[ \t]+\S+)?[：:]/m.test(text)
  ) {
    return parseMarkdown(text);
  }
  return {
    id: null,
    title: filename || '纯文本',
    character: null,
    turns: [{ role: 'assistant', speaker: null, text }],
    format: 'plain',
  };
}

export function parseGold(raw) {
  let data;
  try {
    data = JSON.parse(stripBom(raw));
  } catch (error) {
    throw new Error(`金标 JSON 解析失败：${error.message}`);
  }
  if (!Array.isArray(data.items)) throw new Error('金标文件需要 items 数组');
  const items = data.items.map((item, index) => {
    if (!item || typeof item.text !== 'string') throw new Error(`金标第 ${index + 1} 条缺少 text`);
    if (!['tic', 'clean', 'unjudgeable'].includes(item.label)) {
      throw new Error(`金标 ${item.id || index + 1} 的 label 必须是 tic、clean 或 unjudgeable`);
    }
    const hasBefore = Object.prototype.hasOwnProperty.call(item, 'before');
    return {
      id: item.id || `g${index + 1}`,
      text: item.text,
      label: item.label,
      category: item.category || null,
      note: item.note || '',
      hasBefore,
      before: hasBefore ? (item.before ?? '') : undefined,
    };
  });
  return { version: data.version || 1, description: data.description || '', items };
}

export function parseAnnotation(raw) {
  let data;
  try {
    data = JSON.parse(stripBom(raw));
  } catch (error) {
    throw new Error(`标注 JSON 解析失败：${error.message}`);
  }
  if (!Array.isArray(data.items)) throw new Error('标注文件需要 items 数组');
  return data;
}
