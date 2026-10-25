# 跨模型口癖率

项目：koupi-detector（口癖检测器）。

同一批虚构 prompt、温度 0，按模型统计每千字口癖率，以及句式模板、情绪抹平、比喻套话三类次数。默认只有 DeepSeek 一路。没有密钥的模型留空，不写成 0。

```bash
node cli.mjs cross-model --prompts examples/cross-model-prompts.json --out runs
```

这次环境没有 `KOUPI_LLM_API_KEY`，所以没有请求。结果在 `runs/cross-model.md`、`runs/cross-model.json`，图是 `runs/cross-model.svg`。图上没有柱，旁注写着未跑。

## 在 box 上跑单路 DeepSeek

压缩包是 `koupi-detector-latest.tar.gz`（当前 main，不含 `node_modules` 和 `.git`）。密钥只在 box 上设置，不要写进仓库，也不要传到云端。

```bash
tar -xzf koupi-detector-latest.tar.gz
cd koupi-detector
export KOUPI_LLM_BASE_URL=https://api.deepseek.com/v1
export KOUPI_LLM_MODEL=deepseek-chat
export KOUPI_LLM_API_KEY=你的密钥
node cli.mjs cross-model --prompts examples/cross-model-prompts.json --out runs
```

不设 `KOUPI_LLM_BASE_URL` 和 `KOUPI_LLM_MODEL` 时，默认就是上面这两个值。只设 `KOUPI_LLM_API_KEY` 也会走这一路 DeepSeek。命令把表写到 `runs/cross-model.md`，图写到 `runs/cross-model.svg`，并附带 `runs/cross-model.json`。检测判定沿用现有词表，这个命令不改规则。

## 模型适配

DeepSeek 读现成的三个变量。不设 base 和 model 时，默认 `https://api.deepseek.com/v1` 和 `deepseek-chat`。

| 变量 | 作用 |
| --- | --- |
| `KOUPI_LLM_API_KEY` | 没有就跳过，不发请求 |
| `KOUPI_LLM_BASE_URL` | 接口根路径 |
| `KOUPI_LLM_MODEL` | 模型名 |

再加一路时，名字写进 `KOUPI_EVAL_MODELS`（逗号分隔），并配 `KOUPI_EVAL_<NAME>_BASE_URL`、`KOUPI_EVAL_<NAME>_MODEL`、`KOUPI_EVAL_<NAME>_API_KEY`。名字会转成大写，非字母数字变成下划线。缺密钥的那一路同样留空。

温度写死在 `lib/cross-model.mjs` 的 `CROSS_MODEL_TEMPERATURE`，当前是 0。提示在 `examples/cross-model-prompts.json`，系统句和用户句都没有口癖例句，避免提示自己把套话喂进去。

回复用现有检测器扫描。每千字口径和 `report` 相同。失败的请求记成失败，指标仍是空，不拿别的模型的数来填。
