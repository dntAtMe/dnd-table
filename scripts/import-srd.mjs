#!/usr/bin/env node
// Imports SRD 5.2 (D&D 2024) reference data from 5e-bits/5e-database at a pinned commit, plus the
// SRD 5.2.1 rules glossary (see GLOSSARY), and writes compact, normalised JSON to
// packages/rules/src/srd/data. Same commits → same output.
//
//   node scripts/import-srd.mjs              # fetch from GitHub at the pinned commit
//   node scripts/import-srd.mjs --cache DIR  # read/write raw files in DIR (offline re-runs)
//
// To update: change COMMIT, re-run, review the diff.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = '5e-bits/5e-database';
const COMMIT = 'bce51b3958573819e3b842fbc0cd9524fe4bc2e1';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/rules/src/srd/data');

/**
 * 5e-database's 2024 dataset has no rules glossary (Advantage, Cover, Opportunity Attacks…). This is
 * the SRD 5.2.1 glossary as Markdown (CC-BY-4.0), pinned by commit and checksum. It was compared entry
 * by entry with the official PDF (media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf,
 * SHA-256 8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87, pages 176–191): all 155
 * entries match word for word; only curly quotes are straight.
 */
const GLOSSARY = {
  repo: 'downfallx/dnd-5e-srd-markdown',
  commit: '1b4b99dcb786cdd1a2fb26f8acec1551191f1ca4',
  file: 'rules-glossary.md',
  sha256: '9b25315ef6728518f55b5b0e016d2083091f648e955a4e2ad1c1cd5d31823b2f',
};

const FILES = [
  'Alignments',
  'Backgrounds',
  'Classes',
  'Conditions',
  'Damage-Types',
  'Equipment',
  'Feats',
  'Features',
  'Languages',
  'Levels',
  'Magic-Items',
  'Magic-Schools',
  'Monsters',
  'Poisons',
  'Proficiencies',
  'Skills',
  'Species',
  'Spells',
  'Subclasses',
  'Subspecies',
  'Traits',
  'Weapon-Mastery-Properties',
  'Weapon-Properties',
];

// ---------- fetching ----------

const cacheArg = process.argv.indexOf('--cache');
const cacheDir = cacheArg > 0 ? path.resolve(process.argv[cacheArg + 1]) : null;

async function load(name) {
  const file = `5e-SRD-${name}.json`;
  if (cacheDir && existsSync(path.join(cacheDir, file))) return JSON.parse(readFileSync(path.join(cacheDir, file), 'utf8'));
  const url = `https://raw.githubusercontent.com/${REPO}/${COMMIT}/src/2024/en/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (cacheDir) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, file), text);
  }
  return JSON.parse(text);
}

async function loadGlossary() {
  const cached = cacheDir && path.join(cacheDir, GLOSSARY.file);
  let text;
  if (cached && existsSync(cached)) text = readFileSync(cached, 'utf8');
  else {
    const url = `https://raw.githubusercontent.com/${GLOSSARY.repo}/${GLOSSARY.commit}/${GLOSSARY.file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    text = await res.text();
    if (cached) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cached, text);
    }
  }
  const sha = createHash('sha256').update(text).digest('hex');
  if (sha !== GLOSSARY.sha256) throw new Error(`${GLOSSARY.file}: SHA-256 ${sha}, expected ${GLOSSARY.sha256}`);
  return text;
}

// ---------- text clean-up ----------

// Windows-1252 code points 0x80–0x9F, for undoing UTF-8 text that was decoded as cp1252.
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function fixMojibake(s) {
  if (!/[Â-ô][\u0080-¿ -™Œ-ƒˆ˜]/.test(s)) return s;
  return s.replace(/[Â-ô][\u0080-¿ -™Œ-ƒˆ˜]{1,3}/g, (seq) => {
    const bytes = [...seq].map((ch) => {
      const code = ch.codePointAt(0);
      return code <= 0xff ? code : (CP1252[code] ?? 0x3f);
    });
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
      return seq;
    }
  });
}

let vocabulary = new Set();

function buildVocabulary(texts) {
  const words = new Set();
  for (const t of texts) for (const w of fixMojibake(t).toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? []) words.add(w);
  vocabulary = words;
}

