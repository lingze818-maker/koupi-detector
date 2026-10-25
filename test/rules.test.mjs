import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentCores, slotMentioned } from '../lib/grounding.mjs';
import { classifySlot } from '../lib/lexicon.mjs';
import { compileRuleSet, countSentenceBoundaries, scanText } from '../lib/rules.mjs';
import { scanDialogue } from '../lib/scan.mjs';
import { loadRuleSet } from '../lib/io.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = loadRuleSet(join(root, 'tics', 'default.json'));

function ids(text, options = {}) {
  const { hits, suppressed } = scanText(text, rules, { proximity: 0, ...options });
  return {
    hits,
    suppressed,
    hitIds: hits.map((hit) => hit.ruleId),
    verdicts: hits.map((hit) => hit.verdict),
  };
}

test('每条规则的示例都能被自己打成口癖', () => {
  for (const rule of rules.rules) {
    for (const example of rule.examples) {
      const { hits } = scanText(example, rules, { proximity: 0 });
      const hit = hits.find((item) => item.ruleId === rule.id && item.verdict === 'tic');
      assert.ok(
        hit,
        `${rule.id} 没有打中示例「${example}」，实际 ${hits.map((item) => `${item.ruleId}:${item.verdict}`).join(' | ') || '无命中'}`,
      );
    }
  }
});

test('句式模板是首要类别，形状能泛化', () => {
  const template = rules.categories.find((category) => category.id === 'template');
  assert.equal(template.primary, true);
  const variants = [
    ['没有停顿也没有犹豫只是把杯子放下', 'tpl.mei-you-ye-mei-you-zhi-shi'],
    ['没有责备，也没有安慰，而是把话放平', 'tpl.mei-you-ye-mei-you-er-shi'],
    ['并非责备，而是把声音压平', 'tpl.bu-shi-er-shi'],
    ['却不是质问，而是把灯拧暗', 'tpl.bu-shi-er-shi'],
    ['仿佛在评价，又像在播报', 'tpl.xiang-zai-you-xiang-zai'],
  ];
  for (const [text, ruleId] of variants) {
    const { hits } = ids(text);
    assert.ok(hits.some((hit) => hit.ruleId === ruleId && hit.verdict === 'tic'), text);
  }
});

test('三段模板压过里面的两段，不重复计数', () => {
  const { hits } = ids('那不是责备，也不是安慰，而是把话放平。');
  const templates = hits.filter((hit) => hit.category === 'template');
  assert.deepEqual(templates.map((hit) => hit.ruleId), ['tpl.bu-shi-ye-bu-shi-er-shi']);
});

test('同类别重叠的套话只留更长的一条', () => {
  const { hits } = ids('像在陈述一个不容商榷的事实');
  const metaphors = hits.filter((hit) => hit.category === 'metaphor');
  assert.equal(metaphors.length, 1);
  assert.equal(metaphors[0].ruleId, 'met.stating');
});

test('绕路否定：没提过的具体选项算口癖，提过才放行，单句无前文不可判定', () => {
  const bare = ids('不是茶，也不是酒，而是白开水。');
  assert.equal(bare.hits.length, 1);
  assert.equal(bare.hits[0].verdict, 'indeterminate');
  assert.ok(bare.hits[0].reasons.includes('no-prior-context'));

  const samples = [
    ['这不是红茶，而是去年剩下的那罐乌龙。', '灯还亮着。'],
    ['钥匙不是在抽屉里，而是在玄关的铁盒里。', '闭馆的铃还有一刻。'],
    ['不是茶，也不是酒，而是白开水。', '他把杯子放下。'],
    ['没有茶叶，也没有杯子，只是一壶白开水。', '灯在桌上。'],
    ['他不是周一来的，而是周三凌晨到的。', '页脚有水印。'],
    ['却不是红茶，而是去年的乌龙。', '伞放在门口。'],
  ];
  for (const [text, before] of samples) {
    const { hits, suppressed } = ids(text, { before });
    assert.equal(suppressed.length, 0, text);
    assert.ok(hits.some((hit) => hit.verdict === 'tic' && hit.subclass === 'detour-negation'), text);
  }

  const grounded = ids('这不是茶，而是白水。', { before: '林夏问：这是茶吗？' });
  assert.equal(grounded.hits.filter((hit) => hit.category === 'template').length, 0);
  assert.ok(grounded.suppressed.some((hit) => hit.reasons.includes('grounded-contrast')));

  const partial = ids('不是茶，也不是酒，而是白开水。', { before: '你说的是茶？' });
  assert.equal(partial.hits[0].verdict, 'indeterminate');
  assert.ok(partial.hits[0].reasons.includes('detour-partial'));

  const sameTurn = ids('你刚才说是茶。这不是茶，而是白水。');
  assert.equal(sameTurn.hits.filter((hit) => hit.category === 'template').length, 0);
  assert.ok(sameTurn.suppressed.some((hit) => hit.reasons.includes('grounded-contrast')));

  const laterDetour = ids('账本在灯下。不是茶，也不是酒，而是白开水。');
  assert.ok(laterDetour.hits.some((hit) => hit.subclass === 'detour-negation'));
});

