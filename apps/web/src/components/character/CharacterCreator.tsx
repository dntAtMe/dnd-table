import type { ClientMessage } from '@dnd/protocol';
import {
  ABILITIES,
  ABILITY_NAMES,
  ARMOR,
  BACKGROUNDS,
  CLASSES,
  FEATS,
  POINT_BUY_BUDGET,
  POINT_BUY_COST,
  SKILLS,
  SPECIES,
  STANDARD_ARRAY,
  STANDARD_LANGUAGES,
  SUBSPECIES,
  TRAITS,
  WEAPONS,
  abilityMod,
  blankChoices,
  buildCharacter,
  chosenSkills,
  computeCharacter,
  creatorIssues,
  expertiseCount,
  hasFightingStyle,
  masteryOptions,
  pointBuyCost,
  rollDice,
  speciesGrantsOriginFeat,
  speciesSkillOptions,
  weaponMasteryCount,
  type Ability,
  type CreatorChoices,
  type EquipmentChoice,
  type Skill,
} from '@dnd/rules';
import { useMemo, useState, type ReactNode } from 'react';
import { TOKEN_COLORS } from '../TokenPanels';
import { signed } from './useCharacter';

type Step = 'class' | 'background' | 'species' | 'scores' | 'details' | 'equipment' | 'review';

const STEPS: { id: Step; label: string }[] = [
  { id: 'class', label: 'Class' },
  { id: 'background', label: 'Background' },
  { id: 'species', label: 'Species' },
  { id: 'scores', label: 'Abilities' },
  { id: 'details', label: 'Details' },
  { id: 'equipment', label: 'Equipment' },
  { id: 'review', label: 'Review' },
];

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function ChoiceCard({ selected, onClick, title, children }: { selected: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button type="button" className={`choice-card${selected ? ' is-selected' : ''}`} onClick={onClick} aria-pressed={selected}>
      <span className="choice-card__title">{title}</span>
      {children}
    </button>
  );
}

function Checklist<T extends string>({
  options,
  selected,
  limit,
  onChange,
  label,
  disabled,
}: {
  options: T[];
  selected: T[];
  limit: number;
  onChange: (next: T[]) => void;
  label: (o: T) => string;
  disabled?: (o: T) => string | undefined;
}) {
  return (
    <div className="checklist">
      {options.map((o) => {
        const reason = disabled?.(o);
        const on = selected.includes(o);
        return (
          <label key={o} className={`check${reason ? ' is-disabled' : ''}`} title={reason}>
            <input
              type="checkbox"
              checked={on}
              disabled={Boolean(reason) || (!on && selected.length >= limit)}
              onChange={() => onChange(on ? selected.filter((x) => x !== o) : [...selected, o])}
            />
            {label(o)}
            {reason && <span className="muted"> ({reason})</span>}
          </label>
        );
      })}
    </div>
  );
}