/** Re-joins words split across PDF lines ("ex- pended"), keeping real hyphens ("two- handed" → "two-handed"). */
function dehyphenate(s) {
  return s.replace(/([A-Za-z]+)- ([a-z]+)/g, (_, a, b) => {
    const joined = (a + b).toLowerCase();
    const hyphenated = `${a}-${b}`.toLowerCase();
    if (vocabulary.has(hyphenated) && !vocabulary.has(joined)) return `${a}-${b}`;
    return a + b;
  });
}

function clean(s) {
  if (s == null) return undefined;
  const text = Array.isArray(s) ? s.join('\n') : String(s);
  return dehyphenate(fixMojibake(text))
    .replace(/\r/g, '')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// ---------- helpers ----------

const byIndex = (list) => Object.fromEntries(list.map((x) => [x.index, x]));
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const skillId = (profIndex) => camel(profIndex.replace(/^skill-/, ''));
let skillIndexes = new Set();
/** Skill references come as proficiencies ("skill-insight") or as skills ("insight"). */
const skillRefs = (options) => refs(options).map((r) => r.replace(/^skill-/, '')).filter((r) => skillIndexes.has(r)).map(camel);
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));

/** Structured starting-equipment choice: options A/B/C, each a list of items plus coins (in GP). */
function equipmentChoice(choice) {
  const toGp = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 };
  const options = (choice.from?.options ?? []).map((o, i) => {
    const parts = o.option_type === 'multiple' ? o.items : [o];
    const items = [];
    let gold = 0;
    for (const part of parts) {
      if (part.option_type === 'money') gold += part.count * (toGp[part.unit] ?? 1);
      else if (part.option_type === 'counted_reference' || part.option_type === 'reference') {
        const ref = part.of ?? part.item;
        assert(equipmentByIndex[ref.index] || ref.index === 'holy-symbols', `unknown starting item ${ref.index}`);
        items.push(compact({ id: ref.index, name: ref.name + (ref.note ? ` (${ref.note})` : ''), count: part.count ?? 1 }));
      }
    }
    return { label: String.fromCharCode(65 + i), items, gold };
  });
  return { desc: clean(choice.desc), options };
}

function refs(options) {
  return (options?.from?.options ?? []).flatMap((o) => (o.item ? [o.item.index] : o.of ? [o.of.index] : []));
}

