import {
  ABILITIES,
  ABILITY_NAMES,
  CONDITIONS,
  CONDITION_IDS,
  MAX_EXHAUSTION,
  RULES_TEXT,
  SKILL_IDS,
  SKILLS,
  applyHpChange,
  type Ability,
  type ConditionId,
} from '@dnd/rules';
import { useState, type FormEvent } from 'react';
import { signed, type CharacterActions } from './useCharacter';

const PROFICIENCY_MARK = { 0: '○', 0.5: '◐', 1: '●', 2: '◉' } as const;
const PROFICIENCY_TITLE = { 0: 'Not proficient', 0.5: 'Half proficiency (Jack of All Trades)', 1: 'Proficient', 2: 'Expertise' } as const;

export function Vitals({ a }: { a: CharacterActions }) {
  const { data, derived, canEdit } = a;
  const [amount, setAmount] = useState('');
  const hp = data.state.hp;
  const pct = Math.max(0, Math.min(100, (hp / derived.hpMax) * 100));

  const apply = (sign: 1 | -1) => {
    const n = Math.abs(Math.round(Number(amount)));
    if (!n) return;
    const next = applyHpChange(data.state, derived.hpMax, sign * n);
    a.patchState({ hp: next.hp, tempHp: next.tempHp, deathSaves: next.deathSaves });
    setAmount('');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    apply(-1);
  };

  return (
    <div className="vitals">
      <div className={`hp-card${hp === 0 ? ' is-down' : hp <= derived.hpMax / 4 ? ' is-low' : ''}`}>
        <div className="hp-card__top">
          <span className="stat-label">Hit Points</span>
          {data.state.tempHp > 0 && <span className="hp-card__temp">+{data.state.tempHp} temp</span>}
        </div>
        <div className="hp-card__value">
          <strong>{hp}</strong>
          <span>/ {derived.hpMax}</span>
        </div>
        <div className="hp-bar" aria-hidden="true">
          <div style={{ width: `${pct}%` }} />
        </div>
        {canEdit && (
          <form className="hp-card__controls" onSubmit={submit}>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount"
              aria-label="Hit point amount"
            />
            <button type="submit" className="btn btn--sm btn--danger" disabled={!amount}>
              Damage
            </button>
            <button type="button" className="btn btn--sm" onClick={() => apply(1)} disabled={!amount}>
              Heal
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={!amount}
              onClick={() => {
                const n = Math.abs(Math.round(Number(amount)));
                // Temporary HP doesn't stack: keep the higher value.
                if (n) a.patchState({ tempHp: Math.max(data.state.tempHp, n) });
                setAmount('');
              }}
            >
              Temp
            </button>
          </form>
        )}
      </div>

      <div className="stat-grid">
        <div className="stat" title={derived.acSource}>
          <span className="stat-label">AC</span>
          <strong>{derived.ac}</strong>
        </div>
        <button type="button" className="stat stat--roll" onClick={() => a.rollD20('check', 'Initiative', derived.initiative, 'dex')}>
          <span className="stat-label">Initiative</span>
          <strong>{signed(derived.initiative)}</strong>
        </button>
        <div className="stat">
          <span className="stat-label">Speed</span>
          <strong>{derived.speed}</strong>
        </div>
        <div className="stat">
          <span className="stat-label">Prof.</span>
          <strong>{signed(derived.profBonus)}</strong>
        </div>
        <div className="stat">
          <span className="stat-label">Passive Perc.</span>
          <strong>{derived.passivePerception}</strong>
        </div>
        <button
          type="button"
          className={`stat stat--toggle${data.state.heroicInspiration ? ' is-on' : ''}`}
          onClick={() => a.patchState({ heroicInspiration: !data.state.heroicInspiration })}
          disabled={!canEdit}
          aria-pressed={data.state.heroicInspiration}
          title="Heroic Inspiration: reroll any die"
        >
          <span className="stat-label">Inspiration</span>
          <strong>{data.state.heroicInspiration ? '★' : '☆'}</strong>
        </button>
      </div>
    </div>
  );
}

