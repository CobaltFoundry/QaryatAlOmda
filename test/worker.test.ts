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
  opts: { id?: number; now?: number; auth?: string | null; live?: boolean; admins?: number[] } = {},
) {
  const now = opts.now ?? NOW;
  const auth = opts.auth === undefined ? 'tma ' + (await initData(opts.id ?? 42, Math.floor(now / 1000))) : opts.auth;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  const res = await handleApi(
    new Request('https://x.test' + path, { method: 'POST', headers, body: JSON.stringify(body) }),
    { store, botToken: TOKEN, now, data: gameData, ads: { live: opts.live ?? false, zone: '123' }, newId: () => 'T' + now, admin: { ids: opts.admins ?? [], notify: async () => {} } },
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
  row.state.runEarned = 8e9;
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
    top: (n, h) => mem.top(n, h),
    rank: (l, h) => mem.rank(l, h),
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

test('leaderboard: the owner is hidden from the list and everyone else ranks without them', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync', {}, { id: 1 });
  await api(store, '/api/sync', {}, { id: 2 });
  store.rows.get(1)!.state.lifetimeEarned = 1e12; // the owner, far ahead
  store.rows.get(2)!.state.lifetimeEarned = 500;
  const asPlayer = await api(store, '/api/leaderboard', {}, { id: 2, admins: [1] });
  assert.equal(asPlayer.json.top.length, 1);
  assert.equal(asPlayer.json.me.rank, 1);
  const asOwner = await api(store, '/api/leaderboard', {}, { id: 1, admins: [1] });
  assert.equal(asOwner.json.me.rank, 1, 'the owner can see where they would stand');
  assert.equal(asOwner.json.me.hidden, true);
  assert.equal(asOwner.json.top.length, 1);
  assert.equal(asOwner.json.top[0].lifetime, 500);
  const noAdmin = await api(store, '/api/leaderboard', {}, { id: 2 });
  assert.equal(noAdmin.json.me.rank, 2, 'without an admin list nothing is hidden');
});


const DAY = 86_400_000;
const D0 = Math.floor(NOW / DAY) * DAY + 3_600_000; // an hour into a UTC day

/** Runs a full ad round: start, wait `wait` ms, claim. */
async function watch(store: Store, kind: 'boost' | 'double', at: number, opts: { live?: boolean; wait?: number } = {}) {
  const st = await api(store, '/api/ad/start', { kind }, { now: at, live: opts.live });
  if (!st.json.ok) return st;
  return api(store, '/api/ad/claim', { ticket: st.json.ticket }, { now: at + (opts.wait ?? 15_000), live: opts.live });
}

test('ads: boost needs a ticket and respects the daily limit', async () => {
  const store = new MemoryStore();
  let last: any;
  for (let i = 0; i < 10; i++) last = await watch(store, 'boost', NOW + i * 60_000);
  assert.equal(last.json.ok, true);
  assert.equal(last.json.view.boostClaimsLeft, 0);
  assert.equal((await api(store, '/api/ad/start', { kind: 'boost' }, { now: NOW + 11 * 60_000 })).json.error, 'limit');
  assert.equal((await api(store, '/api/boost')).status, 404, 'the old free boost route is gone');
  assert.equal((await api(store, '/api/ad/start', { kind: 'points' })).status, 400, 'points ads no longer exist');
});

test('ads: tickets cannot be forged, replayed, rushed or expired', async () => {
  const store = new MemoryStore();
  assert.equal((await api(store, '/api/ad/claim', { ticket: 'nope' })).json.error, 'bad_ticket');
  const st = await api(store, '/api/ad/start', { kind: 'boost' }, { live: true });
  assert.equal((await api(store, '/api/ad/claim', { ticket: 'wrong' }, { now: NOW + 20_000, live: true })).json.error, 'bad_ticket');
  assert.equal((await api(store, '/api/ad/claim', { ticket: st.json.ticket }, { now: NOW + 2_000, live: true })).json.error, 'too_early');
  assert.equal((await api(store, '/api/ad/claim', { ticket: st.json.ticket }, { now: NOW + 11 * 60_000, live: true })).json.error, 'expired');
  const at = NOW + 30 * 60_000;
  assert.equal((await watch(store, 'boost', at, { live: true })).json.ok, true);
  assert.equal((await api(store, '/api/ad/claim', { ticket: 'T' + at }, { now: at + 20_000, live: true })).json.error, 'bad_ticket', 'replay');
});

test('rewards: streak climbs daily, breaks after a missed day, day 7 adds a boost', async () => {
  const store = new MemoryStore();
  const first = await api(store, '/api/streak', {}, { now: D0 });
  assert.equal(first.json.ok, true);
  assert.equal(first.json.day, 1);
  assert.equal(first.json.cash, 300);
  assert.equal(first.json.view.cash >= 300, true);
  assert.equal((await api(store, '/api/streak', {}, { now: D0 + 5_000 })).json.error, 'not_ready', 'once a day');
  let last: any;
  for (let d = 1; d < 7; d++) last = await api(store, '/api/streak', {}, { now: D0 + d * DAY });
  assert.equal(last.json.day, 7);
  assert.equal(last.json.boostMinutes, 60);
  assert.ok(last.json.view.boostUntil > D0 + 6 * DAY);
  const wrap = await api(store, '/api/streak', {}, { now: D0 + 7 * DAY });
  assert.equal(wrap.json.day, 1, 'after day 7 the cycle restarts');
  const skip = await api(store, '/api/streak', {}, { now: D0 + 9 * DAY });
  assert.equal(skip.json.day, 1, 'a missed day resets the streak');
});

test('rewards: daily quests count real actions and each pays once', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync', {}, { now: D0 });
  assert.equal((await api(store, '/api/quest/claim', { id: 'tap' }, { now: D0 })).json.error, 'not_ready');
  await api(store, '/api/tap', { count: 20 }, { now: D0 + 1000 });
  for (let i = 1; i <= 16; i++) await api(store, '/api/tap', { count: 20 }, { now: D0 + 1000 + i * 3000 });
  const v = (await api(store, '/api/sync', {}, { now: D0 + 60_000 })).json.view;
  assert.equal(v.quests.find((q: any) => q.id === 'tap').progress, 300, 'capped at the target');
  const claim = await api(store, '/api/quest/claim', { id: 'tap' }, { now: D0 + 61_000 });
  assert.equal(claim.json.ok, true);
  assert.equal(claim.json.cash >= 500, true);
  assert.equal((await api(store, '/api/quest/claim', { id: 'tap' }, { now: D0 + 62_000 })).json.error, 'not_ready', 'only once');
  assert.equal((await api(store, '/api/quest/claim', { id: 'chest' }, { now: D0 + 63_000 })).json.error, 'not_ready', 'chest needs all quests');
  // next day the counters start over
  const next = (await api(store, '/api/sync', {}, { now: D0 + DAY })).json.view;
  assert.equal(next.quests.find((q: any) => q.id === 'tap').progress, 0);
  assert.equal(next.quests.find((q: any) => q.id === 'tap').claimed, false);
});

