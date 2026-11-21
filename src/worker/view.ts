import {
  DAILY_BOOST_LIMIT,
  prestigeMinEarned,
  assetCost,
  assetIncomePerSecond,
  assetLevel,
  baseIncomePerSecond,
  isAssetUnlocked,
  maxAffordable,
  offlineCapSeconds,
  prestigeStarsGain,
  prestigeUpgradeCost,
  tapPower,
} from '../engine/engine.ts';
import type { GameData, GameState } from '../engine/types.ts';
import {
  AD_COOLDOWN_MS,
  AD_REWARD_POINTS,
  MIN_WITHDRAW_POINTS,
  POINTS_PER_EGP,
  POINT_ADS_PER_DAY,
  WITHDRAW_INTERVAL_MS,
  pointAdsLeft,
} from '../engine/wallet.ts';

export interface AdsConfig {
  /** Real point rewards are only paid when this is true (secret ADS_LIVE=1). */
  live: boolean;
  /** Monetag zone id (secret MONETAG_ZONE). */
  zone: string;
}

/** Everything the Mini App needs to draw a screen. The client never computes game rules. */
export function buildView(state: GameState, data: GameData, now: number, ads: AdsConfig = { live: false, zone: '' }) {
  const day = Math.floor(now / 86_400_000);
  const claimsToday = state.boostDay === day ? state.boostClaims : 0;
  const stars = prestigeStarsGain(state);

  const nameOf = (id: number) => data.assets.find((a) => a.id === id)?.name ?? '';

  return {
    now,
    wallet: {
      points: state.walletPoints,
      pointsPerEgp: POINTS_PER_EGP,
      minPoints: MIN_WITHDRAW_POINTS,
      adReward: AD_REWARD_POINTS,
      adsLeft: pointAdsLeft(state, now),
      adsPerDay: POINT_ADS_PER_DAY,
      adLive: ads.live,
      adZone: ads.zone,
      adReadyAt: state.lastAdAt + AD_COOLDOWN_MS,
      nextWithdrawAt: state.lastWithdrawAt ? state.lastWithdrawAt + WITHDRAW_INTERVAL_MS : 0,
    },
    cash: state.cash,
    runEarned: state.runEarned,
    lifetimeEarned: state.lifetimeEarned,
    baseCps: baseIncomePerSecond(state, data),
    boostUntil: state.boostUntil,
    boostClaimsLeft: Math.max(0, DAILY_BOOST_LIMIT - claimsToday),
    tapPower: tapPower(state, data),
    taps: state.taps,
    offlineCapHours: offlineCapSeconds(state, data) / 3600,
    prestigeLevel: state.prestigeLevel,
    stars: state.stars,
    lifetimeStars: state.lifetimeStars,
    prestigeGain: stars,
    prestigeMin: prestigeMinEarned(state),
    canPrestige: stars >= 1,
    assets: data.assets.map((a) => {
      const level = assetLevel(state, a.id);
      const unlocked = isAssetUnlocked(state, a);
      let lock: { kind: 'prestige'; level: number } | { kind: 'asset'; name: string } | null = null;
      if (!unlocked) {
        lock =
          state.prestigeLevel < a.unlockPrestige
            ? { kind: 'prestige', level: a.unlockPrestige }
            : { kind: 'asset', name: nameOf(a.requiresAssetId) };
      }
      return {
        id: a.id,
        key: a.key,
        name: a.name,
        category: a.category,
        description: a.description,
        level,
        cost: assetCost(a, level, 1),
        cost10: assetCost(a, level, 10),
        maxQty: unlocked ? maxAffordable(a, level, state.cash) : 0,
        cps: assetIncomePerSecond(state, data, a.id),
        perLevel:
          level > 0
            ? assetIncomePerSecond(state, data, a.id) / level
            : assetIncomePerSecond({ ...state, assetLevels: { ...state.assetLevels, [String(a.id)]: 1 } }, data, a.id),
        tapBonus: a.tapBonus,
        unlocked,
        lock,
      };
    }),
    upgrades: data.upgrades
      .filter((u) => !state.upgrades.includes(u.id))
      .map((u) => {
        const need =
          u.requiresAssetId !== 0 && assetLevel(state, u.requiresAssetId) < u.requiresLevel
            ? { name: nameOf(u.requiresAssetId), level: u.requiresLevel }
            : null;
        return {
          id: u.id,
          name: u.name,
          description: u.description,
          cost: u.cost,
          type: u.type,
          available: need === null,
          need,
        };
      }),
    prestigeUpgrades: data.prestigeUpgrades.map((p) => {
      const level = state.prestigeUpgrades[p.id] ?? 0;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        level,
        maxLevel: p.maxLevel,
        cost: level >= p.maxLevel ? null : prestigeUpgradeCost(p, level),
      };
    }),
  };
}

export type View = ReturnType<typeof buildView>;
