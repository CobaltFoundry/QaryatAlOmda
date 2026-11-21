import { newState } from '../engine/engine.ts';
import type { GameState } from '../engine/types.ts';

// ---- Minimal shape of the Cloudflare D1 API we use ---------------------------
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
}

export interface PlayerRow {
  userId: number;
  name: string;
  state: GameState;
  /** Optimistic-lock counter, bumped on every successful save. */
  version: number;
  referrer: number | null;
}

export type WithdrawStatus = 'pending' | 'paid' | 'rejected';
export interface Withdrawal {
  id: number;
  userId: number;
  name: string;
  phone: string;
  points: number;
  status: WithdrawStatus;
  createdAt: number;
  resolvedAt: number;
  note: string;
}
export interface AdEvent {
  ymid: string;
  event: string;
  userId: number;
  priceUsd: number;
  createdAt: number;
}
export interface Stats {
  revenueUsd: number;
  adEvents: number;
  players: number;
  walletPoints: number;
  lifetimePoints: number;
  lifetimeAds: number;
  paidPoints: number;
  pendingPoints: number;
}

export interface Store {
  get(userId: number): Promise<PlayerRow | null>;
  /** Returns false if the player already exists. */
  create(userId: number, name: string, state: GameState, referrer: number | null, now: number): Promise<boolean>;
  /** Returns false if someone else saved first (version mismatch). */
  save(row: PlayerRow, now: number): Promise<boolean>;
  /** Leaderboard; `hide` are player ids that must not appear (the owner). */
  top(limit: number, hide?: number[]): Promise<{ name: string; lifetime: number }[]>;
  /** 1-based rank of a player with this lifetime total. */
  rank(lifetime: number, hide?: number[]): Promise<number>;
  addWithdrawal(w: Omit<Withdrawal, 'id' | 'status' | 'resolvedAt' | 'note'>): Promise<number>;
  getWithdrawal(id: number): Promise<Withdrawal | null>;
  /** Moves a pending request to paid/rejected. False if it was not pending (so it can't be resolved twice). */
  resolveWithdrawal(id: number, status: 'paid' | 'rejected', now: number, note: string): Promise<boolean>;
  listWithdrawals(status: WithdrawStatus | null, limit: number): Promise<Withdrawal[]>;
  userWithdrawals(userId: number, limit: number): Promise<Withdrawal[]>;
  /** True if a non-rejected request for this phone exists from a different player. */
  phoneTakenByOther(phone: string, userId: number): Promise<boolean>;
  /** Records a Monetag postback. False if this (ymid, event) was already recorded (retries, duplicates). */
  addAdEvent(e: AdEvent): Promise<boolean>;
  stats(): Promise<Stats>;
}

function parseState(json: string, now: number): GameState {
  // Merge over defaults so fields added in later versions get a value.
  return { ...newState(now), ...(JSON.parse(json) as Partial<GameState>) };
}

