import type { CharacterRecord, ClientMessage, Member, Token } from '@dnd/protocol';
import { LIGHT_PRESETS, computeCharacter, lightPreset, monsterSenses, monsterSensesText, type LightPresetId, type LightSource, type TokenSenses } from '@dnd/rules';
import { useEffect, useState } from 'react';
import { useKnowledge } from '../lib/knowledge';
import { monsterIdForName } from './combat/monsterForToken';

type Send = (msg: ClientMessage) => void;

const MAX_FEET = 1000;

/** A feet field that sends on blur or Enter; empty means "not set". */
function FeetInput({ value, placeholder, label, onCommit }: { value: number | undefined; placeholder?: string; label: string; onCommit: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    const n = text.trim() === '' ? undefined : Math.max(0, Math.min(MAX_FEET, Math.round(Number(text))));
    if (n !== undefined && Number.isNaN(n)) return setText(value === undefined ? '' : String(value));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      type="number"
      min={0}
      max={MAX_FEET}
      step={5}
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Light source picker: none, a 2024 preset, or custom bright/dim distances. Owners may use it too. */
export function LightPicker({ token, send }: { token: Token; send: Send }) {
  const light = token.light;
  const setLight = (next: LightSource | null) => send({ type: 'vision:token', tokenId: token.id, light: next });
  return (
    <>
      <label className="field-row">
        <span>Light</span>
        <select
          value={light?.preset ?? ''}
          onChange={(e) => {
            const id = e.target.value as LightPresetId | '';
            if (!id) setLight(null);
            else setLight(lightPreset(id) ?? { preset: 'custom', bright: light?.bright ?? 10, dim: light?.dim ?? 10 });
          }}
        >
          <option value="">None</option>
          {LIGHT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.bright}/{p.dim} ft)
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {light?.preset === 'custom' && (
        <>
          <label className="field-row">
            <span>Bright light (ft)</span>
            <FeetInput label="Bright light radius" value={light.bright} onCommit={(v) => setLight({ ...light, bright: v ?? 0 })} />
          </label>
          <label className="field-row">
            <span>Dim light beyond (ft)</span>
            <FeetInput label="Dim light beyond" value={light.dim} onCommit={(v) => setLight({ ...light, dim: v ?? 0 })} />
          </label>
        </>
      )}
    </>
  );
}

/** GM fields for a token's light and senses. Darkvision left empty comes from the character sheet. */
export function TokenVisionFields({ token, characters, send }: { token: Token; characters: CharacterRecord[]; send: Send }) {
  const character = token.characterId ? characters.find((c) => c.id === token.characterId) : undefined;
  let fromSheet = 0;
  try {
    fromSheet = character ? computeCharacter(character.data).darkvision : 0;
  } catch {
    // An invalid sheet just has no darkvision here; the server says the same.
  }
  const senses = token.senses ?? {};
  const setSense = (key: keyof TokenSenses, v: number | undefined) =>
    send({ type: 'vision:token', tokenId: token.id, senses: { ...senses, [key]: v } });
  return (
    <fieldset className="fields">
      <legend>Light &amp; vision</legend>
      <LightPicker token={token} send={send} />
      <label className="field-row">
        <span>Darkvision (ft)</span>
        <FeetInput
          label="Darkvision"
          value={senses.darkvision}
          placeholder={character ? `${fromSheet} (sheet)` : '0'}
          onCommit={(v) => setSense('darkvision', v)}
        />
      </label>
      <label className="field-row">
        <span>Blindsight (ft)</span>
        <FeetInput label="Blindsight" value={senses.blindsight} placeholder="0" onCommit={(v) => setSense('blindsight', v)} />
      </label>
      <label className="field-row">
        <span>Truesight (ft)</span>
        <FeetInput label="Truesight" value={senses.truesight} placeholder="0" onCommit={(v) => setSense('truesight', v)} />
      </label>
      {!character && <StatBlockSenses token={token} send={send} />}
    </fieldset>
  );
}

/** For a token named after an SRD monster: copy the stat block's senses when they differ. */
function StatBlockSenses({ token, send }: { token: Token; send: Send }) {
  const { compendium, lazyData } = useKnowledge();
  const id = monsterIdForName(compendium, token.name);
  const monster = id ? lazyData?.monsters[id] : undefined;
  if (!monster) return null;
  const wanted = monsterSenses(monster);
  const have = token.senses ?? {};
  const same = (['darkvision', 'blindsight', 'truesight'] as const).every((k) => (have[k] ?? 0) === (wanted[k] ?? 0));
  if (same) return null;
  const text = monsterSensesText({ senses: monster.senses, passivePerception: monster.passivePerception }).replace(/, Passive Perception \d+$|^Passive Perception \d+$/, '') || 'no special senses';
  return (
    <button
      type="button"
      className="btn btn--sm"
      onClick={() => send({ type: 'vision:token', tokenId: token.id, senses: { darkvision: wanted.darkvision ?? 0, blindsight: wanted.blindsight, truesight: wanted.truesight } })}
      title={`${monster.name}: ${text}`}
    >
      Use {monster.name}'s senses ({text})
    </button>
  );
}

/** Darkvision each character token gets from its sheet (0 for plain tokens and broken sheets). */
export function sheetDarkvision(characters: CharacterRecord[]): (token: Token) => number {
  const byId = new Map<string, number>();
  for (const c of characters) {
    try {
      byId.set(c.id, computeCharacter(c.data).darkvision);
    } catch {
      byId.set(c.id, 0);
    }
  }
  return (token) => (token.characterId && byId.get(token.characterId)) || 0;
}

/** GM map toolbar: see the map through one player's tokens. */
export function VisionPreviewPicker({ members, value, onChange }: { members: Member[]; value: string | null; onChange: (userId: string | null) => void }) {
  return (
    <select
      className="vision-preview"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Preview a player's vision"
      title="See the map as one player's tokens see it"
    >
      <option value="">GM view</option>
      {members
        .filter((m) => m.role === 'player')
        .map((m) => (
          <option key={m.userId} value={m.userId}>
            As {m.name}
          </option>
        ))}
    </select>
  );
}
