import type { ClientMessage, Visibility } from '@dnd/protocol';
import {
  ABILITIES,
  ABILITY_NAMES,
  SKILLS,
  abilityMod,
  criticalDamage,
  d20Expression,
  damageExpression,
  describeDamage,
  monsterCrText,
  monsterInitiative,
  monsterSave,
  monsterSensesText,
  monsterSkill,
  monsterSpeedText,
  type D20Mode,
  type MonsterAction,
  type MonsterDamage,
  type MonsterDef,
  type Skill,
} from '@dnd/rules';
import { useState } from 'react';
import { signed } from '../character/useCharacter';
import { RichText } from '../knowledge/RichText';
import './combat.css';

type Send = (msg: ClientMessage) => void;

interface Props {
  monster: MonsterDef;
  /** Name used in roll labels, e.g. "Goblin Warrior 2". */
  name?: string;
  send: Send;
}

const SECTIONS: { key: 'traits' | 'actions' | 'bonusActions' | 'reactions' | 'legendaryActions'; title: string }[] = [
  { key: 'traits', title: 'Traits' },
  { key: 'actions', title: 'Actions' },
  { key: 'bonusActions', title: 'Bonus Actions' },
  { key: 'reactions', title: 'Reactions' },
  { key: 'legendaryActions', title: 'Legendary Actions' },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A monster's stat block for the GM, with tap-to-roll checks, saves, attacks and damage. */
export function StatBlock({ monster: m, name = m.name, send }: Props) {
  const [mode, setMode] = useState<D20Mode>('normal');
  const [visibility, setVisibility] = useState<Visibility>('gm');

  const roll = (label: string, expr: string) => send({ type: 'roll', expr, label: `${name}: ${label}`.slice(0, 80), visibility });
  const rollD20 = (label: string, bonus: number) => {
    roll(mode === 'normal' ? label : `${label} (${mode})`, d20Expression(bonus, mode));
    setMode('normal');
  };
  const rollDamage = (label: string, damage: readonly MonsterDamage[], crit = false) => {
    const expr = damageExpression(damage);
    roll(`${label} damage${crit ? ' (critical)' : ''}`, crit ? criticalDamage(expr) : expr);
  };

  const speed = monsterSpeedText(m);
  const skills = Object.keys(m.skills) as Skill[];
  const senses = monsterSensesText(m);

  return (
    <article className="statblock">
      <header className="statblock__head">
        <h3>{m.name}</h3>
        <p className="muted">
          {m.size} {cap(m.type)}, {cap(m.alignment)}
        </p>
      </header>

      <div className="statblock__controls">
        <div className="segmented" role="radiogroup" aria-label="Next d20 roll">
          {(['disadvantage', 'normal', 'advantage'] as const).map((x) => (
            <button key={x} type="button" role="radio" aria-checked={mode === x} className={mode === x ? 'is-active' : ''} onClick={() => setMode(x)}>
              {x === 'normal' ? 'Normal' : x === 'advantage' ? 'Adv.' : 'Dis.'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`toggle toggle--sm${visibility === 'gm' ? ' toggle--on' : ''}`}
          onClick={() => setVisibility(visibility === 'gm' ? 'public' : 'gm')}
          aria-pressed={visibility === 'gm'}
        >
          Hidden rolls
        </button>
      </div>

      <dl className="statblock__core">
        <div>
          <dt>AC</dt>
          <dd>
            {m.ac}
            {m.acNote && <span className="muted"> ({m.acNote})</span>}
          </dd>
        </div>
        <div>
          <dt>HP</dt>
          <dd>
            {m.hp} <span className="muted">({m.hpFormula})</span>
          </dd>
        </div>
        <div>
          <dt>Initiative</dt>
          <dd>
            <button type="button" className="roll-btn" onClick={() => rollD20('Initiative', monsterInitiative(m))}>
              {signed(monsterInitiative(m))}
            </button>
          </dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{speed}</dd>
        </div>
      </dl>

      <table className="statblock__abilities">
        <thead>
          <tr>
            <th />
            <th>Score</th>
            <th>Check</th>
            <th>Save</th>
          </tr>
        </thead>
        <tbody>
          {ABILITIES.map((a) => (
            <tr key={a}>
              <th scope="row" title={ABILITY_NAMES[a]}>
                {a.toUpperCase()}
              </th>
              <td>{m.scores[a]}</td>
              <td>
                <button type="button" className="roll-btn" onClick={() => rollD20(`${ABILITY_NAMES[a]} check`, abilityMod(m.scores[a]))}>
                  {signed(abilityMod(m.scores[a]))}
                </button>
              </td>
              <td>
                <button
                  type="button"
                  className={`roll-btn${m.saves[a] !== undefined ? ' roll-btn--proficient' : ''}`}
                  onClick={() => rollD20(`${ABILITY_NAMES[a]} save`, monsterSave(m, a))}
                >
                  {signed(monsterSave(m, a))}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {skills.length > 0 && (
        <div className="statblock__line">
          <strong>Skills</strong>
          <span className="statblock__chips">
            {skills.map((s) => (
              <button key={s} type="button" className="roll-btn roll-btn--inline" onClick={() => rollD20(SKILLS[s].name, monsterSkill(m, s))}>
                {SKILLS[s].name} {signed(monsterSkill(m, s))}
              </button>
            ))}
          </span>
        </div>
      )}
      {m.vulnerabilities.length > 0 && <Line label="Vulnerabilities" text={linkList('damage-type', m.vulnerabilities)} rich />}
      {m.resistances.length > 0 && <Line label="Resistances" text={linkList('damage-type', m.resistances)} rich />}
      {m.immunities.length > 0 && <Line label="Immunities" text={linkList('damage-type', m.immunities)} rich />}
      {m.conditionImmunities.length > 0 && <Line label="Condition Immunities" text={linkList('condition', m.conditionImmunities)} rich />}
      {m.gear && <Line label="Gear" text={m.gear} rich />}
      <Line label="Senses" text={senses} />
      <Line label="Languages" text={m.languages} />
      <Line label="CR" text={monsterCrText(m)} />

      {SECTIONS.map(({ key, title }) =>
        m[key].length ? (
          <section key={key} className="statblock__section">
            <h4>{title}</h4>
            {m[key].map((a) => (
              <ActionEntry key={a.name} action={a} monsterId={m.id} onD20={rollD20} onDamage={rollDamage} />
            ))}
          </section>
        ) : null,
      )}
    </article>
  );
}

/** Explicit knowledge base links ("[[condition:charmed|Charmed]], …") for lowercase id lists. */
function linkList(kind: 'damage-type' | 'condition', ids: string[]): string {
  return ids.map((id) => `[[${kind}:${id.toLowerCase()}|${cap(id)}]]`).join(', ');
}

function Line({ label, text, rich = false }: { label: string; text: string; rich?: boolean }) {
  return (
    <p className="statblock__line">
      <strong>{label}</strong> {rich ? <RichText text={text} inline /> : text}
    </p>
  );
}

interface ActionProps {
  action: MonsterAction;
  monsterId: string;
  onD20: (label: string, bonus: number) => void;
  onDamage: (label: string, damage: readonly MonsterDamage[], crit?: boolean) => void;
}

function ActionEntry({ action: a, monsterId, onD20, onDamage }: ActionProps) {
  const attack = a.attack;
  const save = a.save;
  return (
    <div className="statblock__action">
      <p className="statblock__desc">
        <strong>
          {a.name}
          {a.usage && ` (${a.usage})`}.
        </strong>{' '}
        <RichText text={a.description} self={{ kind: 'monster', id: monsterId }} inline />
      </p>
      {(attack || save?.damage) && (
        <div className="statblock__rolls">
          {attack && (
            <button type="button" className="roll-btn" onClick={() => onD20(a.name, attack.bonus)} title={`${cap(attack.kind)} attack roll`}>
              {signed(attack.bonus)} to hit
            </button>
          )}
          {attack && attack.damage.length > 0 && (
            <>
              <button type="button" className="roll-btn roll-btn--damage" onClick={() => onDamage(a.name, attack.damage)}>
                {describeDamage(attack.damage)}
              </button>
              <button type="button" className="roll-btn roll-btn--crit" onClick={() => onDamage(a.name, attack.damage, true)} title="Critical hit: double the dice">
                Crit
              </button>
            </>
          )}
          {attack?.riders?.map((r) => (
            <span key={r.note} className="statblock__rider">
              <button type="button" className="roll-btn roll-btn--damage" onClick={() => onDamage(`${a.name} (${r.note})`, [r])} title={r.note}>
                {r.note.startsWith('instead') ? '' : '+'}
                {describeDamage([r])}
              </button>
              <span className="muted">{r.note}</span>
            </span>
          ))}
          {save && (
            <span className="statblock__dc">
              DC {save.dc} {save.ability.toUpperCase()}
              {save.half ? ', half on success' : ''}
            </span>
          )}
          {save?.damage && (
            <button type="button" className="roll-btn roll-btn--damage" onClick={() => onDamage(a.name, save.damage!)}>
              {describeDamage(save.damage)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