// ---- D1 implementation -------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
    user_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    lifetime REAL NOT NULL DEFAULT 0,
    referrer INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_players_lifetime ON players (lifetime DESC)',
  `CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL,
    points INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    resolved_at INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS ad_events (
    ymid TEXT NOT NULL,
    event TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (ymid, event)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals (status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_wd_phone ON withdrawals (phone)',
  'CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals (user_id)',
];

interface WdRow {
  id: number;
  user_id: number;
  name: string;
  phone: string;
  points: number;
  status: WithdrawStatus;
  created_at: number;
  resolved_at: number;
  note: string;
}
const wd = (r: WdRow): Withdrawal => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  phone: r.phone,
  points: r.points,
  status: r.status,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  note: r.note,
});

export class D1Store implements Store {
  db: D1Like;
  constructor(db: D1Like) {
    this.db = db;
  }

  /** Creates the tables if missing. Cheap; call once per isolate. */
  async ensureSchema(): Promise<void> {
    for (const sql of SCHEMA) await this.db.prepare(sql).run();
  }

  async get(userId: number): Promise<PlayerRow | null> {
    const r = await this.db
      .prepare('SELECT user_id, name, state, version, referrer FROM players WHERE user_id = ?')
      .bind(userId)
      .first<{ user_id: number; name: string; state: string; version: number; referrer: number | null }>();
    if (!r) return null;
    return { userId: r.user_id, name: r.name, state: parseState(r.state, Date.now()), version: r.version, referrer: r.referrer };
  }

  async create(userId: number, name: string, state: GameState, referrer: number | null, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        'INSERT OR IGNORE INTO players (user_id, name, state, version, lifetime, referrer, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
      )
      .bind(userId, name, JSON.stringify(state), state.lifetimeEarned, referrer, now, now)
      .run();
    return (r.meta?.changes ?? 0) === 1;
  }

  async save(row: PlayerRow, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        'UPDATE players SET name = ?, state = ?, lifetime = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ?',
      )
      .bind(row.name, JSON.stringify(row.state), row.state.lifetimeEarned, now, row.userId, row.version)
      .run();
    return (r.meta?.changes ?? 0) === 1;
  }

  async top(limit: number, hide: number[] = []): Promise<{ name: string; lifetime: number }[]> {
    const marks = hide.map(() => '?').join(',');
    const r = await this.db
      .prepare(`SELECT name, lifetime FROM players ${hide.length ? `WHERE user_id NOT IN (${marks})` : ''} ORDER BY lifetime DESC LIMIT ?`)
      .bind(...hide, limit)
      .all<{ name: string; lifetime: number }>();
    return r.results.map((x) => ({ name: x.name, lifetime: x.lifetime }));
  }

  async rank(lifetime: number, hide: number[] = []): Promise<number> {
    const marks = hide.map(() => '?').join(',');
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS c FROM players WHERE lifetime > ? ${hide.length ? `AND user_id NOT IN (${marks})` : ''}`)
      .bind(lifetime, ...hide)
      .first<{ c: number }>();
    return (r?.c ?? 0) + 1;
  }

  async addWithdrawal(w: Omit<Withdrawal, 'id' | 'status' | 'resolvedAt' | 'note'>): Promise<number> {
    const r = await this.db
      .prepare('INSERT INTO withdrawals (user_id, name, phone, points, status, created_at) VALUES (?, ?, ?, ?, \'pending\', ?) RETURNING id')
      .bind(w.userId, w.name, w.phone, w.points, w.createdAt)
      .first<{ id: number }>();
    return r?.id ?? 0;
  }
  async getWithdrawal(id: number): Promise<Withdrawal | null> {
    const r = await this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').bind(id).first<WdRow>();
    return r ? wd(r) : null;
  }
  async resolveWithdrawal(id: number, status: 'paid' | 'rejected', now: number, note: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE withdrawals SET status = ?, resolved_at = ?, note = ? WHERE id = ? AND status = 'pending'")
      .bind(status, now, note, id)
      .run();
    return (r.meta?.changes ?? 0) === 1;
  }
  async listWithdrawals(status: WithdrawStatus | null, limit: number): Promise<Withdrawal[]> {
    const q = status
      ? this.db.prepare('SELECT * FROM withdrawals WHERE status = ? ORDER BY created_at ASC LIMIT ?').bind(status, limit)
      : this.db.prepare('SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT ?').bind(limit);
    return (await q.all<WdRow>()).results.map(wd);
  }
  async userWithdrawals(userId: number, limit: number): Promise<Withdrawal[]> {
    const r = await this.db
      .prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(userId, limit)
      .all<WdRow>();
    return r.results.map(wd);
  }
  async phoneTakenByOther(phone: string, userId: number): Promise<boolean> {
    const r = await this.db
      .prepare("SELECT 1 AS x FROM withdrawals WHERE phone = ? AND user_id != ? AND status != 'rejected' LIMIT 1")
      .bind(phone, userId)
      .first();
    return r !== null;
  }
  async addAdEvent(e: AdEvent): Promise<boolean> {
    const r = await this.db
      .prepare('INSERT OR IGNORE INTO ad_events (ymid, event, user_id, price, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(e.ymid, e.event, e.userId, e.priceUsd, e.createdAt)
      .run();
    return (r.meta?.changes ?? 0) === 1;
  }
  async stats(): Promise<Stats> {
    const rev = await this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS usd FROM ad_events')
      .first<{ n: number; usd: number }>();
    const p = await this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(json_extract(state, '$.walletPoints')), 0) AS w,
                COALESCE(SUM(json_extract(state, '$.lifetimePoints')), 0) AS lp,
                COALESCE(SUM(json_extract(state, '$.lifetimeAds')), 0) AS ads FROM players`,
      )
      .first<{ n: number; w: number; lp: number; ads: number }>();
    const s = await this.db
      .prepare("SELECT status, COALESCE(SUM(points), 0) AS pts FROM withdrawals GROUP BY status")
      .all<{ status: string; pts: number }>();
    const by = (st: string) => s.results.find((x) => x.status === st)?.pts ?? 0;
    return {
      revenueUsd: rev?.usd ?? 0,
      adEvents: rev?.n ?? 0,
      players: p?.n ?? 0,
      walletPoints: p?.w ?? 0,
      lifetimePoints: p?.lp ?? 0,
      lifetimeAds: p?.ads ?? 0,
      paidPoints: by('paid'),
      pendingPoints: by('pending'),
    };
  }
}

// ---- In-memory implementation (tests and the local dev server) ---------------
export class MemoryStore implements Store {
  rows = new Map<number, PlayerRow>();

  async get(userId: number): Promise<PlayerRow | null> {
    const r = this.rows.get(userId);
    return r ? structuredClone(r) : null;
  }
  async create(userId: number, name: string, state: GameState, referrer: number | null): Promise<boolean> {
    if (this.rows.has(userId)) return false;
    this.rows.set(userId, structuredClone({ userId, name, state, version: 0, referrer }));
    return true;
  }
  async save(row: PlayerRow): Promise<boolean> {
    const cur = this.rows.get(row.userId);
    if (!cur || cur.version !== row.version) return false;
    this.rows.set(row.userId, structuredClone({ ...row, version: row.version + 1 }));
    return true;
  }
  async top(limit: number, hide: number[] = []) {
    return [...this.rows.entries()]
      .filter(([id]) => !hide.includes(id))
      .map(([, r]) => r)
      .map((r) => ({ name: r.name, lifetime: r.state.lifetimeEarned }))
      .sort((a, b) => b.lifetime - a.lifetime)
      .slice(0, limit);
  }
  async rank(lifetime: number, hide: number[] = []) {
    return [...this.rows.entries()].filter(([id, r]) => !hide.includes(id) && r.state.lifetimeEarned > lifetime).length + 1;
  }

  wds: Withdrawal[] = [];
  async addWithdrawal(w: Omit<Withdrawal, 'id' | 'status' | 'resolvedAt' | 'note'>): Promise<number> {
    const id = this.wds.length + 1;
    this.wds.push({ ...w, id, status: 'pending', resolvedAt: 0, note: '' });
    return id;
  }
  async getWithdrawal(id: number) {
    const w = this.wds.find((x) => x.id === id);
    return w ? { ...w } : null;
  }
  async resolveWithdrawal(id: number, status: 'paid' | 'rejected', now: number, note: string) {
    const w = this.wds.find((x) => x.id === id);
    if (!w || w.status !== 'pending') return false;
    Object.assign(w, { status, resolvedAt: now, note });
    return true;
  }
  async listWithdrawals(status: WithdrawStatus | null, limit: number) {
    const l = this.wds.filter((w) => !status || w.status === status).map((w) => ({ ...w }));
    return (status ? l.sort((a, b) => a.createdAt - b.createdAt) : l.sort((a, b) => b.createdAt - a.createdAt)).slice(0, limit);
  }
  async userWithdrawals(userId: number, limit: number) {
    return this.wds.filter((w) => w.userId === userId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((w) => ({ ...w }));
  }
  async phoneTakenByOther(phone: string, userId: number) {
    return this.wds.some((w) => w.phone === phone && w.userId !== userId && w.status !== 'rejected');
  }
  events = new Map<string, AdEvent>();
  async addAdEvent(e: AdEvent): Promise<boolean> {
    const k = e.ymid + '|' + e.event;
    if (this.events.has(k)) return false;
    this.events.set(k, { ...e });
    return true;
  }
  async stats(): Promise<Stats> {
    const rows = [...this.rows.values()];
    const sum = (st: WithdrawStatus) => this.wds.filter((w) => w.status === st).reduce((a, w) => a + w.points, 0);
    return {
      revenueUsd: [...this.events.values()].reduce((a, e) => a + e.priceUsd, 0),
      adEvents: this.events.size,
      players: rows.length,
      walletPoints: rows.reduce((a, r) => a + r.state.walletPoints, 0),
      lifetimePoints: rows.reduce((a, r) => a + r.state.lifetimePoints, 0),
      lifetimeAds: rows.reduce((a, r) => a + r.state.lifetimeAds, 0),
      paidPoints: sum('paid'),
      pendingPoints: sum('pending'),
    };
  }
}
