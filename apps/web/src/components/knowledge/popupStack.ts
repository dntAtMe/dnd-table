// Pure state for knowledge base popups (Hearts of Iron IV style): hover previews that can be pinned,
// and links inside a popup that open further popups beside it. The component in PopupLayer.tsx owns
// timers and DOM measurement; everything here is plain data in, data out.
import { refKey, type EntryRef } from '@dnd/rules';

/** A box in viewport coordinates (what getBoundingClientRect returns). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Popup {
  id: number;
  ref: EntryRef;
  /** Pinned popups stay until closed; unpinned ones are hover previews. */
  pinned: boolean;
  /** The popup whose link opened this one (null for links on the page). */
  parentId: number | null;
  /** The link that opened it, if any. */
  anchor: Box | null;
  /** The parent popup's box when this one opened, so it can sit beside it. */
  beside: Box | null;
}

/**
 * Popups in stacking order: later items are drawn on top. Invariants: a parent always comes before
 * its children, and a pinned popup's ancestors are pinned too.
 */
export interface PopupStack {
  items: readonly Popup[];
  nextId: number;
}

/** How deep popups nest; a link in the deepest popup replaces that popup's content instead. */
export const MAX_DEPTH = 6;

export const EMPTY_STACK: PopupStack = { items: [], nextId: 1 };

export function findPopup(stack: PopupStack, id: number | null): Popup | undefined {
  return id === null ? undefined : stack.items.find((p) => p.id === id);
}

/** The popup and its ancestors, nearest first. */
export function lineage(stack: PopupStack, id: number | null): Popup[] {
  const out: Popup[] = [];
  for (let p = findPopup(stack, id); p; p = findPopup(stack, p.parentId)) out.push(p);
  return out;
}

/** 1 for a popup opened from the page, 2 for one opened from inside it, and so on. */
export function depth(stack: PopupStack, id: number): number {
  return lineage(stack, id).length;
}

/** Ids of the popup's descendants (not including itself). */
export function descendants(stack: PopupStack, id: number): Set<number> {
  const out = new Set<number>();
  // Parents come before children, so one pass in order finds every generation.
  for (const p of stack.items) if (p.parentId !== null && (p.parentId === id || out.has(p.parentId))) out.add(p.id);
  return out;
}

function without(stack: PopupStack, ids: Iterable<number>): PopupStack {
  const drop = new Set<number>();
  for (const id of ids) {
    drop.add(id);
    for (const d of descendants(stack, id)) drop.add(d);
  }
  return drop.size ? { ...stack, items: stack.items.filter((p) => !drop.has(p.id)) } : stack;
}

function pinLineage(stack: PopupStack, id: number): PopupStack {
  const ids = new Set(lineage(stack, id).map((p) => p.id));
  if (![...ids].some((i) => !findPopup(stack, i)!.pinned)) return stack;
  return { ...stack, items: stack.items.map((p) => (ids.has(p.id) && !p.pinned ? { ...p, pinned: true } : p)) };
}

export interface OpenRequest {
  ref: EntryRef;
  parentId: number | null;
  pinned: boolean;
  anchor: Box | null;
  beside: Box | null;
}

/**
 * Opens a popup (or reuses the one already showing this entry from the same place). Unpinned
 * siblings close: hovering another link in the same popup swaps the preview. Pinning a popup pins
 * the popups it was opened from, so a locked chain stays together.
 */
export function openPopup(stack: PopupStack, req: OpenRequest): { stack: PopupStack; id: number } {
  const parent = findPopup(stack, req.parentId);
  const parentId = parent ? parent.id : null;

  // Too deep: show the entry in the deepest popup instead of nesting further.
  if (parent && depth(stack, parent.id) >= MAX_DEPTH) {
    let next = without(stack, descendants(stack, parent.id));
    next = { ...next, items: next.items.map((p) => (p.id === parent.id ? { ...p, ref: req.ref } : p)) };
    return { stack: req.pinned ? pinLineage(next, parent.id) : next, id: parent.id };
  }

  const key = refKey(req.ref);
  const siblings = stack.items.filter((p) => p.parentId === parentId);
  const existing = siblings.find((p) => refKey(p.ref) === key);
  let next = without(
    stack,
    siblings.filter((p) => !p.pinned && p !== existing).map((p) => p.id),
  );

  if (existing) return { stack: req.pinned ? pinLineage(next, existing.id) : next, id: existing.id };

  const id = next.nextId;
  next = {
    items: [...next.items, { id, ref: req.ref, pinned: req.pinned, parentId, anchor: req.anchor, beside: req.beside }],
    nextId: id + 1,
  };
  return { stack: req.pinned ? pinLineage(next, id) : next, id };
}