test('对话窗口：对方问过才放行，关掉回看就不再当成真实纠正', () => {
  const dialogue = {
    turns: [
      { role: 'user', speaker: '林夏', text: '这是茶吗？' },
      { role: 'assistant', speaker: '周衡', text: '这不是茶，而是白水。' },
    ],
  };
  const seen = scanDialogue(dialogue, rules, { contextTurns: 4 });
  assert.equal(seen.hits.filter((hit) => hit.verdict === 'tic').length, 0);
  assert.ok(seen.suppressed.some((hit) => hit.reasons.includes('grounded-contrast')));

  const blind = scanDialogue(dialogue, rules, { contextTurns: 0 });
  assert.ok(blind.hits.some((hit) => hit.verdict === 'indeterminate' && hit.reasons.includes('no-prior-context')));
});

test('虚词转折判口癖，一虚一实标不可判定', () => {
  const tic = ids('他没有生气，也没有惊讶，只是看着她。');
  assert.ok(tic.hits.some((hit) => hit.verdict === 'tic' && hit.reasons.includes('stacked-negation')));

  const mixed = ids('不是催促，也不是前年的那册账，而是把页码对齐。');
  assert.equal(mixed.hits.length, 1);
  assert.equal(mixed.hits[0].verdict, 'indeterminate');
  assert.ok(mixed.hits[0].reasons.includes('mixed-slots'));

  const vague = ids('不是这个，而是那个。');
  assert.equal(vague.hits[0].verdict, 'tic');
  assert.ok(vague.hits[0].reasons.includes('negated-slot-vague'));
});

test('短距离里两处拿不准的转折升级成口癖', () => {
  const text = '不是催促，也不是前年的那册账，而是把页码对齐。不是解释，也不是铁盒里的钥匙，而是先停下。';
  const held = ids(text, { proximity: 0 });
  assert.ok(held.hits.every((hit) => hit.verdict === 'indeterminate'));
  const upgraded = ids(text, { proximity: 80 });
  assert.ok(upgraded.hits.length >= 2);
  assert.ok(upgraded.hits.every((hit) => hit.verdict === 'tic' && hit.reasons.includes('nearby-stack-upgrade')));
});

test('像在……又像是在：套话判口癖，具体长句放行，短排比不可判定', () => {
  const stock = ids('像在陈述事实，又像是在念一份结论。');
  assert.equal(stock.hits.find((hit) => hit.ruleId === 'tpl.xiang-zai-you-xiang-zai').verdict, 'tic');

  const literary = ids('他的声音像在回忆整条巷子里的夜雨，又像是在核对门牌上褪色的数字。');
  assert.equal(literary.hits.filter((hit) => hit.category === 'template').length, 0);
  assert.ok(literary.suppressed.some((hit) => hit.reasons.includes('simile-concrete')));

  const short = ids('像在走路，又像是在跳舞。');
  assert.equal(short.hits.find((hit) => hit.category === 'template').verdict, 'indeterminate');
});

test('平淡的茶、真的天气、单独的声音低沉不误报', () => {
  for (const text of [
    '这茶味道平淡，可是耐泡。',
    '今天天气不错，伞可以收起来。',
    '他声音低沉，把闭馆的时间又说了一遍。',
  ]) {
    const { hits } = ids(text);
    assert.equal(hits.length, 0, text);
  }
});

