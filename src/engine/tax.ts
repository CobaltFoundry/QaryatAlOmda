// "جابي الضرايب": now and then a collector visits. The player pays a small fee and gets a lucky bag
// that is ALWAYS worth more than the fee, so it feels like a gamble that can only help.
import { baseIncomePerSecond } from './engine.ts';
import { credit } from './daily.ts';
import type { GameData, GameState, Result } from './types.ts';

export const TAX_GAP_MS = 60 * 60_000; // quiet time after a visit
export const TAX_TTL_MS = 15 * 60_000; // an offer waits this long
export const TAX_MIN_CASH = 200; // no visit until the player has something
/** [chance, multiplier of the fee]. Expected value ~2x the fee, never below 1.2x. */
export const TAX_MULTS: readonly (readonly [number, number])[] = [
  [0.55, 1.2],
  [0.35, 2],
  [0.09, 5],
  [0.01, 20],
];

export const taxOpen = (s: GameState, now: number) => s.taxCost > 0 && now < s.taxExp;

function roll(rand: () => number): number {
  let r = rand();
  for (const [p, m] of TAX_MULTS) {
    if (r < p) return m;
    r -= p;
  }
  return TAX_MULTS[0][1];
}

/** Called on sync: opens a new visit when it is time. The fee is 5% of cash, between 50 and 5 minutes of income. */
export function maybeOfferTax(state: GameState, data: GameData, now: number, rand: () => number): GameState {
  if (taxOpen(state, now) || now < state.taxNextAt || state.cash < TAX_MIN_CASH) return state;
  const cap = Math.max(50, Math.floor(baseIncomePerSecond(state, data) * 300));
  const cost = Math.max(50, Math.min(Math.floor(state.cash * 0.05), cap));
  if (cost > state.cash) return state;
  return { ...state, taxCost: cost, taxMult: roll(rand), taxExp: now + TAX_TTL_MS };
}

const closed = (s: GameState, now: number): GameState => ({ ...s, taxCost: 0, taxMult: 0, taxExp: 0, taxNextAt: now + TAX_GAP_MS });

export function payTax(state: GameState, now: number): Result<{ cost: number; bag: number; mult: number }> {
  if (!taxOpen(state, now)) return { ok: false, error: 'not_ready' };
  if (state.cash < state.taxCost) return { ok: false, error: 'not_enough_cash' };
  const cost = state.taxCost;
  const mult = state.taxMult;
  const bag = Math.floor(cost * mult);
  // The fee is spent (not an "earning"); the bag counts as earned income.
  const paid: GameState = { ...state, cash: state.cash - cost };
  return { ok: true, state: { ...closed(credit(paid, bag), now), doubleCash: bag }, cost, bag, mult };
}

export function dodgeTax(state: GameState, now: number): Result {
  if (!taxOpen(state, now)) return { ok: false, error: 'not_ready' };
  return { ok: true, state: closed(state, now) };
}