/** Pins a popup and the popups it was opened from. */
export function pinPopup(stack: PopupStack, id: number): PopupStack {
  return findPopup(stack, id) ? pinLineage(stack, id) : stack;
}

/** Closes a popup and everything opened from it. */
export function closePopup(stack: PopupStack, id: number): PopupStack {
  return without(stack, [id]);
}

/** Closes the topmost popup (Escape). */
export function closeTop(stack: PopupStack): PopupStack {
  const top = stack.items[stack.items.length - 1];
  return top ? closePopup(stack, top.id) : stack;
}

/**
 * Closes hover previews the pointer has left: every unpinned popup except `keepId` and the popups
 * it was opened from. With null, closes every unpinned popup (e.g. a click elsewhere).
 */
export function pruneHover(stack: PopupStack, keepId: number | null): PopupStack {
  const keep = new Set(lineage(stack, keepId).map((p) => p.id));
  return without(
    stack,
    stack.items.filter((p) => !p.pinned && !keep.has(p.id)).map((p) => p.id),
  );
}

/** The most recently opened hover preview, if any. */
export function topPreview(stack: PopupStack): Popup | undefined {
  for (let i = stack.items.length - 1; i >= 0; i--) if (!stack.items[i]!.pinned) return stack.items[i];
  return undefined;
}

/** Brings a popup and its descendants to the front (clicking a pinned popup underneath another). */
export function raisePopup(stack: PopupStack, id: number): PopupStack {
  const ids = descendants(stack, id);
  ids.add(id);
  const moving = stack.items.filter((p) => ids.has(p.id));
  const rest = stack.items.filter((p) => !ids.has(p.id));
  if (!moving.length || stack.items.slice(-moving.length).every((p, i) => p === moving[i])) return stack;
  return { ...stack, items: [...rest, ...moving] };
}

// ---------- positioning ----------

export interface PlaceInput {
  /** The popup's rendered size. */
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  anchor: Box | null;
  beside: Box | null;
  /** Space between the popup and what it's attached to. */
  gap?: number;
  /** Space kept clear at the viewport edges. */
  margin?: number;
}

export type Side = 'right' | 'left' | 'below' | 'above' | 'center';

export interface Placement {
  left: number;
  top: number;
  side: Side;
}

/** Clamps to [lo, hi]; when the range is empty (popup bigger than the viewport) sticks to lo. */
const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

/**
 * Where a popup goes: beside its parent popup when nested (right, else left), otherwise under the
 * link (else above it, else wherever there's more room), always kept inside the viewport.
 */
export function placePopup({ size, viewport, anchor, beside, gap = 6, margin = 8 }: PlaceInput): Placement {
  const { width: w, height: h } = size;
  const maxLeft = viewport.width - margin - w;
  const maxTop = viewport.height - margin - h;
  const fitTop = (t: number) => clamp(t, margin, maxTop);
  const fitLeft = (l: number) => clamp(l, margin, maxLeft);

  if (!anchor) return { left: fitLeft((viewport.width - w) / 2), top: fitTop(Math.round(viewport.height * 0.12)), side: 'center' };

  if (beside) {
    // Line the nested popup up with the link that opened it, nudged up a little.
    const top = fitTop(anchor.top - 12);
    const right = beside.left + beside.width + gap;
    if (right + w <= viewport.width - margin) return { left: right, top, side: 'right' };
    const left = beside.left - gap - w;
    if (left >= margin) return { left, top, side: 'left' };
  }

  const left = fitLeft(anchor.left);
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - gap - h;
  if (below + h <= viewport.height - margin) return { left, top: below, side: 'below' };
  if (above >= margin) return { left, top: above, side: 'above' };
  const roomBelow = viewport.height - (anchor.top + anchor.height);
  return roomBelow >= anchor.top ? { left, top: fitTop(below), side: 'below' } : { left, top: fitTop(above), side: 'above' };
}
