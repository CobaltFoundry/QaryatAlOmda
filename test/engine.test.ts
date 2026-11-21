import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accrue,
  applyTaps,
  assetCost,
  buyAsset,
  buyPrestigeUpgrade,
  buyUpgrade,
  claimBoost,
  doPrestige,
  grantBoost,
  incomePerSecond,
  maxAffordable,
  newState,
  offlineCapSeconds,
  prestigeStarsGain,
  tapPower,
} from '../src/engine/engine.ts';
import { formatNumber } from '../src/engine/format.ts';
import type { GameData, GameState } from '../src/engine/types.ts';

const T0 = 1_700_000_000_000;

const data: GameData = {
  assets: [
    { id: 1, key: 'a1', name: 'A1', category: 'transport', description: '', baseCost: 15, costGrowth: 1.15, baseIncome: 1, unlockPrestige: 0, requiresAssetId: 0, tapBonus: 1 },
    { id: 2, key: 'a2', name: 'A2', category: 'food', description: '', baseCost: 100, costGrowth: 1.15, baseIncome: 8, unlockPrestige: 0, requiresAssetId: 1, tapBonus: 0 },
    { id: 3, key: 'a3', name: 'A3', category: 'industry', description: '', baseCost: 1000, costGrowth: 1.15, baseIncome: 60, unlockPrestige: 1, requiresAssetId: 2, tapBonus: 0 },
  ],
  upgrades: [
    { id: 'u_a1', name: '', description: '', cost: 100, type: 'income_mult', value: 2, targetAssetId: 1, requiresAssetId: 1, requiresLevel: 2 },
    { id: 'u_glob', name: '', description: '', cost: 500, type: 'income_mult', value: 1.5, targetAssetId: 0, requiresAssetId: 0, requiresLevel: 0 },
    { id: 'u_tap', name: '', description: '', cost: 50, type: 'tap_mult', value: 3, targetAssetId: 0, requiresAssetId: 0, requiresLevel: 0 },
    { id: 'u_off', name: '', description: '', cost: 200, type: 'offline_hours', value: 2, targetAssetId: 0, requiresAssetId: 0, requiresLevel: 0 },
  ],
  prestigeUpgrades: [
    { id: 'p_inc', name: '', description: '', starCost: 2, starCostGrowth: 2, type: 'income_mult', valuePerLevel: 0.5, maxLevel: 3 },
    { id: 'p_start', name: '', description: '', starCost: 1, starCostGrowth: 1, type: 'start_cash', valuePerLevel: 1000, maxLevel: 5 },
    { id: 'p_off', name: '', description: '', starCost: 1, starCostGrowth: 1, type: 'offline_hours', valuePerLevel: 2, maxLevel: 3 },
  ],
};

const st = (over: Partial<GameState> = {}): GameState => ({ ...newState(T0), ...over });
const [A1] = data.assets;

// ---- costs ----
test('assetCost: first level, growth and bulk', () => {
  assert.equal(assetCost(A1, 0), 15);
  assert.equal(assetCost(A1, 1), 18);
  assert.equal(assetCost(A1, 0, 2), 33);
});

test('maxAffordable never overspends and is maximal', () => {
  for (const cash of [0, 14, 15, 100, 1234, 99999, 5e6]) {
    for (const level of [0, 5, 20]) {
      const n = maxAffordable(A1, level, cash);
      if (n > 0) assert.ok(assetCost(A1, level, n) <= cash, `cash ${cash} level ${level} n ${n}`);
      if (n < 1000) assert.ok(assetCost(A1, level, n + 1) > cash, `not maximal: cash ${cash} level ${level} n ${n}`);
    }
  }
});

// ---- buying ----
test('buyAsset deducts cash and raises the level', () => {
  const r = buyAsset(st({ cash: 100 }), data, 1);
  assert.ok(r.ok);
  assert.equal(r.state.cash, 85);
  assert.equal(r.state.assetLevels['1'], 1);
});

test('buyAsset rejects: poor, unknown, bad qty, locked by dependency and by prestige', () => {
  assert.deepEqual(buyAsset(st({ cash: 10 }), data, 1), { ok: false, error: 'not_enough_cash' });
  assert.deepEqual(buyAsset(st({ cash: 1e9 }), data, 99), { ok: false, error: 'unknown_asset' });
  assert.deepEqual(buyAsset(st({ cash: 1e9 }), data, 1, 0), { ok: false, error: 'bad_quantity' });
  assert.deepEqual(buyAsset(st({ cash: 1e9 }), data, 2), { ok: false, error: 'locked' });
  const owns2 = st({ cash: 1e9, assetLevels: { '1': 1, '2': 1 } });
  assert.deepEqual(buyAsset(owns2, data, 3), { ok: false, error: 'locked' });
  assert.ok(buyAsset({ ...owns2, prestigeLevel: 1 }, data, 3).ok);
});

