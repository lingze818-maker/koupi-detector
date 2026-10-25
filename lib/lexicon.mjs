/**
 * 否定项里的「空转」词。只用于句式模板的槽位，不拿来扫全文。
 * 判定看槽位剥掉这些词之后还剩不剩具体内容，避免「平静的湖面」被硬判成口癖。
 */

export const EMOTION_TERMS = [
  '情绪波动',
  '多余的情绪',
  '特别的情绪',
  '懒洋洋',
  '笑意',
  '怒意',
  '惊讶',
  '生气',
  '愤怒',
  '喜悦',
  '悲伤',
  '害怕',
  '恐惧',
  '慌张',
  '慌乱',
  '激动',
  '平静',
  '平淡',
  '平稳',
  '冷淡',
  '温柔',
  '心软',
  '心虚',
  '失望',
  '期待',
  '难过',
  '开心',
  '高兴',
  '不悦',
  '不满',
  '羞恼',
  '委屈',
  '焦虑',
  '紧张',
  '松弛',
  '疏淡',
  '戏谑',
  '嘲讽',
  '调侃',
  '迟疑',
  '犹豫',
  '停顿',
  '动摇',
  '波澜',
  '起伏',
  '情绪',
  '语调',
  '声调',
  '语气',
  '表情',
];

export const SPEECH_TERMS = [
  '转移话题',
  '下结论',
  '开玩笑',
  '责备',
  '安慰',
  '解释',
  '道歉',
  '质问',
  '挽留',
  '催促',
  '追问',
  '确认',
  '否认',
  '承认',
  '反抗',
  '妥协',
  '让步',
  '退让',
  '表态',
  '评价',
  '陈述',
  '辩解',
  '反驳',
  '质疑',
  '商量',
  '恳求',
  '撒娇',
  '寒暄',
  '客套',
  '闲聊',
  '命令',
  '请求',
  '拒绝',
  '答应',
  '敷衍',
  '打岔',
  '播报',
  '汇报',
  '点评',
  '念稿',
  '读稿',
];

const VAGUE_EXACT = new Set([
  '这个',
  '那个',
  '这样',
  '那样',
  '这些',
  '那些',
  '什么',
  '别的',
  '其他',
  '其它',
  '如此',
  '啥',
]);

const TERM_INDEX = [...EMOTION_TERMS.map((term) => ({ term, kind: 'emotion' })), ...SPEECH_TERMS.map((term) => ({ term, kind: 'speech' }))]
  .filter((item) => item.term.length >= 2)
  .sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term, 'zh'));

export function normalizeSlot(raw) {
  let text = String(raw || '').replace(/\s+/g, '').replace(/[，,、]/g, '');
  text = text.replace(/^(?:并|却|又|还|就|只)/, '');
  text = text.replace(/^(?:方才|刚才|此前|之前)?(?:那种|这种|一种)?/, '');
  text = text.replace(/^(?:什么|任何|丝毫|半点|多少|太多|多余|特别|明显|些许|一丝)的?/, '');
  text = text.replace(/^[在把将给跟同与和]/, '');
  return text;
}

function longestTerm(text) {
  return TERM_INDEX.find((item) => text.includes(item.term)) || null;
}

/**
 * emotion / speech：槽位基本上就是情绪或言语行为虚词
 * vague：空泛指代
 * mixed：虚词旁边还粘着具体内容
 * content：看不出虚词，当成有信息
 */
export function classifySlot(raw) {
  let rest = normalizeSlot(raw);
  if (!rest || VAGUE_EXACT.has(rest)) return 'vague';

  let saw = null;
  for (let i = 0; i < 8; i += 1) {
    const hit = longestTerm(rest);
    if (!hit) break;
    saw = hit.kind;
    rest = rest.replace(hit.term, '');
    rest = rest.replace(/[的地得与和或又而且了着过]/g, '');
  }
  rest = rest.replace(/^[很太更还就只]+/, '');
  if (!rest) return saw || 'vague';
  if (saw) return 'mixed';
  return 'content';
}

const SIMILE_META = /陈述|评价|点评|播报|汇报|念稿|念书|下结论|读稿|天气预报|寻常|平常/;

export function isMetaSimile(slot) {
  const text = String(slot || '').replace(/\s+/g, '');
  if (!text) return false;
  if (SIMILE_META.test(text)) return true;
  if (text.startsWith('念')) return true;
  if (/(事实|结论)/.test(text) && text.length <= 10) return true;
  return false;
}