test('rewards: finishing every quest opens the chest once', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync', {}, { now: D0 });
  const st = store.rows.get(42)!.state;
  Object.assign(st, { qDay: Math.floor(D0 / DAY), qTaps: 300, qBuys: 10, qAds: 1, qBag: 1 });
  for (const id of ['tap', 'buy', 'ad', 'bag']) assert.equal((await api(store, '/api/quest/claim', { id }, { now: D0 + 1000 })).json.ok, true);
  const chest = await api(store, '/api/quest/claim', { id: 'chest' }, { now: D0 + 2000 });
  assert.equal(chest.json.ok, true);
  assert.equal(chest.json.boostMinutes, 30);
  assert.equal(chest.json.view.questChest, 'claimed');
  assert.equal((await api(store, '/api/quest/claim', { id: 'chest' }, { now: D0 + 3000 })).json.error, 'not_ready');
});

test('rewards: lucky bag every 30 minutes, scaled to income', async () => {
  const store = new MemoryStore();
  const one = await api(store, '/api/bag', {}, { now: D0 });
  assert.equal(one.json.ok, true);
  assert.equal(one.json.cash, 300);
  assert.equal(one.json.view.bagReady, false);
  assert.equal((await api(store, '/api/bag', {}, { now: D0 + 10 * 60_000 })).json.error, 'not_ready');
  assert.equal((await api(store, '/api/bag', {}, { now: D0 + 31 * 60_000 })).json.ok, true);
});