/** One entry per line: small diffs, still valid JSON. */
function writeJson(name, data) {
  const body = Array.isArray(data)
    ? `[\n${data.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`
    : `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(path.join(OUT, `${name}.json`), body);
  return { name, entries: Array.isArray(data) ? data.length : Object.keys(data).length };
}

function assert(cond, message) {
  if (!cond) throw new Error(`SRD import check failed: ${message}`);
}

// Known gaps in the source data, fixed here so they're visible and reviewable.
const PATCHES = {
  /** SRD 5.2: the Sage background grants Magic Initiate (Wizard). */
  backgroundFeatNotes: { sage: 'Wizard' },
};

// ---------- main ----------

const raw = Object.fromEntries(await Promise.all(FILES.map(async (f) => [f, await load(f)])));
const glossaryMarkdown = await loadGlossary();

buildVocabulary(
  [
    ...raw.Spells.flatMap((s) => [s.description, ...(s.higher_level ?? [])]),
    ...raw.Features.map((f) => f.description),
    ...raw.Traits.map((t) => t.description),
    ...raw.Feats.map((f) => f.description),
    ...raw.Subclasses.flatMap((s) => [s.description, ...s.features.map((f) => f.description)]),
  ].filter(Boolean),
);

const proficiencies = byIndex(raw.Proficiencies);
skillIndexes = new Set(raw.Skills.map((s) => s.index));
const equipmentByIndex = byIndex(raw.Equipment);

// Weapons & armor
const hasCat = (e, c) => e.equipment_categories?.some((x) => x.index === c);
const weapons = raw.Equipment.filter((e) => hasCat(e, 'weapons') && e.damage).map((e) =>
  compact({
    id: e.index,
    name: e.name,
    category: hasCat(e, 'martial-weapons') ? 'martial' : 'simple',
    ranged: hasCat(e, 'ranged-weapons'),
    damage: e.damage.damage_dice,
    damageType: e.damage.damage_type.index,
    properties: (e.properties ?? []).map((p) => p.index).sort(),
    versatile: e.two_handed_damage?.damage_dice,
    range: e.throw_range ? [e.throw_range.normal, e.throw_range.long] : e.range?.long ? [e.range.normal, e.range.long] : undefined,
    mastery: e.mastery?.index,
    weight: e.weight,
    cost: e.cost ? `${e.cost.quantity} ${e.cost.unit}` : undefined,
  }),
);
assert(weapons.length >= 38, `expected ≥38 weapons, got ${weapons.length}`);
assert(weapons.every((w) => w.mastery), 'every weapon has a mastery');
const weaponIds = new Set(weapons.map((w) => w.id));

const armor = raw.Equipment.filter((e) => hasCat(e, 'armor')).map((e) =>
  compact({
    id: e.index,
    name: e.name,
    category: hasCat(e, 'shields') ? 'shield' : hasCat(e, 'heavy-armor') ? 'heavy' : hasCat(e, 'medium-armor') ? 'medium' : 'light',
    baseAc: e.armor_class.base,
    dexBonus: e.armor_class.dex_bonus,
    maxDex: e.armor_class.dex_bonus ? (e.armor_class.max_bonus ?? undefined) : undefined,
    strength: e.str_minimum || undefined,
    stealthDisadvantage: e.stealth_disadvantage || undefined,
    weight: e.weight,
    cost: e.cost ? `${e.cost.quantity} ${e.cost.unit}` : undefined,
  }),
);
assert(armor.some((a) => a.id === 'shield') && armor.length >= 13, 'armor list incomplete');

const gear = raw.Equipment.filter((e) => !hasCat(e, 'weapons') && !hasCat(e, 'armor')).map((e) =>
  compact({
    id: e.index,
    name: e.name,
    category: (e.equipment_categories ?? []).map((c) => c.index).filter((c) => c !== 'tools')[0],
    weight: e.weight,
    cost: e.cost ? `${e.cost.quantity} ${e.cost.unit}` : undefined,
    description: clean(e.description ?? e.desc),
  }),
);

// Proficiency → structured grant
function weaponGrant(index) {
  if (index === 'simple-weapons') return { category: 'simple' };
  if (index === 'martial-weapons') return { category: 'martial' };
  const single = index.replace(/s$/, '');
  if (weaponIds.has(single)) return { weapon: single };
  return null;
}

const toolName = (index) => proficiencies[index]?.name?.replace(/^Tool: /, '') ?? index;

// Classes
const levelsByClass = {};
for (const l of raw.Levels) {
  if (l.subclass) continue;
  (levelsByClass[l.class.index] ??= []).push(l);
}

const classes = raw.Classes.map((c) => {
  const armorTraining = new Set();
  const weaponTraining = { categories: [], weapons: [] };
  const tools = [];
  for (const p of c.proficiencies) {
    const i = p.index;
    if (i.startsWith('saving-throw-')) continue;
    if (i === 'all-armor') ['light', 'medium', 'heavy'].forEach((a) => armorTraining.add(a));
    else if (i.endsWith('-armor')) armorTraining.add(i.replace('-armor', ''));
    else if (i === 'shields') armorTraining.add('shield');
    else {
      const w = weaponGrant(i);
      if (w?.category) weaponTraining.categories.push(w.category);
      else if (w?.weapon) weaponTraining.weapons.push(w.weapon);
      else tools.push(toolName(i));
    }
  }
  const skillChoice = c.proficiency_choices.find((pc) => skillRefs(pc).length > 0 || /skills?/i.test(pc.desc ?? ''));
  const otherChoices = c.proficiency_choices.filter((pc) => pc !== skillChoice).map((pc) => clean(pc.desc));
  const levels = (levelsByClass[c.index] ?? [])
    .sort((a, b) => a.level - b.level)
    .map((l) =>
      compact({
        level: l.level,
        profBonus: l.prof_bonus,
        features: (l.features ?? []).map((f) => f.index),
        classSpecific: l.class_specific && Object.keys(l.class_specific).length ? l.class_specific : undefined,
        spellcasting: l.spellcasting
          ? {
              cantrips: l.spellcasting.cantrips_known ?? 0,
              prepared: l.spellcasting.prepared_spells ?? 0,
              slots: Array.from({ length: 9 }, (_, i) => l.spellcasting[`spell_slots_level_${i + 1}`] ?? 0),
            }
          : undefined,
      }),
    );
  assert(levels.length === 20, `${c.index} has ${levels.length} levels`);
  return compact({
    id: c.index,
    name: c.name,
    hitDie: c.hit_die,
    // "Strength and Charisma" lists all; "Strength or Dexterity" (Fighter) is a choice.
    primaryAbilities: c.primary_ability.ability_scores?.map((a) => a.index) ?? refs(c.primary_ability.ability_score_options),
    primaryAbilityChoice: c.primary_ability.ability_score_options ? true : undefined,
    savingThrows: c.saving_throws.map((s) => s.index),
    skillChoice: skillChoice && {
      choose: skillChoice.choose,
      from: skillRefs(skillChoice),
    },
    otherProficiencyChoices: otherChoices.length ? otherChoices : undefined,
    armorTraining: [...armorTraining],
    weaponTraining,
    tools: tools.length ? tools : undefined,
    spellcasting: c.spellcasting
      ? { ability: c.spellcasting.spellcasting_ability.index, pact: c.index === 'warlock' }
      : undefined,
    startingEquipment: (c.starting_equipment_options ?? []).map(equipmentChoice),
    subclasses: c.subclasses.map((s) => s.index),
    multiclassPrerequisites: c.multi_classing?.prerequisites?.map((p) => ({ ability: p.ability_score.index, minimum: p.minimum_score })),
    levels,
  });
});
assert(classes.length === 12, 'expected 12 classes');
// "Choose any 3 skills" (Bard) has no option list; it means any skill.
for (const c of classes) if (c.skillChoice && c.skillChoice.from.length === 0) c.skillChoice.from = 'any';

const features = raw.Features.map((f) =>
  compact({ id: f.index, classId: f.class.index, level: Number(f.level.index.split('-').pop()), name: f.name, description: clean(f.description) }),
);
const featureIds = new Set(features.map((f) => f.id));
for (const c of classes) for (const l of c.levels) for (const f of l.features) assert(featureIds.has(f), `missing feature ${f}`);

const subclasses = raw.Subclasses.map((s) => ({
  id: s.index,
  classId: s.class.index,
  name: s.name,
  summary: clean(s.summary),
  description: clean(s.description),
  features: s.features.map((f) => ({ level: f.level, name: f.name, description: clean(f.description) })),
}));

// Species
const traits = raw.Traits.map((t) =>
  compact({
    id: t.index,
    name: t.name,
    description: clean(t.description),
    speed: t.speed,
    skillChoice: t.proficiency_choices
      ? { choose: t.proficiency_choices.choose, from: skillRefs(t.proficiency_choices) }
      : undefined,
    spells: t.spells?.map((s) => s.index ?? s.spell?.index).filter(Boolean),
  }),
);

const species = raw.Species.map((s) =>
  compact({
    id: s.index,
    name: s.name,
    sizes: s.size ? [s.size] : (s.size_options?.from?.options ?? []).map((o) => o.size),
    speed: s.speed,
    traits: s.traits.map((t) => t.index),
    subspecies: s.subspecies?.map((x) => x.index),
  }),
);
assert(species.length === 9, 'expected 9 species');

const subspecies = raw.Subspecies.map((s) =>
  compact({
    id: s.index,
    speciesId: s.species.index,
    name: s.name,
    damageType: s.damage_type?.index,
    traits: s.traits.map((t) => compact({ id: t.index, level: t.level })),
  }),
);

// Backgrounds & feats
const backgrounds = raw.Backgrounds.map((b) => {
  const skills = b.proficiencies.filter((p) => p.index.startsWith('skill-')).map((p) => skillId(p.index));
  const tools = b.proficiencies.filter((p) => !p.index.startsWith('skill-')).map((p) => toolName(p.index));
  return compact({
    id: b.index,
    name: b.name,
    abilities: b.ability_scores.map((a) => a.index),
    feat: compact({ id: b.feat.index, note: b.feat.note ?? PATCHES.backgroundFeatNotes[b.index] }),
    skills,
    tools: tools.length ? tools : undefined,
    toolChoice: b.proficiency_choices?.map((pc) => clean(pc.desc)).join('; '),
    equipment: (b.equipment_options ?? []).map(equipmentChoice),
  });
});

const feats = raw.Feats.map((f) =>
  compact({
    id: f.index,
    name: f.name,
    type: f.type,
    description: clean(f.description),
    repeatable: f.repeatable ? true : undefined,
    minLevel: f.prerequisites?.minimum_level,
    prerequisite: f.prerequisite_options?.desc ?? f.prerequisites?.feature_named,
  }),
);

// Spells
const spells = raw.Spells.map((s) =>
  compact({
    id: s.index,
    name: s.name,
    level: s.level,
    school: s.school.index,
    classes: s.classes.map((c) => c.index).sort(),
    castingTime: s.casting_time,
    ritual: s.ritual || undefined,
    range: s.range,
    components: s.components,
    material: clean(s.material),
    duration: s.duration,
    concentration: s.concentration || undefined,
    attack: s.attack_type,
    damageType: s.damage?.damage_type?.index,
    damageAtSlot: s.damage?.damage_at_slot_level,
    damageAtCharacterLevel: s.damage?.damage_at_character_level,
    description: clean(s.description),
    higherLevel: clean(s.higher_level),
  }),
).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
assert(spells.length > 300, `only ${spells.length} spells`);

// Monsters
const ABILITY_KEYS = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
const feet = (v) => {
  const n = Number(/^(\d+) ft\.$/.exec(String(v))?.[1]);
  assert(Number.isFinite(n), `unexpected distance "${v}"`);
  return n;
};
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** "2d6+3" / "2d6 + 3" / "1d4 – 1" → "2d6 + 3", the form the dice roller and sheet use. */
const dice = (s) =>
  s
    .replace(/[–−]/g, '-')
    .replace(/\s+/g, '')
    .replace(/([+-])/g, ' $1 ');

// "12 (2d6 + 5) Slashing damage" or a flat "1 Piercing damage".
const DAMAGE_RE = String.raw`(\d+)(?: \((\d+d\d+(?: [+\-–−] \d+)?)\))? ([A-Z][a-z]+) damage`;

function damageFrom(match) {
  const [, average, roll, type] = match;
  const damageType = type.toLowerCase();
  assert(DAMAGE_TYPE_SET.has(damageType), `unknown damage type ${type}`);
  return { average: Number(average), dice: roll ? dice(roll) : average, type: damageType };
}

/** The damage listed at the start of a clause, joined by "plus" ("13 (1d10 + 8) Slashing damage plus 5 (2d4) Fire damage"). */
function damageChain(text) {
  const out = [];
  const re = new RegExp(String.raw`^\s*(?:plus )?${DAMAGE_RE}`);
  let rest = text;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    out.push(damageFrom(m));
    rest = rest.slice(m[0].length);
  }
  return out;
}

function usageText(u) {
  if (!u) return undefined;
  if (u.type === 'recharge on roll') {
    assert(u.dice === '1d6', `unexpected recharge die ${u.dice}`);
    return u.min_value === 6 ? 'Recharge 6' : `Recharge ${u.min_value}–6`;
  }
  if (u.type === 'per day') return `${u.times}/Day${u.times_in_lair ? ` (${u.times_in_lair}/Day in Lair)` : ''}`;
  if (u.type === 'recharge after rest') return `Recharges after a ${u.rest_types.map(titleCase).join(' or ')} Rest`;
  throw new Error(`SRD import check failed: unknown usage ${u.type}`);
}

/** Spellcasting entries end with "…the following spells:"; the list itself only exists as structured data. */
function spellList(sc) {
  const groups = new Map();
  for (const sp of sc.spells) {
    const u = sp.usage;
    const key = !u ? '' : u.type === 'at will' ? 'At will' : u.type === 'per day' ? `${u.times}/Day each` : null;
    assert(key !== null, `unknown spell usage ${u?.type}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sp.name);
  }
  return [...groups].map(([k, names]) => (k ? `${k}: ${names.join(', ')}` : names.join(', '))).join('\n');
}

