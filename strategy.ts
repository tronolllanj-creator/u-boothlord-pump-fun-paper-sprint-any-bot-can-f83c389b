import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts'
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts'

export interface Params {
  stakeSol: number
  minBuySol: number
  maxAgeSlots: number
  minDevBuySol: number
  maxDevBuySol: number
  minBuyers: number
  maxBuyers: number
  minRealSol: number
  maxRealSol: number
  maxRunupBps: number
  tpBps: number
  trailArmBps: number
  trailBps: number
  slBps: number
  maxHoldSlots: number
  staleSlots: number
  exitOnDevSell: boolean
  buySlipBps: number
  maxMain: number
  targetCoins: number
  targetFills: number
  paceSecs: number
  probeSol: number
  maxProbes: number
  maxExposureSol: number
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.05,
  minBuySol: 0.005,
  maxAgeSlots: 8,
  minDevBuySol: 0,
  maxDevBuySol: 2.5,
  minBuyers: 1,
  maxBuyers: 12,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxRunupBps: 6000,
  tpBps: 500,
  trailArmBps: 1200,
  trailBps: 800,
  slBps: 800,
  maxHoldSlots: 300,
  staleSlots: 600,
  exitOnDevSell: true,
  buySlipBps: 10000,
  maxMain: 4,
  targetCoins: 40,
  targetFills: 240,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 200,
  maxExposureSol: 1.0,
}

interface TapeEntry {
  mint: Pubkey
  createSlot: number
  creator: Pubkey
  vq0: bigint
  vt0: bigint
  devBuyLamports: bigint
  buyers: Set<Pubkey>
  boughtLamports: bigint
  soldByOthersLamports: bigint
  devSold: boolean
  lastTradeSlot: number
  recentFlow: { slot: number, netLamports: bigint }[]
  buysSent: number
  spentLamports: bigint
  done: boolean
  complete: boolean
}

interface HeldEntry {
  openedSlot: number
  costLamports: bigint
  bestValueLamports: bigint
  lastBuySlot: number
  isProbe: boolean
}

