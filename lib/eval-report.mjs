import { collectRedundancy, datasetProfile, summarizeSubset } from './eval.mjs';

function showRatio(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  return ratio.toFixed(2);
}

function showRate(rate, numerator, denominator) {
  if (rate == null || !denominator) return '无法计算';
  return `${numerator}/${denominator} = ${rate.toFixed(3)}`;
}

function cell(value) {
  return String(value ?? '').replaceAll('|', '｜').replaceAll('\n', ' ');
}

function histogram(ratios) {
  const bins = [
    { label: '低于 1', count: 0, take: (ratio) => ratio < 1 },
    { label: '1.00–1.99', count: 0, take: (ratio) => ratio < 2 },
    { label: '2.00–2.99', count: 0, take: (ratio) => ratio < 3 },
    { label: '3.00–3.99', count: 0, take: (ratio) => ratio < 4 },
    { label: '4.00 及以上', count: 0, take: () => true },
  ];
  for (const ratio of ratios) {
    const bin = bins.find((item) => item.take(ratio));
    bin.count += 1;
  }
  return bins.filter((bin) => bin.label !== '低于 1' || bin.count > 0);
}

function rateTable(result) {
  const counts = result.counts;
  const abstain = counts.indeterminateOnTic + counts.indeterminateOnClean;
  return [
    '| 指标 | 结果 |',
    '| --- | --- |',
    `| 检出率 | ${showRate(result.detectionRate, counts.tp, counts.tp + counts.fn)} |`,
    `| 误报率 | ${showRate(result.falsePositiveRate, counts.fp, counts.fp + counts.tn)} |`,
    `| 不可判定率 | ${showRate(result.indeterminateRate, abstain, counts.decidable)} |`,
  ].join('\n');
}

function categoryTable(result) {
  const lines = [
    '| 类别 | 检出率 | 误报率 | 不可判定率 |',
    '| --- | --- | --- | --- |',
  ];
  for (const category of result.byCategory || []) {
    const counts = category.counts;
    lines.push(
      `| ${cell(category.title)} | ${showRate(category.detectionRate, counts.tp, counts.tp + counts.fn)} | ${showRate(category.falsePositiveRate, counts.fp, counts.fp + counts.tn)} | ${showRate(category.indeterminateRate, counts.indeterminate, counts.positives)} |`,
    );
  }
  return lines.join('\n');
}

function rewriteTable(rows) {
  if (!rows.length) return '（无）';
  const lines = [
    '| 编号 | 原命中 | 最短改写 | 冗余比 | 冗余字 |',
    '| --- | --- | --- | --- | --- |',
  ];
  const ordered = [...rows].sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || a.id.localeCompare(b.id));
  for (const row of ordered) {
    lines.push(
      `| ${cell(row.id)} | ${cell(row.original)} | ${cell(row.rewrite || '（删去）')} | ${showRatio(row.ratio)} | ${row.redundantChars} |`,
    );
  }
  return lines.join('\n');
}

function noteList(rows) {
  const seen = new Set();
  const lines = [];
  for (const row of rows) {
    if (seen.has(row.id) || !row.note) continue;
    seen.add(row.id);
    lines.push(`- ${row.id}：${row.note}`);
  }
  return lines.join('\n');
}

