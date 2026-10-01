// The knowledge base: one index over all SRD content (plus campaign pages), with fuzzy search and
// a linker that turns names in any text ("Frightened", "Fireball", "Goblins") into references.
import { formatCr } from './monsters';
import {
  ARMOR,
  BACKGROUNDS,
  CLASSES,
  FEATS,
  FEATURES,
  GEAR,
  RULES_TEXT,
  SKILLS,
  SPECIES,
  SUBCLASSES,
  SUBSPECIES,
  TRAITS,
  WEAPONS,
  type MagicItemDef,
  type MonsterDef,
  type SpellDef,
} from './srd';

export const ENTRY_KINDS = [
  'page',
  'condition',
  'school',
  'spell',
  'magic-item',
  'monster',
  'feat',
  'class',
  'subclass',
  'feature',
  'species',
  'lineage',
  'trait',
  'background',
  'weapon',
  'armor',
  'gear',
  'poison',
  'mastery',
  'property',
  'skill',
  'damage-type',
  'alignment',
  'language',
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const KIND_LABELS: Record<EntryKind, string> = {
  page: 'Campaign page',
  condition: 'Condition',
  spell: 'Spell',
  'magic-item': 'Magic item',
  monster: 'Monster',
  feat: 'Feat',
  class: 'Class',
  subclass: 'Subclass',
  feature: 'Class feature',
  species: 'Species',
  lineage: 'Lineage',
  trait: 'Species trait',
  background: 'Background',
  weapon: 'Weapon',
  armor: 'Armor',
  gear: 'Gear',
  poison: 'Poison',
  mastery: 'Weapon mastery',
  property: 'Weapon property',
  skill: 'Skill',
  'damage-type': 'Damage type',
  school: 'School of magic',
  alignment: 'Alignment',
  language: 'Language',
};

export interface EntryRef {
  kind: EntryKind;
  id: string;
}

export interface IndexEntry extends EntryRef {
  name: string;
  aliases?: string[];
  /** One line shown in search results and popup headers. */
  summary: string;
  /** Extra searchable words (school, creature type, classes…). */
  keywords?: string;
}

export const refKey = (ref: EntryRef): string => `${ref.kind}:${ref.id}`;

export function parseRefKey(key: string): EntryRef | undefined {
  const i = key.indexOf(':');
  const kind = key.slice(0, i) as EntryKind;
  return i > 0 && (ENTRY_KINDS as readonly string[]).includes(kind) ? { kind, id: key.slice(i + 1) } : undefined;
}

// ---------- entries from SRD data ----------

const ORDINAL = ['Cantrip', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const firstSentence = (text: string | undefined) => {
  const t = (text ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const m = /^(.{1,160}?[.!?])(\s|$)/.exec(t);
  return m ? m[1]! : t.slice(0, 160);
};

/** Entries for everything in the main SRD bundle (spells, monsters and magic items load separately). */
export function coreEntries(): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const [id, c] of Object.entries(RULES_TEXT.conditions)) out.push({ kind: 'condition', id, name: c.name, summary: firstSentence(c.description) });
  for (const f of Object.values(FEATS)) out.push({ kind: 'feat', id: f.id, name: f.name, summary: `${cap(f.type.replace('-', ' '))} feat`, keywords: f.type });
  for (const c of Object.values(CLASSES)) {
    out.push({ kind: 'class', id: c.id, name: c.name, summary: `Class · d${c.hitDie} Hit Die · ${c.primaryAbilities.map((a) => a.toUpperCase()).join(c.primaryAbilityChoice ? ' or ' : ' & ')}` });
  }
  for (const s of Object.values(SUBCLASSES)) out.push({ kind: 'subclass', id: s.id, name: s.name, summary: `${CLASSES[s.classId]?.name ?? s.classId} subclass · ${s.summary}`, keywords: s.classId });
  for (const f of Object.values(FEATURES)) {
    if (/subclass( feature)?$/i.test(f.name) || f.name === 'Ability Score Improvement') continue;
    out.push({ kind: 'feature', id: f.id, name: f.name, summary: `${CLASSES[f.classId]?.name ?? f.classId} ${f.level} feature`, keywords: f.classId });
  }
  for (const s of Object.values(SPECIES)) out.push({ kind: 'species', id: s.id, name: s.name, summary: `Species · ${s.sizes.join(' or ')} · ${s.speed} ft` });
  for (const s of Object.values(SUBSPECIES)) {
    out.push({ kind: 'lineage', id: s.id, name: s.name.split(': ').pop()!, aliases: [s.name], summary: `${SPECIES[s.speciesId]?.name ?? s.speciesId} · ${s.name.split(': ')[0]}`, keywords: s.speciesId });
  }
  for (const t of Object.values(TRAITS)) out.push({ kind: 'trait', id: t.id, name: t.name, summary: firstSentence(t.description) });
  for (const b of Object.values(BACKGROUNDS)) {
    out.push({ kind: 'background', id: b.id, name: b.name, summary: `Background · ${b.abilities.map((a) => a.toUpperCase()).join(', ')} · ${FEATS[b.feat.id]?.name ?? b.feat.id}` });
  }
  for (const w of Object.values(WEAPONS)) {
    out.push({ kind: 'weapon', id: w.id, name: w.name, summary: `${cap(w.category)} ${w.ranged ? 'ranged' : 'melee'} weapon · ${w.damage} ${w.damageType} · ${cap(w.mastery)}` });
  }
  for (const a of Object.values(ARMOR)) {
    const ac = a.category === 'shield' ? `+${a.baseAc} AC` : `AC ${a.baseAc}${a.dexBonus ? (a.maxDex !== undefined ? ` + Dex (max ${a.maxDex})` : ' + Dex') : ''}`;
    out.push({ kind: 'armor', id: a.id, name: a.name, summary: a.category === 'shield' ? `Shield · ${ac}` : `${cap(a.category)} armor · ${ac}` });
  }
  for (const g of Object.values(GEAR)) out.push({ kind: 'gear', id: g.id, name: g.name, summary: [g.category?.replace(/-/g, ' '), g.cost].filter(Boolean).map((s) => cap(s!)).join(' · ') || 'Gear' });
  for (const [id, p] of Object.entries(RULES_TEXT.poisons)) out.push({ kind: 'poison', id, name: p.name, summary: `${cap(p.type)} poison · ${p.cost} GP` });
  for (const [id, m] of Object.entries(RULES_TEXT.masteries)) out.push({ kind: 'mastery', id, name: m.name, summary: firstSentence(m.description) });
  for (const [id, p] of Object.entries(RULES_TEXT.weaponProperties)) out.push({ kind: 'property', id, name: p.name, summary: firstSentence(p.description) });
  for (const [id, s] of Object.entries(RULES_TEXT.skills)) out.push({ kind: 'skill', id, name: s.name, summary: `${SKILLS[id as keyof typeof SKILLS]?.ability.toUpperCase() ?? ''} skill · ${firstSentence(s.description)}` });
  for (const [id, d] of Object.entries(RULES_TEXT.damageTypes)) out.push({ kind: 'damage-type', id, name: d.name, summary: `Damage type · ${d.description}` });
  for (const [id, d] of Object.entries(RULES_TEXT.schools)) out.push({ kind: 'school', id, name: d.name, summary: `School of magic · ${d.description}` });
  for (const [id, d] of Object.entries(RULES_TEXT.alignments)) out.push({ kind: 'alignment', id, name: d.name, aliases: [d.abbreviation], summary: firstSentence(d.description) });
  for (const [id, d] of Object.entries(RULES_TEXT.languages)) out.push({ kind: 'language', id, name: d.name, summary: `${d.rare ? 'Rare' : 'Standard'} language${d.note ? ` · ${d.note}` : ''}` });
  return out;
}

export function spellEntries(spells: readonly SpellDef[]): IndexEntry[] {
  return spells.map((s) => ({
    kind: 'spell',
    id: s.id,
    name: s.name,
    summary: `${s.level === 0 ? 'Cantrip' : `${ORDINAL[s.level]}-level`} ${cap(s.school)}${s.ritual ? ' (ritual)' : ''} · ${s.classes.map(cap).join(', ')}`,
    keywords: [s.school, ...s.classes, s.ritual && 'ritual', s.concentration && 'concentration', s.damageType].filter(Boolean).join(' '),
  }));
}

export function monsterEntries(monsters: readonly MonsterDef[]): IndexEntry[] {
  return monsters.map((m) => ({
    kind: 'monster',
    id: m.id,
    name: m.name,
    summary: `CR ${formatCr(m.cr)} ${m.size} ${m.type}`,
    keywords: `${m.type} ${m.alignment}`,
  }));
}

export function magicItemEntries(items: readonly MagicItemDef[]): IndexEntry[] {
  return items.map((m) => ({
    kind: 'magic-item',
    id: m.id,
    name: m.name,
    summary: [m.type, m.rarity, m.attunement && 'requires attunement'].filter(Boolean).join(' · '),
    keywords: [m.category, m.rarity].filter(Boolean).join(' '),
  }));
}

// ---------- search ----------

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Edit distance, capped: returns max + 1 as soon as it's clear the strings are further apart. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

interface SearchDoc {
  entry: IndexEntry;
  name: string;
  aliases: string[];
  words: string[];
  extra: string;
}

export interface SearchOptions {
  kinds?: readonly EntryKind[];
  limit?: number;
}

const KIND_RANK = Object.fromEntries(ENTRY_KINDS.map((k, i) => [k, i])) as Record<EntryKind, number>;

// ---------- linking ----------

export type TextSegment = { text: string; ref?: EntryRef; broken?: boolean };

export interface LinkOptions {
  /** Don't link the entry this text describes. */
  self?: EntryRef;
  /** Link each entry only the first time it appears (default true). */
  firstOnly?: boolean;
  /** Only auto-link these kinds (explicit [[links]] always resolve). */
  kinds?: readonly EntryKind[];
}

/** Kinds linked automatically when their names appear in text. */
const AUTO_KINDS = new Set<EntryKind>([
  'page',
  'condition',
  'spell',
  'magic-item',
  'monster',
  'feat',
  'class',
  'subclass',
  'species',
  'background',
  'weapon',
  'armor',
  'poison',
  'property',
  'skill',
  'damage-type',
  'school',
]);

/** Kinds whose names are often used in the plural ("Goblins", "Daggers"). */
const PLURAL_KINDS = new Set<EntryKind>(['monster', 'weapon', 'armor', 'gear', 'magic-item']);

/** Kinds whose names are everyday words: link only next to a telling word. */
const KIND_CONTEXT: Partial<Record<EntryKind, { after?: RegExp; before?: RegExp }>> = {
  property: { after: /^\s+propert(y|ies)\b/i },
  'damage-type': { after: /^\s+damage\b/i },
  school: { after: /^\s+(spells?|school)\b/i },
};

/**
 * Spell names that are also rules terms or common words ("Resistance to Fire damage", "Bright
 * Light"): only linked as "the Light cantrip", "a Shield spell" or "cast Shield".
 */
const CONTEXT_ONLY_SPELLS = new Set([
  'Alarm',
  'Bane',
  'Bless',
  'Command',
  'Confusion',
  'Darkness',
  'Darkvision',
  'Daylight',
  'Fear',
  'Fly',
  'Guidance',
  'Haste',
  'Heroism',
  'Invisibility',
  'Jump',
  'Knock',
  'Light',
  'Mending',
  'Message',
  'Resistance',
  'Sanctuary',
  'Sending',
  'Shatter',
  'Shield',
  'Silence',
  'Sleep',
  'Slow',
  'Teleport',
  'Web',
  'Wish',
]);
const SPELL_CONTEXT = { after: /^\s+(spell|cantrip)s?\b/i, before: /\b(cast|casts|casting|cast the|of)\s+$/i };

/** Names too generic to auto-link at all (still searchable and linkable with [[ ]]). */
const NEVER_AUTO = new Set(['Common', 'Spellcasting', 'Armor', 'Weapon', 'Ammunition']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WIKI_LINK = /\[\[([^\][|]+)(?:\|([^\][]+))?\]\]/g;

export class Compendium {
  readonly entries: readonly IndexEntry[];
  private readonly byKey = new Map<string, IndexEntry>();
  private readonly byLowerName = new Map<string, IndexEntry[]>();
  private docs?: SearchDoc[];
  private linker?: { pattern: RegExp; byName: Map<string, IndexEntry[]> };

  constructor(entries: readonly IndexEntry[]) {
    this.entries = entries;
    for (const e of entries) {
      this.byKey.set(refKey(e), e);
      for (const n of [e.name, ...(e.aliases ?? [])]) {
        const key = n.toLowerCase();
        const list = this.byLowerName.get(key);
        if (list) list.push(e);
        else this.byLowerName.set(key, [e]);
      }
    }
    for (const list of this.byLowerName.values()) list.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  }

  /** A new compendium with more entries (e.g. campaign pages); same-key entries are replaced. */
  with(extra: readonly IndexEntry[]): Compendium {
    const keys = new Set(extra.map(refKey));
    return new Compendium([...extra, ...this.entries.filter((e) => !keys.has(refKey(e)))]);
  }

  get(ref: EntryRef): IndexEntry | undefined {
    return this.byKey.get(refKey(ref));
  }

  /** Looks an entry up by name or alias (case-insensitive), preferring `kind` when given. */
  byName(name: string, kind?: EntryKind): IndexEntry | undefined {
    const list = this.byLowerName.get(name.trim().toLowerCase());
    if (!list) return undefined;
    return (kind && list.find((e) => e.kind === kind)) || list[0];
  }

  /** Resolves "kind:id" or a name. */
  resolve(target: string): IndexEntry | undefined {
    const ref = parseRefKey(target.trim());
    return (ref && this.get(ref)) || this.byName(target);
  }

  search(query: string, opts: SearchOptions = {}): IndexEntry[] {
    const q = normalize(query);
    const kinds = opts.kinds ? new Set(opts.kinds) : undefined;
    const limit = opts.limit ?? 50;
    const docs = (this.docs ??= this.entries.map((entry) => {
      const name = normalize(entry.name);
      const aliases = (entry.aliases ?? []).map(normalize);
      return { entry, name, aliases, words: [name, ...aliases].join(' ').split(' '), extra: normalize(`${entry.summary} ${entry.keywords ?? ''}`) };
    }));
    if (!q) return docs.filter((d) => !kinds || kinds.has(d.entry.kind)).slice(0, limit).map((d) => d.entry);
    const tokens = q.split(' ');
    const scored: { doc: SearchDoc; score: number }[] = [];
    for (const doc of docs) {
      if (kinds && !kinds.has(doc.entry.kind)) continue;
      const score = this.score(doc, q, tokens);
      if (score > 0) scored.push({ doc, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        KIND_RANK[a.doc.entry.kind] - KIND_RANK[b.doc.entry.kind] ||
        a.doc.name.length - b.doc.name.length ||
        a.doc.name.localeCompare(b.doc.name),
    );
    return scored.slice(0, limit).map((s) => s.doc.entry);
  }

  private score(doc: SearchDoc, q: string, tokens: string[]): number {
    if (doc.name === q) return 1000;
    if (doc.aliases.includes(q)) return 900;
    if (doc.name.startsWith(q)) return 800 - Math.min(100, doc.name.length - q.length);
    if (doc.words.some((w) => w.startsWith(q))) return 600;
    if (doc.name.includes(q)) return 400;
    // Every token must match a word of the name (as a prefix), or failing that the summary/keywords.
    let inName = 0;
    let fuzzy = 0;
    for (const t of tokens) {
      if (doc.words.some((w) => w.startsWith(t))) inName++;
      else if (t.length >= 4 && doc.words.some((w) => editDistance(t, w.slice(0, t.length + 1), 1) <= 1 || editDistance(t, w, 1) <= 1)) fuzzy++;
      else if (!doc.extra.includes(t)) return 0;
    }
    if (inName === tokens.length) return 300 + inName * 10;
    if (inName + fuzzy === tokens.length) return 200 + inName * 10;
    return inName > 0 || fuzzy > 0 ? 120 : 100;
  }

  /** Splits text into plain runs and links: explicit [[Name]] / [[kind:id|label]] plus names found automatically. */
  linkify(text: string, opts: LinkOptions = {}): TextSegment[] {
    const out: TextSegment[] = [];
    const seen = new Set<string>(opts.self ? [refKey(opts.self)] : []);
    let last = 0;
    for (const m of text.matchAll(WIKI_LINK)) {
      if (m.index! > last) out.push(...this.autoLink(text.slice(last, m.index), opts, seen));
      const entry = this.resolve(m[1]!);
      const label = (m[2] ?? (entry && parseRefKey(m[1]!.trim()) ? entry.name : m[1]!)).trim();
      if (entry) seen.add(refKey(entry));
      out.push(entry ? { text: label, ref: { kind: entry.kind, id: entry.id } } : { text: label, broken: true });
      last = m.index! + m[0].length;
    }
    if (last < text.length) out.push(...this.autoLink(text.slice(last), opts, seen));
    return out;
  }

  private autoLink(text: string, opts: LinkOptions, seen: Set<string>): TextSegment[] {
    const { pattern, byName } = (this.linker ??= this.buildLinker());
    const kinds = opts.kinds ? new Set(opts.kinds) : undefined;
    const firstOnly = opts.firstOnly ?? true;
    const out: TextSegment[] = [];
    let last = 0;
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const raw = m[0];
      const start = m.index!;
      const end = start + raw.length;
      const singular = byName.has(raw) ? raw : raw.replace(/(es|s)$/, (suffix) => (byName.has(raw.slice(0, -suffix.length)) ? '' : suffix));
      const candidates = (byName.get(singular) ?? []).filter((e) => (!kinds || kinds.has(e.kind)) && (singular === raw || PLURAL_KINDS.has(e.kind)));
      const before = text.slice(Math.max(0, start - 20), start);
      const after = text.slice(end, end + 20);
      const entry = candidates.find((e) => {
        const ctx = e.kind === 'spell' && CONTEXT_ONLY_SPELLS.has(e.name) ? SPELL_CONTEXT : KIND_CONTEXT[e.kind];
        if (!ctx) return true;
        return Boolean((ctx.after && ctx.after.test(after)) || (ctx.before && ctx.before.test(before)));
      });
      if (!entry) continue;
      const key = refKey(entry);
      if (seen.has(key) && (firstOnly || (opts.self && key === refKey(opts.self)))) continue;
      seen.add(key);
      if (start > last) out.push({ text: text.slice(last, start) });
      out.push({ text: raw, ref: { kind: entry.kind, id: entry.id } });
      last = end;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  private buildLinker() {
    const byName = new Map<string, IndexEntry[]>();
    for (const e of this.entries) {
      if (!AUTO_KINDS.has(e.kind)) continue;
      // Aliases too, so a campaign page for "Gundren Rockseeker" also links plain "Gundren".
      for (const name of [e.name, ...(e.aliases ?? [])]) {
        if (NEVER_AUTO.has(name) || name.length < 3) continue;
        const list = byName.get(name);
        if (list) list.push(e);
        else byName.set(name, [e]);
      }
    }
    for (const list of byName.values()) list.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
    // Case-sensitive: the 2024 rules capitalise game terms, which keeps "the dagger's edge" or
    // "frightened villagers" in flavour text from turning into links.
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.join('|') || '(?!)'})(?:es|s)?(?![\\p{L}\\p{N}])`, 'gu');
    return { pattern, byName };
  }
}

/** The core SRD compendium (no spells, monsters or magic items), built once on first use. */
let core: Compendium | undefined;
export function coreCompendium(): Compendium {
  return (core ??= new Compendium(coreEntries()));
}

export function fullCompendium(data: { spells: readonly SpellDef[]; monsters: readonly MonsterDef[]; magicItems: readonly MagicItemDef[] }): Compendium {
  return new Compendium([...coreEntries(), ...spellEntries(data.spells), ...monsterEntries(data.monsters), ...magicItemEntries(data.magicItems)]);
}
