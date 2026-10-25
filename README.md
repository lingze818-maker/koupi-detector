# koupi-detector

口癖检测器。零依赖的中文角色扮演「模型口癖」检测。Node.js ≥ 18，只在本机跑，没有 npm 依赖。命令行仍是 `node cli.mjs`。

口癖会先把文笔压扁。角色本来该有的用词和脾气，被换成一套到处都能用的转折和语气说明。读者记住的是「没有……也没有……只是」，不是这个人。人格保持跟着掉，是因为句子的节奏已经被占满了。

这套句子在 DeepSeek 各版本的角色扮演里特别稳。它可能来自训练分布，也可能是对齐偏好，也可能是某次提示词带起来的。这个工具不假装知道是哪一种。它只负责把句子捞出来，标上候选归因，让人自己确认。

目录按「纯函数和 IO 分开、`node:test`、`mcp/server.mjs`」来放。识别、密度和三率都不碰文件系统；读文件、写 JSONL、stdio 都在 `cli.mjs` 和 `mcp/server.mjs`。

## 三层

1. **识别。** 词表在 `tics/default.json`。每条规则有 id、类别、说明和示例。词面规则用正则，能吃「声音很平淡」「并不是……而是」这类变体，不是整句全等。句式模板会先把槽位切出来再判断。输出命中的起止位置、规则 id、类别、判定和上下文。
2. **归因（给人用）。** 每条命中都带着候选标签 `training-data`、`alignment-preference`、`prompt-induced`、`unknown`。工具自己永远建议 `unknown`。你用标注文件确认。可以导出 JSONL badcase，里面有复现用的上下文。`--redact` 只留命中两侧 N 个字，并按顺序把人名换成甲、乙、丙。
3. **评测。** 多轮对话给出每千字密度、类别分布、随轮次的密度曲线，以及一个很浅的人设保持率（角色卡关键词和口头禅有没有出现）。金标命令计算检出率、误报率、不可判定率。

## 首要类别：句式模板 / 无意义转折

最想压下去的是硬凑转折。转折一多，说话就只剩同一种死板节奏。报告把这一类放在最前，单独给出：

- 每千字密度（只计判定为口癖的次数）
- 平均每轮次数
- 每一轮的每千字曲线（文本，或 `--csv`）
- 阈值告警

默认：

- 全篇句式模板 ≥ **4** /千字，告警
- 单轮 ≥ **10** /千字，且这一轮不少于 **30** 字，告警
- 同一轮里有 **2** 处及以上句式口癖，不论长短，告警（堆叠）

短轮次里一个命中就会把「每千字」拉得很高，所以单处短轮不单独告警。全篇阈值在很短的样本上仍然容易响，看曲线时要连字数一起看。

不可判定不计入密度，也不触发告警。

另外两类照常统计：

- **情绪抹平**：语气平淡、听不出什么情绪、没有多余的情绪、声音平稳、声调不高不低、温和又疏淡……
- **比喻套话**：像在陈述天气或事实、再寻常不过、像刚才什么也没发生过、无关紧要、不容商榷、今日天色不错、像是怕惊到……

单独的「声音低沉」「味道平淡」「今天天气不错」不判。它们经常是正常叙述。

## 省力原则和绕路否定

人说话省力。杯子里是白水，就说「这是杯白水」。不会先排除没人提过的茶和酒。「不是茶，也不是酒，而是白开水」绕了一圈，节奏还是那套转折，所以它是口癖。问题不在茶和酒是不是具体名词，而在这句有没有必要绕路。

这类命中归在句式模板下面的子类 **绕路否定**，计入每千字、每轮和告警。回看范围是同轮里命中之前的文字，加上前若干轮，默认 4 轮，用 `--context-turns` 改。设成 0 就只看同轮。

| 情况 | 判定 |
| --- | --- |
| 否定项都是情绪、责备、解释、调侃这类空转 | 口癖 |
| 否定项是具体选项，前文窗口里没出现过 | 绕路否定，算口癖 |
| 否定项是具体选项，前文真的提过或对方猜过 | 放行，不计密度。例如对方问「这是茶吗」，回答「这不是茶，而是白水」 |
| 几个否定项里只有一部分在前文出现 | 不可判定 |
| 单句输入，又没有前文可以看 | 不可判定 |
| 空转和具体内容粘在同一个槽里 | 不可判定 |
| 「像在……又像是在」两边都是陈述、评价、念结论 | 口癖 |
| 两边都比较长、也比较具体的比喻 | 放行 |
| 短排比，又看不出套话（像在走路，又像是在跳舞） | 不可判定 |

80 字以内如果还有另一处转折，空转类的不可判定会升级成口癖。标了「没有前文」的不可判定不会因为旁边还有一句就被升级。

