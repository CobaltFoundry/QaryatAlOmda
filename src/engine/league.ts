// الشلل: small groups (up to 20) that compete on a weekly activity score.
import type { GameState } from './types.ts';

export const GUILD_MAX = 20;
export const GUILD_PERK_PER_MEMBER = 0.02;
export const GUILD_PERK_CAP = 0.2;
const DAY = 86_400_000;

/** Week number counted from Monday (the epoch was a Thursday). */
export const weekIndex = (now: number): number => Math.floor((now / DAY + 3) / 7);

/** Every member makes the whole group's income a bit higher (the first member adds nothing). */
export const guildPerk = (size: number): number => Math.min(GUILD_PERK_CAP, GUILD_PERK_PER_MEMBER * Math.max(0, size - 1));

/** Adds to this week's score; a new week starts from zero. */
export function addPts(state: GameState, pts: number, now: number): GameState {
  const wk = weekIndex(now);
  const base = state.wk === wk ? state.wPts : 0;
  return { ...state, wk, wPts: base + pts };
}

export const cleanGuildName = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const n = raw.replace(/\s+/g, ' ').trim();
  return n.length >= 2 && n.length <= 20 ? n : null;
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function guildCode(rand: () => number): string {
  let c = '';
  for (let i = 0; i < 5; i++) c += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return c;
}
