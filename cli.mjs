#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERSION, DEFAULTS } from './lib/defaults.mjs';
import { readText, loadRuleSet, writeText } from './lib/io.mjs';
import { parseAnnotation, parseDialogue, parseGold } from './lib/dialogue.mjs';
import { scanDialogue } from './lib/scan.mjs';
import { collectNames, presentScan } from './lib/present.mjs';
import { applyAttributions } from './lib/attribution.mjs';
import { toBadcase, toJsonl } from './lib/badcase.mjs';
import { buildReport, formatReport, formatScan, reportToCsv } from './lib/report.mjs';
import { evaluateGold, formatEval } from './lib/eval.mjs';
import { formatEvalReport } from './lib/eval-report.mjs';
import { rewriterFromEnv } from './lib/rewriter.mjs';
import { evaluateDrafts, formatSelfCheck, formatSelfCheckReport, parseDrafts, selfCheckText } from './lib/selfcheck.mjs';
import { buildDataLoop, ticSources, toJsonl as dataJsonl } from './lib/data-loop.mjs';
import { formatCrossModelMarkdown, modelSlots, renderCrossModelSvg, runCrossModel } from './lib/cross-model.mjs';
import { formatPromptAbMarkdown } from './lib/prompt-ab.mjs';
import { replaceNames } from './lib/text.mjs';

const BOOLEAN_FLAGS = new Set(['json', 'redact', 'strict', 'help']);

export function parseArgs(argv) {
  const args = argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    return { cmd: 'help', flags: {}, positionals: [] };
  }
  const cmd = args[0];
  const flags = {};
  const positionals = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = args[i + 1];
    if (next != null && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { cmd, flags, positionals };
}

function helpText() {
  return `koupi-detector ${VERSION}
口癖检测器。零依赖的中文角色扮演模型口癖检测。句式模板是首要类别。

用法
  node cli.mjs scan <文件> [选项]
  node cli.mjs report <文件> [选项]
  node cli.mjs eval --gold <金标.json> [选项]
  node cli.mjs rewrite <文件> [选项]
  node cli.mjs rewrite --drafts <草稿.json> [选项]
  node cli.mjs rules
  node cli.mjs data --gold <金标.json> --consensus <共识.json>
  node cli.mjs cross-model --prompts <prompts.json>
  node cli.mjs prompt-ab --spec <prompt-ab.json>

文件用 - 表示从标准输入读。真实对话只在本机跑，不要提交进仓库。

选项
  --json                     只打印 JSON
  --rules <文件>             词表，默认 tics/default.json
  --roles <列表>             参与统计的角色，默认 assistant
  --redact                   上下文只留命中两侧窗口，并替换人名
  --names <甲,乙>            要替换的人名。脱敏时会并上角色卡和说话人
  --window <字数>            脱敏窗口，默认 ${DEFAULTS.window}
  --annotate <文件>          人工归因。工具自己永远先标 unknown
  --save-badcases <文件>     把命中导出成 JSONL
  --template-threshold <n>   句式模板全篇密度告警线，默认 ${DEFAULTS.templateThreshold} /千字
  --turn-threshold <n>       单轮密度告警线，默认 ${DEFAULTS.turnThreshold} /千字
  --min-turn-chars <n>       单轮密度告警的最小字数，默认 ${DEFAULTS.minTurnChars}
  --context-turns <n>        绕路否定回看的前序轮数，默认 ${DEFAULTS.contextTurns}。0 表示只看同轮
  --csv <文件>               report 另写密度曲线
  --strict                   句式模板告警时用退出码 2
  --gold <文件>              eval 的金标
  --holdout <文件>           eval 的留出集，和金标分开计三率
  --holdout-v2 <文件>        规则定稿后才写的第二份留出集，只评一次
  --baseline <文件>          修复前的评测摘要，报告里和修复后并列
  --report [文件]            eval 写出 docs/eval-report.md；rewrite --drafts 写出 docs/selfcheck-report.md
  --drafts <文件>            rewrite 的一批虚构草稿
  --rewriter <offline|llm>   自查改写器，默认 offline。llm 读 KOUPI_LLM_API_KEY
  --rounds <n>               自查最多重写轮数，默认 2，上限 2
  --before <文本>            单条回复之前的对话，用来判断绕路否定
  --consensus <文件>         data 的共识 tic，只读虚构正文
  --preference <文件>        data 写出的偏好对 JSONL
  --sft <文件>               data 写出的清洗版 SFT JSONL
  --prompts <文件>           cross-model 的虚构 prompt
  --spec <文件>              prompt-ab 的提示变量
  --out <目录>               cross-model 的输出目录，默认 runs

密度只计判定为口癖的命中。不可判定不计入，也不触发告警。
「不是茶，也不是酒，而是白开水」若前文没人提过茶和酒，算绕路否定，计入句式模板密度。
只有前文真的提过这些选项，才放行。单句又没有前文时，标不可判定。
同一轮里，两段式再隔一个无关句时标不可判定；前文已经提过被否定项的仍放行。再多隔一句就不接。不跨说话人轮次。
冗余比 = 命中字数 / 最短改写字数。只计判定为口癖的句式。前文放行的对比不计入。
`;
}

