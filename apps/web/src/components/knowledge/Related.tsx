import { RelatedIndex, refKey, type Compendium, type EntryRef } from '@dnd/rules';
import { useMemo } from 'react';
import { useKnowledge, type LazyData } from '../../lib/knowledge';
import { EntityLink } from './EntityLink';

/** In popups each group shows this many links, then "+N more" opens the full list. */
const POPUP_LIMIT = 6;
/** In the Compendium, groups longer than this start collapsed. */
const OPEN_LIMIT = 40;

let cached: { compendium: Compendium; data: LazyData; index: RelatedIndex } | null = null;

/** One index per compendium (it changes when campaign pages do); built on first use. */
function relatedIndex(compendium: Compendium, data: LazyData): RelatedIndex {
  if (cached?.compendium !== compendium || cached.data !== data) {
    cached = {
      compendium,
      data,
      index: new RelatedIndex(compendium, {
        spells: Object.values(data.spells),
        monsters: Object.values(data.monsters),
        magicItems: Object.values(data.magicItems),
      }),
    };
  }
  return cached.index;
}

/** "Related" groups derived from the SRD: what deals or resists a damage type, who casts a spell… */
export function RelatedSection({ entryRef, size }: { entryRef: EntryRef; size: 'popup' | 'full' }) {
  const k = useKnowledge();
  const { kind, id } = entryRef;
  const groups = useMemo(
    () => (k.lazyData && kind !== 'page' ? relatedIndex(k.compendium, k.lazyData).groups({ kind, id }) : []),
    [k.compendium, k.lazyData, kind, id],
  );
  if (!groups.length) return null;

  return (
    <section className={`kb-related kb-related--${size}`}>
      <h4 className="kb-related__title">Related</h4>
      {groups.map((g) => {
        const shown = size === 'popup' ? g.refs.slice(0, POPUP_LIMIT) : g.refs;
        const more = g.refs.length - shown.length;
        const links = (
          <p className="kb-related__links">
            {shown.map((r, i) => (
              <span key={refKey(r)}>
                {i > 0 && ', '}
                <EntityLink entry={r}>{k.compendium.get(r)?.name ?? r.id}</EntityLink>
              </span>
            ))}
            {more > 0 && (
              <>
                {' '}
                <button type="button" className="kb-related__more" onClick={() => k.show(entryRef)}>
                  +{more} more
                </button>
              </>
            )}
          </p>
        );
        return size === 'full' ? (
          <details key={g.title} className="kb-related__group" open={g.refs.length <= OPEN_LIMIT}>
            <summary>
              {g.title} <span className="kb-related__count">{g.refs.length}</span>
            </summary>
            {links}
          </details>
        ) : (
          <div key={g.title} className="kb-related__group">
            <span className="kb-related__group-title">
              {g.title} <span className="kb-related__count">{g.refs.length}</span>
            </span>
            {links}
          </div>
        );
      })}
    </section>
  );
}
