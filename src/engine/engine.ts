import type {
  AssetDef,
  GameData,
  GameState,
  PrestigeUpgradeDef,
  Result,
  UpgradeDef,
} from './types.ts';

// ---- Tunable constants (balancing happens here) -----------------------------
export const BASE_OFFLINE_HOURS = 2;
export const MAX_TAPS_PER_SECOND = 15;
export const TAP_BURST_ALLOWANCE = 10;
export const PRESTIGE_MIN_EARNED = 1e9;
export const PRESTIGE_THRESHOLD_GROWTH = 2.5;
export const STAR_BONUS_PER_STAR = 0.5; // applied to sqrt(lifetimeStars): diminishing returns
export const BOOST_MULTIPLIER = 2;
export const MAX_BUY_QTY = 1000;
/** A tap batch is judged against at most this many seconds of elapsed time (no banking taps). */
export const TAP_WINDOW_CAP_SECONDS = 30;
export const BOOST_DURATION_MS = 30 * 60 * 1000;
export const BOOST_MAX_STACK_MS = 4 * 3600 * 1000;
export const DAILY_BOOST_LIMIT = 10;

// ---- State ------------------------------------------------------------------
export function newState(now: number): GameState {
  return {
    cash: 0,
    runEarned: 0,
    lifetimeEarned: 0,
    assetLevels: {},
    upgrades: [],
    prestigeLevel: 0,
    stars: 0,
    lifetimeStars: 0,
    prestigeUpgrades: {},
    taps: 0,
    lastSeen: now,
    lastTapAt: now,
    boostUntil: 0,
    boostDay: 0,
    boostClaims: 0,
    lifetimeAds: 0,
    lastAdAt: 0,
    ticketId: '',
    ticketKind: '',
    ticketAt: 0,
    doubleCash: 0,
    streakLast: 0,
    streakCount: 0,
    qDay: 0,
    qTaps: 0,
    qBuys: 0,
    qAds: 0,
    qBag: 0,
    qDone: 0,
    bagAt: 0,
  };
}

export function assetLevel(state: GameState, assetId: number): number {
  return state.assetLevels[String(assetId)] ?? 0;
}

function prestigeUpgradeLevel(state: GameState, id: string): number {
  return state.prestigeUpgrades[id] ?? 0;
}

function ownedUpgrades(state: GameState, data: GameData): UpgradeDef[] {
  return data.upgrades.filter((u) => state.upgrades.includes(u.id));
}

// ---- Costs ------------------------------------------------------------------
/** Cost of buying `qty` levels of an asset starting from `level`. */
export function assetCost(asset: AssetDef, level: number, qty = 1): number {
  const first = asset.baseCost * asset.costGrowth ** level;
  const g = asset.costGrowth;
  if (g === 1) return Math.ceil(first * qty);
  return Math.ceil((first * (g ** qty - 1)) / (g - 1));
}

/** Largest qty (<= MAX_BUY_QTY) affordable with `cash`. */
export function maxAffordable(asset: AssetDef, level: number, cash: number): number {
  if (cash < assetCost(asset, level, 1)) return 0;
  const g = asset.costGrowth;
  const first = asset.baseCost * g ** level;
  let n = g === 1 ? Math.floor(cash / first) : Math.floor(Math.log(1 + (cash * (g - 1)) / first) / Math.log(g));
  n = Math.max(0, Math.min(n, MAX_BUY_QTY));
  while (n < MAX_BUY_QTY && assetCost(asset, level, n + 1) <= cash) n++;
  while (n > 0 && assetCost(asset, level, n) > cash) n--;
  return n;
}

export function isAssetUnlocked(state: GameState, asset: AssetDef): boolean {
  if (state.prestigeLevel < asset.unlockPrestige) return false;
  return asset.requiresAssetId === 0 || assetLevel(state, asset.requiresAssetId) > 0;
}

// ---- Income and taps --------------------------------------------------------
export function incomeMultiplier(state: GameState, data: GameData): number {
  let m = 1 + STAR_BONUS_PER_STAR * Math.sqrt(state.lifetimeStars);
  for (const u of ownedUpgrades(state, data)) {
    if (u.type === 'income_mult' && u.targetAssetId === 0) m *= u.value;
  }
  for (const p of data.prestigeUpgrades) {
    if (p.type === 'income_mult') m *= (1 + p.valuePerLevel) ** prestigeUpgradeLevel(state, p.id);
  }
  return m;
}

/** Income per second contributed by one asset, multipliers included, boost excluded. */
export function assetIncomePerSecond(state: GameState, data: GameData, assetId: number): number {
  const asset = data.assets.find((a) => a.id === assetId);
  if (!asset) return 0;
  const lvl = assetLevel(state, asset.id);
  if (lvl <= 0) return 0;
  let mult = 1;
  for (const u of ownedUpgrades(state, data)) {
    if (u.type === 'income_mult' && u.targetAssetId === asset.id) mult *= u.value;
  }
  return asset.baseIncome * lvl * mult * incomeMultiplier(state, data);
}