test('buyUpgrade: requirements, ownership, price', () => {
  assert.deepEqual(buyUpgrade(st({ cash: 100, assetLevels: { '1': 1 } }), data, 'u_a1'), { ok: false, error: 'locked' });
  const ready = st({ cash: 100, assetLevels: { '1': 2 } });
  const r = buyUpgrade(ready, data, 'u_a1');
  assert.ok(r.ok);
  assert.equal(r.state.cash, 0);
  assert.deepEqual(buyUpgrade(r.state, data, 'u_a1'), { ok: false, error: 'already_owned' });
  assert.deepEqual(buyUpgrade(st({ cash: 10 }), data, 'u_glob'), { ok: false, error: 'not_enough_cash' });
  assert.deepEqual(buyUpgrade(st(), data, 'nope'), { ok: false, error: 'unknown_upgrade' });
});

// ---- income ----
test('income: linear in level, per-asset and global upgrades stack', () => {
  const base = st({ assetLevels: { '1': 3 } });
  assert.equal(incomePerSecond(base, data, T0), 3);
  assert.equal(incomePerSecond({ ...base, upgrades: ['u_a1'] }, data, T0), 6);
  assert.equal(incomePerSecond({ ...base, upgrades: ['u_a1', 'u_glob'] }, data, T0), 9);
});

test('income: lifetime stars give +50% x sqrt(stars), prestige upgrades multiply', () => {
  const s = st({ assetLevels: { '1': 10 }, lifetimeStars: 16 });
  assert.ok(Math.abs(incomePerSecond(s, data, T0) - 30) < 1e-9);
  const s2 = st({ assetLevels: { '1': 10 }, prestigeUpgrades: { p_inc: 2 } });
  assert.ok(Math.abs(incomePerSecond(s2, data, T0) - 22.5) < 1e-9);
});

// ---- accrue / offline / boost ----
test('accrue credits income for elapsed time', () => {
  const r = accrue(st({ assetLevels: { '1': 10 } }), data, T0 + 10_000);
  assert.equal(r.earned, 100);
  assert.equal(r.state.cash, 100);
  assert.equal(r.state.runEarned, 100);
  assert.equal(r.state.lastSeen, T0 + 10_000);
  assert.equal(r.capped, false);
});

test('accrue: offline cap of 2h, extended by upgrades and prestige', () => {
  const owner = st({ assetLevels: { '1': 10 } });
  const tenHours = T0 + 10 * 3600_000;
  const r = accrue(owner, data, tenHours);
  assert.equal(r.secondsCredited, 7200);
  assert.equal(r.earned, 72_000);
  assert.equal(r.capped, true);
  assert.equal(accrue({ ...owner, upgrades: ['u_off'] }, data, tenHours).earned, 144_000);
  assert.equal(offlineCapSeconds({ ...owner, prestigeUpgrades: { p_off: 3 } }, data), 8 * 3600);
});

test('accrue: a clock that goes backwards credits nothing', () => {
  const r = accrue(st({ assetLevels: { '1': 10 } }), data, T0 - 5000);
  assert.equal(r.earned, 0);
  assert.equal(r.state.lastSeen, T0);
});

test('boost doubles income, partial overlap counted exactly', () => {
  const owner = st({ assetLevels: { '1': 10 } });
  assert.equal(accrue({ ...owner, boostUntil: T0 + 1e9 }, data, T0 + 10_000).earned, 200);
  assert.equal(accrue({ ...owner, boostUntil: T0 + 4_000 }, data, T0 + 10_000).earned, 140);
  assert.equal(incomePerSecond({ ...owner, boostUntil: T0 + 1000 }, data, T0), 20);
  assert.equal(incomePerSecond({ ...owner, boostUntil: T0 + 1000 }, data, T0 + 2000), 10);
});

test('grantBoost stacks on an active boost', () => {
  const a = grantBoost(st(), T0, 60_000);
  assert.equal(a.boostUntil, T0 + 60_000);
  assert.equal(grantBoost(a, T0 + 1000, 60_000).boostUntil, T0 + 120_000);
});

// ---- taps ----
test('tapPower: base 1 plus asset bonuses, times multipliers', () => {
  assert.equal(tapPower(st(), data), 1);
  const s = st({ assetLevels: { '1': 2 } });
  assert.equal(tapPower(s, data), 3);
  assert.equal(tapPower({ ...s, upgrades: ['u_tap'] }, data), 9);
});

test('applyTaps is rate limited and ignores garbage input', () => {
  const s = st({ assetLevels: { '1': 2 } });
  const r = applyTaps(s, data, T0 + 1000, 1000);
  assert.equal(r.accepted, 25);
  assert.equal(r.gained, 75);
  assert.equal(r.state.cash, 75);
  assert.equal(applyTaps(s, data, T0 + 1000, 5).accepted, 5);
  assert.equal(applyTaps(s, data, T0 + 1000, -3).accepted, 0);
  assert.equal(applyTaps(s, data, T0 + 1000, Number.NaN).accepted, 0);
});

