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
  lifetimeAds: number;
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
  /** Records a Monetag postback. False if this (ymid, event) was already recorded (retries, duplicates). */
  addAdEvent(e: AdEvent): Promise<boolean>;
  /** Players whose last save was between `from` and `to` (ms), not muted, not yet notified since. */
  listIdle(from: number, to: number, limit: number): Promise<PlayerRow[]>;
  createGuild(id: string, name: string, owner: number, now: number): Promise<boolean>;
  getGuild(id: string): Promise<{ id: string; name: string; owner: number } | null>;
  guildCount(id: string): Promise<number>;
  /** Members with this week's score (0 if they have not played this week). */
  guildMembers(id: string, wk: number, limit: number): Promise<{ name: string; pts: number }[]>;
  topGuilds(wk: number, limit: number): Promise<{ id: string; name: string; pts: number; active: number }[]>;
  guildRank(pts: number, wk: number): Promise<number>;
  /** How many players this one invited and their combined lifetime earnings. */
  invitees(referrerId: number): Promise<{ count: number; lifetime: number }>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
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
  'CREATE INDEX IF NOT EXISTS idx_players_referrer ON players (referrer)',
  `CREATE TABLE IF NOT EXISTS ad_events (
    ymid TEXT NOT NULL,
    event TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (ymid, event)
  )`,
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS guilds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];
// Columns added after the first release. Each runs once; "duplicate column" means it already exists.
const MIGRATIONS = [
  'ALTER TABLE players ADD COLUMN guild TEXT',
  'ALTER TABLE players ADD COLUMN wk INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE players ADD COLUMN wpts REAL NOT NULL DEFAULT 0',
];
const AFTER_MIGRATIONS = [
  'CREATE INDEX IF NOT EXISTS idx_players_guild ON players (guild, wk)',
  'CREATE INDEX IF NOT EXISTS idx_players_week ON players (wk, guild)',
];

export class D1Store implements Store {
  db: D1Like;
  constructor(db: D1Like) {
    this.db = db;
  }

  /** Creates the tables if missing. Cheap; call once per isolate. */
  async ensureSchema(): Promise<void> {
    for (const sql of SCHEMA) await this.db.prepare(sql).run();
    for (const sql of MIGRATIONS) {
      try {
        await this.db.prepare(sql).run();
      } catch {
        // column already there
      }
    }
    for (const sql of AFTER_MIGRATIONS) await this.db.prepare(sql).run();
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
        'INSERT OR IGNORE INTO players (user_id, name, state, version, lifetime, referrer, created_at, updated_at, guild, wk, wpts) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(userId, name, JSON.stringify(state), state.lifetimeEarned, referrer, now, now, state.guildId || null, state.wk, state.wPts)
      .run();
    return (r.meta?.changes ?? 0) === 1;
  }

  async save(row: PlayerRow, now: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        'UPDATE players SET name = ?, state = ?, lifetime = ?, version = version + 1, updated_at = ?, guild = ?, wk = ?, wpts = ? WHERE user_id = ? AND version = ?',
      )
      .bind(row.name, JSON.stringify(row.state), row.state.lifetimeEarned, now, row.state.guildId || null, row.state.wk, row.state.wPts, row.userId, row.version)
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

