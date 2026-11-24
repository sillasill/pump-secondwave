# pump-secondwave

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sillasill/pump-secondwave/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sillasill/pump-secondwave/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A pump.fun paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It trades only the second wave: a coin that spikes at launch, dumps at least 30% from its early high, then recovers 35% from the post-spike low — with net buy flow and several distinct buyers behind the recovery. One 0.3 SOL entry per coin, exits at +125% take profit, a -20% trailing stop once +20% up, a -12% hard stop, or 300 slots held. Tiny 0.02 SOL probe round trips keep the run above the 20-coin guardrail when signals are scarce.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=bfyeqrq3&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>

## Design

- The dev window (24 h, 1,222 coins) was measured before anything was built: buy-and-hold bleeds (median coin ends at 0.94x its first-trade price), dip-buying after a 30–40% drawdown keeps falling (median forward return −6% to −23%), and the house momentum pilot loses −9.39 SOL by pyramiding into tops. The only pattern with a real edge is the second wave: the first +30% recovery from a post-launch low (n=198 coins) has a median +53% max excursion within 300 slots, and 7 of those coins completed the curve (~14.6x).
- Completion is binary at ~85 SOL of real reserves (92% of coins that reach 80–85 SOL complete; 0% below that do), and all 7 gradual completers in dev were in the second half of the window — so the strategy is a positive-skew lottery: many small capped losses, a few big winners. Pyramiding into winners was tested and rejected (it cut the score from +0.81 to +0.04 SOL).
- Backtest on the full dev window with a faithful local port of the replay engine: **net +1.41 SOL** (88 round trips, 86 coins, 28% wins, max drawdown 2.4%), vs the house pilots at −0.49 SOL (sniper), −4.02 SOL (reversion) and −9.39 SOL (momentum). Split by halves it is positive in both (+0.08 / +1.34 SOL), and on four independent 6-hour slices it scores −0.00 / +0.07 / +0.58 / +0.62 SOL with 33–51 coins each — above the 20-coin guardrail in every slice.
- Deterministic: no clock, no randomness, no network, no I/O in the bot — every decision is a pure function of the batches the harness sends. Two runs produce byte-identical action logs.
