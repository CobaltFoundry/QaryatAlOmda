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
import { adminOverview, adminResolve } from './admin.ts';
import { buildView } from './view.ts';
import type { AdsConfig } from './view.ts';
import { claimAd, normalizePhone, requestWithdraw, startAd } from '../engine/wallet.ts';
import type { AdKind } from '../engine/wallet.ts';

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
    if (!out.ok) return json({ ok: false, error: out.error, view: buildView(acc.state, data, now, adsFor(deps, user)) });

    const saved = await store.save({ ...row, name, state: out.state }, now);
    if (!saved) continue; // someone else wrote first: reload and retry

    const before = unlockedIds(acc.state, data);
    const newly = data.assets.filter((a) => isAssetUnlocked(out.state, a) && !before.has(a.id)).map((a) => a.name);
    const more = after ? await after(out.extra) : undefined;
    return json({ ok: true, view: buildView(out.state, data, now, adsFor(deps, user)), newlyUnlocked: newly, ...out.extra, ...more });
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
    case '/api/sync':
      return mutate(deps, user, (s, acc) => ({
        ok: true,
        state: s,
        extra: {
          offline:
            acc.secondsElapsed >= 60
              ? { earned: acc.earned, seconds: acc.secondsCredited, capped: acc.capped }
              : null,
        },
      }));

    case '/api/tap': {
      const count = asInt(body.count);
      if (count === null || count < 0) return bad();
      return mutate(deps, user, (s) => {
        const r = applyTaps(s, data, now, count);
        return { ok: true, state: r.state, extra: { accepted: r.accepted, gained: r.gained } };
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
        return r.ok ? { ok: true, state: r.state, extra: { cost: r.cost, qty: r.qty } } : r;
      });
    }

    case '/api/upgrade': {
      if (typeof body.id !== 'string') return bad();
      const id = body.id;
      return mutate(deps, user, (s) => {
        const r = buyUpgrade(s, data, id);
        return r.ok ? { ok: true, state: r.state } : r;
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
      const kind = body.kind === 'points' || body.kind === 'boost' ? (body.kind as AdKind) : null;
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
        const r = claimAd(s, ticket, now, deps.ads?.live ?? false, deps.ads?.verified ?? false);
        return r.ok ? { ok: true, state: r.state, extra: { kind: r.kind, points: r.points } } : r;
      });
    }

    case '/api/wallet': {
      const list = await deps.store.userWithdrawals(user.id, 10);
      return mutate(deps, user, (s) => ({ ok: true, state: s, extra: { withdrawals: list } }));
    }

    case '/api/withdraw': {
      if (typeof body.phone !== 'string') return bad();
      const phone = normalizePhone(body.phone);
      if (!phone) return json({ ok: false, error: 'bad_phone' });
      if (await deps.store.phoneTakenByOther(phone, user.id)) return json({ ok: false, error: 'phone_taken' });
      return mutate(
        deps,
        user,
        (s) => {
          const r = requestWithdraw(s, now);
          return r.ok ? { ok: true, state: r.state, extra: { points: r.points } } : r;
        },
        async (extra) => {
          const id = await deps.store.addWithdrawal({
            userId: user.id,
            name: displayName(user),
            phone,
            points: extra!.points as number,
            createdAt: now,
          });
          return { withdrawalId: id };
        },
      );
    }

    case '/api/admin/overview': {
      if (!deps.admin?.ids.includes(user.id)) return json({ ok: false, error: 'forbidden' }, 403);
      return json(await adminOverview(deps.store, now));
    }

    case '/api/admin/resolve': {
      if (!deps.admin?.ids.includes(user.id)) return json({ ok: false, error: 'forbidden' }, 403);
      return json(await adminResolve({ store: deps.store, now, notify: deps.admin.notify }, body));
    }

    case '/api/admin/reset-me': {
      // Owner-only: restart the game for testing. Wallet, ad counters and withdrawal timing are kept.
      if (!deps.admin?.ids.includes(user.id)) return json({ ok: false, error: 'forbidden' }, 403);
      return mutate(deps, user, (s) => ({
        ok: true,
        state: {
          ...newState(now),
          walletPoints: s.walletPoints,
          lifetimePoints: s.lifetimePoints,
          lifetimeAds: s.lifetimeAds,
          adDay: s.adDay,
          adCount: s.adCount,
          lastAdAt: s.lastAdAt,
          lastWithdrawAt: s.lastWithdrawAt,
        },
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
