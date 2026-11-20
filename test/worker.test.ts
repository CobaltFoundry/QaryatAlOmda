import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleApi } from '../src/worker/api.ts';
import { handleUpdate } from '../src/worker/bot.ts';
import { gameData } from '../src/worker/data.ts';
import { D1Store, MemoryStore } from '../src/worker/store.ts';
import type { D1Like, D1Statement, Store } from '../src/worker/store.ts';
import { signInitData, validateInitData } from '../src/worker/telegram.ts';
import { newState } from '../src/engine/engine.ts';

const TOKEN = '123456:TEST-token';
const NOW = 1_800_000_000_000;
const user = (id: number, name = 'علي') => JSON.stringify({ id, first_name: name });

async function initData(id = 42, authDate = Math.floor(NOW / 1000), token = TOKEN): Promise<string> {
  return signInitData({ auth_date: String(authDate), query_id: 'AAH', user: user(id) }, token);
}

// ---- Telegram signature ------------------------------------------------------
test('initData: valid signature gives the user', async () => {
  const u = await validateInitData(await initData(42), TOKEN, NOW / 1000);
  assert.equal(u?.id, 42);
  assert.equal(u?.first_name, 'علي');
});

test('initData: rejects wrong token, tampering, missing hash, stale and future dates', async () => {
  const good = await initData(42);
  assert.equal(await validateInitData(good, 'other:token', NOW / 1000), null);
  assert.equal(await validateInitData(good.replace('%22id%22%3A42', '%22id%22%3A43'), TOKEN, NOW / 1000), null);
  assert.equal(await validateInitData(good.replace(/hash=[0-9a-f]+/, ''), TOKEN, NOW / 1000), null);
  assert.equal(await validateInitData('', TOKEN, NOW / 1000), null);
  assert.equal(await validateInitData(await initData(42, NOW / 1000 - 90_000), TOKEN, NOW / 1000), null);
  assert.equal(await validateInitData(await initData(42, NOW / 1000 + 3600), TOKEN, NOW / 1000), null);
});

// ---- API ---------------------------------------------------------------------
async function api(
  store: Store,
  path: string,
  body: unknown = {},
  opts: { id?: number; now?: number; auth?: string | null } = {},
) {
  const now = opts.now ?? NOW;
  const auth = opts.auth === undefined ? 'tma ' + (await initData(opts.id ?? 42, Math.floor(now / 1000))) : opts.auth;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const res = await handleApi(
    new Request('https://x.test' + path, { method: 'POST', headers, body: JSON.stringify(body) }),
    { store, botToken: TOKEN, now, data: gameData },
  );
  return { status: res.status, json: (await res.json()) as any };
}

test('api: rejects missing/forged auth, wrong method, bad json, unknown path', async () => {
  const store = new MemoryStore();
  assert.equal((await api(store, '/api/sync', {}, { auth: null })).status, 401);
  assert.equal((await api(store, '/api/sync', {}, { auth: 'tma garbage' })).status, 401);
  const get = await handleApi(new Request('https://x.test/api/sync'), { store, botToken: TOKEN, now: NOW, data: gameData });
  assert.equal(get.status, 405);
  const badJson = await handleApi(
    new Request('https://x.test/api/tap', {
      method: 'POST',
      headers: { authorization: 'tma ' + (await initData()) },
      body: '{nope',
    }),
    { store, botToken: TOKEN, now: NOW, data: gameData },
  );
  assert.equal(badJson.status, 400);
  assert.equal((await api(store, '/api/nope')).status, 404);
  assert.equal(store.rows.size, 0, 'rejected requests must not create players');
});

test('api: sync creates the player and returns a full view', async () => {
  const store = new MemoryStore();
  const r = await api(store, '/api/sync');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.view.cash, 0);
  assert.equal(r.json.view.assets.length, 40);
  assert.equal(r.json.view.assets[0].unlocked, true);
  assert.equal(r.json.view.assets[39].unlocked, false);
  assert.deepEqual(r.json.view.assets[39].lock, { kind: 'prestige', level: 8 });
  assert.equal(r.json.offline, null);
  assert.equal(store.rows.get(42)?.name, 'علي');
});

