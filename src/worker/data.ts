import assets from '../../data/assets.json' with { type: 'json' };
import upgrades from '../../data/upgrades.json' with { type: 'json' };
import prestigeUpgrades from '../../data/prestige.json' with { type: 'json' };
import strings from '../../public/strings.json' with { type: 'json' };
import type { GameData } from '../engine/types.ts';

export const gameData: GameData = {
  assets: assets as GameData['assets'],
  upgrades: upgrades as GameData['upgrades'],
  prestigeUpgrades: prestigeUpgrades as GameData['prestigeUpgrades'],
};

export const messages = strings as Record<string, string[]>;

/** Picks a random variant and fills {placeholders}. */
export function say(key: string, vars: Record<string, string | number> = {}, rand: () => number = Math.random): string {
  const list = messages[key] ?? [''];
  const text = list[Math.floor(rand() * list.length)] ?? '';
  return text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}