const toLamports = (sol: number): bigint => BigInt(Math.round(sol * 1e9))

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const stakeLamports = toLamports(p.stakeSol)
  const minBuyLamports = toLamports(p.minBuySol)
  const maxExposureLamports = toLamports(p.maxExposureSol)
  const minDevBuyLamports = toLamports(p.minDevBuySol)
  const maxDevBuyLamports = toLamports(p.maxDevBuySol)
  const minRealLamports = toLamports(p.minRealSol)
  const maxRealLamports = toLamports(p.maxRealSol)
  const probeLamports = toLamports(p.probeSol)

  const tapes = new Map<Pubkey, TapeEntry>()
  const held = new Map<Pubkey, HeldEntry>()

  let firstBatchSlot: number | null = null
  let fillCount = 0
  let roundTrippedCoins = 0
  const roundTripMints = new Set<Pubkey>()
  const sawBuy = new Map<Pubkey, boolean>()
  const sawSell = new Map<Pubkey, boolean>()
  let probesUsed = 0

  function getCurveValue(mint: Pubkey, state: BotState): bigint {
    const pos = state.positions.get(mint)
    if (!pos) return 0n
    const curve = state.curves.get(mint)
    if (!curve || curve.complete) return 0n
    const vt = curve.virtual_token_reserves
    if (vt === 0n) return 0n
    const vq = curve.virtual_quote_reserves
    return (BigInt(pos.token_amount) * vq) / vt
  }

  function updateTapeFromEvents(state: BotState, batch: Batch): void {
    // Track creator buys in create slot for dev buy detection
    // We need to evaluate events in order. Trade events for a mint in the same slot as create
    // where user === creator are dev buys.
    
    // First pass: identify creates and mark pending dev buys if needed? 
    // Actually, the design says: "handle by checking TradeEvents whose slot equals createSlot and user === creator".
    // Since events are in order, when we see a CreateEvent, we create the tape.
    // Subsequent TradeEvents in the same batch (which likely implies same or later slot, but usually same slot in replay) 
    // can update it.

    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        if (tapes.has(ev.mint)) continue
        
        const tape: TapeEntry = {
          mint: ev.mint,
          createSlot: state.curves.get(ev.mint)?.created_slot ?? batch.slot,
          creator: ev.creator,
          vq0: BigInt(ev.virtual_sol_reserves),
          vt0: BigInt(ev.virtual_token_reserves),
          devBuyLamports: 0n,
          buyers: new Set<Pubkey>(),
          boughtLamports: 0n,
          soldByOthersLamports: 0n,
          devSold: false,
          lastTradeSlot: batch.slot,
          recentFlow: [{ slot: batch.slot, netLamports: 0n }],
          buysSent: 0,
          spentLamports: 0n,
          done: false,
          complete: false,
        }
        tapes.set(ev.mint, tape)
      } else if (ev.event === 'TradeEvent') {
        let tape = tapes.get(ev.mint)
        // If tape doesn't exist, it might be a trade on an older curve we missed the create for
        // Or it's not a "first-light" candidate. We only care about tapes we've seen Created.
        if (!tape) continue

        // Update recent flow
        const currentSlot = batch.slot
        let flowEntry = tape.recentFlow.find(f => f.slot === currentSlot)
        if (!flowEntry) {
          flowEntry = { slot: currentSlot, netLamports: 0n }
          tape.recentFlow.push(flowEntry)
        }
        
        const amt = BigInt(ev.sol_amount)
        const net = ev.is_buy ? amt : -amt
        flowEntry.netLamports += net

        // Drop older than 10 slots
        const cutoff = currentSlot - 10
        while (tape.recentFlow.length > 0 && tape.recentFlow[0].slot < cutoff) {
          tape.recentFlow.shift()
        }

        tape.lastTradeSlot = currentSlot

        // Update dev buy / sell and buyers metrics
        const isCreator = ev.user === tape.creator
        
        if (isCreator) {
          if (ev.is_buy) {
            // Dev buy
            // Only counts towards devBuyLamports if it's in the create slot? 
            // Design: "creator buys in the create slot only" for initial devBuyLamports field?
            // "devBuy (a buy by creator in the create slot)" in update section.
            // However, "creator has not sold" is a separate check.
            // If creator buys later, does it change anything? 
            // Tape has devBuyLamports. The entry test checks "devBuy within [min, max]". 
            // Usually "Dev Buy" refers to the initial liquidity provided or first buy. 
            // The prompt says: "devBuyLamports (creator buys in the create slot only)" in the state description.
            // So we only add to devBuyLamports if slot === createSlot.
            if (tape.createSlot === currentSlot) {
              tape.devBuyLamports += BigInt(ev.sol_amount)
            }
          } else {
            // Dev sold
            tape.devSold = true
          }
        } else {
          // Non-creator user
          if (ev.is_buy) {
            tape.buyers.add(ev.user)
            tape.boughtLamports += BigInt(ev.sol_amount)
          } else {
            // Sell by others
            // We don't strictly "remove" from boughtLamports because that's cumulative volume?
            // Or is boughtLamports the current virtual/real exposure added by others?
            // "boughtLamports" and "soldByOthersLamports"
            // soldByOthersLamports tracks the specific amount sold by others.
            tape.soldByOthersLamports += BigInt(ev.sol_amount)
          }
        }

        // Update reserves snapshot? The design says "TradeEvent updates reserves snapshot".
        // But we don't store reserves in Tape, we read from state.curves. 
        // The Tape doesn't have vq/vt fields other than vq0/vt0.
        // So we do nothing for reserves here, just rely on state for current price.
        
      } else if (ev.event === 'CompleteEvent') {
        const tape = tapes.get(ev.mint)
        if (tape) {
          tape.complete = true
          tape.done = true
        }
      }
    }
  }

  function reconcileHeld(state: BotState, batch: Batch): void {
    // 1. Remove held entries that are no longer in state.positions
    const mintsToKeep = new Set(state.positions.keys())
    for (const [mint, entry] of held) {
      if (!mintsToKeep.has(mint)) {
        held.delete(mint)
      }
    }

    // 2. Add held entries for new positions
    for (const [mint, pos] of state.positions) {
      if (!held.has(mint)) {
        const value = getCurveValue(mint, state)
        held.set(mint, {
          openedSlot: state.curves.get(mint)?.created_slot ?? batch.slot,
          costLamports: BigInt(pos.cost_lamports),
          bestValueLamports: value,
          lastBuySlot: batch.slot,
          isProbe: false,
        })
      }
    }
  }

  function processFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue

      fillCount++

      const mint = fill.mint
      
      if (fill.side === 'buy') {
        sawBuy.set(mint, true)
        
        const tape = tapes.get(mint)
        if (tape) {
          tape.spentLamports += BigInt(fill.quote_lamports)
          tape.buysSent++ // Incremented on send, but filling confirms it. 
                           // Actually design says "Track spentLamports and buysSent when a buy fill arrives".
                           // So we increment here.
        } else {
          // If it's a probe, we might not have a tape? 
          // Probes are bought from "tapes", so tape should exist unless we raced.
          // Or if it's a manual trade? We only generate trades.
        }

        // Update held if this is our position
        const h = held.get(mint)
        if (h) {
          // Cost is already in state.positions, but we track costLamports in held for ease?
          // Prompt says hold has costLamports. 
          // state.positions[mint].cost_lamports is the source of truth for current cost.
          // Let's update held.costLamports to match state if it changed? 
          // Usually cost increases on buy.
          h.costLamports = BigInt(state.positions.get(mint)?.cost_lamports ?? h.costLamports.toString())
          h.lastBuySlot = batch.slot
        }

      } else if (fill.side === 'sell') {
        sawSell.set(mint, true)
        
        // If we sold, and we previously saw a buy, it's a round trip
        if (sawBuy.get(mint)) {
          if (!roundTripMints.has(mint)) {
            roundTripMints.add(mint)
            roundTrippedCoins++
          }
        }
        
        // Cleared position record? 
        // "filled sells clear the position record" refers to removes from held 
        // if the position is fully sold. But state.positions handling removes it next tick.
        // We can remove from held here if state.positions no longer has it? 
        // Reconcile handles removal. But we might keep it in held for one tick. 
        // Better to let reconcile handle it.
      }
    }
  }

  function computeExits(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = []
    
    for (const [mint, entry] of held) {
      // Check if pending sell already
      let hasPendingSell = false
      for (const [, pending] of state.pending) {
        if (pending.order.mint === mint && pending.order.side === 'sell') {
          hasPendingSell = true
          break
        }
      }
      if (hasPendingSell) continue

      const pos = state.positions.get(mint)
      if (!pos) continue
      
      const curve = state.curves.get(mint)
      if (!curve || curve.complete) continue // Harness closes it

      const value = getCurveValue(mint, state)
      const cost = entry.costLamports
      
      // Update best value
      if (value > entry.bestValueLamports) {
        entry.bestValueLamports = value
      }

      // Prepare sell
      const sellOrder: OrderInput = {
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: 10000,
      }

      // Probe logic: sell whole position on the next batch after its buy fills
      // If it's a probe, and we just bought it (lastBuySlot === batch.slot - latency?) 
      // "sold whole on the next batch after its buy fills"
      // Fill has slot. If lastBuySlot is recent, sell.
      // Specifically: "mark it probe: true in held; probe sells ignore TP/SL/hold rules and sell at once".
      // So if entry.isProbe is true, we should always sell? 
      // "on the next batch after its buy fills". 
      // If we bought in slot S, fill happens S+2. We get batch S+2. Do we sell in S+2 or S+3?
      // "next batch after its buy fills" -> Batch after the fill batch. 
      // Fill batch slot is fill.slot. Batch slot is batch.slot. 
      // If fill.slot <= batch.slot, it's filled. 
      // So if entry.isProbe and value > 0n, sell it.
      
      if (entry.isProbe) {
        orders.push(sellOrder)
        held.delete(mint) // Mark as done for this batch? Reconcile will clean up next tick if position gone.
        continue
      }

      // Standard exit conditions
      const tpValue = (cost * (10000n + BigInt(p.tpBps))) / 10000n
      const trailArmValue = (cost * (10000n + BigInt(p.trailArmBps))) / 10000n
      const trailStopValue = (entry.bestValueLamports * (10000n - BigInt(p.trailBps))) / 10000n
      const slValue = (cost * (10000n - BigInt(p.slBps))) / 10000n

      let shouldExit = false
      let reason = ''

      // 1. Take Profit
      if (value >= tpValue) {
        shouldExit = true
        reason = 'tp'
      }
      // 2. Trailing Stop
      else if (entry.bestValueLamports >= trailArmValue && value <= trailStopValue) {
        shouldExit = true
        reason = 'trail'
      }
      // 3. Stop Loss
      else if (value <= slValue) {
        shouldExit = true
        reason = 'sl'
      }
      // 4. Time Exit
      else if (batch.slot - entry.openedSlot >= p.maxHoldSlots) {
        shouldExit = true
        reason = 'time'
      }
      // 5. Dev Sell Exit
      else if (p.exitOnDevSell) {
        const tape = tapes.get(mint)
        if (tape && tape.devSold) {
          shouldExit = true
          reason = 'dev'
        }
      }
      // 6. Stale Exit
      if (!shouldExit) {
        const tape = tapes.get(mint)
        if (tape) {
          const lastTrade = tape.lastTradeSlot
          if (batch.slot - lastTrade >= p.staleSlots) {
            shouldExit = true
            reason = 'stale'
          }
        }
      }

      if (shouldExit) {
        orders.push(sellOrder)
      }
    }

    return orders
  }

  function computeEntries(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = []
    
    // Iteration through tapes in insertion order
    for (const [mint, tape] of tapes) {
      // 1. Not complete, not done
      if (tape.complete || tape.done) continue
      
      // 2. No open position and no pending buy for the mint
      if (state.positions.has(mint)) continue
      let hasPendingBuy = false
      for (const [, pending] of state.pending) {
        if (pending.order.mint === mint && pending.order.side === 'buy') {
          hasPendingBuy = true
          break
        }
      }
      if (hasPendingBuy) continue

      // 3. Committed position count check
      if (state.committedPositionCount() >= p.maxMain) continue

      // 4. Total cost exposure
      let totalExposure = 0n
      for (const [, pos] of state.positions) {
        totalExposure += BigInt(pos.cost_lamports)
      }
      for (const [, pending] of state.pending) {
        if (pending.order.side === 'buy') {
          totalExposure += BigInt(pending.order.quote_lamports)
        }
      }
      if (totalExposure >= maxExposureLamports) continue

      // 5. Age check
      const age = batch.slot - tape.createSlot
      if (age >= 0 && age <= p.maxAgeSlots) {
        
        const curve = state.curves.get(mint)
        if (!curve || curve.complete) continue

        // 6. Real SOL reserve check
        const realSol = curve.real_quote_reserves
        if (realSol < minRealLamports || realSol > maxRealLamports) continue

        // 7. DevBuy check
        if (tape.devBuyLamports < minDevBuyLamports || tape.devBuyLamports > maxDevBuyLamports) continue

        // 8. Buyers check
        // Distinct non-creator buyers
        let nonCreatorBuyers = 0
        for (const buyer of tape.buyers) {
          if (buyer !== tape.creator) {
            nonCreatorBuyers++
          }
        }
        if (nonCreatorBuyers < p.minBuyers || nonCreatorBuyers > p.maxBuyers) continue

        // 9. Creator has not sold
        if (tape.devSold) continue

        // 10. soldByOthers <= bought * 1.0
        if (tape.soldByOthersLamports > tape.boughtLamports) continue

        // 11. Price run-up
        // (vq * vt0 * 10000) / (vq0 * vt) - 10000 <= maxRunupBps
        const vq = curve.virtual_quote_reserves
        const vt = curve.virtual_token_reserves
        const vq0 = tape.vq0
        const vt0 = tape.vt0

        if (vq0 === 0n || vt0 === 0n || vt === 0n || vq === 0n) continue
        
        const numerator = vq * vt0 * 10000n
        const denominator = vq0 * vt
        
        if (denominator === 0n) continue
        
        const runupBps = (numerator / denominator) - 10000n
        if (runupBps > BigInt(p.maxRunupBps)) continue

        // 12. Recent 10-slot net flow >= 0
        let netFlowSum = 0n
        for (const flow of tape.recentFlow) {
          netFlowSum += flow.netLamports
        }
        if (netFlowSum < 0n) continue

        // Passed all entry tests! Calculate size
        const availableStake = stakeLamports - tape.spentLamports
        const maxByReserve = state.maxBuyLamports(mint)
        let buySize = availableStake < maxByReserve ? availableStake : maxByReserve
        
        if (buySize < minBuyLamports) continue
        
        // Check free cash
        if (state.freeCashLamports() < buySize + state.txFeeLamports()) continue

        // Send buy
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: buySize,
          max_slippage_bps: p.buySlipBps,
        })

        tape.done = true // Never buy again? 
        // Prompt: "done boolean (never buy again)". 
        // Entry test says "no open position...". 
        // Does "done" apply immediately? Yes, "first buy only". 
        // So we mark done to prevent re-entry in subsequent batches.
      }
    }

    return orders
  }

  function computeProbe(state: BotState, batch: Batch): OrderInput | null {
    // Check pacing lag
    if (firstBatchSlot === null) return null
    
    const elapsedSecs = (batch.slot - firstBatchSlot) * 0.4
    const expectedCoins = p.targetCoins * elapsedSecs / p.paceSecs
    
    if (roundTrippedCoins >= expectedCoins) return null
    if (probesUsed >= p.maxProbes) return null
    if (state.committedPositionCount() >= 5) return null

    // Find most liquid recent curve
    // Highest real SOL reserve among tapes with:
    // - trade in last 20 slots
    // - not held (state.positions)
    // - not done
    // - not complete
    let bestMint: Pubkey | null = null
    let bestReal = 0n

    for (const [mint, tape] of tapes) {
      if (tape.done || tape.complete) continue
      if (state.positions.has(mint)) continue

      const curve = state.curves.get(mint)
      if (!curve) continue

      // Trade in last 20 slots
      if (batch.slot - tape.lastTradeSlot > 20) continue

      const realSol = curve.real_quote_reserves
      if (realSol > bestReal) {
        bestReal = realSol
        bestMint = mint
      }
    }

    if (!bestMint) return null

    // Check pending buys for this mint to avoid double ordering?
    // If there's a pending buy for this mint from entries, we might conflict.
    // Probe is a separate logic. 
    // "commitedPositionCount < 5" 
    
    const buySize = probeLamports < state.maxBuyLamports(bestMint) ? probeLamports : state.maxBuyLamports(bestMint)
    // At least 0.01 SOL
    if (buySize < 10000000n) return null 

    if (state.freeCashLamports() < buySize + state.txFeeLamports()) return null

    probesUsed++

    // Mark as probe in held? 
    // We create the order now. The fill will create the position. 
    // We need to know it's a probe when the position appears. 
    // We can just check if the mint was a probe buy candidate? 
    // Better: When we send the probe, we can't easily tag the pending order. 
    // But hold logic: "mark it probe: true in held". 
    // We can add to a set "probeMints" before sending.
    // But we don't have that set in state.
    // Alternative: In reconcileHeld, if we see a new position, how do we know if it's a probe?
    // We can check if we recently sent a probe buy for it.
    // Simplest: Keep a local set of mints probed in this batch? 
    // But probe sells happen on "next batch after fill". 
    // So we need to mark it in held when the position appears. 
    // Let's add a Set<Pubkey> activeProbes or similar to track which mints our probes correspond to.
    // Actually, we can look at the order we're about to send? 
    // No, held is checked in exits. 
    // Let's assume we can identify probe mints by checking if they are in "probedMints".
    // We need to persist this. 
    
    // Let's add a Set to the closure.
    // Wait, I didn't declare activeProbes in the closure space above. I'll assume it exists or add it.
    // Since I can't edit previous lines, I must handle this carefully.
    // I will assume I can access a shared structure. 
    // Let's just return the order. The "mark it probe" instruction implies modifying state.
    // I'll create a Set called probeMints in the outer scope if I could. 
    // Since I'm generating the file, I should have included it.
    // Let's assume I have a helper or variable.
    // For the sake of the code snippet, I'll assume I should mark it.
    // I will add a dummy line here or rely on the structure.
    // Actually, looking at my code structure, I didn't declare probeMints.
    // I will set a flag in the Tape? No.
    // I'll just return the order. The reconciliation logic in reconcileHeld doesn't set isProbe.
    // I need to modify reconcileHeld or have a way to know.
    // Given constraints, I'll assume the "held" entry creation can check if the mint was just probed.
    // But reconcile runs BEFORE exits? No, order is: 
    // 1. fills, 2. events, 3. reconcile, 4. exits, 5. entries, 6. probe.
    // So when reconcile runs, the position from *this* batch's probe hasn't filled yet (2 slots latency).
    // Next batch: Fill arrives. processFills runs. Reconcile runs (adds position). 
    // How does reconcile know it's a probe? 
    // It can't unless we stored "mint X is a probe" somewhere. 
    // I will need to add a Set<Pubkey> `activeProbeMints` to the closure.
    // I will include it in the final code.
    
    return {
      side: 'buy',
      mint: bestMint,
      quote_lamports: buySize,
      max_slippage_bps: p.buySlipBps,
    }
  }

  // Add missing state for probes
  const activeProbeMints = new Set<Pubkey>()

  // Redefine computeProbe to use activeProbeMints? 
  // No, computeProbe is defined above. I need to make it mutable or closure-captive.
  // Since function hoisting doesn't apply to const, and my computeProbe is a const arrow function? 
  // No, I used `function computeProbe`. It can access `activeProbeMints` if it's in scope.
  // `activeProbeMints` is declared below. This will fail in JS/TS strict mode due to TDZ.
  // I must reorder.

  return {
    onHello: (state) => {
      // No-op
    },
    onBatch: (state, batch) => {
      if (firstBatchSlot === null) {
        firstBatchSlot = batch.slot
      }

      // 1. Fold batch.fills
      processFills(state, batch)
      
      // 2. Update tapes
      updateTapeFromEvents(state, batch)
      
      // 3. Reconcile held
      reconcileHeld(state, batch)
      
      // Mark probes in held? 
      // If a mint is in activeProbeMints and now has a position, mark isProbe = true in held.
      for (const mint of activeProbeMints) {
        const h = held.get(mint)
        if (h) {
          h.isProbe = true
        }
      }
      // Clear activeProbeMints? 
      // "sold whole on the next batch after its buy fills". 
      // If we mark it as probe, the exit logic will handle it.
      // We should probably clear the set after marking, or keep it until sold.
      // Let's clear it after processing exits? No, exits come after.
      // Let's just clear it at the end of the batch? 
      // But next batch might need to know? No, held.isProbe is persistent.
      activeProbeMints.clear()

      // 4. Compute exits
      const exitOrders = computeExits(state, batch)
      
      // 5. Compute entries
      const entryOrders = computeEntries(state, batch)
      
      // 6. Compute probe
      let probeOrder: OrderInput | null = null
      // We need to ensure ordering logic.
      // We will handle probe order generation here or via the function.
      // The function `computeProbe` was defined above but had a TDZ issue with activeProbeMints if not careful.
      // Let's inline the probe logic or ensure activeProbeMints is defined before use.
      // I will refactor to define activeProbeMints at the top of createStrategy.
      // Since I am writing the final string, I will correct the order.

      // For now, assume I can access activeProbeMints.
      // I'll re-implement the probe selection inline to avoid closure ordering issues in the string generation.
      
      if (firstBatchSlot !== null) {
        const elapsedSecs = (batch.slot - firstBatchSlot) * 0.4
        const expectedCoins = p.targetCoins * elapsedSecs / p.paceSecs
        
        if (roundTrippedCoins < expectedCoins && probesUsed < p.maxProbes && state.committedPositionCount() < 5) {
          let bestMint: Pubkey | null = null
          let bestReal = 0n

          for (const [mint, tape] of tapes) {
            if (tape.done || tape.complete) continue
            if (state.positions.has(mint)) continue
            
            const curve = state.curves.get(mint)
            if (!curve) continue
            
            if (batch.slot - tape.lastTradeSlot > 20) continue

            const realSol = curve.real_quote_reserves
            if (realSol > bestReal) {
              bestReal = realSol
              bestMint = mint
            }
          }
          
          if (bestMint) {
            const maxByReserve = state.maxBuyLamports(bestMint)
            const buySize = probeLamports < maxByReserve ? probeLamports : maxByReserve
            
            if (buySize >= 10000000n) { // 0.01 SOL
              if (state.freeCashLamports() >= buySize + state.txFeeLamports()) {
                probesUsed++
                activeProbeMints.add(bestMint)
                probeOrder = {
                  side: 'buy',
                  mint: bestMint,
                  quote_lamports: buySize,
                  max_slippage_bps: p.buySlipBps,
                }
              }
            }
          }
        }
      }

      // 7. Return orders
      const orders: OrderInput[] = []
      
      // Exits first
      orders.push(...exitOrders)
      
      // Then entries
      if (orders.length < 16) {
        for (const order of entryOrders) {
          if (orders.length >= 16) break
          orders.push(order)
        }
      }
      
      // Then probe
      if (probeOrder && orders.length < 16) {
        orders.push(probeOrder)
      }

      return orders
    },
    onDone: () => {
      // No-op
    }
  }
}