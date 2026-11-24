/**
 * Unified Single Input Dispatcher & LIFO Scope Stack (#1354 D1 / P1).
 *
 * All keyboard events for a given `stdin` flow through ONE priority-ordered dispatcher hub:
 *   1. LIFO Opaque Scope Stack: modals, drawers, dialogs, and focused inline editors push an
 *      opaque scope frame `{ scopeId, depth, pushSeq }`. The top-most frame by `(depth DESC,
 *      pushSeq DESC)` exclusively owns keyboard routing — automatically masking base views AND
 *      earlier sibling modals without manual `mainActive` / `anyModalOpen` boolean chains.
 *   2. Priority order within eligible scopes:
 *      `(system ? 1 : 0) DESC, depth DESC, layer DESC, seq DESC`.
 *   3. Single-consumption: once a handler returns `true` or calls `ctx.consume()`, dispatch
 *      stops immediately so one keystroke can NEVER trigger two handlers.
 *   4. Reactive masking notifications: pushing/popping opaque scopes notifies subscribers
 *      so `useScopeActive` / `useKeyScope` reactively pause visual focus & claimed keys.
 */
import type { Key } from 'ink';

export const KEY_LAYER_GLOBAL = 100;
export const KEY_LAYER_MODAL_FRAME = 120;
export const KEY_LAYER_WIDGET = 150;
export const KEY_LAYER_VIEW = 200;
export const KEY_LAYER_DRAWER = 300;
export const KEY_LAYER_MODAL = 400;
export const KEY_LAYER_TEXT_INPUT = 500;
export const KEY_LAYER_SYSTEM = 600;

export interface KeyDispatchContext {
  /** Stop dispatching this keystroke to any lower-priority handlers. */
  consume: () => void;
  /** True if an earlier handler already consumed this keystroke. */
  readonly consumed: boolean;
  /** Current modal/overlay nesting depth. */
  readonly depth: number;
  /** Current scope stack frame identifier (0 = root shell/page). */
  readonly scopeId: number;
}

export type ScopedKeyHandler = (input: string, key: Key, ctx: KeyDispatchContext) => boolean | void;

export interface HandlerEntry {
  seq: number;
  layer: number;
  depth: number;
  scopeId: number;
  active: boolean;
  handlerRef: { current: ScopedKeyHandler };
  id?: string;
}

export interface OpaqueScopeEntry {
  id: number;
  scopeId: number;
  depth: number;
  pushSeq: number;
  label?: string;
}

export interface DispatcherHub {
  nextSeq: number;
  nextScopeId: number;
  nextBarrierId: number;
  nextPushSeq: number;
  entries: Map<number, HandlerEntry>;
  opaqueStack: Map<number, OpaqueScopeEntry>;
  stackVersion: number;
  stackListeners: Set<() => void>;
  bridgeCount: number;
  fallbackOwnerSeq: number | null;
  ownerListeners: Set<() => void>;
}

const hubsByStdin = new WeakMap<object, DispatcherHub>();
const FALLBACK_STDIN_KEY = {};

function createHub(): DispatcherHub {
  return {
    nextSeq: 1,
    nextScopeId: 1,
    nextBarrierId: 1,
    nextPushSeq: 1,
    entries: new Map(),
    opaqueStack: new Map(),
    stackVersion: 0,
    stackListeners: new Set(),
    bridgeCount: 0,
    fallbackOwnerSeq: null,
    ownerListeners: new Set(),
  };
}

export function getHub(stdin: unknown): DispatcherHub {
  const key = stdin && typeof stdin === 'object' ? (stdin as object) : FALLBACK_STDIN_KEY;
  let hub = hubsByStdin.get(key);
  if (!hub) {
    hub = createHub();
    hubsByStdin.set(key, hub);
  }
  return hub;
}

export function allocateScopeId(hub: DispatcherHub): number {
  return hub.nextScopeId++;
}

function notifyOwnerListeners(hub: DispatcherHub): void {
  for (const fn of hub.ownerListeners) fn();
}

function notifyStackListeners(hub: DispatcherHub): void {
  hub.stackVersion += 1;
  for (const fn of hub.stackListeners) fn();
}

export function subscribeScopeStack(hub: DispatcherHub, listener: () => void): () => void {
  hub.stackListeners.add(listener);
  return () => {
    hub.stackListeners.delete(listener);
  };
}

export function reconcileFallbackOwner(hub: DispatcherHub): void {
  const prev = hub.fallbackOwnerSeq;
  if (hub.bridgeCount > 0) {
    hub.fallbackOwnerSeq = null;
  } else if (hub.fallbackOwnerSeq === null || !hub.entries.has(hub.fallbackOwnerSeq)) {
    const first = hub.entries.keys().next();
    hub.fallbackOwnerSeq = first.done ? null : first.value;
  }
  if (hub.fallbackOwnerSeq !== prev) {
    notifyOwnerListeners(hub);
  }
}

