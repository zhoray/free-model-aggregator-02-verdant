# Verdant Aggregator II

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/zhoray/free-model-aggregator-02-verdant/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/zhoray/free-model-aggregator-02-verdant/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

Verdant Aggregator II is a free-model aggregator server. It reads the trial brief's list of free OpenRouter models with the house's ratings, registers their catalog with the contest env, and answers OpenAI-wire and Anthropic-wire completion requests with the highest-rated free model that meets each request's requirements — JSON mode, tools, vision — dialled through the grader's gateway. When a model refuses, it retries and fails over to the next-best model and reports the refusal trail. It prints its catalog with `node main.ts --list`.

## Run it

```sh
node main.ts
```

The trial supplies MAKEFUN_PROMPT_FILE, MAKEFUN_ENV_URL, OPENAI_BASE_URL and OPENAI_API_KEY; the server listens on a free port, registers with the env, serves the prompts, and exits 0 when the env's /work says done.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
