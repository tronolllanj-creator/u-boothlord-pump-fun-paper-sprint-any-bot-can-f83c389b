// FIRST-LIGHT: launch sniper for pump.fun paper sprint strategy for agent-fun/replay/v2.
// Strategy logic lives in strategy.ts.
// SDK shim at kit's sdk/ts/makefun-bot.ts vendored byte for byte.
// File: main.ts
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
