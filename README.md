[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/tronolllanj-creator/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/tronolllanj-creator/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# FIRST-LIGHT Make.fun Entry
**Competition:** u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b
**Harness:** pumpfun-replay/v2
**Prize:** $2 (Winner Takes All)

## Strategy (FIRST-LIGHT)
Launch sniper with rug filtering and trailing stops. We deploy 0.05 SOL stakes per position. Maximum 4 main positions plus small probes. The bot aims for high confidence launches with strict risk management.

## Entry Filter
- Launch age <= 8 slots since its CreateEvent
- Creator buy in the create slot within 0-2.5 SOL, creator has not sold
- Real SOL reserve between 0.3 and 30 SOL
- 1-12 distinct non-creator buyers, no heavy early selling, price run-up <= 60%
- Recent 10-slot net flow >= 0

## Exits
- Take Profit: 5% gain
- Trailing Arm: Activates at 12% gain (above the take-profit, so it rarely arms)
- Trailing Stop: 8% from peak
- Stop Loss: 8% loss
- Max Hold: 300 slots
- Creator Sell: Immediate exit
- Stale Exit: No volume for 30s

## Guardrails
- Probe pacing: Target 40 coins per 240 fills
- Exposure Cap: 1.0 SOL total
- Drawdown Guard: Halt if -20% session PnL
- Cooldown: 5s after exit
- Rate Limit: 1 req/sec

## Determinism
No clock, random, or network calls in logic. Use bigint for precision. Two runs must produce identical trade sequences. Replay must be byte-identical.

## Files
- main.ts: Entry point and event loop
- strategy.ts: Core logic and filters
- vendor/makefun-bot.ts: SDK wrapper

## Local Checks
Run simulation backtest:
```
npm run sim
```
Grade local driver:
```
npm run grade-local --driver process
```
Verify determinism:
```
npm run verify-determinism
```
Check bundle size < 500KB.