import { describe, expect, it } from 'vitest';
import { Compendium, coreCompendium, fullCompendium, parseRefKey, refKey, type IndexEntry, type TextSegment } from './compendium';
import { MAGIC_ITEMS } from './srd/magic-items';
import { MONSTERS } from './srd/monsters';
import { SPELLS } from './srd/spells';

const full = fullCompendium({ spells: SPELLS, monsters: MONSTERS, magicItems: MAGIC_ITEMS });
const links = (segments: TextSegment[]) => segments.filter((s) => s.ref || s.broken).map((s) => (s.ref ? `${s.text}→${refKey(s.ref)}` : `${s.text}✗`));
const names = (entries: IndexEntry[]) => entries.map((e) => e.name);

describe('compendium index', () => {
  it('covers every kind of SRD content with unique keys', () => {
    const kinds = new Set(full.entries.map((e) => e.kind));
    for (const k of ['condition', 'spell', 'monster', 'magic-item', 'feat', 'class', 'subclass', 'feature', 'species', 'background', 'weapon', 'armor', 'gear', 'poison', 'skill', 'damage-type', 'school', 'language']) {
      expect(kinds, k).toContain(k);
    }
    const keys = full.entries.map(refKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(full.get({ kind: 'spell', id: 'fireball' })).toMatchObject({ name: 'Fireball', summary: expect.stringContaining('3rd-level Evocation') });
    expect(full.get({ kind: 'monster', id: 'goblin-warrior' })?.summary).toMatch(/^CR 1\/4 Small/);
    expect(coreCompendium().get({ kind: 'condition', id: 'frightened' })?.summary).toMatch(/\.$/);
  });

  it('parses and resolves references', () => {
    expect(parseRefKey('spell:fireball')).toEqual({ kind: 'spell', id: 'fireball' });
    expect(parseRefKey('nonsense:x')).toBeUndefined();
    expect(full.resolve('spell:fireball')?.name).toBe('Fireball');
    expect(full.resolve('fireball')?.kind).toBe('spell');
    expect(full.byName('Shield')?.kind).toBe('spell');
    expect(full.byName('Shield', 'armor')?.kind).toBe('armor');
  });
});

describe('search', () => {
  it('ranks exact and prefix matches first', () => {
    expect(names(full.search('fireball', { limit: 3 }))[0]).toBe('Fireball');
    expect(names(full.search('fire b', { limit: 5 }))).toContain('Fire Bolt');
    // "Goblin" itself is the language; the SRD's goblins are Warrior, Boss and Minion.
    expect(names(full.search('Goblin', { limit: 6 }))).toEqual(expect.arrayContaining(['Goblin', 'Goblin Warrior', 'Goblin Boss']));
  });

  it('tolerates a typo and filters by kind', () => {
    expect(names(full.search('firebal', { limit: 3 }))).toContain('Fireball');
    expect(names(full.search('magic misile', { limit: 3 }))).toContain('Magic Missile');
    const items = full.search('holding', { kinds: ['magic-item'] });
    expect(items.every((e) => e.kind === 'magic-item')).toBe(true);
    expect(names(items)).toContain('Bag of Holding');
  });

  it('matches summaries and keywords when the name does not', () => {
    const evocation = full.search('evocation wizard', { kinds: ['spell'], limit: 200 });
    expect(names(evocation)).toContain('Fireball');
    expect(full.search('zzzzqqq')).toEqual([]);
  });
});

describe('linkify', () => {
  it('links conditions, spells, monsters and damage types in rules text', () => {
    const text = 'The target has the Frightened condition and takes 2d6 Fire damage. Goblins cast Fireball.';
    // "Goblins" isn't a stat block name (the SRD has Goblin Warrior/Boss/Minion), so it stays text.
    expect(links(full.linkify(text))).toEqual(['Frightened→condition:frightened', 'Fire→damage-type:fire', 'Fireball→spell:fireball']);
  });

  it('links plurals of creatures and weapons, but not inside words', () => {
    expect(links(full.linkify('Three Daggers and two Wolves… a Wolf howls. Daggerfall is not a dagger.'))).toEqual(['Daggers→weapon:dagger', 'Wolf→monster:wolf']);
  });

  it('only links ambiguous spell names in context', () => {
    // "Bright Light" and "Resistance" here are the rules terms, not the Light and Resistance spells.
    expect(links(full.linkify('In Bright Light you have Resistance to Fire damage.'))).toEqual([
      'Bright Light→rule:bright-light',
      'Resistance→rule:resistance',
      'Fire→damage-type:fire',
    ]);
    expect(links(full.linkify('You know the Light cantrip and can cast Shield.'))).toEqual(['Light→spell:light', 'Shield→spell:shield']);
  });

  it('tells schools from spells of the same name and skips generic item names', () => {
    expect(links(full.linkify('A Divination spell reveals it. You cast Divination. Armor of any kind; you have Darkvision.'))).toEqual([
      'Divination→school:divination',
      'Divination→spell:divination',
      'Darkvision→rule:darkvision',
    ]);
  });

  it('links each entry once and never the entry itself', () => {
    const text = 'Fireball. A Fireball explodes; another Fireball follows the Poisoned creature, still Poisoned.';
    expect(links(full.linkify(text, { self: { kind: 'spell', id: 'fireball' } }))).toEqual(['Poisoned→condition:poisoned']);
    expect(links(full.linkify('Poisoned, then Poisoned again.', { firstOnly: false }))).toEqual(['Poisoned→condition:poisoned', 'Poisoned→condition:poisoned']);
  });

  it('resolves explicit wiki links, labels and broken links', () => {
    const segs = full.linkify('See [[Fireball]], [[spell:magic-missile|the darts]] and [[Nowhere Inn]].');
    expect(links(segs)).toEqual(['Fireball→spell:fireball', 'the darts→spell:magic-missile', 'Nowhere Inn✗']);
    expect(segs.map((s) => s.text).join('')).toBe('See Fireball, the darts and Nowhere Inn.');
  });

  it('prefers campaign pages, which can be added later', () => {
    const withPages = full.with([{ kind: 'page', id: 'p1', name: 'Gundren Rockseeker', aliases: ['Gundren'], summary: 'NPC · dwarf' }]);
    // The alias links once automatically, the explicit link always, and the full name is then already linked.
    expect(links(withPages.linkify('Gundren hired you; [[Gundren]] pays well. Gundren Rockseeker is missing.'))).toEqual([
      'Gundren→page:p1',
      'Gundren→page:p1',
    ]);
    expect(withPages.search('gundr')[0]?.kind).toBe('page');
  });
});

describe('rules glossary', () => {
  it('has the SRD 5.2.1 glossary, without the conditions it repeats', () => {
    expect(full.get({ kind: 'rule', id: 'opportunity-attacks' })?.summary).toMatch(/^You can make an Opportunity Attack/);
    expect(full.get({ kind: 'rule', id: 'dash' })?.summary).toMatch(/^Action · /);
    expect(full.get({ kind: 'rule', id: 'grappled' })).toBeUndefined();
    expect(full.entries.filter((e) => e.kind === 'rule').length).toBe(140);
  });

  it('links game terms, and everyday words only in context', () => {
    const text = 'You have Advantage on the roll and can take the Dash action. Opportunity Attacks provoke. Attack rolls hit.';
    expect(links(full.linkify(text))).toEqual(['Advantage→rule:advantage', 'Dash→rule:dash', 'Opportunity Attacks→rule:opportunity-attacks']);
    expect(links(full.linkify('Each creature in a 20-foot-radius Sphere takes damage. Sphere of light.'))).toEqual(['Sphere→rule:sphere']);
    expect(links(full.linkify('It makes an Opportunity Attack against a Hostile creature that is Hostile.'))).toEqual([
      'Opportunity Attack→rule:opportunity-attacks',
      'Hostile→rule:hostile',
    ]);
    expect(links(full.linkify('Speed matters. Creature types vary. Target one creature.'))).toEqual([]);
  });

  it('keeps spells and rules of the same name apart', () => {
    expect(links(full.linkify('Magical Darkness spreads. You cast Darkness.', { firstOnly: false }))).toEqual([
      'Darkness→rule:darkness',
      'Darkness→spell:darkness',
    ]);
  });
});

describe('Compendium', () => {
  it('builds the linker lazily and handles empty input', () => {
    const c = new Compendium([]);
    expect(c.linkify('Nothing to link here.')).toEqual([{ text: 'Nothing to link here.' }]);
    expect(c.linkify('')).toEqual([]);
    expect(c.search('anything')).toEqual([]);
  });
});