function delta(later, earlier) {
  if (later == null || earlier == null) return '—';
  const value = later - earlier;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(3)}`;
}

function ratesFromCounts(counts) {
  if (!counts) return null;
  const abstain = counts.indeterminateOnTic + counts.indeterminateOnClean;
  const decidedTic = counts.tp + counts.fn;
  const decidedClean = counts.fp + counts.tn;
  return {
    det: showRate(decidedTic ? counts.tp / decidedTic : null, counts.tp, decidedTic),
    fp: showRate(decidedClean ? counts.fp / decidedClean : null, counts.fp, decidedClean),
    ind: showRate(counts.decidable ? abstain / counts.decidable : null, abstain, counts.decidable),
    detectionRate: decidedTic ? counts.tp / decidedTic : null,
    falsePositiveRate: decidedClean ? counts.fp / decidedClean : null,
    indeterminateRate: counts.decidable ? abstain / counts.decidable : null,
  };
}

function profileRow(name, items) {
  const profile = datasetProfile(items);
  const tic = profile.ticByCategory;
  return `| ${name} | ${profile.total} | ${profile.labels.tic || 0} | ${profile.labels.clean || 0} | ${profile.labels.unjudgeable || 0} | ${tic.template || 0} | ${tic['emotion-flat'] || 0} | ${tic.metaphor || 0} | ${profile.withBefore} |`;
}

function caseList(items, empty) {
  if (!items.length) return empty;
  return items.map((item) => `- **${item.id}**（金标 ${item.gold}，系统 ${item.pred}）${item.text}${item.note ? ` — ${item.note}` : ''}`).join('\n');
}

function datasetSection(name, result) {
  const counts = result.counts;
  const redundancy = result.redundancy || collectRedundancy(result.items || []);
  const ratios = redundancy.penalised.map((row) => row.ratio).filter((ratio) => ratio != null && Number.isFinite(ratio));
  const misses = result.items.filter((item) => item.gold === 'tic' && item.pred === 'negative');
  const alarms = result.items.filter((item) => item.gold === 'clean' && item.pred === 'positive');
  const held = result.items.filter((item) => item.pred === 'indeterminate' && item.gold !== 'unjudgeable');
  const lines = [];
  lines.push(`## ${name}`);
  lines.push('');
  lines.push(`样本 ${result.items.length} 条。人工可判定 ${counts.decidable} 条，人工自己不可判定 ${counts.goldUnjudgeable} 条。`);
  lines.push('');
  lines.push(rateTable(result));
  lines.push('');
  lines.push(`判定明细：真阳性 ${counts.tp}，漏检 ${counts.fn}，误报 ${counts.fp}，真阴性 ${counts.tn}，口癖上弃权 ${counts.indeterminateOnTic}，非口癖上弃权 ${counts.indeterminateOnClean}。`);
  lines.push('');
  lines.push('### 按类别');
  lines.push('');
  lines.push(categoryTable(result));
  lines.push('');
  lines.push('### 冗余比');
  lines.push('');
  lines.push(`计入 ${redundancy.hitCount} 处句式口癖，其中 ${redundancy.ratioCount} 处有断言可留。均值 ${showRatio(redundancy.mean)}，最小 ${showRatio(redundancy.min)}，最大 ${showRatio(redundancy.max)}。冗余字合计 ${redundancy.redundantChars}，相对人工可判定文本 ${redundancy.perKiloAll} /千字，只看含这些口癖的句子 ${redundancy.perKiloOnTicTexts} /千字。非口癖上计入的冗余字是 ${redundancy.cleanRedundant}。`);
  lines.push('');
  lines.push('| 区间 | 处数 |');
  lines.push('| --- | --- |');
  for (const bin of histogram(ratios)) lines.push(`| ${bin.label} | ${bin.count} |`);
  lines.push('');
  const shown = [...redundancy.penalised].sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || a.id.localeCompare(b.id)).slice(0, 8);
  lines.push(`冗余比最高的 ${shown.length} 条（计入 ${redundancy.penalised.length} 条）：`);
  lines.push('');
  lines.push(rewriteTable(shown));
  lines.push('');
  lines.push('### 典型 badcase');
  lines.push('');
  lines.push('#### 漏检');
  lines.push('');
  lines.push(caseList(misses, '没有漏检。'));
  lines.push('');
  lines.push('#### 误报');
  lines.push('');
  lines.push(caseList(alarms, '没有误报。'));
  lines.push('');
  lines.push('#### 系统不可判定');
  lines.push('');
  lines.push(caseList(held, '没有系统弃权。'));
  lines.push('');
  return lines;
}

