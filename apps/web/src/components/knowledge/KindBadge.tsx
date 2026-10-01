import { KIND_LABELS, type EntryKind } from '@dnd/rules';

/** Colour family per kind, for badges in search results. */
const KIND_GROUP: Record<EntryKind, 'page' | 'rules' | 'magic' | 'creature' | 'item' | 'character'> = {
  page: 'page',
  condition: 'rules',
  mastery: 'rules',
  property: 'rules',
  skill: 'rules',
  'damage-type': 'rules',
  school: 'rules',
  alignment: 'rules',
  language: 'rules',
  spell: 'magic',
  monster: 'creature',
  'magic-item': 'item',
  weapon: 'item',
  armor: 'item',
  gear: 'item',
  poison: 'item',
  class: 'character',
  subclass: 'character',
  feature: 'character',
  species: 'character',
  lineage: 'character',
  trait: 'character',
  background: 'character',
  feat: 'character',
};

/** Short labels for chips and badges. */
export const KIND_SHORT: Record<EntryKind, string> = {
  ...KIND_LABELS,
  page: 'Page',
  feature: 'Feature',
  trait: 'Trait',
  mastery: 'Mastery',
  property: 'Property',
  school: 'School',
};

export function KindBadge({ kind }: { kind: EntryKind }) {
  return (
    <span className={`kind-badge kind-badge--${KIND_GROUP[kind]}`} title={KIND_LABELS[kind]}>
      {KIND_SHORT[kind]}
    </span>
  );
}