/** Income per second ignoring the temporary boost. */
export function baseIncomePerSecond(state: GameState, data: GameData): number {
  const perAsset = ownedUpgrades(state, data).filter((u) => u.type === 'income_mult' && u.targetAssetId !== 0);
  let sum = 0;
  for (const asset of data.assets) {
    const lvl = assetLevel(state, asset.id);
    if (lvl <= 0) continue;
    let mult = 1;
    for (const u of perAsset) if (u.targetAssetId === asset.id) mult *= u.value;
    sum += asset.baseIncome * lvl * mult;
  }
  return sum * incomeMultiplier(state, data);
}

/** Income per second as the player sees it right now (boost included). */
export function incomePerSecond(state: GameState, data: GameData, now: number): number {
  return baseIncomePerSecond(state, data) * (now < state.boostUntil ? BOOST_MULTIPLIER : 1);
}

export function tapPower(state: GameState, data: GameData): number {
  let power = 1;
  for (const asset of data.assets) power += asset.tapBonus * assetLevel(state, asset.id);
  for (const u of ownedUpgrades(state, data)) if (u.type === 'tap_mult') power *= u.value;
  for (const p of data.prestigeUpgrades) {
    if (p.type === 'tap_mult') power *= (1 + p.valuePerLevel) ** prestigeUpgradeLevel(state, p.id);
  }
  return power;
}

export function offlineCapSeconds(state: GameState, data: GameData): number {
  let hours = BASE_OFFLINE_HOURS;
  for (const u of ownedUpgrades(state, data)) if (u.type === 'offline_hours') hours += u.value;
  for (const p of data.prestigeUpgrades) {
    if (p.type === 'offline_hours') hours += p.valuePerLevel * prestigeUpgradeLevel(state, p.id);
  }
  return hours * 3600;
}

// ---- Time: credit idle income ----------------------------------------------
export interface AccrueResult {
  state: GameState;
  earned: number;
  secondsElapsed: number;
  secondsCredited: number;
  capped: boolean;
}

/**
 * Credit income for the time since `lastSeen`, limited by the offline cap.
 * Run this first on every server request. A clock that moves backwards
 * credits nothing and never moves lastSeen back.
 */
export function accrue(state: GameState, data: GameData, now: number): AccrueResult {
  const secondsElapsed = Math.max(0, (now - state.lastSeen) / 1000);
  const cap = offlineCapSeconds(state, data);
  const secondsCredited = Math.min(secondsElapsed, cap);

  const windowEnd = state.lastSeen + secondsCredited * 1000;
  const boostedSeconds = Math.max(0, Math.min(windowEnd, state.boostUntil) - state.lastSeen) / 1000;
  const earned = baseIncomePerSecond(state, data) * (secondsCredited + boostedSeconds * (BOOST_MULTIPLIER - 1));

  return {
    state: {
      ...state,
      cash: state.cash + earned,
      runEarned: state.runEarned + earned,
      lifetimeEarned: state.lifetimeEarned + earned,
      lastSeen: Math.max(now, state.lastSeen),
    },
    earned,
    secondsElapsed,
    secondsCredited,
    capped: secondsElapsed > cap,
  };
}

export function grantBoost(state: GameState, now: number, durationMs: number): GameState {
  return { ...state, boostUntil: Math.max(now, state.boostUntil) + durationMs };
}

/**
 * Reward for watching an ad or an invite: +30 minutes of x2 income.
 * Limited per UTC day, and the stack never exceeds 4 hours ahead.
 * The server cannot verify an ad was watched yet, so the daily limit is the guard.
 */
export function claimBoost(state: GameState, now: number): Result<{ boostUntil: number }> {
  const day = Math.floor(now / 86_400_000);
  const claims = state.boostDay === day ? state.boostClaims : 0;
  if (claims >= DAILY_BOOST_LIMIT) return { ok: false, error: 'limit' };
  const until = Math.min(Math.max(now, state.boostUntil) + BOOST_DURATION_MS, now + BOOST_MAX_STACK_MS);
  return { ok: true, boostUntil: until, state: { ...state, boostUntil: until, boostDay: day, boostClaims: claims + 1 } };
}

// ---- Taps -------------------------------------------------------------------
export interface TapResult {
  state: GameState;
  accepted: number;
  gained: number;
}

/**
 * The Mini App batches taps and sends a count. The server accepts only what a
 * human could plausibly have tapped since the last batch. Call accrue() first.
 */
