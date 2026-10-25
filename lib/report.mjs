import { DEFAULTS } from './defaults.mjs';
import { summarizeRedundancy } from './rewrite.mjs';
import { perKilo } from './text.mjs';
import { reasonText } from './reasons.mjs';

function round1(value) {
  return Math.round(value * 10) / 10;
}

function countWhere(turns, predicate) {
  let count = 0;
  for (const turn of turns) {
    for (const hit of turn.hits) {
      if (predicate(hit)) count += 1;
    }
  }
  return count;
}

export function personaRetention(text, card) {
  if (!card) return null;
  const keywords = (card.keywords || []).filter(Boolean);
  const catchphrases = (card.catchphrases || []).filter(Boolean);
  const keywordHits = keywords.filter((item) => text.includes(item));
  const catchphraseHits = catchphrases.filter((item) => text.includes(item));
  const all = [...keywords, ...catchphrases];
  const hit = [...keywordHits, ...catchphraseHits];
  return {
    keywordHits: keywordHits.length,
    keywordTotal: keywords.length,
    keywordRate: keywords.length ? keywordHits.length / keywords.length : null,
    catchphraseHits: catchphraseHits.length,
    catchphraseTotal: catchphrases.length,
    catchphraseRate: catchphrases.length ? catchphraseHits.length / catchphrases.length : null,
    retentionRate: all.length ? hit.length / all.length : null,
    missingKeywords: keywords.filter((item) => !text.includes(item)),
    missingCatchphrases: catchphrases.filter((item) => !text.includes(item)),
  };
}

function categoryStats(category, turns, chars, turnCount) {
  const ticCount = countWhere(turns, (hit) => hit.category === category.id && hit.verdict === 'tic');
  const indeterminateCount = countWhere(
    turns,
    (hit) => hit.category === category.id && hit.verdict === 'indeterminate',
  );
  return {
    id: category.id,
    title: category.title,
    primary: Boolean(category.primary),
    ticCount,
    indeterminateCount,
    perKilo: perKilo(ticCount, chars),
    perTurn: turnCount ? round1(ticCount / turnCount) : 0,
    indeterminatePerKilo: perKilo(indeterminateCount, chars),
  };
}

export function buildReport(scan, dialogue, ruleSet, options = {}) {
  const templateThreshold = options.templateThreshold ?? DEFAULTS.templateThreshold;
  const turnThreshold = options.turnThreshold ?? DEFAULTS.turnThreshold;
  const minTurnChars = options.minTurnChars ?? DEFAULTS.minTurnChars;
  const scanned = scan.turns.filter((turn) => turn.scanned);
  const chars = scanned.reduce((sum, turn) => sum + turn.chars, 0);
  const turnCount = scanned.filter((turn) => turn.chars > 0).length;
  const categories = (ruleSet.categories || []).map((category) => categoryStats(category, scanned, chars, turnCount));
  const template = categories.find((category) => category.primary) || categories.find((category) => category.id === 'template');

  const curve = scanned.map((turn) => {
    const templateTics = turn.hits.filter((hit) => hit.category === 'template' && hit.verdict === 'tic').length;
    const templateIndeterminate = turn.hits.filter(
      (hit) => hit.category === 'template' && hit.verdict === 'indeterminate',
    ).length;
    const templatePerKilo = perKilo(templateTics, turn.chars);
    const alert = templateTics >= 2 || (turn.chars >= minTurnChars && templatePerKilo >= turnThreshold);
    const byCategory = {};
    for (const category of categories) {
      byCategory[category.id] = turn.hits.filter((hit) => hit.category === category.id && hit.verdict === 'tic').length;
    }
    return {
      turn: turn.turn,
      role: turn.role,
      speaker: turn.speaker,
      chars: turn.chars,
      templateTics,
      templateIndeterminate,
      templatePerKilo,
      alert,
      byCategory,
    };
  });

  const detourCount = countWhere(scanned, (hit) => hit.verdict === 'tic' && hit.subclass === 'detour-negation');
  const globalAlert = Boolean(template) && template.perKilo >= templateThreshold;
  const alertTurns = curve.filter((point) => point.alert).map((point) => point.turn);
  const joined = scanned.map((turn) => turn.text).join('\n');
  const ticCount = categories.reduce((sum, category) => sum + category.ticCount, 0);
  const ticHits = scanned.flatMap((turn) => turn.hits.filter((hit) => hit.verdict === 'tic'));
  const redundancy = summarizeRedundancy(ticHits, chars);

  return {
    title: dialogue?.title || null,
    id: dialogue?.id || null,
    chars,
    scannedTurnCount: turnCount,
    roles: options.roles || DEFAULTS.roles,
    ticCount,
    indeterminateCount: categories.reduce((sum, category) => sum + category.indeterminateCount, 0),
    suppressedCount: scanned.reduce((sum, turn) => sum + turn.suppressed.length, 0),
    perKilo: perKilo(ticCount, chars),
    categories,
    template: template
      ? {
          ...template,
          detourCount,
          threshold: templateThreshold,
          turnThreshold,
          minTurnChars,
          globalAlert,
          alertTurns,
          alert: globalAlert || alertTurns.length > 0,
        }
      : null,
    curve,
    redundancy,
    persona: personaRetention(joined, dialogue?.character || null),
  };
}

