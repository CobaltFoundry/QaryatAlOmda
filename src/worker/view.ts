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
import { taxOpen } from '../engine/tax.ts';
import { activeEvent, eventClaimed } from '../engine/events.ts';
import { QUESTS, STREAK, bagReady, dayOf, questProgress, streakShown, titleFor, wasetaPending } from '../engine/daily.ts';
import { AD_COOLDOWN_MS } from '../engine/ads.ts';

export interface AdsConfig {
  /** An ad network is connected (secret MONETAG_ZONE), so ad-only rewards are available. */
  live: boolean;
  /** Monetag zone id (secret MONETAG_ZONE). */
  zone: string;
  /** The viewer is an admin (shows the admin screen). */
  isAdmin?: boolean;
}

/** Everything the Mini App needs to draw a screen. The client never computes game rules. */
export function buildView(
  state: GameState,
  data: GameData,
  now: number,
  ads: AdsConfig = { live: false, zone: '' },
  invitees?: { count: number; lifetime: number },
) {
  const day = Math.floor(now / 86_400_000);
  const claimsToday = state.boostDay === day ? state.boostClaims : 0;
  const stars = prestigeStarsGain(state);

  const nameOf = (id: number) => data.assets.find((a) => a.id === id)?.name ?? '';

  return {
    now,
    isAdmin: ads.isAdmin ?? false,
    title: titleFor(state.prestigeLevel),
    ads: { live: ads.live, zone: ads.zone, readyAt: state.lastAdAt + AD_COOLDOWN_MS },
    doubleCash: state.doubleCash,
    tax: taxOpen(state, now) ? { cost: state.taxCost, expiresAt: state.taxExp } : null,
    event: (() => {
      const ev = activeEvent(now);
      return ev ? { name: ev.name, blurb: ev.blurb, endsAt: ev.endsAt, claimed: eventClaimed(state, ev) } : null;
    })(),
    // Only sent when the server looked it up (sync and claim); the app keeps the last value otherwise.
    waseta: invitees ? { count: invitees.count, pending: wasetaPending(state, invitees.lifetime) } : undefined,
    streak: {
      day: streakShown(state, now),
      claimedToday: state.streakLast === dayOf(now),
      rewards: STREAK.map((r) => r[0]),
    },
    quests: QUESTS.map((q, i) => {
      const today = state.qDay === dayOf(now);
      return {
        id: q.id,
        target: q.target,
        progress: today ? Math.min(q.target, questProgress(state, q.id)) : 0,
        claimed: today && (state.qDone & (1 << i)) !== 0,
      };
    }),
    questChest: state.qDay === dayOf(now) && (state.qDone & (1 << QUESTS.length)) !== 0 ? 'claimed' : QUESTS.every((_, i) => state.qDay === dayOf(now) && (state.qDone & (1 << i)) !== 0) ? 'ready' : 'locked',
    bagReady: bagReady(state, now),
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