  async addAdEvent(e: AdEvent): Promise<boolean> {
    const r = await this.db
      .prepare('INSERT OR IGNORE INTO ad_events (ymid, event, user_id, price, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(e.ymid, e.event, e.userId, e.priceUsd, e.createdAt)
      .run();
    return (r.meta?.changes ?? 0) === 1;
  }
  async createGuild(id: string, name: string, owner: number, now: number): Promise<boolean> {
    const r = await this.db.prepare('INSERT OR IGNORE INTO guilds (id, name, owner, created_at) VALUES (?, ?, ?, ?)').bind(id, name, owner, now).run();
    return (r.meta?.changes ?? 0) === 1;
  }
  async getGuild(id: string) {
    const r = await this.db.prepare('SELECT id, name, owner FROM guilds WHERE id = ?').bind(id).first<{ id: string; name: string; owner: number }>();
    return r ?? null;
  }
  async guildCount(id: string): Promise<number> {
    const r = await this.db.prepare('SELECT COUNT(*) AS c FROM players WHERE guild = ?').bind(id).first<{ c: number }>();
    return r?.c ?? 0;
  }
  async guildMembers(id: string, wk: number, limit: number) {
    const r = await this.db
      .prepare('SELECT name, CASE WHEN wk = ? THEN wpts ELSE 0 END AS pts FROM players WHERE guild = ? ORDER BY pts DESC LIMIT ?')
      .bind(wk, id, limit)
      .all<{ name: string; pts: number }>();
    return r.results.map((x) => ({ name: x.name, pts: x.pts }));
  }
  async topGuilds(wk: number, limit: number) {
    const r = await this.db
      .prepare(
        `SELECT g.id AS id, g.name AS name, SUM(p.wpts) AS pts, COUNT(*) AS active
         FROM players p JOIN guilds g ON g.id = p.guild WHERE p.wk = ?
         GROUP BY g.id ORDER BY pts DESC LIMIT ?`,
      )
      .bind(wk, limit)
      .all<{ id: string; name: string; pts: number; active: number }>();
    return r.results;
  }
  async guildRank(pts: number, wk: number): Promise<number> {
    const r = await this.db
      .prepare('SELECT COUNT(*) AS c FROM (SELECT guild FROM players WHERE wk = ? AND guild IS NOT NULL GROUP BY guild HAVING SUM(wpts) > ?)')
      .bind(wk, pts)
      .first<{ c: number }>();
    return (r?.c ?? 0) + 1;
  }
  async invitees(referrerId: number): Promise<{ count: number; lifetime: number }> {
    const r = await this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(lifetime), 0) AS l FROM players WHERE referrer = ?')
      .bind(referrerId)
      .first<{ n: number; l: number }>();
    return { count: r?.n ?? 0, lifetime: r?.l ?? 0 };
  }
  async getMeta(key: string): Promise<string | null> {
    const r = await this.db.prepare('SELECT v FROM meta WHERE k = ?').bind(key).first<{ v: string }>();
    return r?.v ?? null;
  }
  async setMeta(key: string, value: string): Promise<void> {
    await this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(key, value).run();
  }
  async listIdle(from: number, to: number, limit: number): Promise<PlayerRow[]> {
    const r = await this.db
      .prepare(
        `SELECT user_id, name, state, version, referrer FROM players
         WHERE updated_at > ? AND updated_at < ?
           AND COALESCE(json_extract(state, '$.notifyOff'), 0) = 0
           AND COALESCE(json_extract(state, '$.notifiedAt'), 0) < updated_at
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .bind(from, to, limit)
      .all<{ user_id: number; name: string; state: string; version: number; referrer: number | null }>();
    return r.results.map((x) => ({ userId: x.user_id, name: x.name, state: parseState(x.state, Date.now()), version: x.version, referrer: x.referrer }));
  }
  async stats(): Promise<Stats> {
    const rev = await this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(price), 0) AS usd FROM ad_events')
      .first<{ n: number; usd: number }>();
    const p = await this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(state, '$.lifetimeAds')), 0) AS ads FROM players")
      .first<{ n: number; ads: number }>();
    return { revenueUsd: rev?.usd ?? 0, adEvents: rev?.n ?? 0, players: p?.n ?? 0, lifetimeAds: p?.ads ?? 0 };
  }
}

// ---- In-memory implementation (tests and the local dev server) ---------------
export class MemoryStore implements Store {
  rows = new Map<number, PlayerRow>();

  async get(userId: number): Promise<PlayerRow | null> {
    const r = this.rows.get(userId);
    return r ? structuredClone(r) : null;
  }
  async create(userId: number, name: string, state: GameState, referrer: number | null, now = 0): Promise<boolean> {
    if (this.rows.has(userId)) return false;
    this.touched.set(userId, now);
    this.rows.set(userId, structuredClone({ userId, name, state, version: 0, referrer }));
    return true;
  }
  guilds = new Map<string, { id: string; name: string; owner: number }>();
  async createGuild(id: string, name: string, owner: number) {
    if (this.guilds.has(id)) return false;
    this.guilds.set(id, { id, name, owner });
    return true;
  }
  async getGuild(id: string) {
    return this.guilds.get(id) ?? null;
  }
  private members(id: string) {
    return [...this.rows.values()].filter((r) => r.state.guildId === id);
  }
  async guildCount(id: string) {
    return this.members(id).length;
  }
  async guildMembers(id: string, wk: number, limit: number) {
    return this.members(id)
      .map((r) => ({ name: r.name, pts: r.state.wk === wk ? r.state.wPts : 0 }))
      .sort((a, b) => b.pts - a.pts)
      .slice(0, limit);
  }
  private totals(wk: number) {
    const t = new Map<string, { pts: number; active: number }>();
    for (const r of this.rows.values()) {
      if (!r.state.guildId || r.state.wk !== wk) continue;
      const c = t.get(r.state.guildId) ?? { pts: 0, active: 0 };
      c.pts += r.state.wPts;
      c.active++;
      t.set(r.state.guildId, c);
    }
    return t;
  }
  async topGuilds(wk: number, limit: number) {
    return [...this.totals(wk)]
      .map(([id, c]) => ({ id, name: this.guilds.get(id)?.name ?? id, pts: c.pts, active: c.active }))
      .sort((a, b) => b.pts - a.pts)
      .slice(0, limit);
  }
  async guildRank(pts: number, wk: number) {
    return [...this.totals(wk).values()].filter((c) => c.pts > pts).length + 1;
  }
  async invitees(referrerId: number) {
    const rows = [...this.rows.values()].filter((r) => r.referrer === referrerId);
    return { count: rows.length, lifetime: rows.reduce((a, r) => a + r.state.lifetimeEarned, 0) };
  }
  meta = new Map<string, string>();
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string) {
    this.meta.set(key, value);
  }
  touched = new Map<number, number>();
  async save(row: PlayerRow, now = 0): Promise<boolean> {
    const cur = this.rows.get(row.userId);
    if (!cur || cur.version !== row.version) return false;
    this.touched.set(row.userId, now);
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

  async listIdle(from: number, to: number, limit: number): Promise<PlayerRow[]> {
    return [...this.rows.values()]
      .filter((r) => {
        const t = this.touched.get(r.userId) ?? 0;
        return t > from && t < to && !r.state.notifyOff && r.state.notifiedAt < t;
      })
      .sort((a, b) => (this.touched.get(a.userId) ?? 0) - (this.touched.get(b.userId) ?? 0))
      .slice(0, limit)
      .map((r) => structuredClone(r));
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
    return {
      revenueUsd: [...this.events.values()].reduce((a, e) => a + e.priceUsd, 0),
      adEvents: this.events.size,
      players: rows.length,
      lifetimeAds: rows.reduce((a, r) => a + r.state.lifetimeAds, 0),
    };
  }
}
