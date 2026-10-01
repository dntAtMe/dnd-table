import type { CharacterRecord, ClientMessage } from '@dnd/protocol';
import {
  ABILITIES,
  ABILITY_NAMES,
  CLASSES,
  FEATS,
  SKILLS,
  SUBCLASSES,
  WEAPONS,
  abilityScores,
  applyLevelUp,
  computeCharacter,
  featAbilityOptions,
  featsForLevel,
  levelUpIssues,
  levelUpPlan,
  masteryOptions,
  rollDice,
  type Ability,
  type LevelUpChoices,
  type Skill,
} from '@dnd/rules';
import { useMemo, useState } from 'react';
import { MaybeLink } from '../knowledge/EntityLink';
import { RichText } from '../knowledge/RichText';

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

export function LevelUp({ record, send, onDone }: { record: CharacterRecord; send: (msg: ClientMessage) => void; onDone: () => void }) {
  const c = record.data;
  const plan = useMemo(() => levelUpPlan(c), [c]);
  const [hpMode, setHpMode] = useState<'average' | 'roll' | 'manual'>('average');
  const [ch, setCh] = useState<LevelUpChoices>({
    hpRoll: null,
    subclassId: null,
    featId: null,
    increases: {},
    expertise: [],
    weaponMasteries: [],
    fightingStyle: null,
  });
  const set = (patch: Partial<LevelUpChoices>) => setCh((prev) => ({ ...prev, ...patch }));

  if (!plan) return null;
  const issues = levelUpIssues(c, plan, ch);
  const scores = abilityScores(c);
  const derived = computeCharacter(c);
  const feat = ch.featId ? FEATS[ch.featId] : undefined;
  const featAbilities = feat ? featAbilityOptions(feat) : [];
  const takenFeats = c.advancements.map((a) => a.featId);
  const proficientSkills = Object.entries(derived.skills)
    .filter(([s, v]) => v.proficiency >= 1 && !c.expertise.includes(s as Skill))
    .map(([s]) => s as Skill);
  const cap = feat?.type === 'epic-boon' ? 30 : 20;

  const confirm = () => {
    if (issues.length) return;
    send({ type: 'character:update', characterId: record.id, data: applyLevelUp(c, plan, ch) });
    onDone();
  };

  const setIncrease = (a: Ability, value: number) => {
    const next = { ...ch.increases, [a]: value };
    if (!value) delete next[a];
    set({ increases: next });
  };

  const hpGain = (ch.hpRoll ?? plan.hpAverage) + Math.floor((scores.con - 10) / 2);

  return (
    <div className="creator levelup">
      <header className="creator__head">
        <div>
          <h2>
            {c.name}: level {plan.level}
          </h2>
          <p className="muted">
            <MaybeLink entry={{ kind: 'class', id: c.classId }}>{CLASSES[c.classId]?.name}</MaybeLink> {plan.level}
          </p>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDone}>
          Cancel
        </button>
      </header>

      <div className="creator__body">
        {plan.features.length > 0 && (
          <section className="sheet-card">
            <h3>New features</h3>
            <ul className="trait-list">
              {plan.features.map((f) => (
                <li key={f.source + f.name}>
                  <details>
                    <summary>
                      <MaybeLink entry={f.ref?.kind === 'feature' ? f.ref : null} hoverOnly>
                        {f.name}
                      </MaybeLink>{' '}
                      <span className="muted">
                        ·{' '}
                        <MaybeLink entry={f.ref?.kind === 'subclass' ? f.ref : null} hoverOnly>
                          {f.source}
                        </MaybeLink>
                      </span>
                    </summary>
                    <RichText text={f.description} self={f.ref} className="prose" />
                  </details>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="sheet-card">
          <h3>Hit points</h3>
          <div className="segmented">
            <button
              type="button"
              className={hpMode === 'average' ? 'is-active' : ''}
              onClick={() => {
                setHpMode('average');
                set({ hpRoll: null });
              }}
            >
              Average ({plan.hpAverage})
            </button>
            <button
              type="button"
              className={hpMode === 'roll' ? 'is-active' : ''}
              onClick={() => {
                setHpMode('roll');
                const roll = rollDice(`1d${plan.hitDie}`).total;
                set({ hpRoll: roll });
                send({ type: 'chat', text: `${c.name} rolls ${roll} on a d${plan.hitDie} for level ${plan.level} Hit Points.`, visibility: 'public' });
              }}
            >
              Roll d{plan.hitDie}
            </button>
            <button type="button" className={hpMode === 'manual' ? 'is-active' : ''} onClick={() => setHpMode('manual')}>
              I rolled…
            </button>
          </div>
          {hpMode === 'manual' && (
            <label className="field-row">
              <span>Your d{plan.hitDie} roll</span>
              <input type="number" min={1} max={plan.hitDie} value={ch.hpRoll ?? ''} onChange={(e) => set({ hpRoll: e.target.value ? Number(e.target.value) : null })} />
            </label>
          )}
          <p className="hint">
            {hpMode === 'roll' && ch.hpRoll !== null ? `Rolled ${ch.hpRoll}. ` : ''}Maximum HP goes up by {Math.max(1, hpGain)} (including CON).
          </p>
        </section>

        {plan.needsSubclass && (
          <section className="sheet-card">
            <h3>Subclass</h3>
            <div className="choice-grid">
              {plan.subclassOptions.map((id) => {
                const sub = SUBCLASSES[id]!;
                return (
                  <button key={id} type="button" className={`choice-card${ch.subclassId === id ? ' is-selected' : ''}`} onClick={() => set({ subclassId: id })}>
                    <span className="choice-card__title">
                      <MaybeLink entry={{ kind: 'subclass', id }} hoverOnly>
                        {sub.name}
                      </MaybeLink>
                    </span>
                    <span className="choice-card__meta">{sub.summary}</span>
                    <span className="choice-card__line">
                      <RichText text={sub.description} self={{ kind: 'subclass', id }} inline hoverOnly />
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="hint">The SRD includes one subclass per class; others from your books can be added as homebrew later.</p>
          </section>
        )}

        {plan.featChoice && (
          <section className="sheet-card">
            <h3>{plan.featChoice === 'boon' ? 'Epic Boon' : 'Ability Score Improvement or feat'}</h3>
            <div className="choice-grid choice-grid--compact">
              {featsForLevel(plan.featChoice, plan.level, takenFeats).map((f) => (
                <button key={f.id} type="button" className={`choice-card${ch.featId === f.id ? ' is-selected' : ''}`} onClick={() => set({ featId: f.id, increases: {} })}>
                  <span className="choice-card__title">
                    <MaybeLink entry={{ kind: 'feat', id: f.id }} hoverOnly>
                      {f.name}
                    </MaybeLink>
                  </span>
                  {f.prerequisite && <span className="choice-card__line">Requires {f.prerequisite}</span>}
                </button>
              ))}
            </div>
            {feat && feat.id !== 'ability-score-improvement' && (
              <details className="rules-text" open>
                <summary>
                  <MaybeLink entry={{ kind: 'feat', id: feat.id }} hoverOnly>
                    {feat.name}
                  </MaybeLink>
                </summary>
                <RichText text={feat.description} self={{ kind: 'feat', id: feat.id }} className="prose" />
              </details>
            )}
            {feat && featAbilities.length > 0 && (
              <div className="score-table">
                {featAbilities.map((a) => {
                  const inc = ch.increases[a] ?? 0;
                  const max = feat.id === 'ability-score-improvement' ? 2 : 1;
                  const used = Object.values(ch.increases).reduce((n, v) => n + (v ?? 0), 0);
                  return (
                    <div key={a} className="score-row score-row--compact">
                      <span className="score-row__name">{ABILITY_NAMES[a]}</span>
                      <div className="stepper">
                        <button type="button" onClick={() => setIncrease(a, inc - 1)} disabled={inc <= 0} aria-label={`Lower ${a}`}>
                          −
                        </button>
                        <output>+{inc}</output>
                        <button
                          type="button"
                          onClick={() => setIncrease(a, inc + 1)}
                          disabled={inc >= max || used >= max || scores[a] + inc >= cap}
                          aria-label={`Raise ${a}`}
                        >
                          +
                        </button>
                      </div>
                      <span className="muted">{scores[a]}</span>
                      <strong className="score-row__total">{Math.min(cap, scores[a] + inc)}</strong>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {plan.newExpertise > 0 && (
          <section className="sheet-card">
            <h3>
              Expertise: choose {plan.newExpertise} ({ch.expertise.length}/{plan.newExpertise})
            </h3>
            <div className="checklist">
              {proficientSkills.map((s) => (
                <label key={s} className="check">
                  <input
                    type="checkbox"
                    checked={ch.expertise.includes(s)}
                    disabled={!ch.expertise.includes(s) && ch.expertise.length >= plan.newExpertise}
                    onChange={() => set({ expertise: ch.expertise.includes(s) ? ch.expertise.filter((x) => x !== s) : [...ch.expertise, s] })}
                  />
                  <MaybeLink entry={{ kind: 'skill', id: s }} hoverOnly>
                    {SKILLS[s].name}
                  </MaybeLink>
                </label>
              ))}
            </div>
          </section>
        )}

        {plan.newMasteries > 0 && (
          <section className="sheet-card">
            <h3>
              Weapon Mastery: choose {plan.newMasteries} more ({ch.weaponMasteries.length}/{plan.newMasteries})
            </h3>
            <div className="checklist">
              {masteryOptions(c.classId)
                .filter((w) => !c.weaponMasteries.includes(w))
                .map((w) => (
                  <label key={w} className="check">
                    <input
                      type="checkbox"
                      checked={ch.weaponMasteries.includes(w)}
                      disabled={!ch.weaponMasteries.includes(w) && ch.weaponMasteries.length >= plan.newMasteries}
                      onChange={() =>
                        set({ weaponMasteries: ch.weaponMasteries.includes(w) ? ch.weaponMasteries.filter((x) => x !== w) : [...ch.weaponMasteries, w] })
                      }
                    />
                    <MaybeLink entry={{ kind: 'weapon', id: w }} hoverOnly>
                      {WEAPONS[w]!.name}
                    </MaybeLink>
                  </label>
                ))}
            </div>
          </section>
        )}

        {plan.needsFightingStyle && (
          <section className="sheet-card">
            <h3>Fighting Style</h3>
            <div className="choice-grid choice-grid--compact">
              {Object.values(FEATS)
                .filter((f) => f.type === 'fighting-style')
                .map((f) => (
                  <button key={f.id} type="button" className={`choice-card${ch.fightingStyle === f.id ? ' is-selected' : ''}`} onClick={() => set({ fightingStyle: f.id })}>
                    <span className="choice-card__title">
                      <MaybeLink entry={{ kind: 'feat', id: f.id }} hoverOnly>
                        {f.name}
                      </MaybeLink>
                    </span>
                    <span className="choice-card__line">
                      <RichText text={f.description.split('\n')[0]!} self={{ kind: 'feat', id: f.id }} inline hoverOnly />
                    </span>
                  </button>
                ))}
            </div>
          </section>
        )}

        {plan.spellcasting && (
          <section className="sheet-card">
            <h3>Spellcasting</h3>
            <p>
              Cantrips {plan.spellcasting.cantrips[0]} → {plan.spellcasting.cantrips[1]} · Prepared spells {plan.spellcasting.prepared[0]} →{' '}
              {plan.spellcasting.prepared[1]}
            </p>
            <p className="muted">
              Slots:{' '}
              {plan.spellcasting.slots
                .map((n, i) => (n ? `${ORDINAL[i]} ×${n}` : null))
                .filter(Boolean)
                .join(', ')}
            </p>
            <p className="hint">Add new spells from the Spells tab afterwards.</p>
          </section>
        )}
      </div>

      <footer className="creator__foot">
        {issues.length > 0 && <p className="hint">{issues[0]}</p>}
        <div className="creator__nav">
          <button type="button" className="btn btn--primary" disabled={issues.length > 0} onClick={confirm}>
            Reach level {plan.level}
          </button>
        </div>
      </footer>
    </div>
  );
}
