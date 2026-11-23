// Time-limited events. They are claimable rewards (never income rates), so being away during one
// can't be farmed, and nothing needs to be stored except which ones a player already took.
import { grantBoost } from './engine.ts';
import { credit, scaledReward } from './daily.ts';
import type { GameData, GameState, Result } from './types.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const utc = (iso: string) => Date.parse(iso + 'T00:00:00Z');

export interface ActiveEvent {
  /** Unique per occurrence, e.g. "rain-20418". A player can claim each key once. */
  key: string;
  kind: 'rain' | 'iftar' | 'eid';
  name: string;
  blurb: string;
  endsAt: number;
}

/** Holidays move every year: update these dates (UTC, end exclusive) when needed. */
export const EID_PERIODS: readonly { id: string; name: string; from: number; to: number }[] = [
  { id: 'fitr27', name: 'عيدية العيد الصغير', from: utc('2027-03-09'), to: utc('2027-03-13') },
  { id: 'adha27', name: 'عيدية العيد الكبير', from: utc('2027-05-16'), to: utc('2027-05-20') },
];
export const RAMADAN_PERIODS: readonly { from: number; to: number }[] = [{ from: utc('2027-02-08'), to: utc('2027-03-09') }];

/** The event running at `now`, if any. Eid wins over Ramadan, which wins over the weekly rain. */
export function activeEvent(now: number): ActiveEvent | null {
  for (const e of EID_PERIODS) {
    if (now >= e.from && now < e.to) return { key: 'eid-' + e.id, kind: 'eid', name: e.name, blurb: 'كل سنة وانت طيب يا عمدة، العيدية جاهزة', endsAt: e.to };
  }
  const day = Math.floor(now / DAY);
  const inDay = now - day * DAY;
  // Iftar window, about 17:00-21:30 Cairo.
  if (RAMADAN_PERIODS.some((p) => now >= p.from && now < p.to) && inDay >= 14 * HOUR && inDay < 19.5 * HOUR) {
    return { key: 'iftar-' + day, kind: 'iftar', name: 'مدفع الإفطار', blurb: 'الأذان أذّن، خد فطارك', endsAt: day * DAY + 19.5 * HOUR };
  }
  // Friday noon in Cairo (09:00-12:00 UTC covers winter and summer time).
  if (new Date(now).getUTCDay() === 5 && inDay >= 9 * HOUR && inDay < 12 * HOUR) {
    return { key: 'rain-' + day, kind: 'rain', name: 'مطر دهب', blurb: 'الجمعة الضهر، الدهب بينزل من السما', endsAt: day * DAY + 12 * HOUR };
  }
  return null;
}

export const eventClaimed = (state: GameState, ev: ActiveEvent | null) => !!ev && state.evClaimed.includes(ev.key);

export function claimEvent(state: GameState, data: GameData, now: number): Result<{ cash: number; boostMinutes: number; name: string }> {
  const ev = activeEvent(now);
  if (!ev) return { ok: false, error: 'not_ready' };
  if (state.evClaimed.includes(ev.key)) return { ok: false, error: 'limit' };
  const [seconds, min, boostMin] = ev.kind === 'eid' ? [1800, 5000, 60] : ev.kind === 'iftar' ? [600, 1000, 0] : [420, 800, 0];
  const cash = scaledReward(state, data, seconds, min);
  let s = credit(state, cash);
  if (boostMin) s = grantBoost(s, now, boostMin * 60_000);
  s = { ...s, evClaimed: [...state.evClaimed, ev.key].slice(-12), doubleCash: cash };
  return { ok: true, state: s, cash, boostMinutes: boostMin, name: ev.name };
}
