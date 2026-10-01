// Knowledge base plumbing shared by the whole UI: the compendium (core SRD at once, spells,
// monsters and magic items loaded in the background, plus extra sources such as campaign pages)
// and the handlers that links call (hover preview, pinned popup, open in the Compendium view).
import { coreCompendium, fullCompendium, type Compendium, type EntryRef, type IndexEntry } from '@dnd/rules';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** What a link does; the popup layer and the Compendium view provide the real implementations. */
export interface KnowledgeHandlers {
  /** Pointer rests on a link (desktop): show a preview next to it. */
  hover: (ref: EntryRef, anchor: HTMLElement) => void;
  /** Pointer leaves the link. */
  unhover: (ref: EntryRef, anchor: HTMLElement) => void;
  /** Ctrl/Cmd-click or tap: open a pinned popup next to the link. */
  open: (ref: EntryRef, anchor?: HTMLElement) => void;
  /** Go to the entry in the Compendium view. */
  show: (ref: EntryRef) => void;
}

export interface KnowledgeApi extends KnowledgeHandlers {
  compendium: Compendium;
  /** True until spells, monsters and magic items are in the index. */
  loading: boolean;
  /** Full data for an entry kind loaded lazily (spells, monsters, magic items), keyed by id. */
  lazyData: LazyData | null;
}

export interface LazyData {
  spells: Record<string, import('@dnd/rules').SpellDef>;
  monsters: Record<string, import('@dnd/rules').MonsterDef>;
  magicItems: Record<string, import('@dnd/rules').MagicItemDef>;
}

const noop = () => {};
const KnowledgeContext = createContext<KnowledgeApi | null>(null);
const RegistryContext = createContext<{
  setSource: (id: string, entries: readonly IndexEntry[] | null) => void;
  setHandlers: (handlers: Partial<KnowledgeHandlers> | null) => void;
} | null>(null);

export function KnowledgeProvider({ children }: { children: ReactNode }) {
  const [base, setBase] = useState<Compendium>(coreCompendium);
  const [lazyData, setLazyData] = useState<LazyData | null>(null);
  const [sources, setSources] = useState<Record<string, readonly IndexEntry[]>>({});
  const [handlers, setHandlersState] = useState<Partial<KnowledgeHandlers>>({});

  useEffect(() => {
    let alive = true;
    void Promise.all([import('@dnd/rules/spells'), import('@dnd/rules/monsters'), import('@dnd/rules/magic-items')]).then(([s, m, i]) => {
      if (!alive) return;
      setBase(fullCompendium({ spells: s.SPELLS, monsters: m.MONSTERS, magicItems: i.MAGIC_ITEMS }));
      setLazyData({ spells: s.SPELLS_BY_ID, monsters: m.MONSTERS_BY_ID, magicItems: i.MAGIC_ITEMS_BY_ID });
    });
    return () => {
      alive = false;
    };
  }, []);

  const compendium = useMemo(() => {
    const extra = Object.values(sources).flat();
    return extra.length ? base.with(extra) : base;
  }, [base, sources]);

  const registry = useMemo(
    () => ({
      setSource: (id: string, entries: readonly IndexEntry[] | null) =>
        setSources((prev) => {
          if (!entries) {
            const { [id]: _, ...rest } = prev;
            return rest;
          }
          return { ...prev, [id]: entries };
        }),
      setHandlers: (h: Partial<KnowledgeHandlers> | null) => setHandlersState(h ?? {}),
    }),
    [],
  );

  const api = useMemo<KnowledgeApi>(
    () => ({
      compendium,
      loading: !lazyData,
      lazyData,
      hover: handlers.hover ?? noop,
      unhover: handlers.unhover ?? noop,
      open: handlers.open ?? ((ref) => (handlers.show ?? noop)(ref)),
      show: handlers.show ?? noop,
    }),
    [compendium, lazyData, handlers],
  );

  return (
    <RegistryContext.Provider value={registry}>
      <KnowledgeContext.Provider value={api}>{children}</KnowledgeContext.Provider>
    </RegistryContext.Provider>
  );
}

export function useKnowledge(): KnowledgeApi {
  const ctx = useContext(KnowledgeContext);
  if (!ctx) throw new Error('useKnowledge outside KnowledgeProvider');
  return ctx;
}

/** Adds entries (e.g. the campaign pages this user may see) to the knowledge base while mounted. */
export function useKnowledgeSource(id: string, entries: readonly IndexEntry[] | null): void {
  const registry = useContext(RegistryContext);
  useEffect(() => {
    registry?.setSource(id, entries);
  }, [registry, id, entries]);
  useEffect(() => () => registry?.setSource(id, null), [registry, id]);
}

/** Installs link behaviour (popups, navigation) while mounted. */
export function useKnowledgeHandlers(handlers: Partial<KnowledgeHandlers>): void {
  const registry = useContext(RegistryContext);
  useEffect(() => {
    registry?.setHandlers(handlers);
    return () => registry?.setHandlers(null);
  }, [registry, handlers]);
}

/** Memoised per-text linking so long descriptions aren't re-scanned on every render. */
export function useLinkedText(text: string, self?: EntryRef) {
  const { compendium } = useKnowledge();
  const kind = self?.kind;
  const id = self?.id;
  return useMemo(() => compendium.linkify(text, kind && id ? { self: { kind, id } } : {}), [compendium, text, kind, id]);
}

/** Keeps a stable callback identity for handler objects passed to useKnowledgeHandlers. */
export function useStableHandlers(handlers: Partial<KnowledgeHandlers>): Partial<KnowledgeHandlers> {
  const ref = useRef(handlers);
  ref.current = handlers;
  const hover = useCallback((r: EntryRef, a: HTMLElement) => ref.current.hover?.(r, a), []);
  const unhover = useCallback((r: EntryRef, a: HTMLElement) => ref.current.unhover?.(r, a), []);
  const open = useCallback((r: EntryRef, a?: HTMLElement) => ref.current.open?.(r, a), []);
  const show = useCallback((r: EntryRef) => ref.current.show?.(r), []);
  return useMemo(() => ({ hover, unhover, open, show }), [hover, unhover, open, show]);
}