对照示例 `examples/dialogue-clean.json` 里，林夏先问了茶、抽屉和周一，周衡再否定，这些是真实纠正，会放行。口癖示例末尾那句「不是茶，也不是酒，而是白开水」前文没人提过茶和酒，会计入密度。

## 冗余比

不调用模型。每条命中的句式做一次规则改写，只留断言。人会说「这是杯白水」，不会说「这不是茶，也不是酒，而是白开水」。多出来的那一截就是冗余。

| 原句 | 最短改写 |
| --- | --- |
| 这不是茶，也不是酒，而是白开水（单句，没有前文） | 白开水 |
| 不是茶，也不是酒，而是白开水（有前文） | 是白开水 |
| 没有生气，也没有惊讶，只是看着她 | 只是看着她 |
| 没有责备，而是把杯子放下（有前文） | 是把杯子放下 |
| 没有调侃，也没有笑意 | 删去。没有断言可留 |
| 像在陈述事实，又像是在念一份结论 | 像是在念一份结论 |

字数去掉空白、保留标点，和密度用同一口径。

- 冗余比 = 命中字数 / 最短改写字数
- 冗余字 = 命中字数 − 最短改写字数
- 每千字冗余字 = 冗余字合计 / 文本字数 × 1000

`scan` 和 `report` 的文本和 `--json` 都会给出单条命中的比例，以及全文的均值、最大值、每千字冗余字。`tic_scan` 和 `tic_report` 同样带上这几项。

只把判定为口癖的句式算进去。前文提过的真实纠正会放行，改写可以看，但不进均值、最大值和每千字。系统标成不可判定的也不进。没有断言可留时，比例留空，不进均值和最大值，命中字数全部算冗余字。

## 快速开始

不需要安装依赖。

```bash
node --test
node cli.mjs scan examples/dialogue-tics.json
node cli.mjs scan examples/dialogue-tics.json --annotate examples/attributions.sample.json
node cli.mjs report examples/dialogue-tics.json
node cli.mjs report examples/dialogue-clean.json
node cli.mjs report examples/dialogue-mixed.md --csv examples/out/curve.csv
node cli.mjs eval --gold examples/gold.json --holdout examples/holdout.json --holdout-v2 examples/holdout-v2.json --baseline examples/baseline-before.json
node cli.mjs eval --gold examples/gold.json --holdout examples/holdout.json --holdout-v2 examples/holdout-v2.json --baseline examples/baseline-before.json --report docs/eval-report.md
node cli.mjs rules
node cli.mjs data --gold examples/gold.json --consensus examples/consensus-tic.json
node cli.mjs cross-model --prompts examples/cross-model-prompts.json
node cli.mjs prompt-ab --spec examples/prompt-ab.json
node cli.mjs rewrite examples/selfcheck-one.txt
node cli.mjs rewrite --drafts examples/selfcheck-drafts.json --report docs/selfcheck-report.md
```

标准输入：`node cli.mjs scan -`。告警时想让脚本失败：`node cli.mjs report <文件> --strict`（退出码 2）。

脱敏后再把 badcase 拷走：

```bash
node cli.mjs scan examples/dialogue-tics.json \
  --redact --names 林夏,周衡 --window 24 \
  --save-badcases /tmp/koupi-badcases.jsonl
```

`--redact` 时，角色卡里的名字和各轮说话人会并进替换名单。窗口默认 24 个字。

当前口癖示例（虚构，闭馆前对账）会告警，其中包含一句绕路否定。对照示例 0 处口癖：茶、抽屉、周一都是对方先问过的，回答里的否定被放行。人设关键词都在。

## 对话格式

密度默认只算 `assistant`。旁白要算进去就加 `--roles assistant,narration`。用户轮次不进分母。

JSON：

```json
{
  "id": "fic-01",
  "title": "闭馆前的账本",
  "character": {
    "name": "周衡",
    "keywords": ["账本", "铁盒", "闭馆"],
    "catchphrases": ["先把灯点上"]
  },
  "turns": [
    { "role": "user", "speaker": "林夏", "text": "还亮着灯。" },
    { "role": "assistant", "speaker": "周衡", "text": "先把灯点上。" }
  ]
}
```

Markdown：

```markdown
---
id: fic-mixed
title: 灯还亮着
character: 周衡
keywords: 账本, 先把灯点上, 闭馆
catchphrases: 先把灯点上
---

user 林夏: 我可以进来吗？

assistant 周衡: 先把灯点上。账本还摊着。
```

没有角色行、也不是 JSON 的纯文本，会当成一整段 assistant。