test('近义套话要打中，字面用法和具体动作不打中', () => {
  for (const text of [
    '嗓音四平八稳，一句接一句。',
    '话声稳稳当当，没有起落。',
    '声线平得找不到一个弯。',
    '调门一直是平的。',
    '嗓子里一点高低都没有。',
    '声音里没起一丝波澜。',
    '他古井无波似的，应了一声。',
    '语气里连个涟漪都没有。',
    '眼底静得没有一点起伏。',
    '他把话说得极淡。',
    '五官纹丝不动。',
    '他还是那个不急不缓的劲儿。',
    '他把情绪收得干干净净。',
    '他用不带感情的声音念出一个名字。',
    '她用毫无起伏的嗓音回答。',
    '一点情绪也挂不上。',
    '像在宣读会议纪要。',
    '像在读一份产品说明书。',
    '仿佛在汇报这周的工作进度。',
    '说得像家常便饭一样。',
    '自然得不能更自然。',
    '就像讲每天都会发生的事一样。',
    '像说一件芝麻绿豆的小事。',
    '像在说一加一等于二。',
    '像是在讲太阳从东边出来。',
    '跟聊家常差不多。',
    '像随口点评了一句今天的菜。',
    '像在念一份盖了章的结论。',
    '像下了个没得商量的定论。',
  ]) {
    const { hits } = ids(text);
    assert.ok(hits.some((hit) => hit.verdict === 'tic'), text);
  }
  for (const text of [
    '湖面平静，灯倒映在里面。',
    '仪器读数平稳，他把阀门拧上。',
    '调度员声音很稳，让第二辆车先去南门。',
    '这句话念平一点，别拖。',
    '今晚厨房做的是家常便饭。',
    '他坐在灯下读说明书，把零件对齐。',
    '两人坐下聊家常，茶壶还热着。',
    '山路没有一点起伏，车开得很顺。',
    '他做事四平八稳，先把椅子摆正。',
    '秘书在宣读会议纪要，大家翻到第二页。',
    '他在汇报这周的工作进度，黑板写着三个数。',
    '黑板上写着一加一等于二。',
    '井水映着月亮。',
    '他纹丝不动地站住，伞还在滴水。',
    '茶泡得极淡，还能喝。',
    '地势毫无起伏。',
    '价钱没得商量，他摇了摇头。',
    '他不急不缓地走上石阶。',
    '湖面连个涟漪都没有，船还停着。',
    '湖面没起一丝波澜。',
    '古井无波，倒映着星子。',
  ]) {
    const { hits } = ids(text);
    assert.equal(hits.length, 0, text);
  }
});

test('同一轮里跨一到两个句界，不跨说话人轮次', () => {
  assert.equal(countSentenceBoundaries('不是责备。而是把话放平'), 1);
  assert.equal(countSentenceBoundaries('没有生气。也没有惊讶。只是看着她'), 2);
  assert.equal(countSentenceBoundaries('不是责备。\n而是把话放平'), 1);
  assert.equal(countSentenceBoundaries('不是责备\n而是把话放平'), 1);
  assert.equal(countSentenceBoundaries('不是催促……而是把账本合上'), 1);

  const one = ids('不是责备。而是把话放平。');
  const flat = one.hits.find((hit) => hit.ruleId === 'tpl.bu-shi-er-shi');
  assert.equal(flat.verdict, 'tic');
  assert.ok(flat.reasons.includes('cross-sentence'));
  assert.equal(flat.redundancy.rewrite, '是把话放平');

  const two = ids('没有生气。也没有惊讶。只是看着她。');
  const looking = two.hits.find((hit) => hit.ruleId === 'tpl.mei-you-ye-mei-you-zhi-shi');
  assert.equal(looking.verdict, 'tic');
  assert.equal(looking.redundancy.rewrite, '只是看着她');

  const tea = ids('不是茶。也不是酒。而是白开水。', { before: '灯还亮着。' });
  assert.equal(tea.hits.find((hit) => hit.subclass === 'detour-negation').redundancy.rewrite, '是白开水');

  const question = ids('没有生气！只是看着她。');
  assert.equal(question.hits.find((hit) => hit.ruleId === 'tpl.mei-you-zhi-shi').redundancy.rewrite, '只是看着她');

  const broken = ids('不是责备。\n而是把话放平。');
  assert.equal(broken.hits.find((hit) => hit.category === 'template').redundancy.rewrite, '是把话放平');

  for (const text of [
    '他把杯子放下。而是灯还亮着。',
    '今天天气不错。只是伞可以收起来。',
    '不是墨。他洗了手。灯灭了。而是水。',
    '今天页码对齐了。他合上账本。只是墨有点淡。',
  ]) {
    const { hits } = ids(text);
    assert.equal(hits.filter((hit) => hit.category === 'template').length, 0, text);
  }

  for (const text of [
    '钥匙不是在抽屉里。灯还亮着。而是在铁盒里。',
    '不是责备。他放下杯子。而是把话放平。',
    '不是责备。也不是安慰。他倒了杯水。而是把话放平。',
  ]) {
    const hit = ids(text).hits.find((item) => item.category === 'template');
    assert.equal(hit.verdict, 'indeterminate', text);
    assert.ok(hit.reasons.includes('cross-sentence-gap'), text);
  }

  const groundedGap = scanText('不是墨。他洗了手。而是水。', rules, { proximity: 0, before: '墨用完了吗？' });
  assert.equal(groundedGap.hits.length, 0);
  assert.ok(groundedGap.suppressed.some((hit) => hit.reasons.includes('grounded-contrast')));

  const split = scanDialogue({
    turns: [
      { role: 'assistant', speaker: '周衡', text: '不是责备。' },
      { role: 'assistant', speaker: '周衡', text: '而是把话放平。' },
      { role: 'user', speaker: '林夏', text: '不是茶。' },
      { role: 'assistant', speaker: '周衡', text: '而是白开水。' },
    ],
  }, rules, {});
  assert.equal(split.hits.filter((hit) => hit.category === 'template').length, 0);
});

