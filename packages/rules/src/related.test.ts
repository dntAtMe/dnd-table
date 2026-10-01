import { describe, expect, it } from 'vitest';
import { fullCompendium, type EntryRef } from './compendium';
import { RelatedIndex } from './related';
import { MAGIC_ITEMS } from './srd/magic-items';
import { MONSTERS } from './srd/monsters';
import { SPELLS } from './srd/spells';

const data = { spells: SPELLS, monsters: MONSTERS, magicItems: MAGIC_ITEMS };
const compendium = fullCompendium(data);
const related = new RelatedIndex(compendium, data);

function group(ref: EntryRef, title: string): string[] {
  return (related.groups(ref).find((g) => g.title === title)?.refs ?? []).map((r) => r.id);
}
const titles = (ref: EntryRef) => related.groups(ref).map((g) => g.title);

describe('RelatedIndex', () => {
  it('explains a damage type: what deals it, who resists it, what protects', () => {
    const piercing = { kind: 'damage-type', id: 'piercing' } as const;
    expect(group(piercing, 'Weapons')).toEqual(expect.arrayContaining(['dagger', 'rapier', 'longbow']));
    expect(group(piercing, 'Creatures that deal it').length).toBeGreaterThan(50);
    expect(group(piercing, 'Resisted by').length).toBe(21);
    const fire = { kind: 'damage-type', id: 'fire' } as const;
    expect(group(fire, 'Spells that deal it')).toEqual(expect.arrayContaining(['fireball', 'fire-bolt']));
    expect(group(fire, 'Immune').length).toBe(36);
    expect(group(fire, 'Protection').length).toBeGreaterThan(0);
  });

  it('explains a condition: what causes it and who is immune', () => {
    const frightened = { kind: 'condition', id: 'frightened' } as const;
    expect(group(frightened, 'Spells that cause or mention it')).toContain('fear');
    expect(group(frightened, 'Immune creatures').length).toBe(43);
    expect(group({ kind: 'condition', id: 'poisoned' }, 'Immune creatures').length).toBe(66);
  });

  it('lists spells by level for schools and class spell lists', () => {
    expect(group({ kind: 'school', id: 'evocation' }, '3rd level')).toContain('fireball');
    expect(group({ kind: 'class', id: 'wizard' }, 'Spell list: Cantrips')).toContain('fire-bolt');
    expect(titles({ kind: 'class', id: 'fighter' }).some((t) => t.startsWith('Spell list'))).toBe(false);
  });

  it('finds who casts a spell and what mentions it', () => {
    const fireball = { kind: 'spell', id: 'fireball' } as const;
    expect(group(fireball, 'Creatures that cast it').length).toBeGreaterThan(0);
    expect(group(fireball, 'Mentioned by magic items')).toEqual(expect.arrayContaining(['wand-of-fireballs']));
  });

  it('links weapon properties, masteries, skills and languages to what uses them', () => {
    expect(group({ kind: 'property', id: 'finesse' }, 'Weapons')).toEqual(expect.arrayContaining(['dagger', 'rapier']));
    expect(group({ kind: 'mastery', id: 'vex' }, 'Weapons')).toContain('rapier');
    expect(group({ kind: 'skill', id: 'stealth' }, 'Backgrounds')).toContain('criminal');
    expect(group({ kind: 'skill', id: 'stealth' }, 'Classes')).toEqual(expect.arrayContaining(['rogue', 'bard']));
    expect(group({ kind: 'language', id: 'draconic' }, 'Creatures that speak it').length).toBeGreaterThan(10);
  });

  it('never lists an entry under itself or twice', () => {
    for (const ref of [{ kind: 'spell', id: 'fireball' }, { kind: 'damage-type', id: 'cold' }] as const) {
      const claimed = related
        .groups(ref)
        .filter((g) => !['Resisted by', 'Immune', 'Vulnerable', 'Immune creatures'].includes(g.title))
        .flatMap((g) => g.refs.map((r) => `${r.kind}:${r.id}`));
      expect(claimed).not.toContain(`${ref.kind}:${ref.id}`);
      expect(new Set(claimed).size).toBe(claimed.length);
    }
  });
});
