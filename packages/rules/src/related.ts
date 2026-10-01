// "Related" sections for knowledge base entries, derived from the SRD data rather than written by
// hand: what deals a damage type and what resists it, what causes a condition and who is immune,
// which weapons have a property, a school's spells, who casts a spell, and where an entry is
// mentioned (using the same linker the UI renders, so a "mentioned in" is a link you can click).
import { refKey, type Compendium, type EntryKind, type EntryRef } from './compendium';
import {
  BACKGROUNDS,
  CLASSES,
  FEATS,
  FEATURES,
  RULES_TEXT,
  TRAITS,
  WEAPONS,
  type MagicItemDef,
  type MonsterAction,
  type MonsterDef,
  type SpellDef,
} from './srd';

export interface RelatedGroup {
  title: string;
  refs: EntryRef[];
}

export interface RelatedData {
  spells: readonly SpellDef[];
  monsters: readonly MonsterDef[];
  magicItems: readonly MagicItemDef[];
}

/** A piece of text that can mention other entries. */
interface Source {
  ref: EntryRef;
  text: string;
}

const SOURCE_TITLES: Partial<Record<EntryKind, string>> = {
  spell: 'Spells',
  monster: 'Creatures',
  'magic-item': 'Magic items',
  feat: 'Feats',
  trait: 'Species traits',
  feature: 'Class features',
  condition: 'Conditions',
};
const SOURCE_ORDER: EntryKind[] = ['spell', 'monster', 'magic-item', 'feat', 'trait', 'feature', 'condition'];
const SPELL_LEVELS = ['Cantrips', '1st level', '2nd level', '3rd level', '4th level', '5th level', '6th level', '7th level', '8th level', '9th level'];

