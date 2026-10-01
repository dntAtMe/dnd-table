// Card bodies for the built-in SRD kinds. Descriptions go through RichText with `self` set, so
// cross-references inside them are links too: that's what makes nested popups useful.
import {
  ABILITY_NAMES,
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
  abilityMod,
  monsterCrText,
  monsterSave,
  monsterSensesText,
  monsterSpeedText,
  ABILITIES,
  type EntryKind,
  type EntryRef,
  type MonsterAction,
  type Skill,
} from '@dnd/rules';
import { Fragment, type ReactNode } from 'react';
import { useKnowledge } from '../../lib/knowledge';
import { MaybeLink } from './EntityLink';
import { RichText } from './RichText';
import type { EntryRenderer, EntryRendererProps } from './renderers';

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

type Fact = [label: string, value: ReactNode] | false | null | undefined | '' | 0;

/** Label/value pairs; falsy rows are skipped. */
function Facts({ rows }: { rows: Fact[] }) {
  const shown = rows.filter((r): r is [string, ReactNode] => Boolean(r));
  if (!shown.length) return null;
  return (
    <dl className="kb-facts">
      {shown.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Comma-separated list of links (plain text where an entry is missing). */
function LinkList({ items }: { items: { ref: EntryRef | null; label: string }[] }) {
  return (
    <>
      {items.map((it, i) => (
        <Fragment key={`${it.label}-${i}`}>
          {i > 0 && ', '}
          <MaybeLink entry={it.ref}>{it.label}</MaybeLink>
        </Fragment>
      ))}
    </>
  );
}

function Prose({ text, entry }: { text: string | undefined; entry: EntryRef }) {
  return text ? <RichText text={text} self={entry} className="kb-prose" /> : null;
}

function Loading() {
  return <p className="kb-loading">Loading details…</p>;
}

const ref = (kind: EntryKind, id: string): EntryRef => ({ kind, id });

// ---------- rules text ----------

type RulesGroup = 'conditions' | 'masteries' | 'weaponProperties' | 'skills' | 'damageTypes' | 'schools' | 'alignments' | 'poisons';

function rulesBody(group: RulesGroup): EntryRenderer {
  return function RulesBody({ entry }: EntryRendererProps) {
    const item = (RULES_TEXT[group] as Record<string, { description: string } | undefined>)[entry.id];
    return <Prose text={item?.description} entry={entry} />;
  };
}

function MasteryBody({ entry }: EntryRendererProps) {
  const weapons = Object.values(WEAPONS).filter((w) => w.mastery === entry.id);
  return (
    <>
      <Prose text={RULES_TEXT.masteries[entry.id]?.description} entry={entry} />
      {weapons.length > 0 && <Facts rows={[['Weapons', <LinkList items={weapons.map((w) => ({ ref: ref('weapon', w.id), label: w.name }))} />]]} />}
    </>
  );
}

function PropertyBody({ entry }: EntryRendererProps) {
  const weapons = Object.values(WEAPONS).filter((w) => w.properties.includes(entry.id));
  return (
    <>
      <Prose text={RULES_TEXT.weaponProperties[entry.id]?.description} entry={entry} />
      {weapons.length > 0 && <Facts rows={[['Weapons', <LinkList items={weapons.map((w) => ({ ref: ref('weapon', w.id), label: w.name }))} />]]} />}
    </>
  );
}

function SkillBody({ entry }: EntryRendererProps) {
  const skill = RULES_TEXT.skills[entry.id];
  const ability = SKILLS[entry.id as Skill]?.ability ?? skill?.ability;
  return (
    <>
      {ability && <Facts rows={[['Ability', ABILITY_NAMES[ability]]]} />}
      <Prose text={skill?.description} entry={entry} />
    </>
  );
}

function AlignmentBody({ entry }: EntryRendererProps) {
  const a = RULES_TEXT.alignments[entry.id];
  return (
    <>
      {a && <Facts rows={[['Abbreviation', a.abbreviation]]} />}
      <Prose text={a?.description} entry={entry} />
    </>
  );
}

function LanguageBody({ entry }: EntryRendererProps) {
  const l = RULES_TEXT.languages[entry.id];
  if (!l) return null;
  return <Facts rows={[['Type', l.rare ? 'Rare language' : 'Standard language'], l.note && ['Note', l.note]]} />;
}

function PoisonBody({ entry }: EntryRendererProps) {
  const p = RULES_TEXT.poisons[entry.id];
  if (!p) return null;
  return (
    <>
      <Facts rows={[['Type', cap(p.type)], ['Cost', `${p.cost.toLocaleString('en-US')} GP`]]} />
      <Prose text={p.description} entry={entry} />
    </>
  );
}

// ---------- spells, monsters, magic items (lazy) ----------

function SpellBody({ entry }: EntryRendererProps) {
  const { lazyData } = useKnowledge();
  const s = lazyData?.spells[entry.id];
  if (!s) return <Loading />;
  const school = <MaybeLink entry={ref('school', s.school)}>{cap(s.school)}</MaybeLink>;
  return (
    <>
      <p className="kb-line">
        {s.level === 0 ? (
          <>
            {school} cantrip
          </>
        ) : (
          <>
            Level {s.level} {school}
          </>
        )}
        {s.concentration && <span className="kb-badge">Concentration</span>}
        {s.ritual && <span className="kb-badge">Ritual</span>}
      </p>
      <Facts
        rows={[
          ['Casting time', s.castingTime + (s.ritual ? ' or Ritual' : '')],
          ['Range', s.range],
          ['Components', s.components.join(', ') + (s.material ? ` (${s.material})` : '')],
          ['Duration', s.concentration ? `Concentration, ${s.duration}` : s.duration],
          ['Classes', <LinkList items={s.classes.map((c) => ({ ref: ref('class', c), label: CLASSES[c]?.name ?? cap(c) }))} />],
        ]}
      />
      <Prose text={s.description} entry={entry} />
      {s.higherLevel && <Prose text={`**Using a Higher-Level Spell Slot.** ${s.higherLevel}`} entry={entry} />}
    </>
  );
}

const MONSTER_SECTIONS: { key: 'traits' | 'actions' | 'bonusActions' | 'reactions' | 'legendaryActions'; title: string }[] = [
  { key: 'traits', title: 'Traits' },
  { key: 'actions', title: 'Actions' },
  { key: 'bonusActions', title: 'Bonus Actions' },
  { key: 'reactions', title: 'Reactions' },
  { key: 'legendaryActions', title: 'Legendary Actions' },
];

function MonsterBody({ entry }: EntryRendererProps) {
  const { lazyData, compendium } = useKnowledge();
  const m = lazyData?.monsters[entry.id];
  if (!m) return <Loading />;
  const skills = Object.entries(m.skills) as [Skill, number][];
  const damageList = (list: string[]) => <LinkList items={list.map((d) => ({ ref: ref('damage-type', d.toLowerCase()), label: cap(d) }))} />;
  const languages = m.languages
    .split(/,\s*/)
    .filter(Boolean)
    .map((l) => {
      const e = compendium.byName(l, 'language');
      return { ref: e?.kind === 'language' ? ref('language', e.id) : null, label: l };
    });
  return (
    <div className="kb-monster">
      <p className="kb-line kb-muted">
        {m.size} {cap(m.type)}, {cap(m.alignment)}
      </p>
      <dl className="kb-statline">
        <div>
          <dt>AC</dt>
          <dd>
            {m.ac}
            {m.acNote && <span className="kb-muted"> ({m.acNote})</span>}
          </dd>
        </div>
        <div>
          <dt>HP</dt>
          <dd>
            {m.hp} <span className="kb-muted">({m.hpFormula})</span>
          </dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{monsterSpeedText(m)}</dd>
        </div>
        <div>
          <dt>Initiative</dt>
          <dd>{signed(abilityMod(m.scores.dex))}</dd>
        </div>
      </dl>
      <table className="kb-abilities">
        <thead>
          <tr>
            {ABILITIES.map((a) => (
              <th key={a} title={ABILITY_NAMES[a]}>
                {a.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {ABILITIES.map((a) => (
              <td key={a}>
                {m.scores[a]} <span className="kb-muted">({signed(abilityMod(m.scores[a]))})</span>
              </td>
            ))}
          </tr>
          <tr className="kb-abilities__saves">
            {ABILITIES.map((a) => (
              <td key={a} className={m.saves[a] !== undefined ? 'is-proficient' : ''} title={`${ABILITY_NAMES[a]} save`}>
                Save {signed(monsterSave(m, a))}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <Facts
        rows={[
          skills.length > 0 && [
            'Skills',
            <>
              {skills.map(([s, bonus], i) => (
                <Fragment key={s}>
                  {i > 0 && ', '}
                  <MaybeLink entry={ref('skill', s)}>{SKILLS[s]?.name ?? s}</MaybeLink> {signed(bonus)}
                </Fragment>
              ))}
            </>,
          ],
          m.vulnerabilities.length > 0 && ['Vulnerabilities', damageList(m.vulnerabilities)],
          m.resistances.length > 0 && ['Resistances', damageList(m.resistances)],
          m.immunities.length > 0 && ['Immunities', damageList(m.immunities)],
          m.conditionImmunities.length > 0 && [
            'Condition immunities',
            <LinkList items={m.conditionImmunities.map((c) => ({ ref: ref('condition', c), label: cap(c) }))} />,
          ],
          m.gear && ['Gear', <RichText text={m.gear} inline self={entry} />],
          ['Senses', monsterSensesText(m)],
          ['Languages', languages.length ? <LinkList items={languages} /> : 'None'],
          ['CR', monsterCrText(m)],
        ]}
      />
      {MONSTER_SECTIONS.map(({ key, title }) =>
        m[key].length ? (
          <section key={key} className="kb-section">
            <h4>{title}</h4>
            {m[key].map((a) => (
              <MonsterActionText key={a.name} action={a} self={entry} />
            ))}
          </section>
        ) : null,
      )}
    </div>
  );
}

function MonsterActionText({ action: a, self }: { action: MonsterAction; self: EntryRef }) {
  const { lazyData } = useKnowledge();
  return (
    <div className="kb-action">
      <p>
        <strong>
          {a.name}
          {a.usage && ` (${a.usage})`}.
        </strong>{' '}
        <RichText text={a.description} self={self} inline />
      </p>
      {a.spells && a.spells.length > 0 && (
        <p className="kb-muted kb-action__spells">
          Spells: <LinkList items={a.spells.map((id) => ({ ref: ref('spell', id), label: lazyData?.spells[id]?.name ?? id }))} />
        </p>
      )}
    </div>
  );
}

function MagicItemBody({ entry }: EntryRendererProps) {
  const { lazyData } = useKnowledge();
  const m = lazyData?.magicItems[entry.id];
  if (!m) return <Loading />;
  return (
    <>
      <Facts
        rows={[
          ['Type', m.type],
          m.rarity && ['Rarity', m.rarity],
          m.attunement && ['Attunement', m.limitedTo ? `Required (${m.limitedTo})` : 'Required'],
          m.variants &&
            m.variants.length > 0 && [
              'Variants',
              <LinkList items={m.variants.map((id) => ({ ref: ref('magic-item', id), label: lazyData?.magicItems[id]?.name ?? id }))} />,
            ],
        ]}
      />
      <Prose text={m.description} entry={entry} />
    </>
  );
}

// ---------- character options ----------

function FeatBody({ entry }: EntryRendererProps) {
  const f = FEATS[entry.id];
  if (!f) return null;
  return (
    <>
      <Facts
        rows={[
          ['Type', `${cap(f.type.replace('-', ' '))} feat`],
          f.prerequisite && ['Prerequisite', <RichText text={f.prerequisite} inline self={entry} />],
          f.minLevel && ['Minimum level', String(f.minLevel)],
          f.repeatable && ['Repeatable', 'Yes'],
        ]}
      />
      <Prose text={f.description} entry={entry} />
    </>
  );
}

function ClassBody({ entry, size }: EntryRendererProps) {
  const { compendium } = useKnowledge();
  const c = CLASSES[entry.id];
  if (!c) return null;
  const skillFrom = c.skillChoice?.from;
  return (
    <>
      <Facts
        rows={[
          ['Hit Die', `d${c.hitDie}`],
          ['Primary ability', c.primaryAbilities.map((a) => ABILITY_NAMES[a]).join(c.primaryAbilityChoice ? ' or ' : ' and ')],
          ['Saving throws', c.savingThrows.map((a) => ABILITY_NAMES[a]).join(', ')],
          c.skillChoice && [
            'Skills',
            skillFrom === 'any' ? (
              `Choose any ${c.skillChoice.choose}`
            ) : (
              <>
                Choose {c.skillChoice.choose}: <LinkList items={(skillFrom ?? []).map((s) => ({ ref: ref('skill', s), label: SKILLS[s]?.name ?? s }))} />
              </>
            ),
          ],
          ['Armor training', c.armorTraining.length ? c.armorTraining.map((a) => (a === 'shield' ? 'Shields' : `${cap(a)} armor`)).join(', ') : 'None'],
          [
            'Weapons',
            <>
              {c.weaponTraining.categories.map((w) => `${cap(w)} weapons`).join(', ')}
              {c.weaponTraining.categories.length > 0 && c.weaponTraining.weapons.length > 0 && ', '}
              <LinkList items={c.weaponTraining.weapons.map((w) => ({ ref: ref('weapon', w), label: WEAPONS[w]?.name ?? w }))} />
            </>,
          ],
          c.tools && c.tools.length > 0 && ['Tools', c.tools.join(', ')],
          c.spellcasting && ['Spellcasting', `${ABILITY_NAMES[c.spellcasting.ability]}${c.spellcasting.pact ? ' (Pact Magic)' : ''}`],
          c.subclasses.length > 0 && ['Subclasses', <LinkList items={c.subclasses.map((s) => ({ ref: ref('subclass', s), label: SUBCLASSES[s]?.name ?? s }))} />],
        ]}
      />
      <section className="kb-section">
        <h4>Features</h4>
        <table className={`kb-levels${size === 'popup' ? ' kb-levels--compact' : ''}`}>
          <tbody>
            {c.levels
              .filter((l) => l.features.length)
              .map((l) => (
                <tr key={l.level}>
                  <th scope="row">{l.level}</th>
                  <td>
                    {l.features.map((id, i) => {
                      const f = FEATURES[id];
                      const label = f?.name ?? id;
                      return (
                        <Fragment key={id}>
                          {i > 0 && ', '}
                          {compendium.get(ref('feature', id)) ? <MaybeLink entry={ref('feature', id)}>{label}</MaybeLink> : <span className="kb-muted">{label}</span>}
                        </Fragment>
                      );
                    })}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function SubclassBody({ entry }: EntryRendererProps) {
  const s = SUBCLASSES[entry.id];
  if (!s) return null;
  return (
    <>
      <Facts rows={[['Class', <MaybeLink entry={ref('class', s.classId)}>{CLASSES[s.classId]?.name ?? s.classId}</MaybeLink>]]} />
      <Prose text={s.description} entry={entry} />
      {s.features.map((f) => (
        <section key={f.name} className="kb-section">
          <h4>
            {f.name} <span className="kb-muted">· level {f.level}</span>
          </h4>
          <Prose text={f.description} entry={entry} />
        </section>
      ))}
    </>
  );
}

function FeatureBody({ entry }: EntryRendererProps) {
  const f = FEATURES[entry.id];
  if (!f) return null;
  return (
    <>
      <Facts
        rows={[
          ['Class', <MaybeLink entry={ref('class', f.classId)}>{CLASSES[f.classId]?.name ?? f.classId}</MaybeLink>],
          ['Level', String(f.level)],
        ]}
      />
      <Prose text={f.description} entry={entry} />
    </>
  );
}

function SpeciesBody({ entry }: EntryRendererProps) {
  const s = SPECIES[entry.id];
  if (!s) return null;
  return (
    <Facts
      rows={[
        ['Size', s.sizes.join(' or ')],
        ['Speed', `${s.speed} ft.`],
        ['Traits', <LinkList items={s.traits.map((t) => ({ ref: ref('trait', t), label: TRAITS[t]?.name ?? t }))} />],
        s.subspecies &&
          s.subspecies.length > 0 && [
            'Lineages',
            <LinkList items={s.subspecies.map((id) => ({ ref: ref('lineage', id), label: SUBSPECIES[id]?.name.split(': ').pop() ?? id }))} />,
          ],
      ]}
    />
  );
}

function LineageBody({ entry }: EntryRendererProps) {
  const s = SUBSPECIES[entry.id];
  if (!s) return null;
  return (
    <Facts
      rows={[
        ['Species', <MaybeLink entry={ref('species', s.speciesId)}>{SPECIES[s.speciesId]?.name ?? s.speciesId}</MaybeLink>],
        s.damageType && ['Damage type', <MaybeLink entry={ref('damage-type', s.damageType)}>{cap(s.damageType)}</MaybeLink>],
        [
          'Traits',
          <>
            {s.traits.map((t, i) => (
              <Fragment key={t.id}>
                {i > 0 && ', '}
                <MaybeLink entry={ref('trait', t.id)}>{TRAITS[t.id]?.name ?? t.id}</MaybeLink>
                {t.level && t.level > 1 ? <span className="kb-muted"> (level {t.level})</span> : null}
              </Fragment>
            ))}
          </>,
        ],
      ]}
    />
  );
}

function TraitBody({ entry }: EntryRendererProps) {
  const t = TRAITS[entry.id];
  if (!t) return null;
  const species = Object.values(SPECIES).filter((s) => s.traits.includes(t.id));
  const lineages = Object.values(SUBSPECIES).filter((s) => s.traits.some((x) => x.id === t.id));
  return (
    <>
      <Prose text={t.description} entry={entry} />
      <Facts
        rows={[
          t.speed && ['Speed', `${t.speed} ft.`],
          (species.length > 0 || lineages.length > 0) && [
            'From',
            <LinkList
              items={[
                ...species.map((s) => ({ ref: ref('species', s.id), label: s.name })),
                ...lineages.map((s) => ({ ref: ref('lineage', s.id), label: s.name })),
              ]}
            />,
          ],
        ]}
      />
    </>
  );
}

function BackgroundBody({ entry }: EntryRendererProps) {
  const b = BACKGROUNDS[entry.id];
  if (!b) return null;
  return (
    <Facts
      rows={[
        ['Ability scores', b.abilities.map((a) => ABILITY_NAMES[a]).join(', ')],
        [
          'Feat',
          <>
            <MaybeLink entry={ref('feat', b.feat.id)}>{FEATS[b.feat.id]?.name ?? b.feat.id}</MaybeLink>
            {b.feat.note && ` (${b.feat.note})`}
          </>,
        ],
        ['Skills', <LinkList items={b.skills.map((s) => ({ ref: ref('skill', s), label: SKILLS[s]?.name ?? s }))} />],
        ['Tools', b.tools?.join(', ') ?? b.toolChoice ?? 'None'],
        ...b.equipment.map((e, i): Fact => [b.equipment.length > 1 ? `Equipment ${i + 1}` : 'Equipment', e.desc]),
      ]}
    />
  );
}

// ---------- equipment ----------

function WeaponBody({ entry }: EntryRendererProps) {
  const w = WEAPONS[entry.id];
  if (!w) return null;
  return (
    <Facts
      rows={[
        ['Category', `${cap(w.category)} ${w.ranged ? 'ranged' : 'melee'} weapon`],
        [
          'Damage',
          <>
            {w.damage} <MaybeLink entry={ref('damage-type', w.damageType)}>{cap(w.damageType)}</MaybeLink>
            {w.versatile && <span className="kb-muted"> (versatile {w.versatile})</span>}
          </>,
        ],
        w.properties.length > 0 && [
          'Properties',
          <LinkList items={w.properties.map((p) => ({ ref: ref('property', p), label: RULES_TEXT.weaponProperties[p]?.name ?? cap(p) }))} />,
        ],
        w.range && ['Range', `${w.range[0]}/${w.range[1]} ft.`],
        ['Mastery', <MaybeLink entry={ref('mastery', w.mastery)}>{RULES_TEXT.masteries[w.mastery]?.name ?? cap(w.mastery)}</MaybeLink>],
        w.weight !== undefined && ['Weight', `${w.weight} lb.`],
        w.cost && ['Cost', w.cost.toUpperCase()],
      ]}
    />
  );
}

function ArmorBody({ entry }: EntryRendererProps) {
  const a = ARMOR[entry.id];
  if (!a) return null;
  const ac = a.category === 'shield' ? `+${a.baseAc}` : `${a.baseAc}${a.dexBonus ? (a.maxDex !== undefined ? ` + Dex modifier (max ${a.maxDex})` : ' + Dex modifier') : ''}`;
  return (
    <Facts
      rows={[
        ['Category', a.category === 'shield' ? 'Shield' : `${cap(a.category)} armor`],
        ['Armor Class', ac],
        a.strength && ['Strength', `${a.strength} required`],
        a.stealthDisadvantage && ['Stealth', 'Disadvantage'],
        a.weight !== undefined && ['Weight', `${a.weight} lb.`],
        a.cost && ['Cost', a.cost.toUpperCase()],
      ]}
    />
  );
}

function GearBody({ entry }: EntryRendererProps) {
  const g = GEAR[entry.id];
  if (!g) return null;
  return (
    <>
      <Facts
        rows={[
          g.category && ['Category', cap(g.category.replace(/-/g, ' '))],
          g.cost && ['Cost', g.cost.toUpperCase()],
          g.weight !== undefined && ['Weight', `${g.weight} lb.`],
        ]}
      />
      <Prose text={g.description} entry={entry} />
    </>
  );
}

/** Kinds without a body of their own (and campaign pages until a renderer is registered). */
export function SummaryBody({ entry }: EntryRendererProps) {
  return entry.summary ? <Prose text={entry.summary} entry={entry} /> : <p className="kb-muted">No details yet.</p>;
}

export const BUILTIN_BODIES: Partial<Record<EntryKind, EntryRenderer>> = {
  condition: rulesBody('conditions'),
  'damage-type': rulesBody('damageTypes'),
  school: rulesBody('schools'),
  mastery: MasteryBody,
  property: PropertyBody,
  skill: SkillBody,
  alignment: AlignmentBody,
  language: LanguageBody,
  poison: PoisonBody,
  spell: SpellBody,
  monster: MonsterBody,
  'magic-item': MagicItemBody,
  feat: FeatBody,
  class: ClassBody,
  subclass: SubclassBody,
  feature: FeatureBody,
  species: SpeciesBody,
  lineage: LineageBody,
  trait: TraitBody,
  background: BackgroundBody,
  weapon: WeaponBody,
  armor: ArmorBody,
  gear: GearBody,
};

/** Kinds whose header summary is just a restatement of the body (rules text): don't show it twice. */
export const SUMMARY_IN_BODY = new Set<EntryKind>(['condition', 'mastery', 'property', 'trait', 'alignment']);
