import {
  accrue,
  assetLevel,
  applyTaps,
  buyAsset,
  buyPrestigeUpgrade,
  buyUpgrade,
  claimBoost,
  doPrestige,
  isAssetUnlocked,
  maxAffordable,
  newState,
} from '../engine/engine.ts';
import type { AccrueResult } from '../engine/engine.ts';
import type { GameData, GameState } from '../engine/types.ts';
import type { Store } from './store.ts';
import { validateInitData } from './telegram.ts';
import type { TgUser } from './telegram.ts';
import { buildView } from './view.ts';
import type { AdsConfig } from './view.ts';
import { claimAd, startAd } from '../engine/ads.ts';
import type { AdKind } from '../engine/ads.ts';
import { dodgeTax, maybeOfferTax, payTax } from '../engine/tax.ts';
import { claimEvent } from '../engine/events.ts';
import { claimBag, claimQuest, claimStreak, claimWaseta, noteBuys, noteTaps } from '../engine/daily.ts';

export interface ApiDeps {
  store: Store;
  botToken: string;
  now: number;
  data: GameData;
  ads?: AdsConfig;
  /** Telegram ids allowed to use the in-app admin screen, and how to message a player. */
  admin?: { ids: number[]; notify: (userId: number, text: string) => Promise<void> };
  /** Ticket id generator; tests can pin it. */
  newId?: () => string;
  /** Random source (tests pin it). */
  rand?: () => number;
}

type Body = Record<string, unknown>;
type MutationResult =
  | { ok: true; state: GameState; extra?: Record<string, unknown> }
  | { ok: false; error: string };
type Mutation = (state: GameState, acc: AccrueResult) => MutationResult;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const asInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

export function displayName(u: TgUser): string {
  const n = (u.first_name ?? u.username ?? '').trim().slice(0, 24);
  return n || 'عمدة';
}

function unlockedIds(state: GameState, data: GameData): Set<number> {
  return new Set(data.assets.filter((a) => isAssetUnlocked(state, a)).map((a) => a.id));
}

const adsFor = (deps: ApiDeps, user: TgUser): AdsConfig => ({
  ...(deps.ads ?? { live: false, zone: '' }),
  isAdmin: deps.admin?.ids.includes(user.id) ?? false,
});

async function mutate(
  deps: ApiDeps,
  user: TgUser,
  fn: Mutation,
  after?: (extra: Record<string, unknown> | undefined) => Promise<Record<string, unknown> | void>,
  invitees?: { count: number; lifetime: number },
): Promise<Response> {
  const { store, data, now } = deps;
  const name = displayName(user);

  for (let attempt = 0; attempt < 4; attempt++) {
    let row = await store.get(user.id);
    if (!row) {
      await store.create(user.id, name, newState(now), null, now);
      row = await store.get(user.id);
      if (!row) continue;
    }

    const acc = accrue(row.state, data, now);
    const out = fn(acc.state, acc);
    if (!out.ok) return json({ ok: false, error: out.error, view: buildView(acc.state, data, now, adsFor(deps, user), invitees) });

    const saved = await store.save({ ...row, name, state: out.state }, now);
    if (!saved) continue; // someone else wrote first: reload and retry

    const before = unlockedIds(acc.state, data);
    const newly = data.assets.filter((a) => isAssetUnlocked(out.state, a) && !before.has(a.id)).map((a) => a.name);
    const more = after ? await after(out.extra) : undefined;
    return json({ ok: true, view: buildView(out.state, data, now, adsFor(deps, user), invitees), newlyUnlocked: newly, ...out.extra, ...more });
  }
  return json({ ok: false, error: 'busy' }, 409);
}

