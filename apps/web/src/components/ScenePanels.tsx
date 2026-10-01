import type { ClientMessage, SceneSummary, SceneView } from '@dnd/protocol';
import { gridGeometry, type Grid } from '@dnd/rules';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';

type Send = (msg: ClientMessage) => void;

const BLANK = { cols: 30, rows: 20, cell: 70 };

async function imageSize(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

interface ScenesPanelProps {
  campaignId: string;
  scenes: SceneSummary[];
  activeSceneId: string | null;
  openSceneId: string | null;
  send: Send;
}

export function ScenesPanel({ campaignId, scenes, activeSceneId, openSceneId, send }: ScenesPanelProps) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (file) {
        const { width, height } = await imageSize(file);
        const res = await fetch(`/api/campaigns/${campaignId}/files`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        });
        const data = (await res.json()) as { id?: string; error?: string };
        if (!res.ok || !data.id) throw new Error(data.error ?? 'Upload failed');
        send({ type: 'scene:create', name: name.trim() || file.name.replace(/\.\w+$/, ''), fileId: data.id, width, height });
      } else {
        send({
          type: 'scene:create',
          name: name.trim() || 'Blank map',
          fileId: null,
          width: BLANK.cols * BLANK.cell,
          height: BLANK.rows * BLANK.cell,
          grid: { size: BLANK.cell },
        });
      }
      setName('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (scene: SceneSummary) => {
    if (confirm(`Delete "${scene.name}" and its tokens?`)) send({ type: 'scene:delete', sceneId: scene.id });
  };

  return (
    <div className="scenes">
      {scenes.length > 0 && (
        <ul className="scenes__list">
          {scenes.map((s) => {
            const live = s.id === activeSceneId;
            return (
              <li key={s.id} className={s.id === openSceneId ? 'is-open' : ''}>
                <button
                  type="button"
                  className="scenes__name"
                  onClick={() => send({ type: 'scene:view', sceneId: s.id })}
                  title="Open this scene"
                >
                  {s.name}
                </button>
                {live ? (
                  <button
                    type="button"
                    className="badge badge--live"
                    onClick={() => send({ type: 'scene:activate', sceneId: null })}
                    title="Players see this scene. Click to hide the map."
                  >
                    Live
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => send({ type: 'scene:activate', sceneId: s.id })}
                    title="Show this scene to players and table screens"
                  >
                    Show
                  </button>
                )}
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => remove(s)} aria-label={`Delete ${s.name}`}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="stack scenes__new" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New scene name" maxLength={80} />
        <label className="file-input">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span>{file ? file.name : 'Choose a map image (or leave empty for a blank grid)'}</span>
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="btn" disabled={busy}>
          {busy ? 'Uploading…' : 'Create scene'}
        </button>
      </form>
    </div>
  );
}

/** Sends at most once per `ms`, always delivering the latest value. */
function useThrottled<T>(fn: (value: T) => void, ms: number): (value: T) => void {
  const last = useRef(0);
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => () => clearTimeout(timer.current), []);
  return (value: T) => {
    const now = Date.now();
    pending.current = { value };
    if (now - last.current >= ms) {
      last.current = now;
      pending.current = null;
      fnRef.current(value);
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        last.current = Date.now();
        if (pending.current) fnRef.current(pending.current.value);
        pending.current = null;
      }, ms - (now - last.current));
    }
  };
}

interface SceneSettingsProps {
  scene: SceneView;
  isLive: boolean;
  send: Send;
}

export function SceneSettings({ scene, isLive, send }: SceneSettingsProps) {
  const [grid, setGrid] = useState<Grid>(scene.grid);
  const [name, setName] = useState(scene.name);
  const editing = useRef(false);

  // Follow server updates unless the GM is mid-drag on a slider.
  useEffect(() => {
    if (!editing.current) setGrid(scene.grid);
  }, [scene.grid]);
  useEffect(() => setName(scene.name), [scene.name]);

  const sendGrid = useThrottled((patch: Partial<Grid>) => send({ type: 'scene:update', sceneId: scene.id, grid: patch }), 120);
  const update = (patch: Partial<Grid>) => {
    setGrid((g) => ({ ...g, ...patch }));
    sendGrid({ ...grid, ...patch });
  };

  const { cols, rows } = gridGeometry(grid, scene.width, scene.height);
  const cellsAcross = Math.round((scene.width / grid.size) * 100) / 100;

  return (
    <div className="scene-settings">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name !== scene.name) send({ type: 'scene:update', sceneId: scene.id, name: name.trim() });
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Scene name" className="plain" />
        <button type="submit" className="btn btn--sm" disabled={!name.trim() || name === scene.name}>
          Rename
        </button>
      </form>
      {!isLive && <p className="hint">Only you can see this scene until you press Show.</p>}

      <fieldset className="fields" onPointerDown={() => (editing.current = true)} onPointerUp={() => (editing.current = false)}>
        <legend>Grid</legend>
        <label className="field-row">
          <span>Cells across</span>
          <input
            type="number"
            min={1}
            step={0.5}
            value={cellsAcross}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n > 0) update({ size: Math.round((scene.width / n) * 100) / 100 });
            }}
          />
        </label>
        <label className="field-row">
          <span>Cell size (px)</span>
          <input
            type="number"
            min={8}
            step={0.5}
            value={grid.size}
            onChange={(e) => {
              const size = Number(e.target.value);
              if (size >= 8) update({ size });
            }}
          />
        </label>
        <label className="field-row">
          <span>Shift X</span>
          <input
            type="range"
            min={0}
            max={Math.floor(grid.size)}
            step={0.5}
            value={grid.offsetX}
            onChange={(e) => update({ offsetX: Number(e.target.value) })}
          />
        </label>
        <label className="field-row">
          <span>Shift Y</span>
          <input
            type="range"
            min={0}
            max={Math.floor(grid.size)}
            step={0.5}
            value={grid.offsetY}
            onChange={(e) => update({ offsetY: Number(e.target.value) })}
          />
        </label>
        <label className="field-row">
          <span>Feet per cell</span>
          <input
            type="number"
            min={1}
            max={100}
            value={grid.feetPerCell}
            onChange={(e) => {
              const feetPerCell = Math.round(Number(e.target.value));
              if (feetPerCell >= 1) update({ feetPerCell });
            }}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={grid.visible} onChange={(e) => update({ visible: e.target.checked })} />
          Show grid lines
        </label>
        <p className="hint">
          {cols} × {rows} cells. Changing the cell count resets fog; walls and terrain stay anchored to the top-left cell.
        </p>
      </fieldset>

      <fieldset className="fields">
        <legend>Fog of war</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={scene.fogEnabled}
            onChange={(e) => send({ type: 'scene:update', sceneId: scene.id, fogEnabled: e.target.checked })}
          />
          Hide unexplored areas from players
        </label>
        {scene.fogEnabled && (
          <div className="button-row">
            <button type="button" className="btn btn--sm" onClick={() => send({ type: 'fog:fill', sceneId: scene.id, reveal: false })}>
              Cover all
            </button>
            <button type="button" className="btn btn--sm" onClick={() => send({ type: 'fog:fill', sceneId: scene.id, reveal: true })}>
              Reveal all
            </button>
          </div>
        )}
      </fieldset>
    </div>
  );
}
