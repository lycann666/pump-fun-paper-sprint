# pump-fun-paper-sprint

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lycann666/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lycann666/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum paper-trading bot for pump.fun: buys coins with accelerating buy inflow, exits on +35% take-profit, -10% stop-loss or trailing stop.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: the make.fun harness feeds it pump.fun bonding-curve events and it replies with buy/sell orders. Paper trading only — no real funds, no network, fully deterministic (same batches in, same orders out).

## Strategy

- **Entry:** a coin qualifies after 120 slots of age when, over the last 40 slots, net buy inflow is ≥ 0.5 SOL from ≥ 4 buys by ≥ 4 distinct buyers, price is up 12–120% and sitting within 10% of its window high, the newer half of the window inflows at least as fast as the older half, and real SOL reserves are 1–80 SOL. Candidates are ranked by 10-slot inflow velocity, fastest first.
- **Size:** 0.10 SOL per position, at most 5 open, at most 6 SOL exposed at cost, one buy per coin (no pyramiding, no averaging down).
- **Exits:** +35% take-profit, −10% stop-loss, 15% trailing stop armed at +10%, fade exit when 20-slot net flow turns below −0.5 SOL, or a 900-slot time limit (waived while up ≥ 10%).
- **Guardrail:** tiny 0.01 SOL probe round trips only fire when fills/coins lag the pace for the 20-coin minimum; the main strategy does the earning.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5f3j6jyb&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
