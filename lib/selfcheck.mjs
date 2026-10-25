import { completenessScore, contentChars, textIncomplete } from './complete.mjs';
import { DEFAULTS } from './defaults.mjs';
import { scanText } from './rules.mjs';
import { summarizeRedundancy } from './rewrite.mjs';
import { economyRewriter } from './rewriter.mjs';
import { countChars, perKilo } from './text.mjs';

export { completenessScore, textIncomplete };
export function brokenShape(text) {
  return textIncomplete(text);
}

const DISPOSITION_LABEL = {
  fixed: '已修复',
  'needs-model': '需模型',
  passthrough: '原样通过',
};

const KINDS = new Set(['tic', 'clean', 'abstain', 'unseen']);

function isPromise(value) {
  return Boolean(value && typeof value.then === 'function');
}

export function lcsLength(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  let curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[b.length];
}

/** 载荷 = 命中以外的字，加上每处省力改写。词面套话没有省力改写，不要求保留那一截。 */
export function fidelityPayload(original, feedback) {
  const spans = (feedback || [])
    .filter((item) => item && item.verdict === 'tic' && Number.isInteger(item.start) && item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let payload = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    payload += String(original ?? '').slice(cursor, span.start);
    if (span.rewrite) payload += span.rewrite;
    cursor = span.end;
  }
  payload += String(original ?? '').slice(cursor);
  return contentChars(payload);
}

/**
 * 字面保真：载荷字列和改写结果字列的 Dice（2×LCS / 两边长度）。
 * 两边都没有需要保留的字时为 1。只丢字或只添字都会下降。
 */
export function fidelityScore(original, rewritten, feedback) {
  const payload = fidelityPayload(original, feedback);
  const output = contentChars(rewritten);
  if (!payload.length && !output.length) return 1;
  if (!payload.length || !output.length) return 0;
  return (2 * lcsLength(payload, output)) / (payload.length + output.length);
}

function toFeedback(hit) {
  return {
    start: hit.start,
    end: hit.end,
    text: hit.text,
    category: hit.category,
    title: hit.title,
    ruleId: hit.ruleId,
    verdict: hit.verdict,
    rewrite: hit.redundancy ? hit.redundancy.rewrite : null,
    ratio: hit.redundancy ? hit.redundancy.ratio : null,
  };
}

function roundView(index, text, scan) {
  const tics = scan.hits.filter((hit) => hit.verdict === 'tic');
  const chars = countChars(text);
  return {
    round: index,
    text,
    chars,
    ticCount: tics.length,
    ticPerKilo: perKilo(tics.length, chars),
    indeterminateCount: scan.hits.filter((hit) => hit.verdict === 'indeterminate').length,
    redundancy: summarizeRedundancy(tics, chars),
    hits: tics.map(toFeedback),
  };
}

function dispositionOf(original, rounds) {
  const first = rounds[0];
  const last = rounds[rounds.length - 1];
  if (first.ticCount === 0) return 'passthrough';
  if (last.text !== original && last.ticCount === 0 && completenessScore(last.text) === 1) return 'fixed';
  return 'needs-model';
}

function finish(original, rounds) {
  const first = rounds[0];
  const last = rounds[rounds.length - 1];
  const rewrites = Math.max(0, rounds.length - 1);
  const disposition = dispositionOf(original, rounds);
  return {
    original,
    text: last.text,
    changed: last.text !== original,
    rewriteRounds: rewrites,
    disposition,
    needsModel: disposition === 'needs-model',
    feedback: last.hits,
    fidelity: fidelityScore(original, last.text, first.hits),
    completeness: completenessScore(last.text),
    charDelta: last.chars - first.chars,
    before: {
      chars: first.chars,
      ticCount: first.ticCount,
      ticPerKilo: first.ticPerKilo,
      redundancy: first.redundancy,
    },
    after: {
      chars: last.chars,
      ticCount: last.ticCount,
      ticPerKilo: last.ticPerKilo,
      redundancy: last.redundancy,
    },
    rounds,
  };
}

/**
 * 草稿自查。先扫，有口癖就把命中和省力改写交给改写器。
 * 最多重写 maxRounds 轮（默认 2，上限 2），每轮之后再扫。
 * 改写器若返回 Promise，本函数也返回 Promise；离线改写器保持同步。
 */