test('api: tap -> buy -> idle income -> offline report', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync');
  // 10 taps one second later = 10 EGP (tapPower 1)
  let r = await api(store, '/api/tap', { count: 10 }, { now: NOW + 1000 });
  assert.equal(r.json.accepted, 10);
  assert.equal(r.json.view.cash, 10);
  // Cannot afford a tuk tuk (15) yet
  r = await api(store, '/api/buy', { assetId: 1 }, { now: NOW + 1000 });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'not_enough_cash');
  r = await api(store, '/api/tap', { count: 10 }, { now: NOW + 2000 });
  r = await api(store, '/api/buy', { assetId: 1 }, { now: NOW + 2000 });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.view.assets[0].level, 1);
  // tuk tuk gives +1 tap power too
  assert.equal(r.json.view.tapPower, 2);
  // an hour later the player syncs and sees the offline earnings
  r = await api(store, '/api/sync', {}, { now: NOW + 2000 + 3600_000 });
  assert.ok(r.json.offline.earned > 0);
  assert.equal(r.json.offline.capped, false);
  assert.ok(r.json.view.cash > 0);
});

test('api: tap batch is clamped, garbage rejected', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync');
  let r = await api(store, '/api/tap', { count: 1_000_000 }, { now: NOW + 5000 });
  assert.equal(r.json.accepted, 5 * 15 + 10);
  assert.equal((await api(store, '/api/tap', { count: -1 })).status, 400);
  assert.equal((await api(store, '/api/tap', { count: 'lots' })).status, 400);
  assert.equal((await api(store, '/api/tap', {})).status, 400);
});

test('api: buy max, bad ids and quantities', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync');
  const s = store.rows.get(42)!;
  s.state.cash = 1000;
  s.state.lastSeen = NOW;
  let r = await api(store, '/api/buy', { assetId: 1, qty: 'max' });
  assert.equal(r.json.ok, true);
  assert.ok(r.json.view.assets[0].level >= 10);
  assert.ok(r.json.view.cash >= 0);
  r = await api(store, '/api/buy', { assetId: 999 });
  assert.equal(r.json.error, 'unknown_asset');
  r = await api(store, '/api/buy', { assetId: 1, qty: 0 });
  assert.equal(r.json.error, 'bad_quantity');
  r = await api(store, '/api/buy', { assetId: 1, qty: 'many' });
  assert.equal(r.json.error, 'bad_quantity');
  assert.equal((await api(store, '/api/buy', { assetId: 'x' })).status, 400);
});

test('api: buying reports newly unlocked assets', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync');
  store.rows.get(42)!.state.cash = 1e6;
  store.rows.get(42)!.state.lastSeen = NOW;
  // asset 4 requires owning asset 2; asset 1 unlocks nothing
  assert.deepEqual((await api(store, '/api/buy', { assetId: 1 })).json.newlyUnlocked, []);
  const r = await api(store, '/api/buy', { assetId: 2 });
  assert.deepEqual(r.json.newlyUnlocked, [gameData.assets[3].name]);
});

test('api: upgrades and prestige upgrades report proper errors', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync');
  let r = await api(store, '/api/upgrade', { id: 'nope' });
  assert.equal(r.json.error, 'unknown_upgrade');
  r = await api(store, '/api/upgrade', { id: gameData.upgrades[0].id });
  assert.equal(r.json.ok, false);
  r = await api(store, '/api/prestige');
  assert.equal(r.json.error, 'not_ready');
  r = await api(store, '/api/prestige-buy', { id: gameData.prestigeUpgrades[0].id });
  assert.equal(r.json.error, 'not_enough_stars');
  assert.equal((await api(store, '/api/upgrade', {})).status, 400);
});

