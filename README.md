# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/stteadynfts/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/stteadynfts/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in for marked 18.1.3: `parse(markdown)` returns byte-identical HTML to marked's default render, for less CPU. A fork of marked (MIT, see `vendor/marked/LICENSE`), optimized in place: the inline tokenizer takes a fast plain-text path, and the hot loops avoid re-scanning text the rules already passed over.

## Run it

```sh
node main.ts
```

The harness runs it with `/input/cases.json` mounted and collects `/output/html.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zsmce2ny&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
