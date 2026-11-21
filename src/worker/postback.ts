import { creditAdPoints } from '../engine/wallet.ts';
import type { Store } from './store.ts';

export interface PostbackDeps {
  store: Store;
  now: number;
  /** Secret that Monetag puts in the postback URL. */
  secret: string;
  /** Points are only credited while ads are live. Revenue is recorded either way. */
  live: boolean;
}

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Monetag server-to-server postback (GET). The ymid we pass to the SDK is  <p|b>_<userId>_<ticket>
 * (p = points ad, b = boost ad). Anything unrecognised gets a 200 so Monetag does not retry it for hours.
 *
 * A "valued impression" means Monetag was paid, so that is the only thing that credits points.
 */
export async function handlePostback(req: Request, deps: PostbackDeps): Promise<Response> {
  if (req.method !== 'GET') return text('method', 405);
  const q = new URL(req.url).searchParams;
  const given = q.get('secret') ?? '';
  if (!deps.secret || !safeEqual(given, deps.secret)) return text('forbidden', 403);

  const m = /^([pb])_(\d{1,15})_([A-Za-z0-9]{8,64})$/.exec(q.get('ymid') ?? '');
  if (!m) return text('ignored');
  const kind = m[1];
  const userId = Number(m[2]);

  // Monetag reports the real Telegram user; refuse if it disagrees with the id in ymid.
  const tg = q.get('telegram_id') ?? '';
  if (tg !== '' && tg !== String(userId)) return text('ignored');

  const event = q.get('event_type');
  if (event !== 'impression' && event !== 'click') return text('ignored');
  const valued = q.get('reward_event_type') === 'valued';
  const price = valued ? Number(q.get('estimated_price')) : 0;
  const priceUsd = Number.isFinite(price) && price >= 0 && price < 10 ? price : 0;

  const first = await deps.store.addAdEvent({ ymid: m[0], event, userId, priceUsd, createdAt: deps.now });
  if (!first) return text('duplicate');

  if (kind === 'p' && event === 'impression' && valued && deps.live) {
    for (let i = 0; i < 6; i++) {
      const row = await deps.store.get(userId);
      if (!row) break;
      const next = creditAdPoints(row.state, deps.now);
      if (!next) break; // daily cap reached
      if (await deps.store.save({ ...row, state: next }, deps.now)) break;
    }
  }
  return text('ok');
}
