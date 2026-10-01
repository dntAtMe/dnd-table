import type { ServerMessage } from '@dnd/protocol';
import { describe, expect, it } from 'vitest';
import { Soundboard, layerPosition, type AudioConn } from './audio';
import { openDb } from './db';
import { Store } from './store';

describe('layerPosition', () => {
  it('counts from the shared start time and wraps looping tracks', () => {
    const base = { playing: true, startedAt: 10_000, position: 0, loop: false, duration: 60 };
    expect(layerPosition(base, 25_000)).toBe(15);
    expect(layerPosition(base, 95_000)).toBe(85);
    expect(layerPosition({ ...base, loop: true }, 95_000)).toBe(25);
    expect(layerPosition({ ...base, loop: true, duration: null }, 95_000)).toBe(85);
    expect(layerPosition({ ...base, playing: false, position: 7 }, 95_000)).toBe(7);
    expect(layerPosition(base, 5_000)).toBe(0);
  });
});

describe('Soundboard', () => {
  it('drops non-looping tracks from the shared state once they have ended', () => {
    const store = new Store(openDb(':memory:'));
    const gmUser = store.createUser('gm', 'GM', 'x')!;
    const campaign = store.createCampaign('C', gmUser.id);
    store.addFile({ id: 'f', campaignId: campaign.id, filename: 'f.mp3', mime: 'audio/mpeg', bytes: 1 });
    let now = 1_000_000;
    const sent: ServerMessage[] = [];
    const gm: AudioConn = { role: 'gm', campaignId: campaign.id, user: gmUser };
    const board = new Soundboard(store, { connections: () => [gm], send: (_c, m) => sent.push(m) }, () => now);

    board.handle({ ...gm, user: gmUser }, { type: 'track:create', name: 'Horn', fileId: 'f', kind: 'ambience', loop: false, volume: 1, duration: 10 });
    const [horn] = board.tracks(campaign.id);
    board.handle({ ...gm, user: gmUser }, { type: 'audio:play', trackId: horn!.id });
    now += 11_000;
    expect(board.stateFor(campaign.id).layers).toHaveLength(1);
    now += 2_000;
    expect(board.stateFor(campaign.id).layers).toEqual([]);
  });
});
