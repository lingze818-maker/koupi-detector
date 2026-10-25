export const REASON_TEXT = {
  'negated-slot-emotion': '否定项主要是情绪词',
  'negated-slot-speech-act': '否定项主要是言语行为虚词',
  'negated-slot-vague': '否定项是空泛指代',
  'stacked-negation': '堆叠了多个否定',
  'mixed-slots': '否定项里既有虚词也有具体内容',
  'detour-negation': '绕路否定：被否定的具体选项前文没人提过',
  'grounded-contrast': '前文提过被否定的选项，是真实纠正',
  'no-prior-context': '没有前文，无法判断是不是绕路',
  'detour-partial': '被否定的选项只有一部分在前文出现过',
  'simile-meta': '「像在……又像是在」两边都是陈述或评价套话',
  'simile-partial-meta': '比喻排比只有一侧像套话',
  'simile-short-parallel': '短的「像在……又像是在」，看不出是不是套话',
  'simile-specific': '比喻排比里带了具体内容',
  'simile-concrete': '比喻排比两边都比较具体',
  'nearby-stack-upgrade': '短距离里还有别的转折，按堆叠计',
  'cross-sentence': '同一轮里跨过了句号、问号、叹号、省略号或换行',
  lexical: '词面规则命中',
};

export function reasonText(id) {
  return REASON_TEXT[id] || id;
}
