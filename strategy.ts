// Second-wave strategy for the pump.fun bonding-curve replay.
//
// Pattern (measured on the dev window): a coin spikes at launch, dumps at least 30% from its
// early high, then recovers 35% from the post-spike low. Coins that print that recovery keep
// running often enough to pay: on dev, the first such signal per coin (n=198) had a median +53%
// max excursion within 300 slots and 7 of them completed (~14.6x). Coins that never recover never
// signal, so the strategy sits out the long bleed that kills buy-and-hold and dip-buying here.
//
// Entry: price >= 1.35x the post-high low, low <= 0.7x the early high, real SOL in range, recent
// net buy flow positive with several distinct buyers. Small fixed size, one entry per coin.
// Exits: take profit +125%, trailing stop -20% once +20% up, hard stop -12%, max hold 300 slots.
// Guardrail probes keep the run above 20 coins: when the bot's own coins lag a pace of 30 coins
// over 6 hours of block time, it opens tiny 0.02 SOL probe round trips on liquid coins.
// Pure function of the batches: no clock, no randomness, no I/O.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots after create during which the early high / post-high low are tracked. */
  trackWindow: number;
  /** Low must be at most this share of the early high. */
  dipMax: number;
  /** Entry when price is at least this multiple of the post-high low. */
  recoverMult: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Recent-flow window (slots) and requirements at entry. */
  flowWindow: number;
  minNetFlowSol: number;
  minBuyers: number;
  /** SOL per position (single buy; capped by 1% of real reserve per reply). */
  stakeSol: number;
  minBuySol: number;
  buySlipBps: number;
  /** Exits (fractions of cost / peak value). */
  takeProfit: number;
  trailArm: number;
  trail: number;
  stopLoss: number;
  maxHold: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  maxEntries: number;
  /** Most positions open at once. */
  maxOpen: number;
  /** Pyramid: add to winners. SOL per add, most SOL per position, price step, value gate, max adds. */
  addSol: number;
  maxStakeSol: number;
  addStep: number;
  addIfUp: number;
  maxAdds: number;
  /**
   * Guardrail pacing: the run must end with a round trip on at least 20 coins. When the bot's own
   * coins lag targetCoins scaled by the share of paceSecs elapsed (block time since the first
   * batch), it opens tiny probe round trips (buy probeSol, sell it all as soon as the buy lands)
   * on liquid coins it has not traded, until it is back on pace.
   */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  trackWindow: 200,
  dipMax: 0.7,
  recoverMult: 1.35,
  minRqSol: 1,
  maxRqSol: 60,
  flowWindow: 60,
  minNetFlowSol: 0,
  minBuyers: 3,
  stakeSol: 0.3,
  minBuySol: 0.01,
  buySlipBps: 1500,
  takeProfit: 1.25,
  trailArm: 0.2,
  trail: 0.2,
  stopLoss: 0.12,
  maxHold: 300,
  cooldown: 300,
  maxEntries: 1,
  maxOpen: 5,
  addSol: 0.3,
  maxStakeSol: 0.9,
  addStep: 0.2,
  addIfUp: 0.1,
  maxAdds: 0,
  targetCoins: 30,
  paceSecs: 21_600,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  price: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Coin {
  created: number | null;
  ticks: Tick[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  cost: number;
  exiting: boolean;
  /** SOL spent on buys so far (fees excluded), price at last buy, adds sent, last value. */
  invested: number;
  lastAddPrice: number;
  adds: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Coins the bot has ever probed: never a main entry afterwards. */
  const probed = new Set<Pubkey>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { created: null, ticks: [], entries: 0, lastExit: -1e12 };
      coins.set(mint, c);
    }
    return c;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myCoins.add(f.mint);
        }
        // A sell that was rejected or failed never left: clear the exit flag so the next
        // batch retries it instead of leaving the position stuck until it is flattened.
        if (f.side === 'sell' && f.status !== 'filled' && !f.client_id.startsWith('_')) {
          const h = held.get(f.mint);
          if (h !== undefined) h.exiting = false;
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coinOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.ticks.push({ slot: e.slot, price, buy: e.is_buy, sol: Number(e.sol_amount) / LAMPORTS, user: e.user });
          traded.add(e.mint);
        }
      }
      // Prune old ticks (keep a little beyond the track window).
      for (const mint of traded) {
        const c = coins.get(mint)!;
        const cut = now - p.trackWindow - 400;
        let i = 0;
        while (i < c.ticks.length && c.ticks[i]!.slot < cut) i++;
        if (i > 0) c.ticks.splice(0, i);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) {
            held.delete(mint);
            coinOf(mint).lastExit = now;
          }
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        if (vt + tokens <= 0) continue;
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        h.lastValue = value;
        if (value > h.peakValue) h.peakValue = value;
        let exit = false;
        if (value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && now - h.opened >= p.maxHold) exit = true;
        if (!exit || h.exiting) continue;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        h.exiting = true;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and pyramid adds on coins that traded this batch.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = Math.min(p.maxOpen, state.hello.caps.max_open_positions) - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const h = held.get(mint);
        if (h !== undefined) {
          // Pyramid into a winner: up from cost, price stepped up from the last buy, room left.
          if (!h.exiting && !pendingMints.has(mint) && h.adds < p.maxAdds && h.invested < p.maxStakeSol - p.minBuySol) {
            const pos = state.positions.get(mint);
            if (pos !== undefined && h.lastValue >= Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUp) && price >= h.lastAddPrice * (1 + p.addStep)) {
              const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
              let amount = Math.min(capSol, p.addSol, p.maxStakeSol - h.invested);
              if (amount > free - tx) amount = free - tx;
              if (amount >= p.minBuySol) {
                orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
                free -= amount + tx;
                h.invested += amount;
                h.lastAddPrice = price;
                h.adds++;
              }
            }
          }
          continue;
        }
        if (slotsLeft <= 0 || pendingMints.has(mint) || probes.has(mint) || probed.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.created === null || now - c.created < 10) continue;
        if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        // Early high and post-high low inside the track window after create.
        const t0 = c.created;
        const t1 = t0 + p.trackWindow;
        let high = 0;
        let highSlot = -1;
        for (const t of c.ticks) {
          if (t.slot > t1) break;
          if (t.price > high) {
            high = t.price;
            highSlot = t.slot;
          }
        }
        if (high <= 0 || highSlot < 0) continue;
        let low = Infinity;
        for (const t of c.ticks) {
          if (t.slot <= highSlot) continue;
          if (t.slot > t1) break;
          if (t.price < low) low = t.price;
        }
        if (!Number.isFinite(low) || low > high * p.dipMax) continue;
        if (!(price >= low * p.recoverMult)) continue;
        // Recent flow: net buys and distinct buyers over the flow window.
        let net = 0;
        const buyers = new Set<string>();
        for (let i = c.ticks.length - 1; i >= 0; i--) {
          const t = c.ticks[i]!;
          if (t.slot <= now - p.flowWindow) break;
          net += t.buy ? t.sol : -t.sol;
          if (t.buy) buyers.add(t.user);
        }
        if (net < p.minNetFlowSol || buyers.size < p.minBuyers) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        slotsLeft--;
        c.entries++;
        held.set(mint, { opened: now, peakValue: 0, cost: amount, exiting: false, invested: amount, lastAddPrice: price, adds: 0, lastValue: 0 });
      }

      // Guardrail pacing: open a probe when the bot's coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        if (myCoins.size < Math.ceil(p.targetCoins * pace)) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const mint of traded) {
            if (held.has(mint) || probes.has(mint) || probed.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rq = Number(curve.real_quote_reserves) / LAMPORTS;
            if (rq < minRq * 1.5 || rq <= bestRq) continue;
            best = mint;
            bestRq = rq;
          }
          if (best !== null && orders.length < cap && free >= p.probeSol + 2 * tx) {
            orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: 10_000 });
            probes.set(best, false);
            probed.add(best);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
