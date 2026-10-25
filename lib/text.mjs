export function stripBom(text) {
  if (text && text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text ?? '';
}

/** 去空白后的字符数。常用汉字都在 BMP，UTF-16 长度等于字数。标点计入。 */
export function countChars(text) {
  if (!text) return 0;
  return text.replace(/\s+/g, '').length;
}

export function perKilo(count, chars) {
  if (!chars) return 0;
  return Math.round((count / chars) * 1000 * 10) / 10;
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function gap(a, b) {
  if (a.end <= b.start) return b.start - a.end;
  if (b.end <= a.start) return a.start - b.end;
  return 0;
}

export function sentenceAround(text, start, end) {
  const stops = new Set(['。', '！', '？', '\n']);
  let from = 0;
  for (let i = start - 1; i >= 0; i -= 1) {
    if (stops.has(text[i])) {
      from = i + 1;
      break;
    }
  }
  let to = text.length;
  for (let i = end; i < text.length; i += 1) {
    if (stops.has(text[i])) {
      to = i + 1;
      break;
    }
  }
  const sentence = text.slice(from, to).trim();
  return sentence || text.slice(start, end);
}

export function windowSnippet(text, start, end, window) {
  const from = Math.max(0, start - window);
  const to = Math.min(text.length, end + window);
  return {
    snippet: text.slice(from, to),
    truncatedBefore: from > 0,
    truncatedAfter: to < text.length,
  };
}

const NAME_LABELS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];

export function replaceNames(text, names) {
  const ordered = [...(names || [])].map((name) => String(name).trim()).filter(Boolean);
  const labelOf = new Map(
    ordered.map((name, index) => [name, index < NAME_LABELS.length ? NAME_LABELS[index] : `人${index + 1}`]),
  );
  const byLength = [...ordered].sort((a, b) => b.length - a.length);
  let out = text ?? '';
  const applied = [];
  for (const name of byLength) {
    if (!out.includes(name)) continue;
    const token = labelOf.get(name);
    out = out.split(name).join(token);
    applied.push({ from: name, to: token });
  }
  return { text: out, applied };
}