function monsterAction(a) {
  let description = clean(a.desc);
  if (a.spellcasting && description.endsWith(':')) description += `\n${spellList(a.spellcasting)}`;
  let attack;
  if (a.attack_bonus !== undefined) {
    // Distances come as "5 ft.", "5 ft" or "5 feet"; normalised to "5 ft.".
    const head = /^(Melee or Ranged|Melee|Ranged) Attack Roll: ([+-]\d+)[^,]*, (?:reach (\d+) (?:ft\.?|feet))?(?: or )?(?:range (\d+(?:\/\d+)?) (?:ft\.?|feet))?/.exec(description);
    assert(head && Number(head[2]) === a.attack_bonus, `can't read the attack line of ${a.name}`);
    const kind = head[1].toLowerCase();
    assert((head[3] !== undefined) === kind.startsWith('melee') && (head[4] !== undefined) === kind.endsWith('ranged'), `reach/range of ${a.name}`);
    const hit = description.split('Hit: ')[1] ?? '';
    const damage = damageChain(hit);
    const riders = [...hit.matchAll(new RegExp(String.raw`, (plus|or) ${DAMAGE_RE} (if [^.,]+)`, 'g'))].map((m) =>
      ({ ...damageFrom(m.slice(1)), note: `${m[1] === 'or' ? 'instead ' : ''}${m[5]}` }),
    );
    attack = compact({
      kind,
      bonus: a.attack_bonus,
      reach: head[3] && `${head[3]} ft.`,
      range: head[4] && `${head[4]} ft.`,
      damage,
      riders: riders.length ? riders : undefined,
    });
  }
  let save;
  if (a.dc && !attack && !a.spellcasting) {
    const failure = description.split('Failure: ')[1];
    const damage = failure ? damageChain(failure) : [];
    save = compact({
      ability: a.dc.dc_type.index,
      dc: a.dc.dc_value,
      damage: damage.length ? damage : undefined,
      half: /Success: Half damage/.test(description) || undefined,
    });
  }
  return compact({
    name: a.name,
    description,
    usage: usageText(a.usage),
    attack,
    save,
    spells: a.spellcasting?.spells.map((sp) => sp.index),
  });
}