const monsterBlocks = (m: MonsterDef): MonsterAction[] => [...m.traits, ...m.actions, ...m.bonusActions, ...m.reactions, ...m.legendaryActions];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class RelatedIndex {
  private mentionIndex?: Map<string, EntryRef[]>;
  private texts?: Source[];

  constructor(
    private readonly compendium: Compendium,
    private readonly data: RelatedData,
  ) {}

  /** Every text that can mention something, with the entry it belongs to. */
  private sources(): Source[] {
    if (this.texts) return this.texts;
    const out: Source[] = [];
    for (const s of this.data.spells) out.push({ ref: { kind: 'spell', id: s.id }, text: [s.description, s.higherLevel].filter(Boolean).join('\n') });
    for (const m of this.data.monsters) out.push({ ref: { kind: 'monster', id: m.id }, text: monsterBlocks(m).map((a) => a.description).join('\n') });
    for (const i of this.data.magicItems) out.push({ ref: { kind: 'magic-item', id: i.id }, text: i.description });
    for (const f of Object.values(FEATS)) out.push({ ref: { kind: 'feat', id: f.id }, text: f.description });
    for (const t of Object.values(TRAITS)) out.push({ ref: { kind: 'trait', id: t.id }, text: t.description });
    for (const f of Object.values(FEATURES)) out.push({ ref: { kind: 'feature', id: f.id }, text: f.description });
    for (const [id, c] of Object.entries(RULES_TEXT.conditions)) out.push({ ref: { kind: 'condition', id }, text: c.description });
    return (this.texts = out);
  }

  /** Reverse links: entry key → the entries whose text links to it. Built once, on first use. */
  private mentions(): Map<string, EntryRef[]> {
    if (this.mentionIndex) return this.mentionIndex;
    const index = new Map<string, EntryRef[]>();
    for (const source of this.sources()) {
      for (const seg of this.compendium.linkify(source.text, { self: source.ref })) {
        if (!seg.ref) continue;
        const key = refKey(seg.ref);
        const list = index.get(key);
        if (list) list.push(source.ref);
        else index.set(key, [source.ref]);
      }
    }
    return (this.mentionIndex = index);
  }

  /** Sources whose text matches a pattern (e.g. "Resistance to … Fire"). */
  private matching(kinds: readonly EntryKind[], pattern: RegExp): EntryRef[] {
    return this.sources()
      .filter((s) => kinds.includes(s.ref.kind) && pattern.test(s.text))
      .map((s) => s.ref);
  }

  groups(ref: EntryRef): RelatedGroup[] {
    const name = this.compendium.get(ref)?.name ?? ref.id;
    const groups: RelatedGroup[] = [];
    const used = new Set<string>([refKey(ref)]);
    const add = (title: string, refs: Iterable<EntryRef>, { claim = true } = {}) => {
      const unique = [...new Map([...refs].filter((r) => !used.has(refKey(r)) || !claim).map((r) => [refKey(r), r])).values()];
      if (!unique.length) return;
      if (claim) for (const r of unique) used.add(refKey(r));
      groups.push({ title, refs: this.sortByName(unique) });
    };
    const monsters = this.data.monsters;
    const spells = this.data.spells;

    switch (ref.kind) {
      case 'damage-type': {
        const d = ref.id;
        const deals = (a: MonsterAction) =>
          [...(a.attack?.damage ?? []), ...(a.attack?.riders ?? []), ...(a.save?.damage ?? [])].some((x) => x.type === d);
        add('Spells that deal it', spells.filter((s) => s.damageType === d).map((s) => ({ kind: 'spell', id: s.id })));
        add('Weapons', Object.values(WEAPONS).filter((w) => w.damageType === d).map((w) => ({ kind: 'weapon', id: w.id })));
        add('Creatures that deal it', monsters.filter((m) => monsterBlocks(m).some(deals)).map((m) => ({ kind: 'monster', id: m.id })));
        const protects = new RegExp(`\\b(Resistance|Immunity)\\b[^.]*\\b${escape(name)}\\b`, 'i');
        add('Protection', this.matching(['magic-item', 'trait', 'feat', 'feature', 'spell'], protects));
        add('Resisted by', monsters.filter((m) => m.resistances.includes(d)).map((m) => ({ kind: 'monster', id: m.id })), { claim: false });
        add('Immune', monsters.filter((m) => m.immunities.includes(d)).map((m) => ({ kind: 'monster', id: m.id })), { claim: false });
        add('Vulnerable', monsters.filter((m) => m.vulnerabilities.includes(d)).map((m) => ({ kind: 'monster', id: m.id })), { claim: false });
        break;
      }
      case 'condition': {
        const protects = new RegExp(`(Immunity to|immune to|can't (be|have)|Advantage on saving throws)[^.]*\\b${escape(name)}\\b`, 'i');
        add('Protection', this.matching(['magic-item', 'trait', 'feat', 'feature', 'spell'], protects));
        add('Immune creatures', monsters.filter((m) => m.conditionImmunities.includes(ref.id)).map((m) => ({ kind: 'monster', id: m.id })), { claim: false });
        this.addMentions(add, ref, { spell: 'Spells that cause or mention it', monster: 'Creatures that cause it' });
        return groups;
      }
      case 'skill':
        add('Backgrounds', Object.values(BACKGROUNDS).filter((b) => b.skills.includes(ref.id as never)).map((b) => ({ kind: 'background', id: b.id })));
        add('Classes', Object.values(CLASSES).filter((c) => c.skillChoice && (c.skillChoice.from === 'any' || c.skillChoice.from.includes(ref.id as never))).map((c) => ({ kind: 'class', id: c.id })));
        add('Species traits', Object.values(TRAITS).filter((t) => t.skillChoice?.from.includes(ref.id as never)).map((t) => ({ kind: 'trait', id: t.id })));
        break;
      case 'property':
        add('Weapons', Object.values(WEAPONS).filter((w) => w.properties.includes(ref.id)).map((w) => ({ kind: 'weapon', id: w.id })));
        break;
      case 'mastery':
        add('Weapons', Object.values(WEAPONS).filter((w) => w.mastery === ref.id).map((w) => ({ kind: 'weapon', id: w.id })));
        add('Classes with Weapon Mastery', Object.values(CLASSES).filter((c) => c.levels.some((l) => l.features.some((f) => f.endsWith('-weapon-mastery')))).map((c) => ({ kind: 'class', id: c.id })));
        break;
      case 'school':
        this.addSpellLevels(add, spells.filter((s) => s.school === ref.id));
        return groups;
      case 'language': {
        const speaks = new RegExp(`\\b${escape(name)}\\b`);
        add('Creatures that speak it', monsters.filter((m) => speaks.test(m.languages)).map((m) => ({ kind: 'monster', id: m.id })));
        break;
      }
      case 'spell':
        add('Creatures that cast it', monsters.filter((m) => monsterBlocks(m).some((a) => a.spells?.includes(ref.id))).map((m) => ({ kind: 'monster', id: m.id })));
        add('Species traits', Object.values(TRAITS).filter((t) => t.spells?.includes(ref.id)).map((t) => ({ kind: 'trait', id: t.id })));
        break;
      case 'class':
        this.addSpellLevels(add, spells.filter((s) => s.classes.includes(ref.id)), 'Spell list: ');
        add('Magic items it can attune to', this.data.magicItems.filter((i) => i.limitedTo && new RegExp(`\\b${escape(name)}\\b`).test(i.limitedTo)).map((i) => ({ kind: 'magic-item', id: i.id })));
        break;
      case 'feat':
        add('Backgrounds', Object.values(BACKGROUNDS).filter((b) => b.feat.id === ref.id).map((b) => ({ kind: 'background', id: b.id })));
        break;
      case 'magic-item': {
        const item = this.data.magicItems.find((i) => i.id === ref.id);
        add('Variants', (item?.variants ?? []).map((id) => ({ kind: 'magic-item', id })));
        break;
      }
    }
    this.addMentions(add, ref);
    return groups;
  }

  private addMentions(add: (title: string, refs: Iterable<EntryRef>) => void, ref: EntryRef, titles: Partial<Record<EntryKind, string>> = {}) {
    const mentioned = this.mentions().get(refKey(ref)) ?? [];
    for (const kind of SOURCE_ORDER) {
      const refs = mentioned.filter((r) => r.kind === kind);
      if (refs.length) add(titles[kind] ?? `Mentioned by ${SOURCE_TITLES[kind]!.toLowerCase()}`, refs);
    }
  }

  private addSpellLevels(add: (title: string, refs: Iterable<EntryRef>) => void, list: readonly SpellDef[], prefix = '') {
    for (let level = 0; level <= 9; level++) {
      add(`${prefix}${SPELL_LEVELS[level]}`, list.filter((s) => s.level === level).map((s) => ({ kind: 'spell', id: s.id })));
    }
  }

  private sortByName(refs: EntryRef[]): EntryRef[] {
    const name = (r: EntryRef) => this.compendium.get(r)?.name ?? r.id;
    return refs.sort((a, b) => name(a).localeCompare(name(b)));
  }
}