export function formatEvalReport(result, extras = {}) {
  const holdout = extras.holdout || null;
  const holdoutV2 = extras.holdoutV2 || null;
  const baseline = extras.baseline || null;
  const sameGold = baseline
    ? summarizeSubset(result, (item) => /^g\d+$/.test(item.id) && Number(item.id.slice(1)) <= 150)
    : null;
  const lines = [];
  lines.push('# 口癖检测评测报告');
  lines.push('');
  lines.push('项目：koupi-detector（口癖检测器）。');
  lines.push('');
  lines.push('句子都是虚构的，没有真实用户对话，也没有个人信息。本轮规则只按金标调。旧留出集在上一轮已经看过，这一轮要修的误报和漏检就来自它的 badcase，所以修复后的旧留出分数不是完全干净的估计。留出集 v2 在规则定稿之后才写，只评了一次，没有按它改规则，也没有改句子。');
  lines.push('');
  lines.push('复现：');
  lines.push('');
  lines.push('```bash');
  lines.push('node cli.mjs eval --gold examples/gold.json --holdout examples/holdout.json --holdout-v2 examples/holdout-v2.json --baseline examples/baseline-before.json --report docs/eval-report.md');
  lines.push('```');
  lines.push('');
  lines.push('## 修复前 / 修复后');
  lines.push('');
  lines.push('修复前的数字来自规则改动前保存的 `examples/baseline-before.json`。同一批句子的修复后数字，是现在这套规则重新算的。最后一列是检出率、误报率、不可判定率各自的「修复后减修复前」。');
  lines.push('');
  lines.push('| 数据集 | 时点 | 检出率 | 误报率 | 不可判定率 | 修复后减修复前 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  if (baseline?.gold) {
    const before = ratesFromCounts(baseline.gold.counts);
    lines.push(`| 金标里本轮之前的句子 | 修复前 | ${before.det} | ${before.fp} | ${before.ind} | — |`);
  }
  if (sameGold) {
    const after = ratesFromCounts(sameGold.counts);
    const before = ratesFromCounts(baseline.gold.counts);
    lines.push(`| 金标里本轮之前的句子 | 修复后 | ${after.det} | ${after.fp} | ${after.ind} | ${delta(after.detectionRate, before.detectionRate)} / ${delta(after.falsePositiveRate, before.falsePositiveRate)} / ${delta(after.indeterminateRate, before.indeterminateRate)} |`);
  }
  const full = ratesFromCounts(result.counts);
  lines.push(`| 金标（含本轮补的 ${result.items.length} 条） | 修复后 | ${full.det} | ${full.fp} | ${full.ind} | — |`);
  if (baseline?.holdout && holdout) {
    const before = ratesFromCounts(baseline.holdout.counts);
    const after = ratesFromCounts(holdout.counts);
    lines.push(`| 旧留出集 | 修复前 | ${before.det} | ${before.fp} | ${before.ind} | — |`);
    lines.push(`| 旧留出集 | 修复后 | ${after.det} | ${after.fp} | ${after.ind} | ${delta(after.detectionRate, before.detectionRate)} / ${delta(after.falsePositiveRate, before.falsePositiveRate)} / ${delta(after.indeterminateRate, before.indeterminateRate)} |`);
  }
  if (holdoutV2) {
    const once = ratesFromCounts(holdoutV2.counts);
    lines.push(`| 留出集 v2 | 定稿后一次 | ${once.det} | ${once.fp} | ${once.ind} | — |`);
  }
  lines.push('');
  lines.push('金标在本轮补了介词开头的正常纠正和绕路否定，以及隔句两段式的正反例。那 17 条没有修复前的对照，所以「含本轮补的句子」一行不减修复前。旧留出集的句子没有改。');
  lines.push('');
  lines.push('## 分布');
  lines.push('');
  lines.push('| 数据集 | 条数 | 口癖 | 正常句 | 人工不可判定 | 句式口癖 | 情绪抹平 | 比喻套话 | 带前文 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  lines.push(profileRow('金标', result.items));
  if (holdout) lines.push(profileRow('旧留出集', holdout.items));
  if (holdoutV2) lines.push(profileRow('留出集 v2', holdoutV2.items));
  lines.push('');
  lines.push('口癖按人工标的类别计。正常句的 category 为空，里面包括前文出现过被否定项的真实对比、另起一句的而是/只是、跨轮后半、隔了太多句界的否定，以及情绪词和比喻词的近义说法。留出集 v2 里有一批情绪抹平和比喻套话的近义说法，人工标成口癖，词表里不一定有同样的词面。');
  lines.push('');
  lines.push('## 要量的东西');
  lines.push('');
  lines.push('人说话省力。杯子里是白水，就说「这是杯白水」。模型常写成「这不是茶，也不是酒，而是白开水」：先排除没人问过的选项，再落到真正要说的那半句。节奏是固定的，信息只在最后。');
  lines.push('');
  lines.push('检测回答三件事。');
  lines.push('');
  lines.push('1. 金标口癖里，系统在作出判定的那些条上抓住了多少（检出率）。');
  lines.push('2. 金标非口癖里，系统在作出判定的那些条上误伤了多少（误报率）。');
  lines.push('3. 人工可判定的条目里，系统自己放弃判定的比例（不可判定率）。');
  lines.push('');
  lines.push('冗余比回答第四件：被判成口癖的句式，比只留断言的最短改写长多少。');
  lines.push('');
  lines.push('## 口径');
  lines.push('');
  lines.push('系统对每条金标给出 `positive`（口癖）、`negative`（非口癖）或 `indeterminate`（不可判定）。人工标了 `unjudgeable` 的条目不进下面任何比率。');
  lines.push('');
  lines.push('- 检出率 = 判成口癖的金标口癖 / 系统作出了判定的金标口癖。');
  lines.push('- 误报率 = 被判成口癖的金标非口癖 / 系统作出了判定的金标非口癖。');
  lines.push('- 不可判定率 = 系统不可判定 / 人工可判定的金标。');
  lines.push('');
  lines.push('弃权不进检出率和误报率的分子、分母，也不算一次成功检出。');
  lines.push('');
  lines.push('按类别拆开时，分母不一样，需要分开看：');
  lines.push('');
  lines.push('- 某类的检出率、不可判定率，只在「金标口癖且类别就是这一类」的条目上算。');
  lines.push('- 某类的误报率，分母仍是全部已经作出判定的金标非口癖；分子是其中被这一类判成口癖的条数。');
  lines.push('');
  lines.push('所以总检出率会把情绪抹平、比喻套话算进去，句式模板那一行只看句式。两份数据用同一口径。');
  lines.push('');
  lines.push(...datasetSection('金标', result));
  if (holdout) lines.push(...datasetSection('旧留出集', holdout));
  if (holdoutV2) lines.push(...datasetSection('留出集 v2', holdoutV2));
  if (holdout || holdoutV2) {
    lines.push('## 留出集和金标的差距');
    lines.push('');
    lines.push('旧留出集已经被看过一次。下面的修复后数字可以说明规则有没有把上一轮的 badcase 带走，不能当成一份没见过的估计。没见过的估计看留出集 v2。');
    lines.push('');
    const blocks = [['金标', result]];
    if (holdout) blocks.push(['旧留出集', holdout]);
    if (holdoutV2) blocks.push(['留出集 v2', holdoutV2]);
    lines.push(`| 数据集 | 检出率 | 误报率 | 不可判定率 |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const [name, block] of blocks) {
      const counts = block.counts;
      const abstain = counts.indeterminateOnTic + counts.indeterminateOnClean;
      lines.push(`| ${name} | ${showRate(block.detectionRate, counts.tp, counts.tp + counts.fn)} | ${showRate(block.falsePositiveRate, counts.fp, counts.fp + counts.tn)} | ${showRate(block.indeterminateRate, abstain, counts.decidable)} |`);
    }
    lines.push('');
    const describe = (name, block) => {
      const miss = block.items.filter((item) => item.gold === 'tic' && item.pred === 'negative').map((item) => item.id);
      const alarm = block.items.filter((item) => item.gold === 'clean' && item.pred === 'positive').map((item) => item.id);
      return `${name}：漏检 ${miss.length} 条${miss.length ? `（${miss.join('、')}）` : ''}，误报 ${alarm.length} 条${alarm.length ? `（${alarm.join('、')}）` : ''}`;
    };
    lines.push(`${blocks.map(([name, block]) => describe(name, block)).join('。')}。`);
    lines.push('');
    lines.push('两段式中间再隔一整句时，系统不再判成口癖，也不再当成没看见：前文没把被否定项说全，就标不可判定；前文已经说全，仍放行。隔了两句以上的、以及上一轮才出现前半句的，仍然不接。否定槽若以从、对、被、为、向、往、朝、由、在、把、将、给、跟开头，检索时会剥掉这个介词；从前、对方、被单、为什么这类词不剥。');
    lines.push('');
  }
  lines.push('## 冗余比怎么算');
  lines.push('');
  lines.push('不调用模型。每条句式命中按形状收成最短改写，只留断言：');
  lines.push('');
  lines.push('| 句式 | 最短改写 |');
  lines.push('| --- | --- |');
  lines.push('| 不是 A，也不是 B，而是 C | 是 C |');
  lines.push('| 没有 A，也没有 B，只是 C | 只是 C |');
  lines.push('| 没有 A，只是 B | 只是 B |');
  lines.push('| 不是 A，而是 B；没有 A，而是 B | 是 B |');
  lines.push('| 没有 A，也没有 B | 删去。没有断言可留 |');
  lines.push('| 像在 A，又像是在 B | 像是在 B |');
  lines.push('');
  lines.push('字数去掉空白、保留标点，和密度用同一口径。');
  lines.push('');
  lines.push('- 冗余比 = 命中字数 / 最短改写字数。');
  lines.push('- 冗余字 = 命中字数 − 最短改写字数。');
  lines.push('- 每千字冗余字 = 冗余字合计 / 文本字数 × 1000。');
  lines.push('');
  lines.push('没有断言可留时，冗余比留空，不进均值和最大值，命中字数全部算进冗余字。只把判定为口癖的句式算进去。前文提过的真实纠正会放行，不进这三项。系统标成不可判定的也不进。跨句命中的原文字数把句号、问号、叹号、省略号和换行算进去，最短改写仍然只留断言。同一句「没有糖，也没有牛奶，只是白水」，前文没人提过糖和牛奶时计入；前文问过糖和牛奶时放行。');
  lines.push('');
  lines.push('句子级金标的分母很短，每千字会被抬高。拿去扫一整段对话时，分母是整段角色文本。单条转折绕不绕，看冗余比本身：断言越长，比值越接近 1。');
  lines.push('');
  lines.push('弃权是故意的。槽位一虚一实、前文只出现了部分选项、单句又没有前文、或者短排比看不出套话时，规则不猜。这些条不把检出率抬高，也不把误报率抬高。');
  lines.push('');
  lines.push('## 已知局限');
  lines.push('');
  lines.push('1. 同一轮里，不是/没有和而是/只是之间，紧挨着或只隔一个句界（。！？…，以及换行）时照常判定。两段式再隔一个无关整句：前文已经把被否定项都说过，就放行；否则标不可判定，不判成口癖。再多隔一句就不接。三段式本身可以跨两个句界。不跨说话人轮次：上一轮的「不是责备。」接不上这一轮的「而是把话放平。」');
  lines.push('2. 前文对照仍是子串，不是指代消解。介词开头的槽会先剥一层介词，被、给、跟、对、为后面若还拖着动词，再拿前两字去对。从前、对方、被单、为什么、从容这些不是「介词 + 名词」的说法不剥。前文说「那种饮料」、后文否定「茶」，仍然对不上。');
  lines.push('3. 回看默认 4 轮。更早提过的选项，会被当成没提过。');
  lines.push('4. 冗余比只看结构，不判断改写后好不好读，也不调用模型。「没有 A，也没有 B」没有断言可留，比例留空，字数全部算冗余。「像在 A，又像是在 B」只留后一侧，这是约定。');
  lines.push('5. 情绪抹平和比喻套话的正例大多贴着现有词面。换一种近义说法，规则可以完全看不见。留出集 v2 里这类句子的漏检，就是这个限度。');
  lines.push('6. 旧留出集的修复后分数不是完全干净的估计。留出集 v2 只跑了一次，但两份数据都是虚构句子，作者写的时候看得到规则，不能代替真实对话。');
  lines.push('');
  lines.push('## 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('node cli.mjs eval --gold examples/gold.json --holdout examples/holdout.json --holdout-v2 examples/holdout-v2.json --baseline examples/baseline-before.json');
  lines.push('node cli.mjs eval --gold examples/gold.json --holdout examples/holdout.json --holdout-v2 examples/holdout-v2.json --baseline examples/baseline-before.json --report docs/eval-report.md');
  lines.push('node --test');
  lines.push('```');
  lines.push('');
  lines.push('`--report` 不写路径时，输出就是本文件。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