export function applyTaps(state: GameState, data: GameData, now: number, count: number): TapResult {
  const requested = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const seconds = Math.min(TAP_WINDOW_CAP_SECONDS, Math.max(0, now - state.lastTapAt) / 1000);
  const allowed = Math.floor(seconds * MAX_TAPS_PER_SECOND) + TAP_BURST_ALLOWANCE;
  const accepted = Math.min(requested, allowed);
  if (accepted === 0) return { state, accepted: 0, gained: 0 };

  const gained = accepted * tapPower(state, data);
  return {
    state: {
      ...state,
      cash: state.cash + gained,
      runEarned: state.runEarned + gained,
      lifetimeEarned: state.lifetimeEarned + gained,
      taps: state.taps + accepted,
      lastTapAt: Math.max(now, state.lastTapAt),
    },
    accepted,
    gained,
  };
}

// ---- Purchases --------------------------------------------------------------
export function buyAsset(state: GameState, data: GameData, assetId: number, qty = 1): Result<{ cost: number; qty: number }> {
  const asset = data.assets.find((a) => a.id === assetId);
  if (!asset) return { ok: false, error: 'unknown_asset' };
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_BUY_QTY) return { ok: false, error: 'bad_quantity' };
  if (!isAssetUnlocked(state, asset)) return { ok: false, error: 'locked' };

  const level = assetLevel(state, asset.id);
  const cost = assetCost(asset, level, qty);
  if (state.cash < cost) return { ok: false, error: 'not_enough_cash' };

  return {
    ok: true,
    cost,
    qty,
    state: {
      ...state,
      cash: state.cash - cost,
      assetLevels: { ...state.assetLevels, [String(asset.id)]: level + qty },
    },
  };
}

export function buyUpgrade(state: GameState, data: GameData, upgradeId: string): Result<{ cost: number }> {
  const upgrade = data.upgrades.find((u) => u.id === upgradeId);
  if (!upgrade) return { ok: false, error: 'unknown_upgrade' };
  if (state.upgrades.includes(upgrade.id)) return { ok: false, error: 'already_owned' };
  if (upgrade.requiresAssetId !== 0 && assetLevel(state, upgrade.requiresAssetId) < upgrade.requiresLevel) {
    return { ok: false, error: 'locked' };
  }
  if (state.cash < upgrade.cost) return { ok: false, error: 'not_enough_cash' };

  return {
    ok: true,
    cost: upgrade.cost,
    state: { ...state, cash: state.cash - upgrade.cost, upgrades: [...state.upgrades, upgrade.id] },
  };
}

// ---- Prestige ("التوريث") ---------------------------------------------------
/** Each inheritance raises the bar: the next run must earn more before it pays out. */
export function prestigeMinEarned(state: GameState): number {
  return PRESTIGE_MIN_EARNED * PRESTIGE_THRESHOLD_GROWTH ** state.prestigeLevel;
}
export function prestigeStarsGain(state: GameState): number {
  const min = prestigeMinEarned(state);
  if (state.runEarned < min) return 0;
  return Math.floor(Math.cbrt(state.runEarned / min));
}

export function prestigeUpgradeCost(def: PrestigeUpgradeDef, currentLevel: number): number {
  return Math.ceil(def.starCost * def.starCostGrowth ** currentLevel);
}

export function startingCash(state: GameState, data: GameData): number {
  let cash = 0;
  for (const p of data.prestigeUpgrades) {
    if (p.type === 'start_cash') cash += p.valuePerLevel * prestigeUpgradeLevel(state, p.id);
  }
  return cash;
}

export function doPrestige(state: GameState, data: GameData, now: number): Result<{ starsGained: number }> {
  const starsGained = prestigeStarsGain(state);
  if (starsGained < 1) return { ok: false, error: 'not_ready' };

  const next: GameState = {
    ...state,
    cash: 0,
    runEarned: 0,
    assetLevels: {},
    upgrades: [],
    prestigeLevel: state.prestigeLevel + 1,
    stars: state.stars + starsGained,
    lifetimeStars: state.lifetimeStars + starsGained,
    lastSeen: Math.max(now, state.lastSeen),
  };
  next.cash = startingCash(next, data);
  return { ok: true, starsGained, state: next };
}

export function buyPrestigeUpgrade(state: GameState, data: GameData, id: string): Result<{ cost: number }> {
  const def = data.prestigeUpgrades.find((p) => p.id === id);
  if (!def) return { ok: false, error: 'unknown_upgrade' };

  const level = prestigeUpgradeLevel(state, id);
  if (level >= def.maxLevel) return { ok: false, error: 'max_level' };

  const cost = prestigeUpgradeCost(def, level);
  if (state.stars < cost) return { ok: false, error: 'not_enough_stars' };

  return {
    ok: true,
    cost,
    state: {
      ...state,
      stars: state.stars - cost,
      prestigeUpgrades: { ...state.prestigeUpgrades, [id]: level + 1 },
    },
  };
}