const DAMAGE_TYPE_SET = new Set(raw['Damage-Types'].map((d) => d.index));
const SIZES = new Set(['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan', 'Medium or Small']);

const monsters = raw.Monsters.map((m) => {
  const bonuses = (prefix, key) =>
    Object.fromEntries(
      m.proficiencies.filter((p) => p.proficiency.index.startsWith(prefix)).map((p) => [key(p.proficiency.index.slice(prefix.length)), p.value]),
    );
  const skills = bonuses('skill-', camel);
  for (const s of Object.keys(skills)) assert(skillIndexes.has(s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)), `${m.index}: unknown skill ${s}`);
  assert(m.proficiencies.every((p) => /^(skill|saving-throw)-/.test(p.proficiency.index)), `${m.index}: unexpected proficiency`);
  assert(m.armor_class.length === 1, `${m.index}: several armor classes`);
  const size = m.size.replace(' or small', ' or Small');
  assert(SIZES.has(size), `${m.index}: unknown size ${m.size}`);
  const { hover, ...speeds } = m.speed;
  const { passive_perception: passivePerception, ...senses } = m.senses;
  const list = (key) => (m[key] ?? []).map(monsterAction);
  return compact({
    id: m.index,
    name: m.name,
    size,
    type: m.type,
    alignment: m.alignment,
    ac: m.armor_class[0].value,
    acNote: m.armor_class[0].armor?.map((x) => x.name).join(', '),
    hp: m.hit_points,
    hpFormula: dice(m.hit_points_roll),
    speed: Object.fromEntries(Object.entries(speeds).map(([k, v]) => [k, feet(v)])),
    hover: hover || undefined,
    scores: Object.fromEntries(Object.entries(ABILITY_KEYS).map(([a, key]) => [a, m[key]])),
    saves: bonuses('saving-throw-', (a) => a),
    skills,
    vulnerabilities: m.damage_vulnerabilities.map(clean),
    resistances: m.damage_resistances.map(clean),
    immunities: m.damage_immunities.map(clean),
    conditionImmunities: m.condition_immunities.map((c) => c.index),
    senses: Object.fromEntries(
      Object.entries(senses).map(([k, v]) => {
        assert(/^\d+ ft\.( \(.+\))?$/.test(v), `${m.index}: unexpected sense ${v}`);
        return [k, v];
      }),
    ),
    passivePerception,
    languages: clean(m.languages),
    cr: m.challenge_rating,
    xp: m.xp,
    xpInLair: m.xp_in_lair,
    profBonus: m.proficiency_bonus,
    gear: clean(m.gear),
    traits: list('special_abilities'),
    actions: list('actions'),
    bonusActions: list('bonus_actions'),
    reactions: list('reactions'),
    legendaryActions: list('legendary_actions'),
  });
}).sort((a, b) => a.name.localeCompare(b.name));
assert(monsters.length >= 300, `only ${monsters.length} monsters`);
for (const m of monsters) {
  assert(m.hp > 0 && m.ac > 0 && m.xp >= 0 && m.profBonus >= 2, `${m.id}: bad core stats`);
  assert(m.speed.walk !== undefined, `${m.id}: no walking speed`);
  for (const a of [...m.actions, ...m.bonusActions, ...m.reactions, ...m.legendaryActions]) {
    if (a.attack) assert(a.attack.damage.length > 0 || !/Hit: \d/.test(a.description), `${m.id} ${a.name}: unparsed hit damage`);
  }
}
const attacks = monsters.flatMap((m) => [...m.actions, ...m.bonusActions, ...m.reactions, ...m.legendaryActions]).filter((a) => a.attack);
assert(attacks.length >= 400 && attacks.filter((a) => a.attack.damage.length).length >= 400, 'too few parsed attacks');
const goblin = monsters.find((m) => m.id === 'goblin-warrior');
assert(goblin?.actions[0]?.attack?.bonus === 4 && goblin.actions[0].attack.damage[0].dice === '1d6 + 2', 'goblin warrior scimitar');