export function CharacterCreator({ send, onDone }: { send: (msg: ClientMessage) => void; onDone: () => void }) {
  const [c, setC] = useState<CreatorChoices>(blankChoices);
  const [step, setStep] = useState<Step>('class');
  const [rolled, setRolled] = useState<number[] | null>(null);
  const issues = creatorIssues(c);
  const set = (patch: Partial<CreatorChoices>) => setC((prev) => ({ ...prev, ...patch }));
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const stepIssues = (s: Step) => (s === 'review' ? Object.values(issues).flat() : issues[s]);
  const allIssues = Object.values(issues).flat();

  const preview = useMemo(() => {
    if (allIssues.length) return null;
    const character = buildCharacter(c);
    return { character, derived: computeCharacter(character) };
  }, [c, allIssues.length]);

  const create = () => {
    if (!preview) return;
    send({ type: 'character:create', data: preview.character });
    onDone();
  };

  return (
    <div className="creator">
      <header className="creator__head">
        <h2>New character</h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDone}>
          Cancel
        </button>
      </header>
      <ol className="creator__steps">
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={`${s.id === step ? 'is-active' : ''}${i < stepIndex && stepIssues(s.id).length === 0 ? ' is-done' : ''}`}
              onClick={() => setStep(s.id)}
            >
              <span className="creator__step-num">{i < stepIndex && stepIssues(s.id).length === 0 ? '✓' : i + 1}</span>
              {s.label}
            </button>
          </li>
        ))}
      </ol>

      <div className="creator__body">
        {step === 'class' && (
          <div className="choice-grid">
            {Object.values(CLASSES).map((cls) => (
              <ChoiceCard
                key={cls.id}
                title={cls.name}
                selected={c.classId === cls.id}
                onClick={() =>
                  set({
                    classId: cls.id,
                    classSkills: [],
                    expertise: [],
                    weaponMasteries: [],
                    fightingStyle: null,
                    classEquipment: [],
                    // Start the standard array in a sensible arrangement for the class.
                    ...(c.scoreMethod === 'standard' && { baseScores: suggestedArray(cls.primaryAbilities) }),
                  })
                }
              >
                <span className="choice-card__meta">
                  d{cls.hitDie} · {cls.primaryAbilities.map((a) => a.toUpperCase()).join(cls.primaryAbilityChoice ? ' or ' : ' & ')}
                </span>
                <span className="choice-card__line">Saves: {cls.savingThrows.map((a) => a.toUpperCase()).join(', ')}</span>
                <span className="choice-card__line">Armor: {cls.armorTraining.length ? cls.armorTraining.map(cap).join(', ') : 'None'}</span>
                {cls.spellcasting && <span className="choice-card__line">Spellcasting ({cls.spellcasting.ability.toUpperCase()})</span>}
              </ChoiceCard>
            ))}
          </div>
        )}

        {step === 'background' && (
          <>
            <div className="choice-grid">
              {Object.values(BACKGROUNDS).map((bg) => (
                <ChoiceCard
                  key={bg.id}
                  title={bg.name}
                  selected={c.backgroundId === bg.id}
                  onClick={() => set({ backgroundId: bg.id, backgroundBonus: {}, backgroundEquipment: [], classSkills: c.classSkills.filter((s) => !bg.skills.includes(s)) })}
                >
                  <span className="choice-card__meta">{bg.abilities.map((a) => a.toUpperCase()).join(', ')}</span>
                  <span className="choice-card__line">
                    Feat: {FEATS[bg.feat.id]?.name}
                    {bg.feat.note ? ` (${bg.feat.note})` : ''}
                  </span>
                  <span className="choice-card__line">Skills: {bg.skills.map((s) => SKILLS[s].name).join(', ')}</span>
                  <span className="choice-card__line">Tools: {bg.tools?.join(', ') ?? bg.toolChoice ?? 'None'}</span>
                </ChoiceCard>
              ))}
            </div>
            {BACKGROUNDS[c.backgroundId] && <BackgroundBonus c={c} set={set} />}
            {FEATS[BACKGROUNDS[c.backgroundId]?.feat.id ?? ''] && (
              <details className="rules-text">
                <summary>{FEATS[BACKGROUNDS[c.backgroundId]!.feat.id]!.name}</summary>
                <p className="prose">{FEATS[BACKGROUNDS[c.backgroundId]!.feat.id]!.description}</p>
              </details>
            )}
          </>
        )}

        {step === 'species' && <SpeciesStep c={c} set={set} />}

        {step === 'scores' && <ScoresStep c={c} set={set} rolled={rolled} setRolled={setRolled} />}

        {step === 'details' && <DetailsStep c={c} set={set} />}

        {step === 'equipment' && (
          <div className="stack">
            {CLASSES[c.classId] && (
              <EquipmentPicker
                title={`${CLASSES[c.classId]!.name} equipment`}
                choices={CLASSES[c.classId]!.startingEquipment}
                selected={c.classEquipment}
                onChange={(classEquipment) => set({ classEquipment })}
              />
            )}
            {BACKGROUNDS[c.backgroundId] && (
              <EquipmentPicker
                title={`${BACKGROUNDS[c.backgroundId]!.name} equipment`}
                choices={BACKGROUNDS[c.backgroundId]!.equipment}
                selected={c.backgroundEquipment}
                onChange={(backgroundEquipment) => set({ backgroundEquipment })}
              />
            )}
          </div>
        )}

        {step === 'review' &&
          (preview ? (
            <div className="review">
              <div className="review__head">
                <span className="sheet__swatch" style={{ background: c.color }} />
                <div>
                  <h3>{preview.character.name}</h3>
                  <p className="muted">
                    Level 1 {(c.subspeciesId && SUBSPECIES[c.subspeciesId]?.name.split(': ').pop()) || SPECIES[c.speciesId]?.name}{' '}
                    {CLASSES[c.classId]?.name} · {BACKGROUNDS[c.backgroundId]?.name}
                  </p>
                </div>
              </div>
              <div className="stat-grid review__stats">
                {[
                  ['HP', preview.derived.hpMax],
                  ['AC', preview.derived.ac],
                  ['Initiative', signed(preview.derived.initiative)],
                  ['Speed', preview.derived.speed],
                  ['Prof.', signed(preview.derived.profBonus)],
                  ['Passive Perc.', preview.derived.passivePerception],
                ].map(([label, value]) => (
                  <div key={label} className="stat">
                    <span className="stat-label">{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <div className="review__scores">
                {ABILITIES.map((a) => (
                  <div key={a} className="stat">
                    <span className="stat-label">{a.toUpperCase()}</span>
                    <strong>{preview.derived.scores[a]}</strong>
                    <span className="muted">{signed(preview.derived.mods[a])}</span>
                  </div>
                ))}
              </div>
              <p>
                <strong>Skills:</strong>{' '}
                {Object.entries(preview.derived.skills)
                  .filter(([, v]) => v.proficiency >= 1)
                  .map(([k, v]) => `${SKILLS[k as Skill].name} ${signed(v.bonus)}${v.proficiency === 2 ? ' (expertise)' : ''}`)
                  .join(', ')}
              </p>
              <p>
                <strong>Attacks:</strong>{' '}
                {preview.derived.attacks
                  .filter((a) => a.id !== 'unarmed')
                  .map((a) => `${a.name} ${signed(a.attackBonus)} (${a.damage})`)
                  .join(', ') || 'None'}
              </p>
              {preview.derived.warnings.map((w) => (
                <p key={w} className="form-error">
                  {w}
                </p>
              ))}
            </div>
          ) : (
            <div className="stack">
              <p>A few things are still missing:</p>
              <ul className="issues">
                {STEPS.filter((s) => s.id !== 'review').flatMap((s) =>
                  issues[s.id as Exclude<Step, 'review'>].map((msg) => (
                    <li key={s.id + msg}>
                      <button type="button" className="link-btn" onClick={() => setStep(s.id)}>
                        {s.label}
                      </button>
                      : {msg}
                    </li>
                  )),
                )}
              </ul>
            </div>
          ))}
      </div>

      <footer className="creator__foot">
        {step !== 'review' && stepIssues(step).length > 0 && <p className="hint">{stepIssues(step)[0]}</p>}
        <div className="creator__nav">
          <button type="button" className="btn" disabled={stepIndex === 0} onClick={() => setStep(STEPS[stepIndex - 1]!.id)}>
            Back
          </button>
          {step === 'review' ? (
            <button type="button" className="btn btn--primary" disabled={!preview} onClick={create}>
              Create character
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => setStep(STEPS[stepIndex + 1]!.id)}>
              Next
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function BackgroundBonus({ c, set }: { c: CreatorChoices; set: (p: Partial<CreatorChoices>) => void }) {
  const abilities = BACKGROUNDS[c.backgroundId]!.abilities;
  const values = Object.values(c.backgroundBonus).filter(Boolean);
  const spread = values.length === 3 ? 'even' : 'split';
  const plus2 = abilities.find((a) => c.backgroundBonus[a] === 2) ?? abilities[0]!;
  const plus1 = abilities.find((a) => c.backgroundBonus[a] === 1 && a !== plus2) ?? abilities.find((a) => a !== plus2)!;

  const setSplit = (two: Ability, one: Ability) => set({ backgroundBonus: two === one ? { [two]: 2 } : { [two]: 2, [one]: 1 } });

  return (
    <section className="sheet-card">
      <h3>Ability score increases</h3>
      <div className="segmented">
        <button type="button" className={spread === 'split' && values.length ? 'is-active' : ''} onClick={() => setSplit(plus2, plus1)}>
          +2 / +1
        </button>
        <button
          type="button"
          className={spread === 'even' ? 'is-active' : ''}
          onClick={() => set({ backgroundBonus: Object.fromEntries(abilities.map((a) => [a, 1])) })}
        >
          +1 / +1 / +1
        </button>
      </div>
      {spread === 'split' && values.length > 0 && (
        <div className="field-pair">
          <label className="field-row">
            <span>+2 to</span>
            <select value={plus2} onChange={(e) => setSplit(e.target.value as Ability, plus1 === e.target.value ? plus2 : plus1)}>
              {abilities.map((a) => (
                <option key={a} value={a}>
                  {ABILITY_NAMES[a]}
                </option>
              ))}
            </select>
          </label>
          <label className="field-row">
            <span>+1 to</span>
            <select value={plus1} onChange={(e) => setSplit(plus2, e.target.value as Ability)}>
              {abilities
                .filter((a) => a !== plus2)
                .map((a) => (
                  <option key={a} value={a}>
                    {ABILITY_NAMES[a]}
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}
      {values.length === 0 && <p className="hint">Pick how to spread the increases.</p>}
    </section>
  );
}

function SpeciesStep({ c, set }: { c: CreatorChoices; set: (p: Partial<CreatorChoices>) => void }) {
  const species = SPECIES[c.speciesId];
  const skillOptions = species ? speciesSkillOptions(species.id) : null;
  const originFeats = Object.values(FEATS).filter((f) => f.type === 'origin');
  return (
    <>
      <div className="choice-grid">
        {Object.values(SPECIES).map((s) => (
          <ChoiceCard
            key={s.id}
            title={s.name}
            selected={c.speciesId === s.id}
            onClick={() => set({ speciesId: s.id, subspeciesId: null, size: s.sizes.length === 1 ? s.sizes[0]! : '', speciesSkill: null, versatileFeat: null })}
          >
            <span className="choice-card__meta">
              {s.sizes.join(' or ')} · {s.speed} ft
            </span>
            <span className="choice-card__line">{s.traits.map((t) => TRAITS[t]?.name ?? t).join(', ')}</span>
          </ChoiceCard>
        ))}
      </div>
      {species && (
        <section className="sheet-card">
          <h3>{species.name} choices</h3>
          {species.subspecies && species.subspecies.length > 0 && (
            <label className="field-row">
              <span>Lineage</span>
              <select value={c.subspeciesId ?? ''} onChange={(e) => set({ subspeciesId: e.target.value || null })}>
                <option value="">Choose…</option>
                {species.subspecies.map((id) => (
                  <option key={id} value={id}>
                    {SUBSPECIES[id]?.name.split(': ').pop()}
                  </option>
                ))}
              </select>
            </label>
          )}
          {species.sizes.length > 1 && (
            <label className="field-row">
              <span>Size</span>
              <select value={c.size} onChange={(e) => set({ size: e.target.value })}>
                <option value="">Choose…</option>
                {species.sizes.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
          {skillOptions && (
            <label className="field-row">
              <span>Skill proficiency</span>
              <select value={c.speciesSkill ?? ''} onChange={(e) => set({ speciesSkill: (e.target.value || null) as Skill | null, classSkills: c.classSkills.filter((s) => s !== e.target.value) })}>
                <option value="">Choose…</option>
                {skillOptions
                  .filter((s) => !BACKGROUNDS[c.backgroundId]?.skills.includes(s))
                  .map((s) => (
                    <option key={s} value={s}>
                      {SKILLS[s].name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {speciesGrantsOriginFeat(species.id) && (
            <label className="field-row">
              <span>Origin feat (Versatile)</span>
              <select value={c.versatileFeat ?? ''} onChange={(e) => set({ versatileFeat: e.target.value || null })}>
                <option value="">Choose…</option>
                {originFeats.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ul className="trait-list">
            {[...species.traits, ...(c.subspeciesId ? (SUBSPECIES[c.subspeciesId]?.traits.map((t) => t.id) ?? []) : [])].map((t) => (
              <li key={t}>
                <details>
                  <summary>{TRAITS[t]?.name}</summary>
                  <p className="prose">{TRAITS[t]?.description}</p>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ScoresStep({
  c,
  set,
  rolled,
  setRolled,
}: {
  c: CreatorChoices;
  set: (p: Partial<CreatorChoices>) => void;
  rolled: number[] | null;
  setRolled: (r: number[] | null) => void;
}) {
  const cost = pointBuyCost(c.baseScores);
  const primary = CLASSES[c.classId]?.primaryAbilities ?? [];

  const setMethod = (scoreMethod: CreatorChoices['scoreMethod']) =>
    set({
      scoreMethod,
      baseScores:
        scoreMethod === 'pointBuy'
          ? { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }
          : scoreMethod === 'standard'
            ? suggestedArray(primary)
            : c.baseScores,
    });

  const pool = c.scoreMethod === 'standard' ? STANDARD_ARRAY : (rolled ?? []);

  /** Assigning a value swaps it with whichever ability held it, so each value is used once. */
  const assign = (ability: Ability, value: number) => {
    const scores = { ...c.baseScores };
    const holder = ABILITIES.find((a) => a !== ability && scores[a] === value && countOf(scores, value) >= countIn(pool, value));
    if (holder) scores[holder] = scores[ability];
    scores[ability] = value;
    set({ baseScores: scores });
  };

  return (
    <div className="stack">
      <div className="segmented">
        {(
          [
            ['standard', 'Standard array'],
            ['pointBuy', 'Point buy'],
            ['rolled', 'Roll 4d6'],
          ] as const
        ).map(([m, label]) => (
          <button key={m} type="button" className={c.scoreMethod === m ? 'is-active' : ''} onClick={() => setMethod(m)}>
            {label}
          </button>
        ))}
      </div>
      {c.scoreMethod === 'pointBuy' && (
        <p className="hint">
          {POINT_BUY_BUDGET - (cost ?? 99)} of {POINT_BUY_BUDGET} points left. Scores range 8–15 before increases.
        </p>
      )}
      {c.scoreMethod === 'rolled' && (
        <div className="button-row">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              const values = Array.from({ length: 6 }, () => rollDice('4d6dl1').total).sort((x, y) => y - x);
              setRolled(values);
              set({ baseScores: Object.fromEntries(ABILITIES.map((a, i) => [a, values[i]!])) as CreatorChoices['baseScores'] });
            }}
          >
            {rolled ? 'Reroll' : 'Roll 4d6 (drop lowest) ×6'}
          </button>
          {rolled && <span className="muted">Rolled: {rolled.join(', ')}</span>}
        </div>
      )}
      {primary.length > 0 && <p className="hint">Tip: {CLASSES[c.classId]!.name}s rely on {primary.map((a) => ABILITY_NAMES[a]).join(primary.length > 1 && CLASSES[c.classId]!.primaryAbilityChoice ? ' or ' : ' and ')}.</p>}
      <div className="score-table">
        {ABILITIES.map((a) => {
          const base = c.baseScores[a];
          const total = base + (c.backgroundBonus[a] ?? 0);
          return (
            <div key={a} className={`score-row${primary.includes(a) ? ' is-primary' : ''}`}>
              <span className="score-row__name">{ABILITY_NAMES[a]}</span>
              {c.scoreMethod === 'pointBuy' ? (
                <div className="stepper">
                  <button type="button" onClick={() => set({ baseScores: { ...c.baseScores, [a]: base - 1 } })} disabled={base <= 8} aria-label={`Lower ${a}`}>
                    −
                  </button>
                  <output>{base}</output>
                  <button
                    type="button"
                    onClick={() => set({ baseScores: { ...c.baseScores, [a]: base + 1 } })}
                    disabled={base >= 15 || (cost ?? 0) - POINT_BUY_COST[base]! + POINT_BUY_COST[base + 1]! > POINT_BUY_BUDGET}
                    aria-label={`Raise ${a}`}
                  >
                    +
                  </button>
                </div>
              ) : (
                <select value={base} onChange={(e) => assign(a, Number(e.target.value))} disabled={pool.length === 0}>
                  {[...new Set(pool)].sort((x, y) => y - x).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                  {!pool.includes(base) && <option value={base}>{base}</option>}
                </select>
              )}
              <span className="muted">{c.backgroundBonus[a] ? `+${c.backgroundBonus[a]}` : ''}</span>
              <strong className="score-row__total">{total}</strong>
              <span className="score-row__mod">{signed(abilityMod(total))}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const countOf = (scores: Record<Ability, number>, v: number) => ABILITIES.filter((a) => scores[a] === v).length;
const countIn = (pool: number[], v: number) => pool.filter((x) => x === v).length;

/** Standard array with the highest values in the class's primary abilities, then CON. */
function suggestedArray(primary: Ability[]): CreatorChoices['baseScores'] {
  const order = [...new Set([...primary, 'con' as Ability, 'dex' as Ability, 'wis' as Ability, ...ABILITIES])];
  return Object.fromEntries(order.map((a, i) => [a, STANDARD_ARRAY[i]!])) as CreatorChoices['baseScores'];
}

function DetailsStep({ c, set }: { c: CreatorChoices; set: (p: Partial<CreatorChoices>) => void }) {
  const cls = CLASSES[c.classId];
  if (!cls) return <p className="hint">Choose a class first.</p>;
  const fromBackground = new Set(BACKGROUNDS[c.backgroundId]?.skills ?? []);
  const skillPool = cls.skillChoice?.from === 'any' ? (Object.keys(SKILLS) as Skill[]) : (cls.skillChoice?.from ?? []);
  const expertise = expertiseCount(cls.id, 1);
  const masteries = weaponMasteryCount(cls.id, 1);
  const fightingStyles = Object.values(FEATS).filter((f) => f.type === 'fighting-style');

  return (
    <div className="stack">
      <section className="sheet-card">
        <h3>Name &amp; colour</h3>
        <input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="Character name" maxLength={60} autoFocus />
        <div className="swatches">
          {TOKEN_COLORS.map((col) => (
            <button key={col} type="button" className={`swatch${c.color === col ? ' is-active' : ''}`} style={{ background: col }} onClick={() => set({ color: col })} aria-label={col} />
          ))}
        </div>
      </section>

      {cls.skillChoice && (
        <section className="sheet-card">
          <h3>
            Class skills: choose {cls.skillChoice.choose} ({c.classSkills.length}/{cls.skillChoice.choose})
          </h3>
          <Checklist
            options={skillPool}
            selected={c.classSkills}
            limit={cls.skillChoice.choose}
            onChange={(classSkills) => set({ classSkills, expertise: c.expertise.filter((s) => [...classSkills, ...fromBackground, c.speciesSkill].includes(s)) })}
            label={(s) => SKILLS[s].name}
            disabled={(s) => (fromBackground.has(s) ? 'from background' : c.speciesSkill === s ? 'from species' : undefined)}
          />
        </section>
      )}

      {expertise > 0 && (
        <section className="sheet-card">
          <h3>
            Expertise: choose {expertise} ({c.expertise.length}/{expertise})
          </h3>
          <Checklist options={chosenSkills(c)} selected={c.expertise} limit={expertise} onChange={(e) => set({ expertise: e })} label={(s) => SKILLS[s].name} />
        </section>
      )}

      {hasFightingStyle(cls.id, 1) && (
        <section className="sheet-card">
          <h3>Fighting Style</h3>
          <div className="choice-grid choice-grid--compact">
            {fightingStyles.map((f) => (
              <ChoiceCard key={f.id} title={f.name} selected={c.fightingStyle === f.id} onClick={() => set({ fightingStyle: f.id })}>
                <span className="choice-card__line">{f.description.split('\n')[0]}</span>
              </ChoiceCard>
            ))}
          </div>
        </section>
      )}

      {masteries > 0 && (
        <section className="sheet-card">
          <h3>
            Weapon Mastery: choose {masteries} ({c.weaponMasteries.length}/{masteries})
          </h3>
          <Checklist
            options={masteryOptions(cls.id)}
            selected={c.weaponMasteries}
            limit={masteries}
            onChange={(weaponMasteries) => set({ weaponMasteries })}
            label={(w) => `${WEAPONS[w]!.name} (${cap(WEAPONS[w]!.mastery)})`}
          />
        </section>
      )}

      <section className="sheet-card">
        <h3>Languages: Common plus two ({c.languages.length}/2)</h3>
        <Checklist options={STANDARD_LANGUAGES} selected={c.languages} limit={2} onChange={(languages) => set({ languages })} label={(l) => l} />
      </section>
    </div>
  );
}

function EquipmentPicker({ title, choices, selected, onChange }: { title: string; choices: EquipmentChoice[]; selected: string[]; onChange: (s: string[]) => void }) {
  return (
    <section className="sheet-card">
      <h3>{title}</h3>
      {choices.map((choice, i) => (
        <div key={i} className="equipment-options">
          {choice.options.map((o) => (
            <label key={o.label} className={`equipment-option${selected[i] === o.label ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name={`${title}-${i}`}
                checked={selected[i] === o.label}
                onChange={() => {
                  const next = [...selected];
                  next[i] = o.label;
                  onChange(next);
                }}
              />
              <span className="equipment-option__label">{o.label}</span>
              <span>
                {o.items.map((it) => `${it.count > 1 ? `${it.count} × ` : ''}${ARMOR[it.id]?.name ?? WEAPONS[it.id]?.name ?? it.name}`).join(', ')}
                {o.items.length ? ', ' : ''}
                {o.gold} GP
              </span>
            </label>
          ))}
        </div>
      ))}
    </section>
  );
}
