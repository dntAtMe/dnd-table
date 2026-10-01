import type { ClientMessage, SceneView } from '@dnd/protocol';
import { TERRAINS, gridGeometry, type GridResize, type TerrainId } from '@dnd/rules';
import { EditSection } from '../ScenePanels';
import { TERRAIN_SWATCH } from './MapFeatures';

type Send = (msg: ClientMessage) => void;

/** Toolbar picker for the terrain brush. */
export function TerrainPicker({ value, onChange }: { value: TerrainId; onChange: (t: TerrainId) => void }) {
  return (
    <div className="segmented terrain-picker" role="radiogroup" aria-label="Terrain">
      {TERRAINS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={value === t.id}
          className={value === t.id ? 'is-active' : ''}
          onClick={() => onChange(t.id)}
          title={t.difficult ? `${t.label} (difficult terrain)` : t.passable ? t.label : `${t.label} (impassable)`}
        >
          <span className={`terrain-swatch terrain-swatch--${t.id}`} style={{ background: TERRAIN_SWATCH[t.id] }} />
          <span className="terrain-picker__label">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Toolbar toggle: whether new doors are secret. */
export function SecretDoorToggle({ secret, onChange }: { secret: boolean; onChange: (secret: boolean) => void }) {
  return (
    <button
      type="button"
      className={`toggle toggle--sm${secret ? ' toggle--on' : ''}`}
      onClick={() => onChange(!secret)}
      aria-pressed={secret}
      title="New doors are secret: players see a plain wall until it is opened. Shift-click a door to toggle."
    >
      Secret door
    </button>
  );
}

const SIDES = [
  { side: 'top', label: 'Top', unit: 'row' },
  { side: 'bottom', label: 'Bottom', unit: 'row' },
  { side: 'left', label: 'Left', unit: 'column' },
  { side: 'right', label: 'Right', unit: 'column' },
] as const;

/** Edit scene card sections: map size for blank maps, whole-map fills, and how the tools work. */
export function MapEditorPanel({ scene, send }: { scene: SceneView; send: Send }) {
  const { cols, rows } = gridGeometry(scene.grid, scene.width, scene.height);
  const resize = (side: keyof GridResize, by: number) =>
    send({ type: 'map:resize', sceneId: scene.id, top: 0, right: 0, bottom: 0, left: 0, [side]: by });
  const fill = (terrain: TerrainId, question: string) => {
    if (confirm(question)) send({ type: 'map:fill', sceneId: scene.id, terrain });
  };

  return (
    <>
      {!scene.imageUrl && (
        <EditSection title="Map size" meta={`${cols} × ${rows}`}>
        <div className="fields map-editor">
          {SIDES.map(({ side, label, unit }) => (
            <div key={side} className="field-row map-editor__side">
              <span>{label}</span>
              <div className="button-row">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => resize(side, -1)}
                  disabled={unit === 'row' ? rows <= 1 : cols <= 1}
                  aria-label={`Remove a ${unit} at the ${side}`}
                  title={`Remove a ${unit} at the ${side}`}
                >
                  −
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => resize(side, 1)}
                  aria-label={`Add a ${unit} at the ${side}`}
                  title={`Add a ${unit} at the ${side}`}
                >
                  +
                </button>
              </div>
            </div>
          ))}
          <p className="hint">Tokens, fog, walls and terrain stay where they are on the map.</p>
        </div>
        </EditSection>
      )}
      <EditSection title="Walls & terrain" open>
      <div className="map-editor">
      {scene.imageUrl && <p className="hint">Draw walls, doors and terrain over the picture. Image maps keep their size.</p>}
      <div className="button-row">
        <button type="button" className="btn btn--sm" onClick={() => fill('rock', 'Fill the whole map with solid rock? Then carve rooms with Floor.')}>
          Fill with rock
        </button>
        <button type="button" className="btn btn--sm" onClick={() => fill('none', 'Clear all terrain on this map?')}>
          Clear terrain
        </button>
        <button
          type="button"
          className="btn btn--sm btn--danger"
          onClick={() => confirm('Remove every wall and door on this map?') && send({ type: 'map:clear-walls', sceneId: scene.id })}
        >
          Remove walls
        </button>
      </div>
      <p className="hint">
        <b>Wall</b>: drag along grid lines. <b>Door</b>: click an edge, click again for open → closed → locked; Shift-click
        toggles secret. <b>Terrain</b>: paint with the brush. <b>Erase</b>: drag over walls and doors. With <b>Move</b>, click a
        door to open or close it.
      </p>
      </div>
      </EditSection>
    </>
  );
}
