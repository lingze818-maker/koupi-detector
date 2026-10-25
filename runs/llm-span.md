# llm 按命中拼接

日期：2026-10-24。环境里没有 `KOUPI_LLM_API_KEY`（`KOUPI_LLM_BASE_URL`、`KOUPI_LLM_MODEL` 也未设置），所以没有调用模型，没有 d05/d08 的线上前后保真和完整性。下面只记测试和离线对照。

## 改了什么

`createChatRewriter` 不再把整段草稿交给模型。`selectRewriteSpans` 里已有省力改写（`rewrite != null`，含空串）且套用后句子仍成立的，直接 `applyEconomy`，不发请求。没有省力改写，或离线套用后成残句的，才按 span 调一次模型，用 `applyEconomy` / `tidyRewrite` 拼回；拼完仍是残句则该句回退原文。没有命中的句子按原文字节拼接。

默认 system 写明：只改列出的命中；「他开口。」不要补情绪；可省主语，不硬补「他/她」；单句无前文不加「是」（「白开水。」而不是「是白开水。」）；不新增情节。

## 测试

`node --test`：43 项全部通过。

覆盖：整段只有一处词面命中时，未命中句「伞还在滴水。」与原文字节级一致；「他没有生气，也没有惊讶，只是看着她。伞还在滴水。」有省力改写，模型调用次数为 0，结果是「他只是看着她。伞还在滴水。」。

## 三率

检测与金标判定没有改。金标仍是检出 81/81 = 1.000，误报 0/66 = 0.000，不可判定 16/163 = 0.098。离线自查草稿的已修复 / 需模型计数也没变（含口癖 6 已修复、6 需模型）。

## 未跑的对比

有密钥时再跑：

```bash
KOUPI_LLM_BASE_URL=https://api.deepseek.com/v1 KOUPI_LLM_MODEL=deepseek-chat \
  node cli.mjs rewrite --drafts examples/selfcheck-drafts.json --rewriter llm --report docs/selfcheck-report-llm.md
```

那时才能写下 d05、d08 改写前后的保真和完整性。这次没有这些数。