export function selfCheckText(text, ruleSet, options = {}) {
  const source = String(text ?? '');
  const rewriter = options.rewriter || economyRewriter;
  const maxRounds = Math.min(2, Math.max(0, options.maxRounds ?? 2));
  const scanOptions = { proximity: options.proximity ?? DEFAULTS.proximity };
  if (options.before != null) scanOptions.before = options.before;

  const rounds = [];
  let current = source;
  let pending = null;

  const scanRound = (index) => {
    const scan = scanText(current, ruleSet, scanOptions);
    const view = roundView(index, current, scan);
    rounds.push(view);
    return view;
  };

  const step = (index) => {
    const view = scanRound(index);
    if (!view.hits.length || index >= maxRounds) return finish(source, rounds);
    const produced = rewriter(current, view.hits);
    if (isPromise(produced)) {
      pending = produced.then((next) => {
        if (typeof next !== 'string') throw new Error('改写器必须返回字符串');
        if (next === current) return finish(source, rounds);
        current = next;
        return step(index + 1);
      });
      return pending;
    }
    if (typeof produced !== 'string') throw new Error('改写器必须返回字符串');
    if (produced === current) return finish(source, rounds);
    current = produced;
    return step(index + 1);
  };

  return step(0);
}

export function parseDrafts(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`草稿 JSON 解析失败：${error.message}`);
  }
  if (!Array.isArray(data.items)) throw new Error('草稿文件需要 items 数组');
  const items = data.items.map((item, index) => {
    if (!item || typeof item.text !== 'string' || !item.text.trim()) {
      throw new Error(`草稿第 ${index + 1} 条缺少 text`);
    }
    const kind = item.kind || item.label;
    if (!KINDS.has(kind)) throw new Error(`草稿 ${item.id || index + 1} 的 kind 必须是 tic、clean、abstain 或 unseen`);
    const hasBefore = Object.prototype.hasOwnProperty.call(item, 'before');
    return {
      id: item.id || `d${index + 1}`,
      text: item.text,
      kind,
      note: item.note || '',
      hasBefore,
      before: hasBefore ? (item.before ?? '') : undefined,
    };
  });
  return { version: data.version || 1, description: data.description || '', items };
}

function ratiosOf(roundsHits) {
  const ratios = [];
  for (const hits of roundsHits) {
    for (const hit of hits) {
      if (hit.ratio != null && Number.isFinite(hit.ratio)) ratios.push(hit.ratio);
    }
  }
  if (!ratios.length) return null;
  return ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
}

function groupSummary(items) {
  const beforeHits = items.reduce((sum, item) => sum + item.before.ticCount, 0);
  const afterHits = items.reduce((sum, item) => sum + item.after.ticCount, 0);
  const beforeChars = items.reduce((sum, item) => sum + item.before.chars, 0);
  const afterChars = items.reduce((sum, item) => sum + item.after.chars, 0);
  const withTicBefore = items.filter((item) => item.before.ticCount > 0).length;
  const withTicAfter = items.filter((item) => item.after.ticCount > 0).length;
  const fidelities = items.map((item) => item.fidelity);
  const completeness = items.map((item) => item.completeness);
  return {
    count: items.length,
    unchanged: items.filter((item) => item.unchanged).length,
    fixed: items.filter((item) => item.disposition === 'fixed').length,
    needsModel: items.filter((item) => item.disposition === 'needs-model').length,
    passthrough: items.filter((item) => item.disposition === 'passthrough').length,
    withTicBefore,
    withTicAfter,
    ticDraftRateBefore: items.length ? withTicBefore / items.length : null,
    ticDraftRateAfter: items.length ? withTicAfter / items.length : null,
    ticPerKiloBefore: perKilo(beforeHits, beforeChars),
    ticPerKiloAfter: perKilo(afterHits, afterChars),
    ticHitsBefore: beforeHits,
    ticHitsAfter: afterHits,
    charsBefore: beforeChars,
    charsAfter: afterChars,
    charDelta: afterChars - beforeChars,
    redundancyBefore: ratiosOf(items.map((item) => item.rounds[0].hits)),
    redundancyAfter: ratiosOf(items.map((item) => item.rounds[item.rounds.length - 1].hits)),
    fidelityMean: fidelities.length ? fidelities.reduce((sum, value) => sum + value, 0) / fidelities.length : null,
    fidelityMin: fidelities.length ? Math.min(...fidelities) : null,
    completenessMean: completeness.length ? completeness.reduce((sum, value) => sum + value, 0) / completeness.length : null,
    completenessMin: completeness.length ? Math.min(...completeness) : null,
  };
}