export function RollControls({ a }: { a: CharacterActions }) {
  return (
    <div className="roll-controls">
      <div className="segmented" role="radiogroup" aria-label="Next roll">
        {(['disadvantage', 'normal', 'advantage'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={a.mode === m} className={a.mode === m ? 'is-active' : ''} onClick={() => a.setMode(m)}>
            {m === 'normal' ? 'Normal' : m === 'advantage' ? 'Advantage' : 'Disadvantage'}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`toggle toggle--sm${a.visibility === 'gm' ? ' toggle--on' : ''}`}
        onClick={() => a.setVisibility(a.visibility === 'gm' ? 'public' : 'gm')}
        aria-pressed={a.visibility === 'gm'}
      >
        To GM only
      </button>
    </div>
  );
}

export function AbilitiesTab({ a }: { a: CharacterActions }) {
  const { derived } = a;
  const skillsBy = (ability: Ability) => SKILL_IDS.filter((s) => SKILLS[s].ability === ability);
  return (
    <div className="abilities">
      {ABILITIES.map((ab) => {
        const save = derived.saves[ab];
        return (
          <section key={ab} className="ability">
            <button type="button" className="ability__head" onClick={() => a.rollD20('check', `${ABILITY_NAMES[ab]} check`, derived.mods[ab], ab)}>
              <span className="ability__name">{ABILITY_NAMES[ab]}</span>
              <span className="ability__mod">{signed(derived.mods[ab])}</span>
              <span className="ability__score">{derived.scores[ab]}</span>
            </button>
            <button type="button" className="skill-row" onClick={() => a.rollD20('save', `${ab.toUpperCase()} save`, save.bonus, ab)}>
              <span className="skill-row__mark" title={save.proficient ? 'Proficient' : 'Not proficient'}>
                {save.proficient ? '●' : '○'}
              </span>
              <span className="skill-row__name">Saving throw</span>
              <span className="skill-row__bonus">{signed(save.bonus)}</span>
            </button>
            {skillsBy(ab).map((s) => {
              const sk = derived.skills[s];
              return (
                <button
                  key={s}
                  type="button"
                  className="skill-row"
                  onClick={() => a.rollD20('check', `${SKILLS[s].name} check`, sk.bonus, ab)}
                  title={RULES_TEXT.skills[s]?.description}
                >
                  <span className="skill-row__mark" title={PROFICIENCY_TITLE[sk.proficiency]}>
                    {PROFICIENCY_MARK[sk.proficiency]}
                  </span>
                  <span className="skill-row__name">{SKILLS[s].name}</span>
                  <span className="skill-row__bonus">{signed(sk.bonus)}</span>
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

export function CombatTab({ a }: { a: CharacterActions }) {
  const { data, derived, canEdit } = a;
  const [openMastery, setOpenMastery] = useState<string | null>(null);
  const conditions = new Set(data.state.conditions);

  const toggleCondition = (id: ConditionId) => {
    const next = conditions.has(id) ? data.state.conditions.filter((c) => c !== id) : [...data.state.conditions, id];
    a.patchState({ conditions: next });
  };

  const hitDiceLeft = data.level - data.state.hitDiceSpent;
  const ds = data.state.deathSaves;

  return (
    <div className="combat">
      {data.state.hp === 0 && (
        <section className="sheet-card death-saves">
          <h3>Death saves</h3>
          <button type="button" className="btn btn--sm" onClick={() => a.roll('Death saving throw', '1d20')}>
            Roll death save
          </button>
          {(['successes', 'failures'] as const).map((k) => (
            <div key={k} className="pips-row">
              <span>{k === 'successes' ? 'Successes' : 'Failures'}</span>
              <Pips
                count={3}
                used={ds[k]}
                disabled={!canEdit}
                variant={k === 'failures' ? 'danger' : 'success'}
                onChange={(n) => a.patchState({ deathSaves: { ...ds, [k]: n } })}
              />
            </div>
          ))}
        </section>
      )}

      <section className="sheet-card">
        <h3>Attacks</h3>
        <ul className="attacks">
          {derived.attacks.map((atk) => (
            <li key={atk.id} className="attack">
              <div className="attack__main">
                <span className="attack__name">{atk.name}</span>
                <span className="attack__meta">
                  {atk.range} · {atk.damageType}
                  {!atk.proficient && ' · not proficient'}
                </span>
              </div>
              <div className="attack__buttons">
                <button type="button" className="roll-btn" onClick={() => a.rollD20('attack', `${atk.name} attack`, atk.attackBonus, atk.ability)} title="Attack roll">
                  {signed(atk.attackBonus)}
                </button>
                <button type="button" className="roll-btn roll-btn--damage" onClick={() => a.rollDamage(`${atk.name} damage`, atk.damage)} title="Damage">
                  {atk.damage}
                </button>
                {atk.versatileDamage && (
                  <button
                    type="button"
                    className="roll-btn roll-btn--damage"
                    onClick={() => a.rollDamage(`${atk.name} damage (two hands)`, atk.versatileDamage!)}
                    title="Two-handed damage"
                  >
                    {atk.versatileDamage}
                  </button>
                )}
                <button type="button" className="roll-btn roll-btn--crit" onClick={() => a.rollDamage(`${atk.name} damage`, atk.damage, true)} title="Critical hit damage">
                  Crit
                </button>
              </div>
              {(atk.mastery || atk.notes.length > 0) && (
                <div className="attack__extra">
                  {atk.mastery && (
                    <button type="button" className="chip" onClick={() => setOpenMastery(openMastery === atk.id ? null : atk.id)}>
                      Mastery: {RULES_TEXT.masteries[atk.mastery]?.name ?? atk.mastery}
                    </button>
                  )}
                  {atk.notes.map((n) => (
                    <span key={n} className="attack__note">
                      {n}
                    </span>
                  ))}
                  {openMastery === atk.id && atk.mastery && <p className="hint">{RULES_TEXT.masteries[atk.mastery]?.description}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="sheet-card">
        <h3>Conditions</h3>
        <div className="chips">
          {CONDITION_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`chip${conditions.has(id) ? ' chip--on' : ''}`}
              onClick={() => toggleCondition(id)}
              disabled={!canEdit}
              title={CONDITIONS[id].summary}
              aria-pressed={conditions.has(id)}
            >
              {CONDITIONS[id].name}
            </button>
          ))}
        </div>
        <div className="pips-row">
          <span title="Each level: −2 to d20 tests and −5 ft speed">Exhaustion</span>
          <Pips count={MAX_EXHAUSTION} used={data.state.exhaustion} disabled={!canEdit} variant="danger" onChange={(n) => a.patchState({ exhaustion: n })} />
        </div>
      </section>

      <section className="sheet-card">
        <h3>Hit Dice</h3>
        <p>
          <strong>
            {hitDiceLeft}d{derived.hitDie}
          </strong>{' '}
          <span className="muted">of {data.level} left. Spend them during a Short Rest.</span>
        </p>
      </section>
    </div>
  );
}

/** Row of toggleable pips: clicking pip i sets the count to i+1 (or i if it was the last filled). */
export function Pips({
  count,
  used,
  onChange,
  disabled,
  variant = 'default',
}: {
  count: number;
  used: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  variant?: 'default' | 'danger' | 'success';
}) {
  if (count > 12) {
    return (
      <div className="counter">
        <button type="button" onClick={() => onChange(Math.max(0, used - 1))} disabled={disabled || used <= 0} aria-label="Decrease">
          −
        </button>
        <output>
          {used} / {count}
        </output>
        <button type="button" onClick={() => onChange(Math.min(count, used + 1))} disabled={disabled || used >= count} aria-label="Increase">
          +
        </button>
      </div>
    );
  }
  return (
    <div className={`pips pips--${variant}`}>
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          className={`pip${i < used ? ' is-filled' : ''}`}
          disabled={disabled}
          onClick={() => onChange(i + 1 === used ? i : i + 1)}
          aria-label={`${i + 1} of ${count}`}
        />
      ))}
    </div>
  );
}