// Reference text
// Magic items: the first line of the source text is the item type ("Wondrous Item", "Armor (Any
// Medium or Heavy, Except Hide Armor)"), the rest the description.
const magicItems = raw['Magic-Items']
  .map((m) => {
    const [first, ...rest] = (m.desc ?? '').split(/ *\n/);
    return compact({
      id: m.index,
      name: m.name,
      category: m.equipment_category?.index,
      type: clean(first),
      rarity: m.rarity?.name,
      attunement: m.attunement || undefined,
      limitedTo: m['limited-to'] ? clean(m['limited-to']) : undefined,
      variant: m.variant || undefined,
      variants: m.variants?.length ? m.variants.map((v) => v.index) : undefined,
      description: clean(rest.join('\n')),
    });
  })
  .sort((a, b) => a.name.localeCompare(b.name));
assert(magicItems.length > 200 && magicItems.every((m) => m.description), 'magic items incomplete');

// ---------- rules glossary ----------

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** One HTML table as text lines: the header row in bold, cells joined by " · ". */
function tableText(html) {
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => ({
    head: /<th/.test(row),
    cells: [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, c]) => c.replace(/\s+/g, ' ').trim()).filter(Boolean),
  }));
  return rows
    .filter((r) => r.cells.length)
    .map((r) => (r.head ? `**${r.cells.join(' · ')}**` : r.cells.join(' · ')))
    .join('\n');
}

