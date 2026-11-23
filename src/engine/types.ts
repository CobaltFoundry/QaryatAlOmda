// Pure game types. No Cloudflare, Telegram or DOM dependencies in this folder.

export type Category = 'transport' | 'food' | 'realestate' | 'industry' | 'vip';

export interface AssetDef {
  id: number;
  key: string;
  name: string;
  category: Category;
  description: string;
  baseCost: number;
  costGrowth: number;
  /** EGP per second at level 1. Income at level L is baseIncome * L. */
  baseIncome: number;
  /** Prestige level needed before this asset appears. */
  unlockPrestige: number;
  /** Another asset that must be owned (level >= 1). 0 = none. */
  requiresAssetId: number;
  /** Extra EGP per tap, per level owned. */
  tapBonus: number;
}

export type UpgradeType = 'income_mult' | 'tap_mult' | 'offline_hours';

export interface UpgradeDef {
  id: string;
  name: string;
  description: string;
  cost: number;
  type: UpgradeType;
  /** Multiplier for *_mult types, hours for offline_hours. */
  value: number;
  /** For income_mult: the single asset it boosts. 0 = global. */
  targetAssetId: number;
  requiresAssetId: number;
  requiresLevel: number;
}

export type PrestigeUpgradeType = UpgradeType | 'start_cash';

export interface PrestigeUpgradeDef {
  id: string;
  name: string;
  description: string;
  starCost: number;
  starCostGrowth: number;
  type: PrestigeUpgradeType;
  /** *_mult: (1+v)^level. offline_hours: +v hours per level. start_cash: +v EGP per level. */
  valuePerLevel: number;
  maxLevel: number;
}

export interface GameData {
  assets: AssetDef[];
  upgrades: UpgradeDef[];
  prestigeUpgrades: PrestigeUpgradeDef[];
}

export interface GameState {
  cash: number;
  /** EGP earned since the last prestige. Drives star gains. */
  runEarned: number;
  lifetimeEarned: number;
  /** Keyed by String(assetId) so it survives JSON round trips. */
  assetLevels: Record<string, number>;
  upgrades: string[];
  prestigeLevel: number;
  /** Unspent stars. */
  stars: number;
  /** Every star ever earned. Gives a permanent income bonus. */
  lifetimeStars: number;
  prestigeUpgrades: Record<string, number>;
  taps: number;
  /** ms epoch of the last time income was credited. */
  lastSeen: number;
  /** ms epoch of the last accepted tap batch (anti-cheat rate limit). */
  lastTapAt: number;
  /** ms epoch until which the x2 boost is active. 0 = none. */
  boostUntil: number;
  /** UTC day number (ms / 86400000) of the last boost claim, and claims made that day. */
  boostDay: number;
  boostClaims: number;
  lifetimeAds: number;
  lastAdAt: number;
  /** Outstanding ad ticket: the reward is only granted for the ticket the server issued. */
  ticketId: string;
  ticketKind: string;
  ticketAt: number;
  /** The last reward collected, that the player may double by watching an ad. */
  doubleCash: number;
  /** UTC day of the last streak claim, and the streak day (1..7) reached. */
  streakLast: number;
  streakCount: number;
  /** Daily quest counters (reset each UTC day) and the bitmask of rewards already claimed. */
  qDay: number;
  qTaps: number;
  qBuys: number;
  qAds: number;
  qBag: number;
  qDone: number;
  /** ms epoch of the last lucky-bag claim. */
  bagAt: number;
  /** Last push sent to this player (ms), 0 = never. One push per absence. */
  notifiedAt: number;
  /** Invitees' lifetime earnings already paid out as "الواسطة". */
  wasetaSeen: number;
  /** Keys of event occurrences already claimed (last few). */
  evClaimed: string[];
  /** Tax collector visit: fee (0 = none), hidden bag multiplier, expiry, earliest next visit. */
  taxCost: number;
  taxMult: number;
  taxExp: number;
  taxNextAt: number;
  /** True after /mute or when Telegram says the bot was blocked. */
  notifyOff: boolean;
}

export type ErrorCode =
  | 'unknown_asset'
  | 'unknown_upgrade'
  | 'locked'
  | 'not_enough_cash'
  | 'not_enough_stars'
  | 'already_owned'
  | 'max_level'
  | 'bad_quantity'
  | 'not_ready'
  | 'limit'
  | 'ads_off'
  | 'cooldown'
  | 'bad_ticket'
  | 'too_early'
  | 'expired';

export type Result<T = object> = ({ ok: true; state: GameState } & T) | { ok: false; error: ErrorCode };
