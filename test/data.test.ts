import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AssetDef, PrestigeUpgradeDef, UpgradeDef } from '../src/engine/types.ts';

const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../${name === 'strings' ? 'public' : 'data'}/${name}.json`, import.meta.url), 'utf8')) as T;

const assets = load<AssetDef[]>('assets');
const upgrades = load<UpgradeDef[]>('upgrades');
const prestige = load<PrestigeUpgradeDef[]>('prestige');
const strings = load<Record<string, string[]>>('strings');

test('assets: 40, ids are 1..40, cost strictly increasing, 8 per category', () => {
  assert.equal(assets.length, 40);
  assets.forEach((a, i) => assert.equal(a.id, i + 1));
  for (let i = 1; i < assets.length; i++) assert.ok(assets[i].baseCost > assets[i - 1].baseCost, `cost order at ${i + 1}`);
  const count: Record<string, number> = {};
  for (const a of assets) count[a.category] = (count[a.category] ?? 0) + 1;
  assert.deepEqual(count, { transport: 8, food: 8, realestate: 8, industry: 8, vip: 8 });
  assert.equal(new Set(assets.map((a) => a.key)).size, 40);
  for (const a of assets) {
    assert.ok(a.name.trim() && a.description.trim(), `text for ${a.id}`);
    assert.ok(a.baseIncome > 0 && a.costGrowth > 1, `numbers for ${a.id}`);
  }
});

test('assets: every asset can be unlocked at its prestige level (no dead chains)', () => {
  for (let p = 0; p <= 8; p++) {
    const owned = new Set<number>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of assets) {
        if (owned.has(a.id) || a.unlockPrestige > p) continue;
        if (a.requiresAssetId === 0 || owned.has(a.requiresAssetId)) {
          owned.add(a.id);
          changed = true;
        }
      }
    }
    const expected = assets.filter((a) => a.unlockPrestige <= p).length;
    assert.equal(owned.size, expected, `prestige ${p}: reachable ${owned.size} of ${expected}`);
  }
  assert.equal(assets[39].unlockPrestige, 8);
  assert.equal(assets[39].name, 'القصر الجمهوري');
});

test('upgrades: unique ids, valid references, required fields', () => {
  assert.equal(upgrades.length, 34);
  assert.equal(new Set(upgrades.map((u) => u.id)).size, upgrades.length);
  const ids = new Set(assets.map((a) => a.id));
  for (const u of upgrades) {
    assert.ok(u.name.trim() && u.description.trim(), u.id);
    assert.ok(u.cost > 0 && u.value > 0, u.id);
    if (u.targetAssetId) assert.ok(ids.has(u.targetAssetId), `target of ${u.id}`);
    if (u.requiresAssetId) assert.ok(ids.has(u.requiresAssetId), `requirement of ${u.id}`);
  }
});

test('prestige upgrades: sane numbers', () => {
  assert.equal(prestige.length, 10);
  assert.equal(new Set(prestige.map((p) => p.id)).size, 10);
  for (const p of prestige) {
    assert.ok(p.starCost >= 1 && p.starCostGrowth >= 1 && p.maxLevel >= 1 && p.valuePerLevel > 0, p.id);
    assert.ok(p.name.trim() && p.description.trim(), p.id);
  }
});

test('strings: only allowed placeholders, and required ones are present', () => {
  const required: Record<string, string[]> = {
    offline_welcome: ['amount'],
    offline_capped: ['amount', 'hours'],
    asset_unlocked: ['name'],
    prestige_confirm: ['stars'],
    prestige_done: ['stars'],
    boost_on: ['minutes'],
    invite_friend: ['name'],
    tax_paid: ['bag', 'mult'],
    tax_jackpot: ['bag', 'mult'],
  };
  for (const [key, list] of Object.entries(strings)) {
    assert.ok(list.length > 0, key);
    for (const s of list) {
      assert.ok(s.trim(), `${key} has an empty string`);
      const found = [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const allowed = required[key] ?? [];
      for (const f of found) assert.ok(allowed.includes(f), `${key}: unexpected {${f}} in "${s}"`);
      for (const r of allowed) assert.ok(found.includes(r), `${key}: missing {${r}} in "${s}"`);
    }
  }
});
