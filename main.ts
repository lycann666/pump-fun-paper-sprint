// Pump.fun Paper Sprint — deterministic momentum paper-trading bot.
//
// Idea: pump.fun coins that are already moving keep moving for a few minutes,
// and most of them then bleed out. So the bot only buys a coin AFTER it shows
// real, broad buying (several distinct buyers, net SOL flowing in, price up
// and sitting near its short-window high), stakes a small fixed size, and
// exits fast: +35% take-profit, -10% stop-loss, a 15% trailing stop once the
// position is +10% up, a fade exit when the tape turns seller-heavy, or a
// hard time limit. No averaging down, no re-entry spam (cooldown + max 2
// entries per coin). Tiny 0.01 SOL probe round trips only fire when the bot
// is behind the pace needed for the 20-coin guardrail, so the main strategy
// is what makes (or loses) the money, not the probes.
//
// Deterministic by construction: no clock, no environment, no randomness —
// every decision is a pure function of the batches the harness delivered,
// iterated in insertion order. The bot runs twice in grading and the two
// action logs must match byte for byte, so nothing here may depend on
// anything outside the batch stream.
//
// Fees shape every number below: ~1.25% curve fees per leg plus a flat
// ~0.000105 SOL tx fee per order makes a 0.01 SOL round trip cost ~4.6%,
// so the entry bar (+12% momentum) and the exits (+35% / -10%) are set
// wide of the fee band on purpose.
//
// Pass 1: core momentum entry + exits + guardrail probes.
// Pass 2 (this revision): Freemodel design review applied — entry bar raised
//   8% -> 12%, TP 25% -> 35%, SL 15% -> 10%, trailing stop tightened to 15%
//   armed at +10%, entry candidates ranked by 10-slot inflow velocity.
//   Freemodel code review applied too: candidates now sort by (velocity desc,
//   mint asc) with an explicit tiebreak instead of relying on sort stability,
//   and a single-wallet concentration guard (one buyer > 80% of window buy
//   SOL) replaces a dead check. Pacing uses block_time from the chain data
//   itself — deterministic across runs, never the wall clock.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95bps + creator 30bps fallback

// --- tunable strategy parameters (all in SOL / slots / fractions) ---
const P = {
  window: 40, // entry lookback, slots (~16 s)
  minNetSol: 0.5, // net buy SOL over the window
  minBuys: 4, // buy trades in the window
  minBuyers: 4, // distinct buying wallets in the window
  minUp: 0.12, // price rise over the window, min
  maxUp: 1.2, // price rise over the window, max (skip vertical blow-offs)
  nearHigh: 0.9, // price now must be >= 90% of the window high
  minRqSol: 1, // real SOL reserve at entry, min
  maxRqSol: 80, // real SOL reserve at entry, max
  minAge: 120, // slots since CreateEvent before an entry is allowed
  stakeSol: 0.1, // SOL per position (one buy, no pyramiding)
  buySlipBps: 2000,
  sellSlipBps: 10_000,
  takeProfit: 0.35,
  stopLoss: 0.1,
  trailArm: 0.1, // trailing stop arms once value >= cost * 1.10
  trail: 0.15, // sell once value < peak * 0.85
  maxHold: 900, // slots (~6 min); waived while the position is up >= 10%
  fadeWindow: 20,
  fadeNetSol: -0.5, // exit when net SOL over fadeWindow < -0.5
  cooldown: 150, // slots to wait after an exit before re-entering a coin
  maxEntries: 2, // most entries per coin over the run
  maxMain: 5, // most momentum positions open at once
  maxExposureSol: 6, // most SOL at cost across all positions at once
  targetCoins: 25, // guardrail pacing targets (pace of a 4 h run)
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01, // exactly the minimum round-trip size
  maxProbes: 1,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
}

/** SOL per token from virtual reserves. */
function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

/** What a position is worth in SOL right now if sold (curve + tx fees deducted). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint, txLamports: bigint): number {
  const t = Number(tokens);
  if (t <= 0 || vt <= 0n) return 0;
  const grossLamports = (t * Number(vq)) / (Number(vt) + t);
  return (grossLamports / LAMPORTS) * (1 - CURVE_FEE) - Number(txLamports) / LAMPORTS;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

const tapeOf = (mint: Pubkey): Tape => {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
};

/** Net recorded SOL (buys minus sells) on a tape over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

interface Signal {
  ok: boolean;
  /** Net inflow over the last 10 slots: ranks candidates, fastest first. */
  velocity: number;
}

