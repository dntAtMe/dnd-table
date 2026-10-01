import type { ClientMessage, SceneView } from '@dnd/protocol';
import { useState } from 'react';
import { SceneSettings } from '../ScenePanels';
import { MapEditorPanel } from './MapEditorPanel';

type Send = (msg: ClientMessage) => void;

interface Props {
  scene: SceneView;
  isLive: boolean;
  send: Send;
  onDone: () => void;
  /** 'panel' fills the desktop sidebar; 'sheet' sits over the map on phones and starts folded away. */
  variant: 'panel' | 'sheet';
}

/**
 * Everything about preparing the open scene, shown while the GM is in Edit scene mode: name, grid
 * calibration, fog, lighting, map size and whole-map wall/terrain changes.
 */
export function SceneEditCard({ scene, isLive, send, onDone, variant }: Props) {
  const [open, setOpen] = useState(variant === 'panel');
  return (
    <aside className={`scene-edit scene-edit--${variant}`} aria-label="Scene settings">
      <header className="scene-edit__head">
        {variant === 'sheet' ? (
          <button type="button" className="scene-edit__toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            Scene settings
          </button>
        ) : (
          <span className="scene-edit__title">Editing {scene.name}</span>
        )}
        <button type="button" className="btn btn--sm btn--primary" onClick={onDone} title="Back to playing">
          Done
        </button>
      </header>
      {open && (
        <div className="scene-edit__body">
          <SceneSettings key={scene.id} scene={scene} isLive={isLive} send={send} />
          <MapEditorPanel key={`editor-${scene.id}`} scene={scene} send={send} />
        </div>
      )}
    </aside>
  );
}