function defaultRulesPath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'tics', 'default.json');
}

function flagNumber(flags, name, fallback) {
  if (flags[name] == null || flags[name] === true) return fallback;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) throw new Error(`--${name} 需要数字`);
  return value;
}

function listFlag(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionsFrom(flags, dialogue) {
  const roles = listFlag(flags.roles);
  const redact = Boolean(flags.redact);
  const extraNames = listFlag(flags.names);
  return {
    roles: roles.length ? roles : [...DEFAULTS.roles],
    proximity: DEFAULTS.proximity,
    redact,
    window: flagNumber(flags, 'window', DEFAULTS.window),
    names: redact ? collectNames(dialogue, extraNames) : extraNames,
    templateThreshold: flagNumber(flags, 'template-threshold', DEFAULTS.templateThreshold),
    turnThreshold: flagNumber(flags, 'turn-threshold', DEFAULTS.turnThreshold),
    minTurnChars: flagNumber(flags, 'min-turn-chars', DEFAULTS.minTurnChars),
    contextTurns: flagNumber(flags, 'context-turns', DEFAULTS.contextTurns),
  };
}

function withAttribution(scan, annotation) {
  const hits = applyAttributions(scan.hits, annotation || { items: [] });
  const byId = new Map(hits.map((hit) => [hit.id, hit]));
  return {
    ...scan,
    hits,
    turns: scan.turns.map((turn) => ({
      ...turn,
      hits: turn.hits.map((hit) => byId.get(hit.id) || hit),
    })),
  };
}

function analyzeFile(file, flags) {
  const dialogue = parseDialogue(readText(file), file === '-' ? 'stdin' : file);
  const ruleSet = loadRuleSet(flags.rules || defaultRulesPath());
  const options = optionsFrom(flags, dialogue);
  const annotation = flags.annotate ? parseAnnotation(readText(flags.annotate)) : null;
  const scan = withAttribution(scanDialogue(dialogue, ruleSet, options), annotation);
  const report = buildReport(scan, dialogue, ruleSet, options);
  if (options.redact) {
    report.curve = report.curve.map((point) => ({
      ...point,
      speaker: point.speaker ? replaceNames(point.speaker, options.names).text : point.speaker,
    }));
  }
  const presented = presentScan(scan, options);
  return { dialogue, ruleSet, options, report, presented };
}

function printJson(io, value) {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function maybeBadcases(flags, presented) {
  if (!flags['save-badcases']) return;
  const records = presented.hits.map((hit) => toBadcase(hit, {
    source: flags._file || null,
    window: presented.hits[0]?.charWindow,
  }));
  writeText(flags['save-badcases'], toJsonl(records));
}

function commandScan(flags, positionals, io) {
  const file = positionals[0];
  if (!file) throw new Error('scan 需要一个文件。例如 node cli.mjs scan examples/dialogue-tics.json');
  flags._file = file;
  const { report, presented } = analyzeFile(file, flags);
  maybeBadcases(flags, presented);
  if (flags.json) {
    printJson(io, {
      version: VERSION,
      title: report.title,
      chars: presented.chars,
      hits: presented.hits,
      suppressed: presented.suppressed,
      template: report.template,
      redundancy: report.redundancy,
    });
    return 0;
  }
  io.stdout.write(formatScan(presented, report));
  return 0;
}

function commandReport(flags, positionals, io) {
  const file = positionals[0];
  if (!file) throw new Error('report 需要一个文件。例如 node cli.mjs report examples/dialogue-tics.json');
  flags._file = file;
  const { report, presented } = analyzeFile(file, flags);
  maybeBadcases(flags, presented);
  if (flags.csv) writeText(flags.csv, reportToCsv(report));
  if (flags.json) {
    printJson(io, { version: VERSION, ...report });
  } else {
    io.stdout.write(formatReport(report));
  }
  if (flags.strict && report.template?.alert) return 2;
  return 0;
}

function commandEval(flags, io) {
  const goldPath = flags.gold;
  if (!goldPath || goldPath === true) throw new Error('eval 需要 --gold <文件>');
  const gold = parseGold(readText(goldPath));
  const ruleSet = loadRuleSet(flags.rules || defaultRulesPath());
  const result = evaluateGold(gold, ruleSet, { proximity: DEFAULTS.proximity });
  let holdout = null;
  if (flags.holdout) {
    if (flags.holdout === true) throw new Error('eval --holdout 需要 <文件>');
    holdout = evaluateGold(parseGold(readText(flags.holdout)), ruleSet, { proximity: DEFAULTS.proximity });
  }
  let holdoutV2 = null;
  if (flags['holdout-v2']) {
    if (flags['holdout-v2'] === true) throw new Error('eval --holdout-v2 需要 <文件>');
    holdoutV2 = evaluateGold(parseGold(readText(flags['holdout-v2'])), ruleSet, { proximity: DEFAULTS.proximity });
  }
  let baseline = null;
  if (flags.baseline) {
    if (flags.baseline === true) throw new Error('eval --baseline 需要 <文件>');
    baseline = JSON.parse(readText(flags.baseline));
  }
  if (flags.report) {
    const out = flags.report === true
      ? join(dirname(fileURLToPath(import.meta.url)), 'docs', 'eval-report.md')
      : flags.report;
    writeText(out, formatEvalReport(result, { holdout, holdoutV2, baseline }));
    io.stderr.write(`已写入 ${out}\n`);
  }
  if (flags.json) {
    const payload = { version: VERSION, gold: result };
    if (holdout) payload.holdout = holdout;
    if (holdoutV2) payload.holdoutV2 = holdoutV2;
    printJson(io, holdout || holdoutV2 ? payload : { version: VERSION, ...result });
  } else {
    io.stdout.write(formatEval(result, '金标评测'));
    if (holdout) io.stdout.write(`\n${formatEval(holdout, '旧留出集评测')}`);
    if (holdoutV2) io.stdout.write(`\n${formatEval(holdoutV2, '留出集 v2 评测')}`);
  }
  return 0;
}

function commandRules(flags, io) {
  const ruleSet = loadRuleSet(flags.rules || defaultRulesPath());
  if (flags.json) {
    printJson(io, {
      version: VERSION,
      categories: ruleSet.categories,
      rules: ruleSet.rules.map((rule) => ({
        id: rule.id,
        category: rule.category,
        title: rule.title,
        kind: rule.kind,
        shape: rule.shape || null,
        description: rule.description,
        examples: rule.examples,
      })),
    });
    return 0;
  }
  const lines = [`词表 ${ruleSet.name}，${ruleSet.rules.length} 条`, ''];
  for (const category of ruleSet.categories) {
    lines.push(`${category.primary ? '【首要】' : ''}${category.title}`);
    lines.push(`  ${category.description}`);
    for (const rule of ruleSet.rules.filter((item) => item.category === category.id)) {
      lines.push(`  ${rule.id}　${rule.description}`);
      lines.push(`    例：${rule.examples[0]}`);
    }
    lines.push('');
  }
  io.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

export function run(parsed, io) {
  const { cmd, flags, positionals } = parsed;
  if (cmd === 'help') {
    io.stdout.write(helpText());
    return 0;
  }
  if (cmd === 'scan') return commandScan(flags, positionals, io);
  if (cmd === 'report') return commandReport(flags, positionals, io);
  if (cmd === 'eval') return commandEval(flags, io);
  if (cmd === 'rewrite') return commandRewrite(flags, positionals, io);
  if (cmd === 'rules') return commandRules(flags, io);
  if (cmd === 'data') return commandData(flags, io);
  if (cmd === 'cross-model') return commandCrossModel(flags, io);
  if (cmd === 'prompt-ab') return commandPromptAb(flags, io);
  throw new Error(`未知命令 ${cmd}。用 node cli.mjs --help 看用法。`);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function commandData(flags, io) {
  if (!flags.gold || flags.gold === true) throw new Error('data 需要 --gold <文件>');
  if (!flags.consensus || flags.consensus === true) throw new Error('data 需要 --consensus <文件>');
  const ruleSet = loadRuleSet(flags.rules || defaultRulesPath());
  const gold = parseGold(readText(flags.gold));
  const consensus = JSON.parse(readText(flags.consensus));
  const built = buildDataLoop(ticSources(gold, consensus), ruleSet);
  const preference = flags.preference && flags.preference !== true
    ? flags.preference
    : join(dirname(fileURLToPath(import.meta.url)), 'data', 'preference.jsonl');
  const sft = flags.sft && flags.sft !== true
    ? flags.sft
    : join(dirname(fileURLToPath(import.meta.url)), 'data', 'sft.jsonl');
  writeText(preference, dataJsonl(built.pairs));
  writeText(sft, dataJsonl(built.sft));
  if (flags.json) {
    printJson(io, {
      version: VERSION,
      ...built.stats,
      files: { preference, sft },
    });
  }
  else io.stdout.write(`${JSON.stringify(built.stats, null, 2)}\n`);
  return 0;
}

function commandCrossModel(flags, io) {
  if (!flags.prompts || flags.prompts === true) throw new Error('cross-model 需要 --prompts <文件>');
  const prompts = JSON.parse(readText(flags.prompts));
  const ruleSet = loadRuleSet(flags.rules || defaultRulesPath());
  const slots = modelSlots();
  const outDir = flags.out && flags.out !== true
    ? flags.out
    : join(dirname(fileURLToPath(import.meta.url)), 'runs');
  return runCrossModel({ slots, prompts, ruleSet }).then((result) => {
    const markdown = formatCrossModelMarkdown(result);
    const svg = renderCrossModelSvg(result);
    writeText(join(outDir, 'cross-model.md'), markdown);
    writeText(join(outDir, 'cross-model.svg'), svg);
    const saved = {
      temperature: result.temperature,
      rows: result.rows.map((row) => {
        const copy = { ...row };
        delete copy.replies;
        return copy;
      }),
    };
    writeText(join(outDir, 'cross-model.json'), `${JSON.stringify(saved, null, 2)}\n`);
    if (flags.json) printJson(io, saved);
    else io.stdout.write(markdown);
    return 0;
  });
}

function commandPromptAb(flags, io) {
  if (!flags.spec || flags.spec === true) throw new Error('prompt-ab 需要 --spec <文件>');
  const spec = JSON.parse(readText(flags.spec));
  const ruleSet = loadRuleSet(flags.rules || defaultRulesPath());
  const markdown = formatPromptAbMarkdown(spec, ruleSet);
  if (flags.report) {
    const out = flags.report === true
      ? join(dirname(fileURLToPath(import.meta.url)), 'docs', 'prompt-ab.md')
      : flags.report;
    writeText(out, markdown);
    io.stderr.write(`已写入 ${out}\n`);
  }
  if (flags.json) printJson(io, { version: VERSION, markdown });
  else io.stdout.write(markdown);
  return 0;
}

function commandRewrite(flags, positionals, io) {
  const ruleSet = loadRuleSet(flags.rules || defaultRulesPath());
  const mode = flags.rewriter || 'offline';
  const rewriter = rewriterFromEnv(mode);
  const maxRounds = flagNumber(flags, 'rounds', 2);
  if (flags.drafts) {
    if (flags.drafts === true) throw new Error('rewrite --drafts 需要 <文件>');
    const drafts = parseDrafts(readText(flags.drafts));
    const evaluated = evaluateDrafts(drafts, ruleSet, { rewriter, maxRounds });
    const finish = (result) => {
      const markdown = formatSelfCheckReport(result, { rewriter: mode });
      if (flags.report) {
        const out = flags.report === true
          ? join(dirname(fileURLToPath(import.meta.url)), 'docs', 'selfcheck-report.md')
          : flags.report;
        writeText(out, markdown);
        io.stderr.write(`已写入 ${out}\n`);
      }
      if (flags.json) printJson(io, { version: VERSION, rewriter: mode, ...result });
      else io.stdout.write(markdown);
      return 0;
    };
    if (evaluated && typeof evaluated.then === 'function') return evaluated.then(finish);
    return finish(evaluated);
  }
  const file = positionals[0];
  if (!file) throw new Error('rewrite 需要一个文件，或 --drafts <文件>。例如 node cli.mjs rewrite examples/selfcheck-one.txt');
  const raw = readText(file);
  const before = flags.before && flags.before !== true ? flags.before : undefined;
  const checked = selfCheckText(raw.trim(), ruleSet, { rewriter, maxRounds, before });
  const finish = (result) => {
    if (flags.json) printJson(io, { version: VERSION, rewriter: mode, ...result });
    else io.stdout.write(formatSelfCheck(result));
    return 0;
  };
  if (checked && typeof checked.then === 'function') return checked.then(finish);
  return finish(checked);
}

if (isDirectRun()) {
  try {
    const code = run(parseArgs(process.argv), {
      stdout: process.stdout,
      stderr: process.stderr,
    });
    if (code && typeof code.then === 'function') {
      code.then(
        (value) => {
          process.exitCode = value;
        },
        (error) => {
          process.stderr.write(`${error.message}\n`);
          process.exitCode = 1;
        },
      );
    } else {
      process.exitCode = code;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