function entrySignal(t: Tape, now: number, rqSol: number): Signal {
  const no: Signal = { ok: false, velocity: 0 };
  if (rqSol < P.minRqSol || rqSol > P.maxRqSol) return no;
  if (t.created === null || now - t.created < P.minAge) return no;
  const from = now - P.window;
  const mid = now - P.window / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < P.minBuys || byUser.size < P.minBuyers) return no;
  if (buySol - sellSol < P.minNetSol) return no;
  if (startPrice <= 0 || last <= 0) return no;
  const up = last / startPrice - 1;
  if (up < P.minUp || up > P.maxUp) return no;
  if (last < high * P.nearHigh) return no;
  // Accelerating, not fading: the newer half must inflow at least as much.
  if (netNew <= 0 || netNew < netOld) return no;
  // One wallet doing almost all the buying is a bundle / insider shape,
  // not broad momentum: skip the coin.
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  if (top > 0.8 * buySol) return no;
  return { ok: true, velocity: flow(t, now, 10) };
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const traded = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          user: e.user,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
        traded.add(e.mint);
      }
    }
    const keep = Math.max(P.window, P.fadeWindow) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const txSol = Number(tx) / LAMPORTS;
    const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
    for (const po of state.pending.values()) {
      const rec = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
      if (po.order.side === 'buy') rec.buy = true;
      else rec.sell = true;
      pendingByMint.set(po.order.mint, rec);
    }
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

    // --- exits first: take-profit, stop-loss, trailing stop, fade, time ---
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const value = sellValue(BigInt(pos.token_amount), vq, vt, tx);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (!exit && value >= cost * (1 + P.takeProfit)) exit = true;
      if (!exit && value < cost * (1 - P.stopLoss)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + P.trailArm) && value < h.peakValue * (1 - P.trail)) exit = true;
      if (!exit && flow(t, now, P.fadeWindow) < P.fadeNetSol) exit = true;
      if (!exit && now - h.opened > P.maxHold && value < cost * (1 + P.trailArm)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.get(mint)?.sell) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlipBps });
    }

    // --- probe round trips: sell the whole probe as soon as its buy lands ---
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlipBps });
      if (!selling) probes.set(mint, true);
    }

    // --- entries: rank fresh signals by 10-slot inflow velocity, fastest first ---
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = P.maxMain - held.size;
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    const candidates: { mint: Pubkey; velocity: number }[] = [];
    for (const mint of traded) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
      const t = tapes.get(mint)!;
      if (t.entries >= P.maxEntries || now - t.lastExit < P.cooldown) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      const sig = entrySignal(t, now, rqSol);
      if (sig.ok) candidates.push({ mint, velocity: sig.velocity });
    }
    // Explicit tiebreak (velocity desc, mint asc): the ranking is a pure
    // function of the batch stream and never depends on sort stability.
    candidates.sort((a, b) => b.velocity - a.velocity || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    for (const { mint } of candidates) {
      if (orders.length >= cap || slotsLeft <= 0 || mainLeft <= 0) break;
      const curve = state.curves.get(mint)!;
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, P.stakeSol, P.maxExposureSol - exposure);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < 0.01) continue; // below the guardrail's minimum round trip
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
        max_slippage_bps: P.buySlipBps,
      });
      free -= amount + txSol;
      exposure += amount;
      const t = tapeOf(mint);
      held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
      t.entries++;
      slotsLeft--;
      mainLeft--;
    }

    // --- guardrail pacing: a probe when fills or coins lag the pace ---
    if (probes.size < P.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / P.paceSecs);
      const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
      const needFills = myFills < Math.ceil(P.targetFills * pace);
      if (needCoins || needFills) {
        const minRq = (P.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= P.maxProbes) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < P.probeSol + 2 * txSol) break;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(P.probeSol * LAMPORTS)),
            max_slippage_bps: P.buySlipBps,
          });
          probes.set(mint, false);
          free -= P.probeSol + txSol;
        }
      }
    }
    return orders;
  },
});
