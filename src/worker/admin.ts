import { WITHDRAW_HOLD_MS, POINTS_PER_EGP } from '../engine/wallet.ts';
import type { Store } from './store.ts';

export interface AdminDeps {
  store: Store;
  now: number;
  secret: string;
  /** Sends a Telegram message to a player (best effort). */
  notify: (userId: number, text: string) => Promise<void>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const egp = (points: number) => points / POINTS_PER_EGP;

export async function adminOverview(store: Store, now: number) {
  const [stats, pending, recent] = await Promise.all([
    store.stats(),
    store.listWithdrawals('pending', 200),
    store.listWithdrawals(null, 30),
  ]);
  return {
    ok: true,
    now,
    holdMs: WITHDRAW_HOLD_MS,
    pointsPerEgp: POINTS_PER_EGP,
    stats: { ...stats, owedEgp: egp(stats.walletPoints + stats.pendingPoints), paidEgp: egp(stats.paidPoints) },
    pending,
    recent: recent.filter((w) => w.status !== 'pending'),
  };
}

export async function adminResolve(
  deps: Pick<AdminDeps, 'store' | 'now' | 'notify'>,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const { store, now } = deps;
  const id = body.id;
  const action = body.action;
  if (typeof id !== 'number' || (action !== 'paid' && action !== 'rejected')) return { ok: false, error: 'bad_request' };
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : '';
  const w = await store.getWithdrawal(id);
  if (!w) return { ok: false, error: 'not_found' };
  if (w.status !== 'pending') return { ok: false, error: 'already_resolved' };
  if (action === 'paid' && now - w.createdAt < WITHDRAW_HOLD_MS && body.force !== true) return { ok: false, error: 'on_hold' };
  // Resolve first (atomic: only a pending row can change), then refund if rejected.
  if (!(await store.resolveWithdrawal(id, action, now, note))) return { ok: false, error: 'already_resolved' };

  if (action === 'rejected') {
    for (let i = 0; i < 6; i++) {
      const row = await store.get(w.userId);
      if (!row) break;
      const state = { ...row.state, walletPoints: row.state.walletPoints + w.points, lastWithdrawAt: 0 };
      if (await store.save({ ...row, state }, now)) break;
    }
  }
  const amount = egp(w.points);
  await deps
    .notify(
      w.userId,
      action === 'paid'
        ? `تم شحن ${amount} جنيه على الرقم ${w.phone} ✅ ألف هنا يا عمدة!`
        : `طلب السحب (${amount} جنيه) اترفض والنقاط رجعت لمحفظتك.${note ? '\nالسبب: ' + note : ''}`,
    )
    .catch(() => {});
  return { ok: true };
}

/** Key-protected variant, kept as a fallback to the in-app admin screen. */
export async function handleAdmin(req: Request, deps: AdminDeps): Promise<Response> {
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  const key = req.headers.get('x-admin-key') ?? '';
  if (!deps.secret || !safeEqual(key, deps.secret)) return json({ ok: false, error: 'forbidden' }, 403);
  const path = new URL(req.url).pathname;
  let body: Record<string, unknown> = {};
  try {
    const t = await req.text();
    if (t) body = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (path === '/admin-api/overview') return json(await adminOverview(deps.store, deps.now));
  if (path === '/admin-api/resolve') {
    const r = await adminResolve(deps, body);
    return json(r, r.error === 'not_found' ? 404 : r.error === 'bad_request' ? 400 : 200);
  }
  return json({ ok: false, error: 'not_found' }, 404);
}