test('rewards: an ad doubles the last reward once, only when ads are live', async () => {
  const store = new MemoryStore();
  await api(store, '/api/bag', {}, { now: D0 });
  assert.equal(store.rows.get(42)!.state.doubleCash, 300);
  assert.equal((await api(store, '/api/ad/start', { kind: 'double' }, { now: D0 + 60_000, live: false })).json.error, 'ads_off');
  const cashBefore = store.rows.get(42)!.state.cash;
  const r = await watch(store, 'double', D0 + 60_000, { live: true });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.bonus, 300);
  assert.ok(store.rows.get(42)!.state.cash >= cashBefore + 300);
  assert.equal(store.rows.get(42)!.state.doubleCash, 0);
  assert.equal((await api(store, '/api/ad/start', { kind: 'double' }, { now: D0 + 200_000, live: true })).json.error, 'not_ready', 'nothing left to double');
});

test('rewards: offline earnings can be doubled', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync', {}, { now: D0 });
  await api(store, '/api/tap', { count: 20 }, { now: D0 + 1000 });
  for (let i = 0; i < 4; i++) await api(store, '/api/buy', { assetId: 1 }, { now: D0 + 2000 + i });
  const back = await api(store, '/api/sync', {}, { now: D0 + 3_600_000 });
  assert.ok(back.json.offline && back.json.offline.earned > 0);
  assert.equal(store.rows.get(42)!.state.doubleCash, back.json.offline.earned);
});

test('titles: the ladder climbs with prestige and the mayor is the top', async () => {
  const { titleFor, TITLES } = await import('../src/engine/daily.ts');
  assert.equal(titleFor(0), 'فلاح');
  assert.equal(titleFor(3), 'بيه');
  assert.equal(titleFor(7), 'شيخ البلد');
  assert.equal(titleFor(8), 'عمدة');
  assert.equal(titleFor(500), 'عمدة', 'nothing above the mayor');
  assert.equal(TITLES[TITLES.length - 1][1], 'عمدة');
});

test('postback: records revenue once per event, only for authentic requests', async () => {
  const { handlePostback } = await import('../src/worker/postback.ts');
  const store = new MemoryStore();
  const pb = async (q: Record<string, string>, secret = 'S3CRET') => {
    const url = new URL('https://x.test/postback');
    for (const [k, v] of Object.entries({ secret: 'S3CRET', event_type: 'impression', reward_event_type: 'valued', estimated_price: '0.0030000', ...q })) url.searchParams.set(k, v);
    const r = await handlePostback(new Request(url), { store, now: NOW, secret });
    return { status: r.status, body: await r.text() };
  };
  assert.equal((await pb({ ymid: 'b_42_ABCDEFGH1', secret: 'wrong' })).status, 403);
  assert.equal((await pb({ ymid: 'b_42_ABCDEFGH1' }, '')).status, 403);
  assert.equal((await pb({ ymid: 'garbage' })).body, 'ignored');
  assert.equal((await pb({ ymid: 'b_42_ABCDEFGH1', telegram_id: '42' })).body, 'ok');
  assert.equal((await pb({ ymid: 'b_42_ABCDEFGH1', telegram_id: '42' })).body, 'duplicate', 'Monetag retries are not double counted');
  assert.equal((await pb({ ymid: 'd_42_ABCDEFGH2', telegram_id: '99' })).body, 'ignored', 'telegram_id must match');
  assert.equal((await pb({ ymid: 'd_42_ABCDEFGH3', reward_event_type: 'non_valued', estimated_price: '0' })).body, 'ok');
  const st = await store.stats();
  assert.equal(st.adEvents, 2);
  assert.ok(Math.abs(st.revenueUsd - 0.003) < 1e-9);
});

test('in-app admin: only listed ids, overview shows revenue, reset restarts the game', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync');
  assert.equal((await api(store, '/api/admin/overview', {}, { admins: [1] })).status, 403);
  assert.equal((await api(store, '/api/sync', {}, { admins: [42] })).json.view.isAdmin, true);
  assert.equal((await api(store, '/api/sync', {}, { admins: [] })).json.view.isAdmin, false);
  const ov = await api(store, '/api/admin/overview', {}, { admins: [42] });
  assert.equal(ov.json.stats.players, 1);
  const st = store.rows.get(42)!.state;
  Object.assign(st, { cash: 5e9, stars: 900, lifetimeStars: 900, prestigeLevel: 5, lifetimeAds: 12 });
  assert.equal((await api(store, '/api/admin/reset-me', {}, { admins: [1] })).status, 403);
  assert.equal(store.rows.get(42)!.state.prestigeLevel, 5, 'untouched for non-owners');
  assert.equal((await api(store, '/api/admin/reset-me', {}, { admins: [42] })).json.ok, true);
  const after = store.rows.get(42)!.state;
  assert.deepEqual([after.prestigeLevel, after.stars, after.lifetimeStars, after.lifetimeAds], [0, 0, 0, 12]);
});