test('api: prestige end to end', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync');
  const row = store.rows.get(42)!;
  row.state.runEarned = 4e9;
  row.state.cash = 123;
  row.state.assetLevels = { '1': 5 };
  row.state.lastSeen = NOW;
  let r = await api(store, '/api/prestige');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.starsGained, 2);
  assert.equal(r.json.view.stars, 2);
  assert.equal(r.json.view.prestigeLevel, 1);
  assert.equal(r.json.view.assets[0].level, 0);
  const first = gameData.prestigeUpgrades.find((p) => p.starCost <= 2)!;
  r = await api(store, '/api/prestige-buy', { id: first.id });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.view.stars, 2 - first.starCost);
});

test('api: boost claims respect the daily limit', async () => {
  const store = new MemoryStore();
  let last: any;
  for (let i = 0; i < 10; i++) last = await api(store, '/api/boost');
  assert.equal(last.json.ok, true);
  assert.equal(last.json.view.boostClaimsLeft, 0);
  const eleventh = await api(store, '/api/boost');
  assert.equal(eleventh.json.error, 'limit');
  assert.ok(eleventh.json.view.boostUntil > NOW);
});

test('api: players are isolated and the leaderboard ranks by lifetime earnings', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync', {}, { id: 1 });
  await api(store, '/api/sync', {}, { id: 2 });
  await api(store, '/api/sync', {}, { id: 3 });
  store.rows.get(1)!.state.lifetimeEarned = 100;
  store.rows.get(2)!.state.lifetimeEarned = 5000;
  store.rows.get(3)!.state.lifetimeEarned = 700;
  const r = await api(store, '/api/leaderboard', {}, { id: 3 });
  assert.deepEqual(r.json.top.map((t: any) => t.lifetime), [5000, 700, 100]);
  assert.equal(r.json.me.rank, 2);
});

test('api: a lost optimistic-lock race is retried, not dropped', async () => {
  const mem = new MemoryStore();
  await api(mem, '/api/sync');
  let injected = false;
  const racy: Store = {
    get: (id) => mem.get(id),
    create: (...a) => mem.create(a[0], a[1], a[2], a[3]),
    top: (n) => mem.top(n),
    rank: (l) => mem.rank(l),
    async save(row) {
      if (!injected) {
        injected = true;
        // another request sneaks in and saves first
        const cur = (await mem.get(row.userId))!;
        await mem.save({ ...cur, state: { ...cur.state, taps: cur.state.taps + 7 } });
      }
      return mem.save(row);
    },
  };
  const r = await api(racy, '/api/tap', { count: 5 }, { now: NOW + 1000 });
  assert.equal(r.json.ok, true);
  assert.equal(mem.rows.get(42)!.state.taps, 12, 'both writes must survive');
});

// ---- D1 SQL against real SQLite ----------------------------------------------
function sqliteD1(db: DatabaseSync): D1Like {
  return {
    prepare(sql: string) {
      let params: any[] = [];
      const st: D1Statement = {
        bind(...v: unknown[]) {
          params = v;
          return st;
        },
        async first() {
          return (db.prepare(sql).get(...params) ?? null) as any;
        },
        async run() {
          return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
        },
        async all() {
          return { results: db.prepare(sql).all(...params) as any };
        },
      };
      return st;
    },
  };
}

