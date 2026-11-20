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

export interface Store {
  get(userId: number): Promise<PlayerRow | null>;
  /** Returns false if the player already exists. */
  create(userId: number, name: string, state: GameState, referrer: number | null, now: number): Promise<boolean>;
  /** Returns false if someone else saved first (version mismatch). */
  save(row: PlayerRow, now: number): Promise<boolean>;
  top(limit: number): Promise<{ name: string; lifetime: number }[]>;
  /** 1-based rank of a player with this lifetime total. */
  rank(lifetime: number): Promise<number>;
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
];

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

  async top(limit: number): Promise<{ name: string; lifetime: number }[]> {
    const r = await this.db
      .prepare('SELECT name, lifetime FROM players ORDER BY lifetime DESC LIMIT ?')
      .bind(limit)
      .all<{ name: string; lifetime: number }>();
    return r.results.map((x) => ({ name: x.name, lifetime: x.lifetime }));
  }

  async rank(lifetime: number): Promise<number> {
    const r = await this.db.prepare('SELECT COUNT(*) AS c FROM players WHERE lifetime > ?').bind(lifetime).first<{ c: number }>();
    return (r?.c ?? 0) + 1;
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
  async top(limit: number) {
    return [...this.rows.values()]
      .map((r) => ({ name: r.name, lifetime: r.state.lifetimeEarned }))
      .sort((a, b) => b.lifetime - a.lifetime)
      .slice(0, limit);
  }
  async rank(lifetime: number) {
    return [...this.rows.values()].filter((r) => r.state.lifetimeEarned > lifetime).length + 1;
  }
}