// ---- push notifications ----
import { runPush } from '../src/worker/push.ts';

const H = 3_600_000;
async function pushWith(store: Store, sent: any[], reply: any, now: number) {
  return runPush(store, gameData, async (m: string, b: any) => (sent.push({ m, ...b }), reply), 'https://x.dev', now, () => 0);
}

test('push: only players away 3-72h, once per absence, with a Mini App button', async () => {
  const store = new MemoryStore();
  for (const id of [1, 2, 3, 4]) await store.create(id, 'p' + id, newState(NOW), null, NOW);
  // 1: 1h ago (too soon), 2: 5h ago, 3: 100h ago (gave up), 4: 5h ago but muted
  (store as any).touched.set(1, NOW - 1 * H);
  (store as any).touched.set(2, NOW - 5 * H);
  (store as any).touched.set(3, NOW - 100 * H);
  (store as any).touched.set(4, NOW - 5 * H);
  store.rows.get(4)!.state.notifyOff = true;

  const sent: any[] = [];
  assert.equal(await pushWith(store, sent, { ok: true }, NOW), 1);
  assert.equal(sent[0].chat_id, 2);
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].web_app.url, 'https://x.dev');
  // second run: already notified for this absence
  assert.equal(await pushWith(store, sent, { ok: true }, NOW + H), 0);
  // player 1 (touched at NOW-1h) is now 6h idle too; player 2 comes back and leaves again
  const row = (await store.get(2))!;
  await store.save({ ...row, state: { ...row.state, lastSeen: NOW + 2 * H } }, NOW + 2 * H);
  assert.equal(await pushWith(store, sent, { ok: true }, NOW + 6 * H), 2);
});

test('push: a blocked bot (403) mutes the player for good', async () => {
  const store = new MemoryStore();
  await store.create(7, 'p', newState(NOW), null, NOW - 5 * H);
  const sent: any[] = [];
  assert.equal(await pushWith(store, sent, { ok: false, error_code: 403 }, NOW), 0);
  assert.equal(store.rows.get(7)!.state.notifyOff, true);
  assert.equal(await pushWith(store, sent, { ok: true }, NOW + 5 * H), 0);
});

test('push: a temporary failure is retried next run', async () => {
  const store = new MemoryStore();
  await store.create(8, 'p', newState(NOW), null, NOW - 5 * H);
  const sent: any[] = [];
  assert.equal(await pushWith(store, sent, { ok: false, error_code: 429 }, NOW), 0);
  assert.equal(store.rows.get(8)!.state.notifiedAt, 0);
  assert.equal(await pushWith(store, sent, { ok: true }, NOW + 1000), 1);
});

test('push: the real SQL query selects the same players', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new D1Store(sqliteD1(db));
  await store.ensureSchema();
  await store.create(1, 'a', newState(NOW), null, NOW - 5 * H);
  await store.create(2, 'b', newState(NOW), null, NOW - 1 * H);
  await store.create(3, 'c', { ...newState(NOW), notifyOff: true }, null, NOW - 5 * H);
  const sent: any[] = [];
  assert.equal(await pushWith(store, sent, { ok: true }, NOW), 1);
  assert.deepEqual(sent.map((s) => s.chat_id), [1]);
  assert.equal(await pushWith(store, sent, { ok: true }, NOW + 1000), 0);
  await store.setMeta('origin', 'https://a.dev');
  await store.setMeta('origin', 'https://b.dev');
  assert.equal(await store.getMeta('origin'), 'https://b.dev');
});

test('bot: /mute and /unmute toggle notifications', async () => {
  const { store, sent, start } = botHarness();
  await start(11, '/mute');
  assert.ok(sent[0].text.includes('/start')); // unknown player
  await start(11, '/start');
  await start(11, '/mute');
  assert.equal(store.rows.get(11)!.state.notifyOff, true);
  await start(11, '/unmute');
  assert.equal(store.rows.get(11)!.state.notifyOff, false);
});