人设保持率 = 出现过的关键词和口头禅 / 角色卡里的总数。这只说明这些字还在不在，不是人格一致性。

## 金标和三率

`examples/gold.json` 是虚构的句子级金标。`label`：

- `tic`：人工认为是口癖
- `clean`：人工认为不是
- `unjudgeable`：人工自己也拿不准，不进下面三项

系统对每条给出 `positive`（口癖）、`negative`（非口癖）、`indeterminate`（不可判定）。

在人工可判定的样本上：

- **检出率** = 判成口癖的金标口癖 / 系统作出了判定的金标口癖
- **误报率** = 被判成口癖的金标非口癖 / 系统作出了判定的金标非口癖
- **不可判定率** = 系统不可判定 / 人工可判定的金标

系统弃权的样本不进检出率和误报率的分子、分母，也不算一次成功检出。金标可以带 `before`，表示命中之前的对话；不写 `before` 就是单句，没有前文。

`examples/gold.json` 有 167 条：句式口癖 41、情绪抹平 25、比喻套话 25、正常句 72、人工不可判定 4。其中 17 条是本轮为介词槽和隔句补的虚构句。`examples/holdout.json` 仍是上一轮的 52 条，句子没有改。`examples/holdout-v2.json` 有 52 条，换了码头场景，并放进情绪抹平和比喻套话的近义说法；规则定稿后才写，只评了一次。

同一批旧句子上，金标从 **77/78 = 0.987**、**0/61 = 0.000**、**7/146 = 0.048** 变成 **77/77 = 1.000**、**0/56 = 0.000**、**13/146 = 0.089**。补例之后的金标是 **81/81 = 1.000**、**0/66 = 0.000**、**16/163 = 0.098**。旧留出集从 **22/23 = 0.957**、**1/25 = 0.040**、**3/51 = 0.059** 变成 **22/22 = 1.000**、**0/23 = 0.000**、**6/51 = 0.118**。这份旧留出集已经被看过，修复后的分数不是完全干净的估计。留出集 v2 是 **14/22 = 0.636**、**0/23 = 0.000**、**6/51 = 0.118**，漏检集中在近义说法。

`eval --holdout` 和 `--holdout-v2` 把三份三率分开打。`--baseline` 读修复前的摘要。`eval --report` 写成 `docs/eval-report.md`。

## 回复前自查

草稿先扫。有口癖时，把命中片段、类别和省力改写交给改写器，最多重写 2 轮，每轮后再扫。不可判定不改。不含口癖的草稿原样通过。

```bash
node cli.mjs rewrite examples/selfcheck-one.txt
node cli.mjs rewrite --drafts examples/selfcheck-drafts.json --rewriter offline --report docs/selfcheck-report.md
```

`--rewriter offline` 不调用模型：句式口癖换成省力改写。词面套话只有删完句子仍成立才删，否则保留原句，标成需模型改写，并返回命中。MCP 里的工具名是 `tic_rewrite`。

`--rewriter llm` 也只改命中 span：已有省力改写的直接套用，不调模型；没有省力改写、或套用后成残句的，才把那一截交给模型，再拼回原文，未命中的字保持原样。接口是 OpenAI 兼容的 `POST {KOUPI_LLM_BASE_URL}/chat/completions`。密钥只从环境变量读：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `KOUPI_LLM_API_KEY` | 必填，否则直接失败 | 无 |
| `KOUPI_LLM_BASE_URL` | 接口根路径 | `https://api.openai.com/v1` |
| `KOUPI_LLM_MODEL` | 模型名 | `gpt-4o-mini` |

DeepSeek：`KOUPI_LLM_BASE_URL=https://api.deepseek.com/v1`，`KOUPI_LLM_MODEL=deepseek-chat`。

`examples/selfcheck-drafts.json` 是虚构的情感类草稿。评测报告在 `docs/selfcheck-report.md`，含改写前后的口癖率、平均冗余比、字数变化、字面保真和句子完整性，以及已修复、需模型、原样通过。保真是载荷字列和结果字列的 Dice，不靠人判。它看不出同义替换，也会把「口癖删干净但句子塌了」记成 1.000。完整性单独计成立的句数，避免这一类结果靠保真拿满分。

## 语义层

近义说法收在默认词表里，对照说明是 `docs/consensus-lexicon.md`。32 条两人同判 tic 只用来扩词。本仓库没有单独的 `semantic/` 目录。

## 数据、横评、提示归因

偏好对和清洗版 SFT 从金标与共识里的虚构口癖句导出，说明在 `docs/data-loop.md`。跨模型口癖率的脚本在 `docs/cross-model-eval.md`，没有密钥就留空。风格提示和 ADHD 短提示的归因表在 `docs/prompt-ab.md`，没有落盘的生成结果就写未测。

