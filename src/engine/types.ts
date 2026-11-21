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
  /** Wallet, in points (1000 points = 1 EGP). */
  walletPoints: number;
  lifetimePoints: number;
  lifetimeAds: number;
  /** UTC day and count of point-paying ads watched that day. */
  adDay: number;
  adCount: number;
  lastAdAt: number;
  /** Outstanding ad ticket: the reward is only granted for the ticket the server issued. */
  ticketId: string;
  ticketKind: string;
  ticketAt: number;
  lastWithdrawAt: number;
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
  | 'expired'
  | 'below_minimum'
  | 'too_soon';

export type Result<T = object> = ({ ok: true; state: GameState } & T) | { ok: false; error: ErrorCode };
