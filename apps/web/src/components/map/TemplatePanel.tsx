import type { ClientMessage, MapTemplate, SceneView } from '@dnd/protocol';
import { AREA_SHAPES, AREA_SHAPE_LABELS, AREA_SIZE_LABELS, gridGeometry, parseSpellArea, type SpellArea } from '@dnd/rules';
import { useEffect, useMemo, useState } from 'react';
import { TEMPLATE_COLORS, caughtBy, templateTitle, type TemplateSettings } from './TemplateLayer';

type Send = (msg: ClientMessage) => void;

interface SpellOption {
  id: string;
  name: string;
  area: SpellArea;
  /** Lasts beyond the moment it's cast (a Cloudkill rather than a Fireball). */
  lasting: boolean;
}

let spellAreas: Promise<SpellOption[]> | undefined;

/** SRD spells whose text names an area of effect (loaded on first use; the spell list is large). */
function loadSpellAreas(): Promise<SpellOption[]> {
  spellAreas ??= import('@dnd/rules/spells').then((m) =>
    m.SPELLS.flatMap((s) => {
      const area = parseSpellArea(s.description);
      return area ? [{ id: s.id, name: s.name, area, lasting: s.duration !== 'Instantaneous' }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name)),
  );
  return spellAreas;
}

const clampFeet = (n: number) => Math.max(5, Math.min(1000, Math.round(n) || 5));

interface OptionsProps {
  value: TemplateSettings;
  onChange: (next: TemplateSettings) => void;
  isGm: boolean;
  /** GM: remove every template on the scene. */
  onClear?: () => void;
}

/** Toolbar options for the template tool: a spell or a shape and size, colour, and how long it stays. */
export function TemplateOptions({ value, onChange, isGm, onClear }: OptionsProps) {
  const [spells, setSpells] = useState<SpellOption[]>([]);
  const [spellId, setSpellId] = useState('');
  useEffect(() => {
    let alive = true;
    void loadSpellAreas().then((list) => alive && setSpells(list));
    return () => {
      alive = false;
    };
  }, []);
  const set = (patch: Partial<TemplateSettings>) => onChange({ ...value, ...patch });

  const pickSpell = (id: string) => {
    setSpellId(id);
    const spell = spells.find((s) => s.id === id);
    if (!spell) return set({ label: '' });
    const { shape, size, width, height } = spell.area;
    set({ label: spell.name, shape, size, width: width ?? 5, height: height ?? value.height, linger: spell.lasting });
  };

  return (
    <div className="template-options">
      <select value={spellId} onChange={(e) => pickSpell(e.target.value)} aria-label="Spell" title="Fill in the area from a spell">
        <option value="">Custom area</option>
        {spells.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <select
        value={value.shape}
        onChange={(e) => {
          setSpellId('');
          set({ shape: e.target.value as TemplateSettings['shape'], label: '' });
        }}
        aria-label="Shape"
      >
        {AREA_SHAPES.map((s) => (
          <option key={s} value={s}>
            {AREA_SHAPE_LABELS[s]}
          </option>
        ))}
      </select>
      <label className="template-options__size" title={`The area's ${AREA_SIZE_LABELS[value.shape]} in feet`}>
        <input
          type="number"
          min={5}
          max={1000}
          step={5}
          inputMode="numeric"
          value={value.size}
          onChange={(e) => set({ size: clampFeet(Number(e.target.value)) })}
          aria-label={`${AREA_SIZE_LABELS[value.shape]} in feet`}
        />
        ft {AREA_SIZE_LABELS[value.shape]}
      </label>
      {value.shape === 'line' && (
        <label className="template-options__size">
          <input
            type="number"
            min={5}
            max={100}
            step={5}
            inputMode="numeric"
            value={value.width}
            onChange={(e) => set({ width: clampFeet(Number(e.target.value)) })}
            aria-label="Width in feet"
          />
          ft wide
        </label>
      )}
      <div className="swatches" role="radiogroup" aria-label="Colour">
        {TEMPLATE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value.color === c}
            aria-label={c}
            className={`swatch${value.color === c ? ' is-active' : ''}`}
            style={{ background: c }}
            onClick={() => set({ color: c })}
          />
        ))}
      </div>
      <button
        type="button"
        className={`toggle toggle--sm${value.linger ? ' toggle--on' : ''}`}
        onClick={() => set({ linger: !value.linger })}
        aria-pressed={value.linger}
        title="Kept areas stay until removed. Others disappear when the turn passes or you place another."
      >
        Keep
      </button>
      <button
        type="button"
        className={`toggle toggle--sm${value.snap ? ' toggle--on' : ''}`}
        onClick={() => set({ snap: !value.snap })}
        aria-pressed={value.snap}
        title="Aim in 45° steps"
      >
        45°
      </button>
      {isGm && (
        <button
          type="button"
          className={`toggle toggle--sm${value.hidden ? ' toggle--on' : ''}`}
          onClick={() => set({ hidden: !value.hidden })}
          aria-pressed={value.hidden}
          title="Only you see hidden areas"
        >
          Hidden
        </button>
      )}
      {isGm && onClear && (
        <button type="button" className="btn btn--sm btn--danger" onClick={onClear}>
          Clear all
        </button>
      )}
    </div>
  );
}