// ---- الواسطة ----
test('waseta: 5% of invitees\' earnings, claimable in parts, capped, and both stores agree', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync', {}, { id: 42, now: D0 });
  const none = await api(store, '/api/sync', {}, { id: 42, now: D0 + 1000 });
  assert.deepEqual(none.json.view.waseta, { count: 0, pending: 0 });
  assert.equal((await api(store, '/api/waseta', {}, { id: 42, now: D0 + 1000 })).json.error, 'not_ready');

  store.rows.get(42)!.state.lifetimeEarned = 1e6;
  // two friends join through 42 and earn
  await store.create(7, 'a', { ...newState(D0), lifetimeEarned: 10_000 }, 42, D0);
  await store.create(8, 'b', { ...newState(D0), lifetimeEarned: 30_000 }, 42, D0);
  const sync = await api(store, '/api/sync', {}, { id: 42, now: D0 + 2000 });
  assert.deepEqual(sync.json.view.waseta, { count: 2, pending: 2000 });
  // other calls keep the last value instead of querying
  assert.equal((await api(store, '/api/tap', { count: 1 }, { id: 42, now: D0 + 2500 })).json.view?.waseta, undefined);

  const claim = await api(store, '/api/waseta', {}, { id: 42, now: D0 + 3000 });
  assert.equal(claim.json.ok, true);
  assert.equal(claim.json.cash, 2000);
  assert.equal(claim.json.view.waseta.pending, 0);
  assert.equal(store.rows.get(42)!.state.doubleCash, 2000);
  assert.equal((await api(store, '/api/waseta', {}, { id: 42, now: D0 + 4000 })).json.error, 'not_ready', 'no double pay');

  // friend earns more: only the new part pays
  store.rows.get(7)!.state.lifetimeEarned = 110_000;
  assert.equal((await api(store, '/api/waseta', {}, { id: 42, now: D0 + 5000 })).json.cash, 5000);
});

test('waseta: one payout is capped by the player\'s own lifetime, the rest stays claimable', async () => {
  const store = new MemoryStore();
  await api(store, '/api/sync', {}, { id: 42, now: D0 });
  await store.create(7, 'a', { ...newState(D0), lifetimeEarned: 1e9 }, 42, D0); // pending 5e7
  const first = await api(store, '/api/waseta', {}, { id: 42, now: D0 + 1000 });
  assert.equal(first.json.cash, 1000); // minimum cap since the player has earned almost nothing
  const second = await api(store, '/api/waseta', {}, { id: 42, now: D0 + 2000 });
  assert.equal(second.json.ok, true);
  assert.ok(Math.abs(first.json.cash + second.json.cash - 2000) < 5);
});

test('waseta: the real SQL counts only players invited by this one', async () => {
  const store = new D1Store(sqliteD1(new DatabaseSync(':memory:')));
  await store.ensureSchema();
  await store.create(1, 'boss', newState(NOW), null, NOW);
  await store.create(2, 'x', { ...newState(NOW), lifetimeEarned: 500 }, 1, NOW);
  await store.create(3, 'y', { ...newState(NOW), lifetimeEarned: 700 }, 1, NOW);
  await store.create(4, 'z', { ...newState(NOW), lifetimeEarned: 999 }, 2, NOW);
  assert.deepEqual(await store.invitees(1), { count: 2, lifetime: 1200 });
  assert.deepEqual(await store.invitees(9), { count: 0, lifetime: 0 });
});

// ---- events ----
import { activeEvent } from '../src/engine/events.ts';

test('events: Friday-noon rain, Ramadan iftar, Eid; nothing otherwise', () => {
  const fri = Date.UTC(2026, 10, 27, 10, 0); // Friday 27 Nov 2026, 10:00 UTC
  assert.equal(new Date(fri).getUTCDay(), 5);
  assert.equal(activeEvent(fri)?.kind, 'rain');
  assert.equal(activeEvent(Date.UTC(2026, 10, 27, 12, 0)), null, 'window closed');
  assert.equal(activeEvent(Date.UTC(2026, 10, 26, 10, 0)), null, 'Thursday');
  assert.equal(activeEvent(Date.UTC(2027, 1, 10, 15, 0))?.kind, 'iftar'); // Ramadan afternoon
  assert.equal(activeEvent(Date.UTC(2027, 1, 10, 9, 0)), null, 'Ramadan morning');
  assert.equal(activeEvent(Date.UTC(2027, 2, 10, 8, 0))?.kind, 'eid');
  // Eid wins over the Friday rain (9 Mar 2027 is a Tuesday; 12 Mar is a Friday inside the Eid period)
  assert.equal(activeEvent(Date.UTC(2027, 2, 12, 10, 0))?.kind, 'eid');
});