// ---- prestige ----
test('prestige: gate, star formula and reset', () => {
  assert.equal(prestigeStarsGain(st({ runEarned: 5e8 })), 0);
  assert.equal(prestigeStarsGain(st({ runEarned: 1e9 })), 1);
  assert.equal(prestigeStarsGain(st({ runEarned: 8e9 })), 2);
  assert.equal(prestigeStarsGain(st({ runEarned: 1e9, prestigeLevel: 1 })), 0);
  assert.equal(prestigeStarsGain(st({ runEarned: 2.5e9, prestigeLevel: 1 })), 1);
  assert.deepEqual(doPrestige(st({ runEarned: 5e8 }), data, T0), { ok: false, error: 'not_ready' });

  const before = st({
    cash: 777,
    runEarned: 8e9,
    assetLevels: { '1': 5 },
    upgrades: ['u_glob'],
    prestigeUpgrades: { p_inc: 1 },
    stars: 1,
    lifetimeStars: 1,
  });
  const r = doPrestige(before, data, T0 + 1);
  assert.ok(r.ok);
  assert.equal(r.starsGained, 2);
  assert.equal(r.state.cash, 0);
  assert.equal(r.state.runEarned, 0);
  assert.deepEqual(r.state.assetLevels, {});
  assert.deepEqual(r.state.upgrades, []);
  assert.equal(r.state.prestigeLevel, 1);
  assert.equal(r.state.stars, 3);
  assert.equal(r.state.lifetimeStars, 3);
  assert.deepEqual(r.state.prestigeUpgrades, { p_inc: 1 });
});

test('prestige: start_cash upgrade seeds the new run', () => {
  const r = doPrestige(st({ runEarned: 1e9, prestigeUpgrades: { p_start: 3 } }), data, T0);
  assert.ok(r.ok);
  assert.equal(r.state.cash, 3000);
});

test('buyPrestigeUpgrade: growing cost, max level, stars check', () => {
  let s = st({ stars: 10 });
  let r = buyPrestigeUpgrade(s, data, 'p_inc');
  assert.ok(r.ok);
  assert.equal(r.state.stars, 8);
  r = buyPrestigeUpgrade(r.state, data, 'p_inc');
  assert.ok(r.ok);
  assert.equal(r.state.stars, 4);
  assert.deepEqual(buyPrestigeUpgrade(r.state, data, 'p_inc'), { ok: false, error: 'not_enough_stars' });
  s = st({ stars: 100, prestigeUpgrades: { p_inc: 3 } });
  assert.deepEqual(buyPrestigeUpgrade(s, data, 'p_inc'), { ok: false, error: 'max_level' });
  assert.deepEqual(buyPrestigeUpgrade(s, data, 'nope'), { ok: false, error: 'unknown_upgrade' });
});

// ---- format ----
test('formatNumber: Arabic units and digits', () => {
  assert.equal(formatNumber(0), '٠');
  assert.equal(formatNumber(999), '٩٩٩');
  assert.equal(formatNumber(1500), '١٫٥ ألف');
  assert.equal(formatNumber(24_800), '٢٤٫٨ ألف');
  assert.equal(formatNumber(1_000_000), '١ مليون');
  assert.equal(formatNumber(1.5e9), '١٫٥ مليار');
  assert.equal(formatNumber(999_960), '١ مليون');
  assert.equal(formatNumber(1500, false), '1.5 ألف');
});

test('applyTaps: idle time cannot be banked beyond the window cap', () => {
  const s = st({ assetLevels: { '1': 0 } });
  const r = applyTaps(s, data, T0 + 3600_000, 100_000);
  assert.equal(r.accepted, 30 * 15 + 10);
});

test('claimBoost: +30 min, stacks up to 4h, limited per day', () => {
  let s = st();
  const r1 = claimBoost(s, T0);
  assert.ok(r1.ok);
  assert.equal(r1.state.boostUntil, T0 + 30 * 60_000);
  s = r1.state;
  for (let i = 0; i < 20; i++) {
    const r = claimBoost(s, T0);
    if (!r.ok) break;
    s = r.state;
  }
  assert.ok(s.boostUntil <= T0 + 4 * 3600_000);
  assert.equal(s.boostClaims, 10);
  const day = Math.floor(T0 / 86_400_000);
  const maxed = st({ boostDay: day, boostClaims: 10 });
  assert.deepEqual(claimBoost(maxed, T0), { ok: false, error: 'limit' });
  const nextDay = claimBoost(maxed, (day + 1) * 86_400_000 + 5);
  assert.ok(nextDay.ok);
  assert.equal(nextDay.state.boostClaims, 1);
});

test('formatRate: one decimal below 10', async () => {
  const { formatRate } = await import('../src/engine/format.ts');
  assert.equal(formatRate(0.1), '٠٫١');
  assert.equal(formatRate(0), '٠');
  assert.equal(formatRate(1.66), '١٫٧');
  assert.equal(formatRate(25), '٢٥');
  assert.equal(formatRate(1500), '١٫٥ ألف');
  assert.equal(formatRate(0.25, false), '0.3');
});