interface CardProps {
  template: MapTemplate;
  scene: SceneView;
  isGm: boolean;
  canEdit: boolean;
  send: Send;
  onClose: () => void;
}

/** The selected template: who it catches, and (for its owner and the GM) size, keep, hide and remove. */
export function TemplateCard({ template: t, scene, isGm, canEdit, send, onClose }: CardProps) {
  const caught = useMemo(
    () => caughtBy(t, scene.tokens, scene.grid.feetPerCell, gridGeometry(scene.grid, scene.width, scene.height)),
    [t, scene.tokens, scene.grid, scene.width, scene.height],
  );
  const update = (patch: Omit<Extract<ClientMessage, { type: 'template:update' }>, 'type' | 'templateId'>) =>
    send({ type: 'template:update', templateId: t.id, ...patch });
  const names = caught.map((c) => c.name).join(', ');
  const postCaught = () => {
    // Hidden areas or creatures stay between the GM and themselves.
    const secret = t.hidden || caught.some((c) => c.hidden);
    send({ type: 'chat', text: `${templateTitle(t)}: ${names || 'no one'} caught`, visibility: secret ? 'gm' : 'public' });
  };

  return (
    <div className="template-card" style={{ ['--tpl' as string]: t.color }} role="dialog" aria-label="Area template">
      <div className="template-card__head">
        <span className="template-card__title">{templateTitle(t)}</span>
        {t.hidden && <span className="badge badge--gm">Hidden</span>}
        <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <p className="template-card__caught">
        {caught.length ? `${caught.length} caught: ${names}` : 'No one caught'}
        {t.shape === 'cylinder' && t.height ? ` · ${t.height} ft high` : ''}
      </p>
      {canEdit && (
        <div className="template-card__row">
          <div className="stepper" aria-label="Size">
            <button type="button" onClick={() => update({ size: clampFeet(t.size - 5) })} aria-label="Smaller">
              −
            </button>
            <output>{t.size}</output>
            <button type="button" onClick={() => update({ size: clampFeet(t.size + 5) })} aria-label="Larger">
              +
            </button>
          </div>
          <button
            type="button"
            className={`toggle toggle--sm${t.linger ? ' toggle--on' : ''}`}
            onClick={() => update({ linger: !t.linger })}
            aria-pressed={t.linger}
            title="Kept areas stay until removed"
          >
            Keep
          </button>
          {isGm && (
            <button
              type="button"
              className={`toggle toggle--sm${t.hidden ? ' toggle--on' : ''}`}
              onClick={() => update({ hidden: !t.hidden })}
              aria-pressed={t.hidden}
            >
              Hidden
            </button>
          )}
          <button type="button" className="btn btn--sm btn--danger" onClick={() => send({ type: 'template:delete', templateId: t.id })}>
            Remove
          </button>
        </div>
      )}
      {canEdit && caught.length > 0 && (
        <div className="template-card__row">
          <button type="button" className="btn btn--sm" onClick={postCaught} title="Post who is caught to the log, e.g. to call for saving throws">
            Post to log
          </button>
        </div>
      )}
    </div>
  );
}