/**
 * The glossary's entries ("#### Term" or "#### Term [Tag]"; one is "###") as plain text with
 * **bold** run-in headings and table titles, bullet lists, and "See also" references to other
 * entries turned into links. Conditions are skipped: they come from 5e-database already.
 */
function parseGlossary(md) {
  const defs = md.split(/^## Rules Definitions\s*$/m)[1];
  assert(defs, 'Glossary: no "Rules Definitions" section');
  const parts = defs.split(/^#{3,4} (.+)$/m).slice(1);
  const entries = [];
  for (let i = 0; i < parts.length; i += 2) {
    const [, name, tag] = /^(.*?)(?: \[(.*)\])?\s*$/.exec(parts[i]);
    entries.push({ id: slug(name), name, tag: tag || undefined, body: parts[i + 1].trim() });
  }
  const byName = new Map(entries.map((e) => [e.name.toLowerCase(), e]));
  const linkTo = (quoted) => {
    const e = byName.get(quoted.toLowerCase());
    if (!e) return null;
    return e.tag === 'Condition' ? `[[condition:${e.id}|${quoted}]]` : `[[rule:${e.id}|${quoted}]]`;
  };
  const out = [];
  for (const e of entries) {
    if (e.tag === 'Condition') continue;
    let text = e.body
      .replace(/<table>[\s\S]*?<\/table>/g, (t) => tableText(t))
      // "_See also_ "Unarmed Strike" and "Grappled."": quoted entry names become links.
      .replace(/_See also_ ([^\n]*)/g, (_, rest) =>
        'See also ' + rest.replace(/"([^"]+?)([.,;]?)"/g, (m, q, punct) => (linkTo(q) ? `${linkTo(q)}${punct}` : m)),
      )
      .replace(/^_([^_\n]+?\.)_/gm, '**$1**')
      .replace(/_([^_\n]+)_/g, '$1')
      .replace(/^- /gm, '• ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    // Bullet lists read as one block, not a paragraph per line.
    text = text.replace(/\n\n(?=• )/g, '\n');
    assert(!/[<>]|(^|\s)_|_(\s|$)/.test(text), `Glossary: markup left in ${e.name}`);
    out.push(compact({ id: e.id, name: e.name, tag: e.tag, description: text }));
  }
  return { all: entries.length, entries: out };
}

const glossary = parseGlossary(glossaryMarkdown);
assert(glossary.all === 155, `Glossary: ${glossary.all} entries, expected 155`);
for (const name of ['Advantage', 'Cover', 'Opportunity Attacks', 'Grappling', 'Difficult Terrain', 'Concentration', 'Bloodied']) {
  assert(glossary.entries.some((e) => e.name === name), `Glossary: missing ${name}`);
}

const rules = {
  conditions: Object.fromEntries(raw.Conditions.map((c) => [c.index, { name: c.name, description: clean(c.description ?? c.desc) }])),
  masteries: Object.fromEntries(raw['Weapon-Mastery-Properties'].map((m) => [m.index, { name: m.name, description: clean(m.description ?? m.desc) }])),
  weaponProperties: Object.fromEntries(raw['Weapon-Properties'].map((p) => [p.index, { name: p.name, description: clean(p.description ?? p.desc) }])),
  skills: Object.fromEntries(raw.Skills.map((s) => [camel(s.index), { name: s.name, ability: s.ability_score.index, description: clean(s.description ?? s.desc) }])),
  damageTypes: Object.fromEntries(raw['Damage-Types'].map((d) => [d.index, { name: d.name, description: clean(d.description ?? d.desc) }])),
  schools: Object.fromEntries(raw['Magic-Schools'].map((d) => [d.index, { name: d.name, description: clean(d.description ?? d.desc) }])),
  alignments: Object.fromEntries(raw.Alignments.map((d) => [d.index, { name: d.name, abbreviation: d.abbreviation, description: clean(d.description ?? d.desc) }])),
  languages: Object.fromEntries(raw.Languages.map((d) => [d.index, compact({ name: d.name, rare: d.is_rare || undefined, note: clean(d.note) || undefined })])),
  poisons: Object.fromEntries(raw.Poisons.map((d) => [d.index, { name: d.name, type: d.type, cost: d.cost, description: clean(d.description ?? d.desc) }])),
  glossary: glossary.entries,
};

mkdirSync(OUT, { recursive: true });
const written = [
  writeJson('classes', classes),
  writeJson('features', features),
  writeJson('subclasses', subclasses),
  writeJson('species', species),
  writeJson('subspecies', subspecies),
  writeJson('traits', traits),
  writeJson('backgrounds', backgrounds),
  writeJson('feats', feats),
  writeJson('weapons', weapons),
  writeJson('armor', armor),
  writeJson('gear', gear),
  writeJson('spells', spells),
  writeJson('monsters', monsters),
  writeJson('magic-items', magicItems),
  writeJson('rules', rules),
];
writeJson('manifest', {
  source: `https://github.com/${REPO}`,
  commit: COMMIT,
  dataset: 'src/2024/en (SRD 5.2)',
  glossary: { source: `https://github.com/${GLOSSARY.repo}`, commit: GLOSSARY.commit, file: GLOSSARY.file, sha256: GLOSSARY.sha256, edition: 'SRD 5.2.1' },
  license:
    'This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode. This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  files: Object.fromEntries(written.map((w) => [w.name, w.entries])),
});

for (const w of written) console.log(`${w.name.padEnd(12)} ${w.entries}`);
console.log(`\nSRD 5.2 data from ${REPO}@${COMMIT.slice(0, 7)} → ${path.relative(process.cwd(), OUT)}`);