export async function handleApi(req: Request, deps: ApiDeps): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('tma ')) return json({ ok: false, error: 'unauthorized' }, 401);
  const user = await validateInitData(auth.slice(4), deps.botToken, Math.floor(deps.now / 1000));
  if (!user) return json({ ok: false, error: 'unauthorized' }, 401);

  const raw = await req.text();
  if (raw.length > 4096) return json({ ok: false, error: 'too_large' }, 413);
  let body: Body = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
      body = parsed as Body;
    } catch {
      return json({ ok: false, error: 'bad_request' }, 400);
    }
  }

  const { data, now } = deps;
  const bad = () => json({ ok: false, error: 'bad_request' }, 400);

  switch (new URL(req.url).pathname) {
    case '/api/sync': {
      const inv = await deps.store.invitees(user.id);
      return mutate(
        deps,
        user,
        (s, acc) => ({
          ok: true,
          // Offline earnings can be doubled with an ad until the next reward replaces them.
          state: maybeOfferTax(
            acc.secondsElapsed >= 60 && acc.earned > 0 ? { ...s, doubleCash: acc.earned } : s,
            data,
            now,
            deps.rand ?? Math.random,
          ),
          extra: {
            offline:
              acc.secondsElapsed >= 60
                ? { earned: acc.earned, seconds: acc.secondsCredited, capped: acc.capped }
                : null,
          },
        }),
        undefined,
        inv,
      );
    }

    case '/api/waseta': {
      const inv = await deps.store.invitees(user.id);
      return mutate(
        deps,
        user,
        (s) => {
          const r = claimWaseta(s, inv.lifetime);
          return r.ok ? { ok: true, state: r.state, extra: { cash: r.cash } } : r;
        },
        undefined,
        inv,
      );
    }

    case '/api/tap': {
      const count = asInt(body.count);
      if (count === null || count < 0) return bad();
      return mutate(deps, user, (s) => {
        const r = applyTaps(s, data, now, count);
        return { ok: true, state: noteTaps(r.state, r.accepted, now), extra: { accepted: r.accepted, gained: r.gained } };
      });
    }

    case '/api/buy': {
      const assetId = asInt(body.assetId);
      if (assetId === null) return bad();
      const qtyRaw = body.qty ?? 1;
      return mutate(deps, user, (s) => {
        let qty: number;
        if (qtyRaw === 'max') {
          const asset = data.assets.find((a) => a.id === assetId);
          if (!asset) return { ok: false, error: 'unknown_asset' };
          qty = maxAffordable(asset, assetLevel(s, asset.id), s.cash);
          if (qty < 1) return { ok: false, error: 'not_enough_cash' };
        } else {
          const n = asInt(qtyRaw);
          if (n === null) return { ok: false, error: 'bad_quantity' };
          qty = n;
        }
        const r = buyAsset(s, data, assetId, qty);
        return r.ok ? { ok: true, state: noteBuys(r.state, r.qty, now), extra: { cost: r.cost, qty: r.qty } } : r;
      });
    }

    case '/api/upgrade': {
      if (typeof body.id !== 'string') return bad();
      const id = body.id;
      return mutate(deps, user, (s) => {
        const r = buyUpgrade(s, data, id);
        return r.ok ? { ok: true, state: noteBuys(r.state, 1, now) } : r;
      });
    }

    case '/api/prestige':
      return mutate(deps, user, (s) => {
        const r = doPrestige(s, data, now);
        return r.ok ? { ok: true, state: r.state, extra: { starsGained: r.starsGained } } : r;
      });

    case '/api/prestige-buy': {
      if (typeof body.id !== 'string') return bad();
      const id = body.id;
      return mutate(deps, user, (s) => {
        const r = buyPrestigeUpgrade(s, data, id);
        return r.ok ? { ok: true, state: r.state } : r;
      });
    }

    case '/api/ad/start': {
      const kind = body.kind === 'boost' || body.kind === 'double' ? (body.kind as AdKind) : null;
      if (!kind) return bad();
      const id = (deps.newId ?? (() => crypto.randomUUID().replace(/-/g, '')))();
      return mutate(deps, user, (s) => {
        const r = startAd(s, kind, now, id, deps.ads?.live ?? false);
        return r.ok ? { ok: true, state: r.state, extra: { ticket: r.ticket } } : r;
      });
    }

    case '/api/ad/claim': {
      if (typeof body.ticket !== 'string') return bad();
      const ticket = body.ticket;
      return mutate(deps, user, (s) => {
        const r = claimAd(s, ticket, now, deps.ads?.live ?? false);
        return r.ok ? { ok: true, state: r.state, extra: { kind: r.kind, bonus: r.bonus } } : r;
      });
    }

    case '/api/streak':
      return mutate(deps, user, (s) => {
        const r = claimStreak(s, data, now);
        return r.ok ? { ok: true, state: r.state, extra: { day: r.day, cash: r.cash, boostMinutes: r.boostMinutes } } : r;
      });

    case '/api/quest/claim': {
      if (typeof body.id !== 'string') return bad();
      const id = body.id;
      return mutate(deps, user, (s) => {
        const r = claimQuest(s, data, id, now);
        return r.ok ? { ok: true, state: r.state, extra: { cash: r.cash, boostMinutes: r.boostMinutes } } : r;
      });
    }

    case '/api/tax/pay':
      return mutate(deps, user, (s) => {
        const r = payTax(s, now);
        return r.ok ? { ok: true, state: r.state, extra: { cost: r.cost, bag: r.bag, mult: r.mult } } : r;
      });

    case '/api/tax/dodge':
      return mutate(deps, user, (s) => dodgeTax(s, now));

    case '/api/event/claim':
      return mutate(deps, user, (s) => {
        const r = claimEvent(s, data, now);
        return r.ok ? { ok: true, state: r.state, extra: { cash: r.cash, boostMinutes: r.boostMinutes, name: r.name } } : r;
      });

    case '/api/bag':
      return mutate(deps, user, (s) => {
        const r = claimBag(s, data, now);
        return r.ok ? { ok: true, state: r.state, extra: { cash: r.cash } } : r;
      });

    case '/api/admin/overview': {
      if (!deps.admin?.ids.includes(user.id)) return json({ ok: false, error: 'forbidden' }, 403);
      return json({ ok: true, now, stats: await deps.store.stats() });
    }

    case '/api/admin/reset-me': {
      // Owner-only: restart the game for testing. Ad counters are kept.
      if (!deps.admin?.ids.includes(user.id)) return json({ ok: false, error: 'forbidden' }, 403);
      return mutate(deps, user, (s) => ({
        ok: true,
        state: { ...newState(now), lifetimeAds: s.lifetimeAds, lastAdAt: s.lastAdAt },
      }));
    }

    case '/api/leaderboard': {
      // The owner plays outside the ranking: hidden from everyone's list, but can still see where they would stand.
      const hide = deps.admin?.ids ?? [];
      const [top, row] = await Promise.all([deps.store.top(20, hide), deps.store.get(user.id)]);
      const mine = row ? row.state.lifetimeEarned : 0;
      const isOwner = hide.includes(user.id);
      return json({
        ok: true,
        top,
        me: row ? { name: row.name, lifetime: mine, rank: await deps.store.rank(mine, hide), hidden: isOwner } : null,
      });
    }

    default:
      return json({ ok: false, error: 'not_found' }, 404);
  }
}
