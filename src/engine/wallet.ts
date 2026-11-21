// Real-money wallet: points earned by watching ads, withdrawn as mobile credit (paid by hand).
// ALL money knobs live here. 1 point = 1 milli-EGP, so 1000 points = 1 EGP.
import { claimBoost, DAILY_BOOST_LIMIT } from './engine.ts';
import type { GameState, Result } from './types.ts';

/** What the player earns per rewarded ad, in points (milli-EGP). See docs/economics.md. */
export const AD_REWARD_POINTS = 6;
/** Rewarded ads per UTC day that pay points. Boost ads pay nothing, so they are pure margin. */
export const POINT_ADS_PER_DAY = 20;
/** The ad must be open at least this long before a reward is accepted (Monetag ads last ~15s). */
export const AD_MIN_WATCH_MS = 8_000;
export const AD_TICKET_TTL_MS = 10 * 60_000;
export const AD_COOLDOWN_MS = 30_000;
export const POINTS_PER_EGP = 1000;
export const MIN_WITHDRAW_EGP = 5;
export const MIN_WITHDRAW_POINTS = MIN_WITHDRAW_EGP * POINTS_PER_EGP;
export const WITHDRAW_INTERVAL_MS = 7 * 86_400_000;
/** Requests younger than this are not payable yet in the admin page (time to spot fraud). */
export const WITHDRAW_HOLD_MS = 48 * 3_600_000;

export type AdKind = 'points' | 'boost';

const dayOf = (now: number) => Math.floor(now / 86_400_000);
export const pointAdsLeft = (s: GameState, now: number) =>
  Math.max(0, POINT_ADS_PER_DAY - (s.adDay === dayOf(now) ? s.adCount : 0));

/** Egyptian mobile number -> 01XXXXXXXXX, or null. Accepts Arabic digits, spaces, +20 and 0020. */
export function normalizePhone(raw: string): string | null {
  const ar = '٠١٢٣٤٥٦٧٨٩';
  let p = raw.replace(/[٠-٩]/g, (d) => String(ar.indexOf(d))).replace(/[\s\-().]/g, '');
  if (p.startsWith('+20')) p = '0' + p.slice(3);
  else if (p.startsWith('0020')) p = '0' + p.slice(4);
  return /^01[0125]\d{8}$/.test(p) ? p : null;
}

export function startAd(state: GameState, kind: AdKind, now: number, ticketId: string, live: boolean): Result<{ ticket: string }> {
  if (kind === 'points') {
    if (!live) return { ok: false, error: 'ads_off' };
    if (pointAdsLeft(state, now) < 1) return { ok: false, error: 'limit' };
  } else {
    const used = state.boostDay === dayOf(now) ? state.boostClaims : 0;
    if (used >= DAILY_BOOST_LIMIT) return { ok: false, error: 'limit' };
  }
  if (now - state.lastAdAt < AD_COOLDOWN_MS) return { ok: false, error: 'cooldown' };
  return { ok: true, state: { ...state, ticketId, ticketKind: kind, ticketAt: now }, ticket: ticketId };
}

/**
 * Credits one Monetag-confirmed (paid) impression. Called by the postback, never by the client.
 * Returns null when the daily cap is already used up (the ad still earned us money, the player just gets nothing more today).
 */
export function creditAdPoints(state: GameState, now: number): GameState | null {
  const today = dayOf(now);
  const count = state.adDay === today ? state.adCount : 0;
  if (count >= POINT_ADS_PER_DAY) return null;
  return {
    ...state,
    adDay: today,
    adCount: count + 1,
    lastAdAt: now,
    lifetimeAds: state.lifetimeAds + 1,
    walletPoints: state.walletPoints + AD_REWARD_POINTS,
    lifetimePoints: state.lifetimePoints + AD_REWARD_POINTS,
  };
}

/** `verified`: Monetag postbacks are set up, so points come only from the postback, never from the client. */
export function claimAd(state: GameState, ticketId: string, now: number, live: boolean, verified = false): Result<{ kind: AdKind; points: number }> {
  if (!state.ticketId || state.ticketId !== ticketId) return { ok: false, error: 'bad_ticket' };
  const age = now - state.ticketAt;
  if (age > AD_TICKET_TTL_MS) return { ok: false, error: 'expired' };
  // With no ad network connected there is nothing to watch, so no minimum either.
  if (live && age < AD_MIN_WATCH_MS) return { ok: false, error: 'too_early' };
  const kind = state.ticketKind as AdKind;
  const base: GameState = { ...state, ticketId: '', ticketKind: '', ticketAt: 0, lastAdAt: now, lifetimeAds: state.lifetimeAds + 1 };

  if (kind === 'boost') {
    const r = claimBoost(base, now);
    return r.ok ? { ok: true, state: r.state, kind, points: 0 } : r;
  }
  if (!live) return { ok: false, error: 'ads_off' };
  if (verified) return { ok: false, error: 'bad_ticket' };
  const today = dayOf(now);
  const count = base.adDay === today ? base.adCount : 0;
  if (count >= POINT_ADS_PER_DAY) return { ok: false, error: 'limit' };
  return {
    ok: true,
    kind,
    points: AD_REWARD_POINTS,
    state: {
      ...base,
      adDay: today,
      adCount: count + 1,
      walletPoints: base.walletPoints + AD_REWARD_POINTS,
      lifetimePoints: base.lifetimePoints + AD_REWARD_POINTS,
    },
  };
}

/** Takes the whole balance out of the wallet. The caller records the withdrawal row. */
export function requestWithdraw(state: GameState, now: number): Result<{ points: number }> {
  if (state.walletPoints < MIN_WITHDRAW_POINTS) return { ok: false, error: 'below_minimum' };
  if (state.lastWithdrawAt && now - state.lastWithdrawAt < WITHDRAW_INTERVAL_MS) return { ok: false, error: 'too_soon' };
  const points = state.walletPoints;
  return { ok: true, points, state: { ...state, walletPoints: 0, lastWithdrawAt: now } };
}
