// Daily loop: login streak, daily quests, lucky money bag, titles.
import { baseIncomePerSecond, grantBoost } from './engine.ts';
import type { GameData, GameState, Result } from './types.ts';

export const dayOf = (now: number) => Math.floor(now / 86_400_000);

/** Adds money as earnings (counts toward stars and the ranking). */
export function credit(state: GameState, amount: number): GameState {
  return {
    ...state,
    cash: state.cash + amount,
    runEarned: state.runEarned + amount,
    lifetimeEarned: state.lifetimeEarned + amount,
  };
}

/** A reward that scales with the player: some minutes of income, never less than `min`. */
export function scaledReward(state: GameState, data: GameData, seconds: number, min: number): number {
  return Math.floor(Math.max(min, baseIncomePerSecond(state, data) * seconds));
}

/** Resets the per-day counters when a new UTC day has started. */
export function ensureDay(state: GameState, now: number): GameState {
  const today = dayOf(now);
  if (state.qDay === today) return state;
  return { ...state, qDay: today, qTaps: 0, qBuys: 0, qAds: 0, qBag: 0, qDone: 0 };
}

// ---- Login streak (7-day chest) ---------------------------------------------
/** [minutes of income, minimum cash] for day 1..7. Day 7 also gives an hour of x2. */
export const STREAK = [
  [10, 300],
  [15, 500],
  [25, 800],
  [40, 1200],
  [60, 2000],
  [90, 3000],
  [120, 5000],
] as const;
export const STREAK_BOOST_MS = 60 * 60_000;

/** Day number shown today: 0 if the streak is broken or never started. */
export function streakShown(state: GameState, now: number): number {
  const today = dayOf(now);
  if (state.streakLast === today || state.streakLast === today - 1) return state.streakCount;
  return 0;
}

export function claimStreak(state: GameState, data: GameData, now: number): Result<{ day: number; cash: number; boostMinutes: number }> {
  const today = dayOf(now);
  if (state.streakLast === today) return { ok: false, error: 'not_ready' };
  const day = state.streakLast === today - 1 ? (state.streakCount % 7) + 1 : 1;
  const [minutes, min] = STREAK[day - 1];
  const cash = scaledReward(state, data, minutes * 60, min);
  let next = { ...credit(ensureDay(state, now), cash), streakLast: today, streakCount: day, doubleCash: cash };
  if (day === 7) next = grantBoost(next, now, STREAK_BOOST_MS);
  return { ok: true, state: next, day, cash, boostMinutes: day === 7 ? 60 : 0 };
}

// ---- Daily quests -----------------------------------------------------------
export const QUESTS = [
  { id: 'tap', target: 300 },
  { id: 'buy', target: 10 },
  { id: 'ad', target: 1 },
  { id: 'bag', target: 1 },
] as const;
export type QuestId = (typeof QUESTS)[number]['id'];

export function questProgress(state: GameState, id: QuestId): number {
  return { tap: state.qTaps, buy: state.qBuys, ad: state.qAds, bag: state.qBag }[id];
}

const QUEST_BIT = (i: number) => 1 << i;
const CHEST_BIT = 1 << QUESTS.length;

export function claimQuest(state: GameState, data: GameData, id: string, now: number): Result<{ cash: number; boostMinutes: number }> {
  const s = ensureDay(state, now);
  if (id === 'chest') {
    const all = QUESTS.every((_, i) => s.qDone & QUEST_BIT(i));
    if (!all || s.qDone & CHEST_BIT) return { ok: false, error: 'not_ready' };
    const cash = scaledReward(s, data, 3600, 3000);
    const next = grantBoost({ ...credit(s, cash), qDone: s.qDone | CHEST_BIT, doubleCash: cash }, now, 30 * 60_000);
    return { ok: true, state: next, cash, boostMinutes: 30 };
  }
  const i = QUESTS.findIndex((q) => q.id === id);
  if (i < 0) return { ok: false, error: 'not_ready' };
  if (s.qDone & QUEST_BIT(i)) return { ok: false, error: 'not_ready' };
  if (questProgress(s, QUESTS[i].id) < QUESTS[i].target) return { ok: false, error: 'not_ready' };
  const cash = scaledReward(s, data, 900, 500);
  return { ok: true, state: { ...credit(s, cash), qDone: s.qDone | QUEST_BIT(i), doubleCash: cash }, cash, boostMinutes: 0 };
}

export const noteTaps = (s: GameState, n: number, now: number): GameState => {
  const d = ensureDay(s, now);
  return n > 0 ? { ...d, qTaps: d.qTaps + n } : d;
};
export const noteBuys = (s: GameState, levels: number, now: number): GameState => {
  const d = ensureDay(s, now);
  return levels > 0 ? { ...d, qBuys: d.qBuys + levels } : d;
};

// ---- Lucky money bag ---------------------------------------------------------
export const BAG_INTERVAL_MS = 30 * 60_000;
export const bagReady = (s: GameState, now: number) => now - s.bagAt >= BAG_INTERVAL_MS;

export function claimBag(state: GameState, data: GameData, now: number): Result<{ cash: number }> {
  if (!bagReady(state, now)) return { ok: false, error: 'not_ready' };
  const s = ensureDay(state, now);
  const cash = scaledReward(s, data, 180, 300);
  return { ok: true, state: { ...credit(s, cash), bagAt: now, qBag: s.qBag + 1, doubleCash: cash }, cash };
}

// ---- Titles -------------------------------------------------------------------
/** [from prestige level, title]. The ladder climbs with every inheritance and "عمدة" is the top. */
export const TITLES: readonly (readonly [number, string])[] = [
  [0, 'فلاح'],
  [1, 'معلم'],
  [2, 'أفندي'],
  [3, 'بيه'],
  [4, 'باشا'],
  [6, 'شيخ البلد'],
  [8, 'عمدة'],
];
export function titleFor(level: number): string {
  let t = TITLES[0][1];
  for (const [from, name] of TITLES) if (level >= from) t = name;
  return t;
}