export function summarizeDrafts(items) {
  const groups = {
    all: groupSummary(items),
    tic: groupSummary(items.filter((item) => item.kind === 'tic')),
    clean: groupSummary(items.filter((item) => item.kind === 'clean')),
    abstain: groupSummary(items.filter((item) => item.kind === 'abstain')),
    unseen: groupSummary(items.filter((item) => item.kind === 'unseen')),
  };
  return groups;
}

export function evaluateDrafts(drafts, ruleSet, options = {}) {
  const runOne = (draft) => {
    const checked = selfCheckText(draft.text, ruleSet, {
      ...options,
      before: draft.hasBefore ? draft.before : undefined,
    });
    const attach = (result) => ({
      id: draft.id,
      kind: draft.kind,
      note: draft.note,
      beforeContext: draft.hasBefore ? draft.before : null,
      unchanged: result.text === draft.text,
      ...result,
    });
    if (isPromise(checked)) return checked.then(attach);
    return attach(checked);
  };
  const mapped = drafts.items.map(runOne);
  if (mapped.some((item) => isPromise(item))) {
    return Promise.all(mapped).then((items) => ({ items, summary: summarizeDrafts(items) }));
  }
  return { items: mapped, summary: summarizeDrafts(mapped) };
}

function showNum(value, digits = 3) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function showRate(numerator, denominator) {
  if (!denominator) return '—';
  return `${numerator}/${denominator} = ${(numerator / denominator).toFixed(3)}`;
}

function metricTable(summary) {
  const rows = [
    ['全部', summary.all],
    ['含口癖', summary.tic],
    ['不含口癖', summary.clean],
    ['系统不可判定', summary.abstain],
    ['检测器看不见', summary.unseen],
  ].filter(([, group]) => group.count > 0);
  const lines = [
    '| 分组 | 条数 | 改写前含口癖 | 改写后含口癖 | 改写前每千字 | 改写后每千字 | 改写前冗余比 | 改写后冗余比 | 字数变化 | 平均保真 | 平均完整性 | 已修复 | 需模型 | 原样通过 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const [name, group] of rows) {
    lines.push(`| ${name} | ${group.count} | ${showRate(group.withTicBefore, group.count)} | ${showRate(group.withTicAfter, group.count)} | ${group.ticPerKiloBefore} | ${group.ticPerKiloAfter} | ${showNum(group.redundancyBefore, 2)} | ${showNum(group.redundancyAfter, 2)} | ${group.charDelta} | ${showNum(group.fidelityMean)} | ${showNum(group.completenessMean)} | ${showRate(group.fixed, group.count)} | ${showRate(group.needsModel, group.count)} | ${showRate(group.passthrough, group.count)} |`);
  }
  return lines.join('\n');
}

function exampleBlock(item) {
  const hits = item.rounds[0].hits.map((hit) => {
    let action = hit.rewrite || '删去';
    if (hit.rewrite == null) action = item.needsModel ? '留下原句，需模型改写' : '删去';
    return `${hit.category}「${hit.text}」→ ${action}`;
  }).join('；') || '初扫无口癖';
  return [
    `- **${item.id}**（${item.kind}）${item.note ? item.note : ''}`,
    `  - 改写前：${item.original}`,
    `  - 改写后：${item.text || '（空）'}`,
    `  - 口癖 ${item.before.ticCount} → ${item.after.ticCount}，字数 ${item.before.chars} → ${item.after.chars}，保真 ${showNum(item.fidelity)}，完整性 ${showNum(item.completeness)}，${DISPOSITION_LABEL[item.disposition] || item.disposition}，重写 ${item.rewriteRounds} 轮`,
    `  - ${hits}`,
  ].join('\n');
}