test('events: claim once per occurrence, again next week', async () => {
  const store = new MemoryStore();
  const fri = Date.UTC(2026, 10, 27, 10, 0);
  const sync = await api(store, '/api/sync', {}, { now: fri });
  assert.equal(sync.json.view.event.name, 'مطر دهب');
  assert.equal(sync.json.view.event.claimed, false);
  const r = await api(store, '/api/event/claim', {}, { now: fri + 1000 });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.cash, 800);
  assert.equal(r.json.view.event.claimed, true);
  assert.equal((await api(store, '/api/event/claim', {}, { now: fri + 2000 })).json.error, 'limit');
  assert.equal((await api(store, '/api/event/claim', {}, { now: fri + 4 * 3600_000 })).json.error, 'not_ready');
  const next = fri + 7 * 86_400_000;
  assert.equal((await api(store, '/api/event/claim', {}, { now: next })).json.ok, true);
  assert.equal(store.rows.get(42)!.state.evClaimed.length, 2);
});

test('events: Eid also gives an hour of x2', async () => {
  const store = new MemoryStore();
  const eid = Date.UTC(2027, 2, 10, 8, 0);
  const r = await api(store, '/api/event/claim', {}, { now: eid });
  assert.equal(r.json.cash, 5000);
  assert.ok(store.rows.get(42)!.state.boostUntil >= eid + 3600_000);
});

// ---- tax collector ----
import { TAX_MULTS, maybeOfferTax, payTax } from '../src/engine/tax.ts';

test('tax: the bag is always worth more than the fee, and the odds add up', () => {
  assert.ok(Math.abs(TAX_MULTS.reduce((a, m) => a + m[0], 0) - 1) < 1e-9);
  assert.ok(TAX_MULTS.every((m) => m[1] > 1));
  const ev = TAX_MULTS.reduce((a, m) => a + m[0] * m[1], 0);
  assert.ok(ev > 1.5 && ev < 2.5, 'expected value ' + ev);
});

test('tax: offer -> pay -> bag, then a quiet hour', async () => {
  const store = new MemoryStore();
  const rand = () => 0.7; // lands in the x2 bracket (0.55-0.90)
  const call = async (path: string, now: number, body: unknown = {}) => {
    const auth = 'tma ' + (await initData(42, Math.floor(now / 1000)));
    const res = await handleApi(
      new Request('https://x.test' + path, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      { store, botToken: TOKEN, now, data: gameData, rand, ads: { live: false, zone: '' } },
    );
    return (await res.json()) as any;
  };
  await call('/api/sync', D0);
  assert.equal((await call('/api/sync', D0 + 1000)).view.tax, null, 'too poor for a visit');
  const row = (await store.get(42))!;
  await store.save({ ...row, state: { ...row.state, cash: 10_000 } }, D0 + 1500);

  const offer = await call('/api/sync', D0 + 2000);
  assert.equal(offer.view.tax.cost, 50); // 5% of 10 000 = 500, but capped at 5 minutes of the tiny starting income
  assert.equal(JSON.stringify(offer.view).includes('taxMult'), false, 'the roll stays hidden');

  const paid = await call('/api/tax/pay', D0 + 3000);
  assert.equal(paid.ok, true);
  assert.equal(paid.bag, 100); // x2
  assert.equal(paid.mult, 2);
  const st = store.rows.get(42)!.state;
  assert.ok(st.cash >= 10_000 - 50 + 100 - 5, 'net gain, fee spent and bag credited');
  assert.equal(st.doubleCash, 100, 'the bag can be doubled with an ad');
  assert.equal((await call('/api/tax/pay', D0 + 4000)).error, 'not_ready');
  assert.equal((await call('/api/sync', D0 + 600_000)).view.tax, null, 'quiet for an hour');
  assert.ok((await call('/api/sync', D0 + 3_700_000)).view.tax, 'back after an hour');
});

test('tax: dodging costs nothing, offers expire, and you need the cash', () => {
  let s = { ...newState(NOW), cash: 1000 };
  s = maybeOfferTax(s, gameData, NOW, () => 0.1);
  assert.equal(s.taxCost, 50);
  assert.equal(payTax({ ...s, cash: 10 }, NOW).ok, false);
  assert.equal(payTax(s, NOW + 16 * 60_000).ok, false, 'expired');
  assert.equal(maybeOfferTax({ ...s, taxCost: 0, taxExp: 0 }, gameData, NOW, () => 0.1).taxCost, 50);
});
