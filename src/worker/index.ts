import { handleAdmin } from './admin.ts';
import { handleApi } from './api.ts';
import { handleUpdate, setupBot } from './bot.ts';
import type { TgUpdate } from './bot.ts';
import { gameData } from './data.ts';
import { D1Store } from './store.ts';
import type { D1Like } from './store.ts';

export interface Env {
  DB: D1Like;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Secret: token from @BotFather. */
  BOT_TOKEN: string;
  /** Secret: any random string of letters, digits, "_" or "-". */
  WEBHOOK_SECRET: string;
  /** Secret, optional: set to 1 to pay points for ads (only after the ad network works). */
  ADS_LIVE?: string;
  /** Secret, optional: Monetag zone id for the rewarded ad. */
  MONETAG_ZONE?: string;
}

let schemaReady: Promise<void> | null = null;

function store(env: Env): D1Store {
  const s = new D1Store(env.DB);
  // Create tables once per isolate; retry on the next request if it failed.
  schemaReady ??= s.ensureSchema().catch((e) => {
    schemaReady = null;
    throw e;
  });
  return s;
}

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

const tgCall = (token: string) => async (method: string, body: unknown): Promise<unknown> => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/health') return text('ok');

    if (path.startsWith('/api/')) {
      if (!env.BOT_TOKEN) return text('BOT_TOKEN is not set', 500);
      const st = store(env);
      await schemaReady;
      return handleApi(req, {
        store: st,
        botToken: env.BOT_TOKEN,
        now: Date.now(),
        data: gameData,
        ads: { live: env.ADS_LIVE === '1' && !!env.MONETAG_ZONE, zone: (env.MONETAG_ZONE ?? '').replace(/[^0-9]/g, '') },
      });
    }

    if (path.startsWith('/admin-api/')) {
      const st = store(env);
      await schemaReady;
      const call = tgCall(env.BOT_TOKEN);
      return handleAdmin(req, {
        store: st,
        now: Date.now(),
        secret: env.WEBHOOK_SECRET ?? '',
        notify: async (userId, text) => void (await call('sendMessage', { chat_id: userId, text })),
      });
    }

    if (path === '/webhook' && req.method === 'POST') {
      if (!env.WEBHOOK_SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
        return text('forbidden', 403);
      }
      try {
        const st = store(env);
        await schemaReady;
        await handleUpdate((await req.json()) as TgUpdate, {
          store: st,
          origin: url.origin,
          now: Date.now(),
          call: tgCall(env.BOT_TOKEN),
        });
      } catch (e) {
        // Always answer 200, otherwise Telegram retries the same update forever.
        console.error('webhook error', e);
      }
      return text('ok');
    }

    // One-time setup: open  https://<your-worker>/setup?key=<WEBHOOK_SECRET>
    if (path === '/setup') {
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) return text('Set BOT_TOKEN and WEBHOOK_SECRET first', 500);
      if (url.searchParams.get('key') !== env.WEBHOOK_SECRET) return text('forbidden', 403);
      const result = await setupBot(url.origin, env.WEBHOOK_SECRET, tgCall(env.BOT_TOKEN));
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    return env.ASSETS.fetch(req);
  },
};