export function formatSelfCheckReport(result, extras = {}) {
  const summary = result.summary;
  const successes = result.items.filter((item) => item.disposition === 'fixed').slice(0, 4);
  const needsModel = result.items.filter((item) => item.disposition === 'needs-model');
  const broken = result.items.filter((item) => item.completeness < 1);
  const stuck = result.items.filter((item) => item.kind === 'tic' && item.after.ticCount > 0);
  const stuckOutside = stuck.filter((item) => item.disposition !== 'needs-model');
  const missed = result.items.filter((item) => item.kind === 'unseen');
  const cleanChanged = result.items.filter((item) => (item.kind === 'clean' || item.kind === 'abstain') && !item.unchanged);
  const lines = [];
  lines.push('# 回复前自查');
  lines.push('');
  lines.push('项目：koupi-detector（口癖检测器）。');
  lines.push('');
  lines.push('草稿先扫描。有判定为口癖的命中时，把命中片段、类别和规则算出的省力改写交给改写器，最多重写 2 轮，每轮后再扫。不可判定不触发改写。离线改写器在一句删完不成立时保留该句原文，标成需模型改写，并带回命中，不把词面套话硬删成残句。这份报告用离线改写器，不调用模型。句子都是虚构的。');
  lines.push('');
  lines.push(`改写器：${extras.rewriter || 'offline'}。`);
  lines.push('');
  lines.push('复现：');
  lines.push('');
  lines.push('```bash');
  lines.push('node cli.mjs rewrite --drafts examples/selfcheck-drafts.json --report docs/selfcheck-report.md');
  lines.push('```');
  lines.push('');
  lines.push('## 指标');
  lines.push('');
  lines.push(metricTable(summary));
  lines.push('');
  lines.push('含口癖指初扫至少有一处 `verdict: tic`。每千字 = 口癖处数 / 字数 × 1000，字数去掉空白、保留标点。冗余比只平均句式口癖里有断言可留的那些条，词面套话不进这个均值；改完之后没有这类命中，就写成 —。字数变化是这一组改写后字数减改写前字数。');
  lines.push('');
  lines.push('已修复：文本改过、口癖清完、完整性为 1。需模型：初扫有口癖，但离线改写留下了原句或还没清完，命中反馈仍返回。原样通过：初扫没有口癖，文本不变。这三栏在每一组里互斥，加起来等于条数。');
  lines.push('');
  lines.push('保真是机器算的字面 Dice，不靠人判。载荷是「命中跨度以外的字」加上「该命中的省力改写」；词面套话没有省力改写，那一截不要求留下。保真 = 2 × LCS(载荷字列, 结果字列) / 两边字数。只计汉字、数字和拉丁字母。两边都空时记 1。');
  lines.push('');
  lines.push('这个保真看不出同义替换，也会把语序大改当成丢失。句式口癖内部的断言只通过省力改写进入载荷，改写器若换成另一个事实，分数会掉。词面套话被整段删掉时，套话里面偶有的具体词不在载荷里，删掉仍可能是满分。它也不检查改写后好不好读，所以口癖清了、句子塌了，保真仍可以是 1.000。');
  lines.push('');
  lines.push('需模型的条目保留原句，词面套话还在正文里。保真的载荷不含这截套话，多出来的字会把 Dice 拉低。因此这一组的平均保真可以低于 1，同时完整性仍是 1.000。硬删成残句时则相反：保真可以是 1.000，完整性是 0。');
  lines.push('');
  lines.push('完整性是另一项机器指标，和保真并列。按。！？切开，完整性 = 成立的句数 / 句数。一句记不成立的情况：去掉标点后不足 3 个字；某个逗号分句只剩「一样」「似的」或「一般」；整句收在「显得、像在、像是、仿佛、好像」上；整句收在「得」上，且不是「值得、舍得、懂得、获得、赢得、记得、认得」这类词；出现「一个的」「一件的」这种量词紧贴「的」。空文本记 0。这批草稿的原文都成立，表里的平均完整性是改写后的。');
  lines.push('');
  lines.push('完整性的局限：正当的「一个人的伞」会被「一个的」误伤；短于 3 个字的完整短句也会被算残。它不判断好不好读，只拦这几类删完之后明显站不住的句子。');
  lines.push('');
  lines.push('## 典型成功');
  lines.push('');
  lines.push(successes.length ? successes.map(exampleBlock).join('\n') : '没有把口癖清干净的草稿。');
  lines.push('');
  lines.push('## 需模型改写');
  lines.push('');
  lines.push('这些草稿初扫有口癖。离线改写若硬删，句子就不成立，所以保留原句，并留下命中反馈。口癖还在，不算已修复。');
  lines.push('');
  lines.push(needsModel.length ? needsModel.map(exampleBlock).join('\n') : '没有这种草稿。');
  lines.push('');
  lines.push('## 结果里的残句');
  lines.push('');
  lines.push('完整性小于 1 的结果会出现在这里。残句规则就是上面的完整性定义。离线改写器不该留下这种结果；若改写器仍输出残句，保真可以是 1.000，完整性不会。');
  lines.push('');
  lines.push(broken.length ? broken.map(exampleBlock).join('\n') : '没有这种草稿。');
  lines.push('');
  lines.push('## 改写后仍有口癖');
  lines.push('');
  if (!stuck.length) lines.push('含口癖的草稿在两轮内都清完了，或初扫就没有口癖。');
  else if (!stuckOutside.length) lines.push('还留着口癖的都已标成需模型改写，命中反馈在上一节。');
  else lines.push(stuckOutside.map(exampleBlock).join('\n'));
  lines.push('');
  lines.push('## 检测器看不见、因此没改');
  lines.push('');
  lines.push(missed.length ? missed.map(exampleBlock).join('\n') : '没有这种草稿。');
  lines.push('');
  lines.push('## 不含口癖或不可判定却被改动');
  lines.push('');
  lines.push(cleanChanged.length ? cleanChanged.map(exampleBlock).join('\n') : '这些草稿都原样通过。');
  lines.push('');
  lines.push('## 接上模型');
  lines.push('');
  lines.push('默认 `--rewriter offline`，句式口癖换成省力改写。词面套话只有在删完这一句仍然成立时才删；否则保留原句，标成需模型改写，并返回命中。不需要密钥。');
  lines.push('');
  lines.push('`--rewriter llm` 调用 OpenAI 兼容的 `POST {KOUPI_LLM_BASE_URL}/chat/completions`。密钥只读环境变量，不写进仓库。');
  lines.push('');
  lines.push('| 变量 | 作用 | 默认 |');
  lines.push('| --- | --- | --- |');
  lines.push('| `KOUPI_LLM_API_KEY` | 必填，否则 llm 模式直接失败 | 无 |');
  lines.push('| `KOUPI_LLM_BASE_URL` | 接口根路径，后面会接 `/chat/completions` | `https://api.openai.com/v1` |');
  lines.push('| `KOUPI_LLM_MODEL` | 模型名 | `gpt-4o-mini` |');
  lines.push('');
  lines.push('DeepSeek 示例：`KOUPI_LLM_BASE_URL=https://api.deepseek.com/v1`，`KOUPI_LLM_MODEL=deepseek-chat`，再设 `KOUPI_LLM_API_KEY`。温度固定为 0。模型只拿到草稿、命中片段、类别和省力改写，不拿到评测分组。');
  lines.push('');
  lines.push('## 单条用法');
  lines.push('');
  lines.push('```bash');
  lines.push('node cli.mjs rewrite examples/selfcheck-one.txt');
  lines.push('node cli.mjs rewrite - --json <<\'EOF\'');
  lines.push('他没有生气，也没有惊讶，只是看着她。');
  lines.push('EOF');
  lines.push('```');
  lines.push('');
  lines.push('MCP 工具名是 `tic_rewrite`。`rewriter` 默认 `offline`，`maxRounds` 默认 2 且不超过 2。可选 `before`，表示这条回复之前的对话。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function formatSelfCheck(result) {
  const lines = [];
  lines.push(`改写器完成，重写 ${result.rewriteRounds} 轮，${result.changed ? '文本有改动' : '文本未改动'}`);
  lines.push(`口癖 ${result.before.ticCount} → ${result.after.ticCount}`);
  lines.push(`每千字 ${result.before.ticPerKilo} → ${result.after.ticPerKilo}`);
  const beforeRatio = result.before.redundancy.mean == null ? '—' : result.before.redundancy.mean.toFixed(2);
  const afterRatio = result.after.redundancy.mean == null ? '—' : result.after.redundancy.mean.toFixed(2);
  lines.push(`冗余比 ${beforeRatio} → ${afterRatio}`);
  lines.push(`字数 ${result.before.chars} → ${result.after.chars}（${result.charDelta >= 0 ? '+' : ''}${result.charDelta}）`);
  lines.push(`保真 ${result.fidelity.toFixed(3)}`);
  lines.push(`完整性 ${result.completeness.toFixed(3)}`);
  lines.push(`处置 ${DISPOSITION_LABEL[result.disposition] || result.disposition}`);
  if (result.needsModel && result.feedback?.length) {
    lines.push('命中反馈：');
    for (const hit of result.feedback) {
      const suggestion = hit.rewrite == null ? '删去会把句子拆残，需模型改写' : hit.rewrite;
      lines.push(`- ${hit.category || '未知'}「${hit.text}」→ ${suggestion}`);
    }
  }
  lines.push('');
  lines.push(result.text);
  return `${lines.join('\n')}\n`;
}