export function reportToCsv(report) {
  const header = [
    'turn',
    'role',
    'chars',
    'template_tics',
    'template_per_kilo',
    'template_indeterminate',
    'emotion_tics',
    'metaphor_tics',
    'alert',
  ];
  const lines = [header.join(',')];
  for (const point of report.curve) {
    lines.push(
      [
        point.turn,
        point.role,
        point.chars,
        point.templateTics,
        point.templatePerKilo,
        point.templateIndeterminate,
        point.byCategory['emotion-flat'] || 0,
        point.byCategory.metaphor || 0,
        point.alert ? 1 : 0,
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

function rewriteLine(hit) {
  const redundancy = hit.redundancy;
  const ratio = redundancy.ratio == null ? '无断言可留' : redundancy.ratio.toFixed(2);
  const rewrite = redundancy.rewrite || '（删去）';
  const counted = hit.verdict === 'tic' ? '计入' : '不计入汇总';
  return `最短改写：${rewrite}　冗余比 ${ratio}（${counted}）`;
}

function bar(value, max) {
  if (!max || value <= 0) return '';
  const width = Math.max(1, Math.round((value / max) * 12));
  return '█'.repeat(width);
}

function kilo(value) {
  return Number(value).toFixed(1);
}

export function formatReport(report) {
  const lines = [];
  lines.push(`口癖报告${report.title ? ` · ${report.title}` : ''}`);
  lines.push(`扫描角色：${report.roles.join(', ')}　字数 ${report.chars}　轮次 ${report.scannedTurnCount}`);
  lines.push(`口癖 ${report.ticCount} 处，合计 ${kilo(report.perKilo)} /千字；不可判定 ${report.indeterminateCount} 处；前文提过的对比已放行 ${report.suppressedCount} 处`);
  lines.push('密度只计「口癖」，不可判定不计入，也不触发告警。');
  lines.push('');

  const ordered = [...report.categories].sort((a, b) => Number(b.primary) - Number(a.primary));
  for (const category of ordered) {
    const head = category.primary ? `【首要】${category.title}` : category.title;
    lines.push(head);
    lines.push(`  口癖 ${category.ticCount} 处　${kilo(category.perKilo)} /千字　平均 ${kilo(category.perTurn)} /轮`);
    lines.push(`  不可判定 ${category.indeterminateCount} 处（${kilo(category.indeterminatePerKilo)} /千字，不计入上面的密度）`);
    if (category.primary && report.template) {
      lines.push(`  其中绕路否定 ${report.template.detourCount} 处（具体选项前文没人提过，计入上面的密度和告警）`);
      const whole = report.template.globalAlert
        ? `全篇 ${kilo(category.perKilo)} /千字 ≥ ${report.template.threshold} → 告警`
        : `全篇 ${kilo(category.perKilo)} /千字，阈值 ${report.template.threshold}，未超过`;
      const turns = report.template.alertTurns.length
        ? `单轮告警：第 ${report.template.alertTurns.join('、')} 轮`
        : '单轮无告警';
      lines.push(`  ${whole}`);
      lines.push(`  ${turns}（单轮 ≥ ${report.template.turnThreshold} /千字且不少于 ${report.template.minTurnChars} 字，或同一轮里有 2 处及以上口癖）`);
    }
    lines.push('');
  }

  lines.push('冗余比');
  lines.push('  只统计判定为口癖的句式模板。前文放行的对比、不可判定，都不计入。');
  lines.push('  冗余比 = 命中字数 / 最短改写字数。最短改写只留断言。单句又没有前文时，「不是茶，也不是酒，而是白开水」收成「白开水」；有前文或跨了句界，仍收成「是白开水」。');
  lines.push('  没有断言可留时，比例留空，命中字数全部算冗余字。字数去掉空白、保留标点。');
  if (!report.redundancy || report.redundancy.hitCount === 0) {
    lines.push('  没有计入的句式口癖。');
  } else {
    const redundancy = report.redundancy;
    const mean = redundancy.mean == null ? '—' : redundancy.mean.toFixed(2);
    const max = redundancy.max == null ? '—' : redundancy.max.toFixed(2);
    lines.push(`  计入 ${redundancy.hitCount} 处，其中 ${redundancy.ratioCount} 处有断言可留`);
    lines.push(`  均值 ${mean}　最大 ${max}`);
    lines.push(`  冗余字 ${redundancy.redundantChars}，合 ${kilo(redundancy.redundantPerKilo)} /千字`);
  }
  lines.push('');

  if (report.persona) {
    const persona = report.persona;
    const keyword = persona.keywordTotal
      ? `${persona.keywordHits}/${persona.keywordTotal}`
      : '未提供';
    const catchphrase = persona.catchphraseTotal
      ? `${persona.catchphraseHits}/${persona.catchphraseTotal}`
      : '未提供';
    lines.push('人设保持');
    lines.push(`  关键词 ${keyword}${persona.missingKeywords.length ? `（缺：${persona.missingKeywords.join('、')}）` : ''}`);
    lines.push(`  口头禅 ${catchphrase}${persona.missingCatchphrases.length ? `（缺：${persona.missingCatchphrases.join('、')}）` : ''}`);
    lines.push(`  保持率 ${persona.retentionRate == null ? '—' : persona.retentionRate.toFixed(3)}`);
    lines.push('  这只是字面出现率，不是人格一致性。');
    lines.push('');
  } else {
    lines.push('人设保持：没有角色卡，跳过。');
    lines.push('');
  }

  lines.push('密度曲线（句式模板，口癖 /千字）');
  const max = Math.max(1, ...report.curve.map((point) => point.templatePerKilo));
  if (!report.curve.length) lines.push('  （没有扫描到轮次）');
  for (const point of report.curve) {
    const speaker = point.speaker ? ` ${point.speaker}` : '';
    const mark = point.alert ? ' 告警' : (point.templateTics > 0 ? ' （未达单轮告警）' : '');
    lines.push(
      `  轮${point.turn} ${point.role}${speaker}　${point.chars}字　${kilo(point.templatePerKilo)} /千字　${bar(point.templatePerKilo, max)}${mark}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatScan(presented, report) {
  const lines = [];
  lines.push(`扫描${report?.title ? ` · ${report.title}` : ''}`);
  lines.push(`字数 ${presented.chars}　命中 ${presented.hits.length}　抑制 ${presented.suppressed.length}`);
  if (report?.redundancy?.hitCount) {
    const redundancy = report.redundancy;
    const mean = redundancy.mean == null ? '—' : redundancy.mean.toFixed(2);
    const max = redundancy.max == null ? '—' : redundancy.max.toFixed(2);
    lines.push(`冗余比 均值 ${mean}　最大 ${max}　冗余字 ${kilo(redundancy.redundantPerKilo)} /千字`);
  }
  if (report?.template?.alert) lines.push('句式模板超过阈值，详见 report。');
  lines.push('');
  const groups = new Map();
  for (const hit of presented.hits) {
    if (!groups.has(hit.category)) groups.set(hit.category, []);
    groups.get(hit.category).push(hit);
  }
  const order = ['template', 'emotion-flat', 'metaphor'];
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const key of keys) {
    const sample = groups.get(key)[0];
    lines.push(sample.title || key);
    for (const hit of groups.get(key)) {
      const label = hit.subclass === 'detour-negation'
        ? '绕路否定'
        : (hit.verdict === 'indeterminate' ? '不可判定' : '口癖');
      const who = hit.turn ? `轮${hit.turn}` : '文本';
      const confirmed = hit.attribution?.confirmed ? `确认 ${hit.attribution.confirmed}` : '归因 unknown';
      lines.push(`  [${label}] ${hit.ruleId}　${who}　${confirmed}`);
      lines.push(`    ${hit.text}`);
      if (hit.redundancy) lines.push(`    ${rewriteLine(hit)}`);
      if (hit.context && hit.context !== hit.text) lines.push(`    上下文：${hit.context}`);
      lines.push(`    ${hit.reasons.map(reasonText).join('；')}`);
    }
    lines.push('');
  }
  if (presented.suppressed.length) {
    lines.push('前文提过的对比（已放行，不计密度）');
    for (const hit of presented.suppressed) {
      lines.push(`  ${hit.ruleId}　轮${hit.turn}　${hit.text}`);
      if (hit.redundancy) lines.push(`    最短改写 ${hit.redundancy.rewrite || '（删去）'}，不计入冗余比`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
