/**
 * 句子完整性。不调用模型。
 * 和字面保真分开：保真只看字还在不在，完整性看删完之后句子还站不站得住。
 */

export function contentChars(text) {
  return String(text ?? '').replace(/[^\p{Script=Han}\p{N}A-Za-z]/gu, '');
}

const DANGLING_CLAUSE = /^(?:一样|似的|一般)$/;
const DANGLING_END = /(?:显得|像在|像是|仿佛|好像)$/;
const LEXICAL_DE = /(?:值得|舍得|懂得|获得|赢得|记得|认得|亏得|免得)$/;
const HOLLOW_MEASURE = /[一二两三几][个件]的/;

function clauseContents(chunk) {
  return chunk.split(/[，,]/).map((part) => part.trim()).filter(Boolean);
}

/** 一句不成立。chunk 不含句号。 */
export function chunkIncomplete(chunk) {
  const body = String(chunk ?? '').trim();
  if (!body) return true;
  const content = contentChars(body);
  if (content.length < 3) return true;
  if (clauseContents(body).some((clause) => DANGLING_CLAUSE.test(contentChars(clause)))) return true;
  if (DANGLING_END.test(content)) return true;
  if (/得$/.test(content) && !LEXICAL_DE.test(content)) return true;
  if (HOLLOW_MEASURE.test(body)) return true;
  return false;
}

/**
 * 成立的句数 / 句数。按。！？切开。空文本为 0。
 * 不足 3 个字、以「一样」起句、收在「显得 / 像在 / 得」上、或出现「一件的」这种挖空，记不成立。
 * 局限：正当的「一个人的伞」会误伤；短于 3 个字的完整短句也会被算残。
 */
export function completenessScore(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return 0;
  const chunks = raw.split(/[。！？]/).map((part) => part.trim()).filter(Boolean);
  if (!chunks.length) return 0;
  const ok = chunks.filter((chunk) => !chunkIncomplete(chunk)).length;
  return ok / chunks.length;
}

export function textIncomplete(text) {
  return completenessScore(text) < 1;
}