test('D1Store: schema, create, get, optimistic save, top and rank', async () => {
  const store = new D1Store(sqliteD1(new DatabaseSync(':memory:')));
  await store.ensureSchema();
  await store.ensureSchema(); // idempotent

  const s = newState(NOW);
  assert.equal(await store.create(1, 'أ', s, null, NOW), true);
  assert.equal(await store.create(1, 'تاني', s, null, NOW), false, 'no overwrite');
  const row = (await store.get(1))!;
  assert.equal(row.name, 'أ');
  assert.equal(row.version, 0);
  assert.equal(row.referrer, null);

  row.state.lifetimeEarned = 500;
  assert.equal(await store.save(row, NOW), true);
  assert.equal(await store.save(row, NOW), false, 'stale version must fail');
  const again = (await store.get(1))!;
  assert.equal(again.version, 1);
  assert.equal(again.state.lifetimeEarned, 500);

  await store.create(2, 'ب', { ...s, lifetimeEarned: 900 }, 1, NOW);
  await store.create(3, 'ج', { ...s, lifetimeEarned: 100 }, null, NOW);
  assert.deepEqual((await store.top(2)).map((t) => t.name), ['ب', 'أ']);
  assert.equal(await store.rank(500), 2);
  assert.equal(await store.rank(1000), 1);
  assert.equal((await store.get(2))!.referrer, 1);
  assert.equal(await store.get(99), null);
});

test('D1Store: old saves missing newer fields get defaults', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new D1Store(sqliteD1(db));
  await store.ensureSchema();
  const { boostDay: _a, boostClaims: _b, ...old } = newState(NOW);
  db.prepare('INSERT INTO players (user_id, name, state, created_at, updated_at) VALUES (?,?,?,?,?)').run(7, 'قديم', JSON.stringify(old), 1, 1);
  const row = (await store.get(7))!;
  assert.equal(row.state.boostDay, 0);
  assert.equal(row.state.boostClaims, 0);
});

// ---- Bot ---------------------------------------------------------------------
function botHarness() {
  const store = new MemoryStore();
  const sent: any[] = [];
  const deps = {
    store,
    origin: 'https://omda.example.workers.dev',
    now: NOW,
    rand: () => 0,
    call: async (method: string, body: any) => {
      sent.push({ method, ...body });
      return { ok: true };
    },
  };
  const start = (id: number, text: string, name = 'سمير', type = 'private') =>
    handleUpdate({ message: { text, chat: { id, type }, from: { id, first_name: name } } }, deps);
  return { store, sent, start };
}

test('bot: /start creates the player, welcomes with a boost and a Mini App button', async () => {
  const { store, sent, start } = botHarness();
  await start(10, '/start');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, 10);
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].web_app.url, 'https://omda.example.workers.dev');
  assert.equal(store.rows.get(10)!.state.boostUntil, NOW + 30 * 60_000);
  // second /start does not give another boost
  await start(10, '/start');
  assert.equal(store.rows.get(10)!.state.boostUntil, NOW + 30 * 60_000);
  assert.ok(!sent[1].text.includes('هدية'));
});

test('bot: referral rewards both sides once, ignores self and unknown referrers', async () => {
  const { store, sent, start } = botHarness();
  await start(1, '/start');
  await start(2, '/start ref_1', 'منى');
  assert.equal(store.rows.get(2)!.referrer, 1);
  assert.equal(store.rows.get(2)!.state.boostUntil, NOW + 90 * 60_000);
  assert.equal(store.rows.get(1)!.state.boostUntil, NOW + 30 * 60_000 + 60 * 60_000);
  assert.ok(sent.some((m) => m.chat_id === 1 && m.text.includes('منى')));

  await start(2, '/start ref_1');
  assert.equal(store.rows.get(1)!.state.boostUntil, NOW + 90 * 60_000, 'no second reward');

  await start(3, '/start ref_3');
  assert.equal(store.rows.get(3)!.referrer, null);
  await start(4, '/start ref_999');
  assert.equal(store.rows.get(4)!.referrer, null);
});

test('bot: ignores groups and updates without a sender; other text gets the button', async () => {
  const { store, sent, start } = botHarness();
  await start(5, '/start', 'x', 'group');
  assert.equal(sent.length, 0);
  assert.equal(store.rows.size, 0);
  await start(6, 'مرحبا');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].reply_markup);
  await start(6, '/help@QaryatAlOmdaBot');
  assert.ok(sent[1].text.includes('القصر'));
});