test('附件里的口癖短语至少命中一条', () => {
  const phrases = [
    '他语气平淡，听不出什么情绪',
    '没有方才那种懒洋洋的调侃，而是带着一种少见的、平直的陈述语气',
    '他说，声音低沉平缓，听不出什么情绪',
    '他说，声音平静，没有什么多余的情绪，像是在陈述一个已经到站的事实',
    '声音恢复了往常的温和周正',
    '声音恢复了平常的平稳',
    '眉眼的弧度显得温和又疏淡。',
    '语调平缓温和，听不出什么多余的情绪',
    '语气随意得像在说今天天气不错',
    '声音很平淡',
    '像是评价',
    '像是怕惊到什么似的',
    '语气平淡，像在陈述一个不容商榷的事实',
    '他语气平淡地陈述，像是在点评什么无关紧要的细节',
    '像在陈述一件理所当然的事',
    '他语气平淡地评价，像在说今天的天气。',
    '动作自然而随意，像刚才什么也没发生过一样。',
    '表情平静而松弛，像在做一件再寻常不过的事。',
    '声音低沉，像在陈述一个再平常不过的事实',
    '语气平淡表情专注而平静，像在做一件需要精确操作的工作。',
    '他的语气还是那种不紧不慢的调子，像在陈述一件再寻常不过的事',
    '语气平淡，像在陈述一件无关紧要的事实',
    '语气平淡得像在陈述天气预报，声音仍然平稳',
    '声调不高不低',
    '语气平静得就像谈论天气',
    '语气平静得就像念书',
    '语气平静得就像在说一件和自己无关的事',
    '语气平淡得仿佛只是说了一句“今日天色不错”。',
    '他开口，声音里带着雨夜的潮意，却听不出什么特别的情绪',
  ];
  for (const phrase of phrases) {
    const { hits } = ids(phrase);
    assert.ok(hits.some((hit) => hit.verdict === 'tic'), phrase);
  }
});

test('介词开头的否定槽能对上前文里的名词', () => {
  assert.ok(contentCores('从侧廊过来的').includes('侧廊'));
  assert.ok(contentCores('往西厢去的').includes('西厢'));
  assert.ok(contentCores('被夜风吹开的').includes('夜风'));
  assert.ok(contentCores('给林夏的那封').includes('林夏'));
  assert.equal(slotMentioned('从侧廊过来的', '侧廊有风吗？'), true);
  assert.equal(slotMentioned('对旧账', '旧账还在架子上吗？'), true);
  assert.equal(slotMentioned('为了闭馆', '闭馆的钟点改了吗？'), true);
  assert.equal(slotMentioned('被夜风吹开的', '夜风是从窗缝进来的吗？'), true);
  assert.equal(slotMentioned('在抽屉里', '抽屉里那把还在吗？'), true);
  assert.equal(slotMentioned('从前', '门前有灯'), false);
  assert.equal(slotMentioned('对方', '方便的话'), false);
  assert.equal(slotMentioned('被单', '单上有灰'), false);
  assert.equal(slotMentioned('为什么', '什么都没说'), false);
  assert.equal(slotMentioned('从图书馆后门过来的', '图书室还开着吗'), false);
  assert.equal(slotMentioned('从容', '他很从容'), true);
});

test('槽位分类', () => {
  assert.equal(classifySlot('生气'), 'emotion');
  assert.equal(classifySlot('方才那种懒洋洋的调侃'), 'emotion');
  assert.equal(classifySlot('平静的湖面'), 'mixed');
  assert.equal(classifySlot('催促'), 'speech');
  assert.equal(classifySlot('前年的那册账'), 'content');
  assert.equal(classifySlot('在抽屉里'), 'content');
  assert.equal(classifySlot('这个'), 'vague');
  assert.equal(classifySlot('红茶'), 'content');
});

test('坏词表会在编译时失败', () => {
  assert.throws(
    () => compileRuleSet({
      categories: [{ id: 'template', title: '句式模板' }],
      rules: [{ id: 'x', category: 'template', kind: 'template', shape: 'nope', description: '', examples: ['a'] }],
    }),
    /未知句式形状/,
  );
});