/** Return the active top-most opaque scope frame by `(depth DESC, pushSeq DESC)`, or null when empty. */
export function getTopOpaqueScope(hub: DispatcherHub): OpaqueScopeEntry | null {
  let top: OpaqueScopeEntry | null = null;
  for (const entry of hub.opaqueStack.values()) {
    if (
      !top ||
      entry.depth > top.depth ||
      (entry.depth === top.depth && entry.pushSeq > top.pushSeq)
    ) {
      top = entry;
    }
  }
  return top;
}

/** Return true if a handler/scope at `(depth, scopeId)` is currently masked by a higher/newer opaque scope. */
export function isScopeMasked(hub: DispatcherHub, depth: number, scopeId: number): boolean {
  const top = getTopOpaqueScope(hub);
  if (!top) return false;
  if (depth > top.depth) return false;
  if (depth < top.depth) return true;
  // Same depth: legacy depth-only barriers (`top.scopeId === 0`) allow same-depth handlers;
  // named LIFO opaque scopes (`top.scopeId > 0`) exclusively allow their own scopeId.
  if (top.scopeId === 0) return false;
  return scopeId !== top.scopeId;
}

/** Push an opaque scope frame onto the hub's LIFO stack; returns a clean pop callback. */
export function pushOpaqueScope(
  hub: DispatcherHub,
  opts: { depth: number; scopeId: number; label?: string },
): () => void {
  const id = hub.nextBarrierId++;
  const pushSeq = hub.nextPushSeq++;
  hub.opaqueStack.set(id, {
    id,
    scopeId: opts.scopeId,
    depth: opts.depth,
    pushSeq,
    label: opts.label,
  });
  notifyStackListeners(hub);
  let popped = false;
  return () => {
    if (popped) return;
    popped = true;
    if (hub.opaqueStack.delete(id)) {
      notifyStackListeners(hub);
    }
  };
}

/** Pure dispatch helper — also exported for deterministic unit tests. */
export function dispatchToHub(hub: DispatcherHub, input: string, key: Key): boolean {
  if (hub.entries.size === 0) return false;

  const ordered: HandlerEntry[] = [];
  for (const entry of hub.entries.values()) {
    if (!entry.active) continue;
    if (entry.layer < KEY_LAYER_SYSTEM && isScopeMasked(hub, entry.depth, entry.scopeId)) continue;
    ordered.push(entry);
  }
  if (ordered.length === 0) return false;

  ordered.sort((a, b) => {
    const aSys = a.layer >= KEY_LAYER_SYSTEM ? 1 : 0;
    const bSys = b.layer >= KEY_LAYER_SYSTEM ? 1 : 0;
    if (aSys !== bSys) return bSys - aSys;
    if (a.depth !== b.depth) return b.depth - a.depth;
    if (a.layer !== b.layer) return b.layer - a.layer;
    return b.seq - a.seq;
  });

  let consumed = false;
  for (const entry of ordered) {
    if (consumed) break;
    if (!entry.active) continue;
    const ctx: KeyDispatchContext = {
      consume: () => {
        consumed = true;
      },
      get consumed() {
        return consumed;
      },
      depth: entry.depth,
      scopeId: entry.scopeId,
    };
    const result = entry.handlerRef.current(input, key, ctx);
    if (result === true) consumed = true;
  }
  return consumed;
}

/** Testing helper: create an isolated in-memory hub for deterministic priority & LIFO tests. */
export function createTestKeyHub(): DispatcherHub {
  return createHub();
}

/** Testing helper: register a handler directly on a test hub. */
export function registerTestHandler(
  hub: DispatcherHub,
  handler: ScopedKeyHandler,
  opts: { layer?: number; depth?: number; scopeId?: number; active?: boolean; id?: string } = {},
): () => void {
  const seq = hub.nextSeq++;
  const entry: HandlerEntry = {
    seq,
    layer: opts.layer ?? KEY_LAYER_VIEW,
    depth: opts.depth ?? 0,
    scopeId: opts.scopeId ?? 0,
    active: opts.active ?? true,
    handlerRef: { current: handler },
    id: opts.id,
  };
  hub.entries.set(seq, entry);
  return () => {
    hub.entries.delete(seq);
  };
}

/** Testing helper: register a legacy depth-only barrier directly on a test hub. */
export function registerTestBarrier(hub: DispatcherHub, depth: number): () => void {
  return pushOpaqueScope(hub, { depth, scopeId: 0 });
}

/** Testing helper: push a named LIFO opaque scope onto a test hub. */
export function pushTestOpaqueScope(
  hub: DispatcherHub,
  opts: { depth: number; scopeId: number; label?: string },
): () => void {
  return pushOpaqueScope(hub, opts);
}

/** Testing helper: inspect the current opaque scope stack ordered from bottom to top. */
export function getOpaqueStackSnapshot(hub: DispatcherHub): readonly OpaqueScopeEntry[] {
  return [...hub.opaqueStack.values()].sort((a, b) => a.depth - b.depth || a.pushSeq - b.pushSeq);
}
