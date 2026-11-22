// Rewarded ads. The player gets in-game rewards only; ad revenue is ours.
import { claimBoost, DAILY_BOOST_LIMIT } from './engine.ts';
import { credit } from './daily.ts';
import type { GameState, Result } from './types.ts';

/** The ad must stay open at least this long before the reward is accepted (ads last ~15s). */
export const AD_MIN_WATCH_MS = 8_000;
export const AD_TICKET_TTL_MS = 10 * 60_000;
export const AD_COOLDOWN_MS = 30_000;

/** boost = x2 income for 30 minutes. double = doubles the last reward the player collected. */
export type AdKind = 'boost' | 'double';

const dayOf = (now: number) => Math.floor(now / 86_400_000);

export function startAd(state: GameState, kind: AdKind, now: number, ticketId: string, live: boolean): Result<{ ticket: string }> {
  if (kind === 'double') {
    if (!live) return { ok: false, error: 'ads_off' };
    if (state.doubleCash <= 0) return { ok: false, error: 'not_ready' };
  } else {
    const used = state.boostDay === dayOf(now) ? state.boostClaims : 0;
    if (used >= DAILY_BOOST_LIMIT) return { ok: false, error: 'limit' };
  }
  if (now - state.lastAdAt < AD_COOLDOWN_MS) return { ok: false, error: 'cooldown' };
  return { ok: true, state: { ...state, ticketId, ticketKind: kind, ticketAt: now }, ticket: ticketId };
}

export function claimAd(state: GameState, ticketId: string, now: number, live: boolean): Result<{ kind: AdKind; bonus: number }> {
  if (!state.ticketId || state.ticketId !== ticketId) return { ok: false, error: 'bad_ticket' };
  const age = now - state.ticketAt;
  if (age > AD_TICKET_TTL_MS) return { ok: false, error: 'expired' };
  // With no ad network connected there is nothing to watch, so no minimum either.
  if (live && age < AD_MIN_WATCH_MS) return { ok: false, error: 'too_early' };
  const kind = state.ticketKind as AdKind;
  const base: GameState = {
    ...state,
    ticketId: '',
    ticketKind: '',
    ticketAt: 0,
    lastAdAt: now,
    lifetimeAds: state.lifetimeAds + 1,
    qAds: (state.qDay === dayOf(now) ? state.qAds : 0) + 1,
    qDay: dayOf(now),
  };

  if (kind === 'boost') {
    const r = claimBoost(base, now);
    return r.ok ? { ok: true, state: r.state, kind, bonus: 0 } : r;
  }
  if (!live || state.doubleCash <= 0) return { ok: false, error: 'ads_off' };
  const bonus = state.doubleCash;
  return { ok: true, kind, bonus, state: { ...credit(base, bonus), doubleCash: 0 } };
}