## 隐私

真实对话只在你自己的电脑上跑。仓库里只有虚构示例：图书馆闭馆、账本、茶和伞，没有敏感内容，也没有 NSFW。

导出的 JSONL 在不加 `--redact` 时会带上命中句，方便你自己复现。要拿去给别人看，先脱敏。不要把真实样本提交进这个仓库。

## 词表怎么扩展

`tics/default.json` 的 `kind: "regex"` 可以直接加。正则里的 `⏎` 表示换行，免得手写转义。同一类别里互相重叠的命中只留更长、或更具体的那条。

```json
{
  "id": "emo.my-phrase",
  "category": "emotion-flat",
  "kind": "regex",
  "description": "你新看到的一句",
  "pattern": "听不出半点脾气",
  "examples": ["他听不出半点脾气"]
}
```

用 `--rules` 指向你的文件。每条规则至少留一个示例；`node --test` 会检查默认词表里的示例都能被自己打中。

句式「形状」写在 `lib/rules.mjs`。现在有八种：没有……也没有……只是、没有……也没有……而是、没有……也没有、没有……只是、没有……而是、不是……也不是……而是、不是……而是（含并不是、却不是、并非）、像在……又像是在（含像是在、仿佛在、好像在、又像在）。新形状要改代码，因为要切槽。空转词表在 `lib/lexicon.mjs`。

默认词表 33 条：句式 8，情绪抹平 10，比喻套话 15。附件里的那些干净短语都有对应规则；测试会逐条扫过。

标注文件：

```json
{
  "version": 1,
  "items": [
    {
      "match": { "ruleId": "tpl.mei-you-ye-mei-you-zhi-shi", "text": "没有生气，也没有惊讶，只是看着她" },
      "attribution": "training-data",
      "note": "多个版本里几乎原样出现"
    }
  ]
}
```

`attribution` 只能是那四个标签之一。

## MCP

`mcp/server.mjs` 是 JSON-RPC 2.0、协议 `2024-11-05` 的 stdio 服务。帧格式是 `Content-Length`。工具：

- `tic_scan`：文本进，命中出。句式口癖带上单条冗余比，并给出均值、最大值和每千字冗余字
- `tic_report`：文本进，密度、曲线、告警和同样的冗余比汇总出

评测仍走 CLI。文本由调用方传入，服务不去读你的对话文件。

```json
{
  "mcpServers": {
    "koupi": {
      "command": "node",
      "args": ["mcp/server.mjs"]
    }
  }
}
```

## 测试

```bash
node --test
```

覆盖规则命中、句式变体、绕路否定、真实纠正放行、单句不可判定、密度和阈值、三率、脱敏、CLI 和 MCP 握手。

## 已知局限

- 绕路否定靠字符串是否在前文出现，不是指代消解。说法换了（问「那杯饮料」，答「不是茶」）会对不上，可能把真实纠正判成绕路。
- 回看窗口默认 4 轮。提得更早的选项会被当成没人说过。用 `--context-turns` 加长。
- 同一轮里，两段式再隔一个无关整句时标不可判定；前文已经把被否定项说全的仍放行。再多隔一句就不接。三段式可以跨两个句界。不跨说话人轮次。
- 介词开头的否定槽会剥掉从、对、被、为、向、往、朝、由、在、把、将、给、跟。从前、对方、被单、为什么、从容不剥。被、给、跟、对、为后面拖着动词时，还会拿前两字去对前文。说法换了（问「那种饮料」，答「不是茶」）仍然对不上。
- 空转词用子串匹配。`生气勃勃`、`确认函` 这类可能被看成混合，从而不可判定；偶尔也会偏严。
- 「像在……又像是在」只有两边都像套话才算口癖。短的具体排比标不可判定，长的具体比喻直接抑制。故意写的短排比不会被算进密度，但会留在不可判定里。
- 每千字对短文本很敏感。看告警时要看字数和是不是同一轮堆了两处。
- 不判断成因。归因默认 unknown。
- 人设保持只是关键词还在不在。
- 金标是句子级，不是跨轮 span。
- 词表正则按本地信任的文件来编译，不要把来历不明的词表直接跑。

## 下一步

- 用你自己的真实样本在本地跑一版（不要入库），把不可判定逐条复核，再决定哪些虚词留在词表里。
- 按模型版本画句式模板的密度曲线，看是哪一次改动把它抬上去的。
- 误报如果集中在某一个虚词，就把那个词从 `lib/lexicon.mjs` 移出去。
- 金标可以从句子级扩到标注好的 span。
- 不可判定可以单独导出成待标注队列。
- MCP 若需要，再加一个 `tic_eval`。
