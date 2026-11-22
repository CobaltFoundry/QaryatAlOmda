import { accrue } from '../engine/engine.ts';
import type { GameData } from '../engine/types.ts';
import { say } from './data.ts';
import type { TgCall } from './bot.ts';
import type { PlayerRow, Store } from './store.ts';

export const PUSH_MIN_IDLE_MS = 3 * 3600_000;
export const PUSH_MAX_IDLE_MS = 72 * 3600_000;
/** Keeps one run well under the 50-subrequest limit (each push = 1 send + 1 save). */
export const PUSH_BATCH = 20;

/** Sends one "come back" message to players who have been away 3-72h. One push per absence. */
export async function runPush(
  store: Store,
  data: GameData,
  call: TgCall,
  origin: string,
  now: number,
  rand: () => number = Math.random,
): Promise<number> {
  const rows: PlayerRow[] = await store.listIdle(now - PUSH_MAX_IDLE_MS, now - PUSH_MIN_IDLE_MS, PUSH_BATCH);
  let sent = 0;
  for (const row of rows) {
    const capped = accrue(row.state, data, now).capped;
    const text = say(capped ? 'push_cap_reached' : 'push_money_waiting', {}, rand);
    let res: { ok?: boolean; error_code?: number } = {};
    try {
      res = (await call('sendMessage', {
        chat_id: row.userId,
        text: `👑 ${text}`,
        reply_markup: { inline_keyboard: [[{ text: '🎮 ادخل اجمع', web_app: { url: origin } }]] },
      })) as typeof res;
    } catch {
      continue;
    }
    // 403 = the player blocked the bot: never try again. Other failures: try next run.
    if (res.ok) sent++;
    else if (res.error_code !== 403) continue;
    await store.save({ ...row, state: { ...row.state, notifiedAt: now, notifyOff: res.ok ? row.state.notifyOff : true } }, now);
  }
  return sent;
}
