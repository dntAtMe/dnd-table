// Area-of-effect templates on scenes: who may place, move and remove them, and keeping them on the
// map. The hub re-sends the scene whose id these functions return.
import { MAX_TEMPLATES, type ClientMessage, type ClientRole, type MapTemplate, type TemplateMessage } from '@dnd/protocol';
import { gridGeometry, normalizeAngle } from '@dnd/rules';
import { GameError } from './scenes';
import type { SceneRecord, Store } from './store';

export interface TemplateActor {
  role: ClientRole;
  userId: string;
  campaignId: string;
  /** The scene players currently see. */
  activeSceneId: string | null;
}

export function isTemplateMessage(msg: ClientMessage): msg is TemplateMessage {
  return msg.type.startsWith('template:');
}

/** Applies one template message. Throws GameError for anything the actor may not do. */
export function applyTemplateMessage(store: Store, msg: TemplateMessage, actor: TemplateActor): string {
  const gm = actor.role === 'gm';
  switch (msg.type) {
    case 'template:place': {
      const scene = sceneOf(store, msg.sceneId, actor);
      if (!gm && msg.hidden) throw new GameError('Only the GM can hide templates');
      let tokenId: string | null = null;
      if (msg.tokenId) {
        if (msg.shape !== 'emanation') throw new GameError('Only an Emanation can follow a token');
        const token = store.getToken(msg.tokenId);
        if (!token || token.sceneId !== scene.id) throw new GameError('Token not found');
        if (!gm && token.ownerUserId !== actor.userId) throw new GameError("That's not your token");
        tokenId = token.id;
      }
      const linger = msg.linger ?? false;
      // A one-shot area replaces the owner's previous one (the last Fireball has already gone off).
      const existing = store.templates(scene.id);
      const replaced = linger ? 0 : existing.filter((t) => !t.linger && t.ownerUserId === actor.userId).length;
      if (existing.length - replaced >= MAX_TEMPLATES) throw new GameError('Too many templates on this map: remove some first');
      if (replaced) store.deleteTemplates(scene.id, actor.userId);
      store.createTemplate({
        sceneId: scene.id,
        shape: msg.shape,
        size: msg.size,
        ...(msg.shape === 'line' && msg.width !== undefined && { width: msg.width }),
        ...(msg.shape === 'cylinder' && msg.height !== undefined && { height: msg.height }),
        ...clampOrigin(scene, msg.shape, msg.x, msg.y),
        angle: normalizeAngle(msg.angle),
        color: msg.color,
        label: msg.label ?? '',
        ownerUserId: actor.userId,
        tokenId,
        hidden: msg.hidden ?? false,
        linger,
      });
      return scene.id;
    }
    case 'template:update': {
      const { template, scene } = templateOf(store, msg.templateId, actor);
      if (!gm && msg.hidden !== undefined && msg.hidden !== template.hidden) throw new GameError('Only the GM can hide templates');
      const next: MapTemplate = { ...template };
      // A template following a token goes where the token goes.
      if ((msg.x !== undefined || msg.y !== undefined) && !template.tokenId) {
        Object.assign(next, clampOrigin(scene, template.shape, msg.x ?? template.x, msg.y ?? template.y));
      }
      if (msg.angle !== undefined) next.angle = normalizeAngle(msg.angle);
      if (msg.size !== undefined) next.size = msg.size;
      if (msg.width !== undefined && template.shape === 'line') next.width = msg.width;
      if (msg.height !== undefined && template.shape === 'cylinder') next.height = msg.height;
      if (msg.color !== undefined) next.color = msg.color;
      if (msg.label !== undefined) next.label = msg.label;
      if (msg.hidden !== undefined) next.hidden = msg.hidden;
      if (msg.linger !== undefined) next.linger = msg.linger;
      store.updateTemplate(next);
      return scene.id;
    }
    case 'template:delete': {
      const { template, scene } = templateOf(store, msg.templateId, actor);
      store.deleteTemplate(template.id);
      return scene.id;
    }
    case 'template:clear': {
      if (!gm) throw new GameError('Only the GM can do that');
      const scene = sceneOf(store, msg.sceneId, actor);
      store.deleteTemplates(scene.id);
      return scene.id;
    }
  }
}

/** The scene, if the actor may put templates on it: the GM anywhere, players on the one in play. */
function sceneOf(store: Store, sceneId: string, actor: TemplateActor): SceneRecord {
  const scene = store.getScene(sceneId);
  if (!scene || scene.campaignId !== actor.campaignId) throw new GameError('Scene not found');
  if (actor.role !== 'gm' && scene.id !== actor.activeSceneId) throw new GameError('That scene is not in play');
  return scene;
}

/** A template the actor may change: players only their own, and never hidden ones. */
function templateOf(store: Store, templateId: string, actor: TemplateActor): { template: MapTemplate; scene: SceneRecord } {
  const template = store.getTemplate(templateId);
  const scene = template && store.getScene(template.sceneId);
  const hiddenFromActor = template?.hidden && actor.role !== 'gm';
  if (!template || !scene || scene.campaignId !== actor.campaignId || hiddenFromActor) throw new GameError('Template not found');
  if (actor.role !== 'gm') {
    if (template.ownerUserId !== actor.userId) throw new GameError("That's not your template");
    if (scene.id !== actor.activeSceneId) throw new GameError('That scene is not in play');
  }
  return { template, scene };
}

/** Keeps an origin on the map: grid intersections for most shapes, a cell for a free Emanation. */
function clampOrigin(scene: SceneRecord, shape: MapTemplate['shape'], x: number, y: number): { x: number; y: number } {
  const { cols, rows } = gridGeometry(scene.grid, scene.width, scene.height);
  const cell = shape === 'emanation' ? 1 : 0;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
  return { x: clamp(x, cols - cell), y: clamp(y, rows - cell) };
}
