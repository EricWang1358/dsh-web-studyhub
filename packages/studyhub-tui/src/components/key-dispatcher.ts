/**
 * Unified Priority Key Dispatcher (#1354 D1 / P1-a).
 *
 * Replaces 100+ uncoordinated Ink `useInput` listeners with a single per-stdin
 * priority-ordered router:
 *   1. Priority order: `(system ? 1 : 0, scopeDepth DESC, layer DESC, seq DESC)`
 *   2. Single-consumption: once a handler returns `true` or calls `ctx.consume()`,
 *      dispatch stops immediately — one keystroke can NEVER trigger two handlers.
 *   3. Scope isolation: shell overlays wrap children in `<KeyScopeProvider>` and
 *      register an opaque barrier at `scopeDepth`; handlers with `depth < maxBarrier`
 *      are skipped automatically (except `KEY_LAYER_SYSTEM` like Ctrl+C).
 *   4. Single Ink `useInput` listener per `stdin`: in the full app, `AppShell`
 *      mounts `useKeyDispatcherBridge()`; in standalone component tests without
 *      `AppShell`, the hub elects exactly ONE active fallback owner so every
 *      keystroke dispatches through the hub strictly once with zero cross-test pollution.
 */
import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useInput as useInkInput, useStdin, type Key } from 'ink';

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
}

export type ScopedKeyHandler = (input: string, key: Key, ctx: KeyDispatchContext) => boolean | void;

export interface ScopedInputOptions {
  /** Whether this handler is currently active (default true). */
  isActive?: boolean;
  /** Priority layer within the current scope depth (default KEY_LAYER_VIEW). */
  layer?: number;
  /** Optional explicit scope depth override (defaults to nearest KeyScopeContext). */
  depth?: number;
  /** Optional debug label for conflict diagnostics. */
  id?: string;
}

interface HandlerEntry {
  seq: number;
  layer: number;
  depth: number;
  active: boolean;
  handlerRef: { current: ScopedKeyHandler };
  id?: string;
}

interface BarrierEntry {
  id: number;
  depth: number;
}

interface DispatcherHub {
  nextSeq: number;
  nextBarrierId: number;
  entries: Map<number, HandlerEntry>;
  barriers: Map<number, BarrierEntry>;
  bridgeCount: number;
  fallbackOwnerSeq: number | null;
  ownerListeners: Set<() => void>;
}

const hubsByStdin = new WeakMap<object, DispatcherHub>();
const FALLBACK_STDIN_KEY = {};

function createHub(): DispatcherHub {
  return {
    nextSeq: 1,
    nextBarrierId: 1,
    entries: new Map(),
    barriers: new Map(),
    bridgeCount: 0,
    fallbackOwnerSeq: null,
    ownerListeners: new Set(),
  };
}

function getHub(stdin: unknown): DispatcherHub {
  const key = stdin && typeof stdin === 'object' ? (stdin as object) : FALLBACK_STDIN_KEY;
  let hub = hubsByStdin.get(key);
  if (!hub) {
    hub = createHub();
    hubsByStdin.set(key, hub);
  }
  return hub;
}

function notifyOwnerListeners(hub: DispatcherHub): void {
  for (const fn of hub.ownerListeners) fn();
}

function reconcileFallbackOwner(hub: DispatcherHub): void {
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

function maxBarrierDepth(hub: DispatcherHub): number {
  let max = 0;
  for (const b of hub.barriers.values()) {
    if (b.depth > max) max = b.depth;
  }
  return max;
}

/** Pure dispatch helper — also exported for deterministic unit tests. */
export function dispatchToHub(hub: DispatcherHub, input: string, key: Key): boolean {
  if (hub.entries.size === 0) return false;
  const barrier = maxBarrierDepth(hub);

  const ordered: HandlerEntry[] = [];
  for (const entry of hub.entries.values()) {
    if (!entry.active) continue;
    if (entry.layer < KEY_LAYER_SYSTEM && entry.depth < barrier) continue;
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
    };
    const result = entry.handlerRef.current(input, key, ctx);
    if (result === true) consumed = true;
  }
  return consumed;
}

/** Modal / overlay nesting depth context (0 = root shell & page, 1 = shell overlay, 2 = nested confirm). */
export const KeyScopeContext = createContext<number>(0);

export function useKeyScopeDepth(): number {
  return useContext(KeyScopeContext);
}

export interface KeyScopeProviderProps {
  /** Override depth (defaults to parentDepth + 1). */
  depth?: number;
  /** When true (default), registers an opaque barrier blocking lower depths while mounted. */
  opaque?: boolean;
  children: ReactNode;
}

export function useKeyScopeBarrier(active: boolean, depthOverride?: number): void {
  const { stdin } = useStdin();
  const contextDepth = useContext(KeyScopeContext);
  const depth = depthOverride ?? contextDepth;

  useEffect(() => {
    if (!active || depth <= 0) return undefined;
    const hub = getHub(stdin);
    const id = hub.nextBarrierId++;
    hub.barriers.set(id, { id, depth });
    return () => {
      hub.barriers.delete(id);
    };
  }, [stdin, active, depth]);
}

export const KeyScopeProvider: React.FC<KeyScopeProviderProps> = ({ depth, opaque = true, children }) => {
  const parentDepth = useContext(KeyScopeContext);
  const nextDepth = depth ?? parentDepth + 1;
  useKeyScopeBarrier(opaque, nextDepth);
  return React.createElement(KeyScopeContext.Provider, { value: nextDepth }, children);
};

/**
 * Single root bridge mounted once in `AppShell`.
 * Holds the single Ink `useInput` subscription for the entire application.
 */
export function useKeyDispatcherBridge(active = true): void {
  const { stdin } = useStdin();
  const hub = getHub(stdin);

  useEffect(() => {
    if (!active) return undefined;
    hub.bridgeCount += 1;
    reconcileFallbackOwner(hub);
    return () => {
      hub.bridgeCount = Math.max(0, hub.bridgeCount - 1);
      reconcileFallbackOwner(hub);
    };
  }, [hub, active]);

  useInkInput(
    (input, key) => {
      dispatchToHub(hub, input, key);
    },
    { isActive: active },
  );
}

/**
 * Unified keyboard subscription hook replacing direct Ink `useInput` calls.
 * Registers the handler in the per-stdin priority dispatcher. When mounted
 * standalone without `AppShell`, exactly one registered hook per `stdin` owns
 * the single fallback Ink `useInput` listener.
 */
export function useScopedInput(handler: ScopedKeyHandler, options?: ScopedInputOptions): void {
  const isActive = options?.isActive ?? true;
  const layer = options?.layer ?? KEY_LAYER_VIEW;
  const contextDepth = useContext(KeyScopeContext);
  const depth = options?.depth ?? contextDepth;
  const id = options?.id;

  const { stdin } = useStdin();
  const hub = getHub(stdin);
  const handlerRef = useRef<ScopedKeyHandler>(handler);
  handlerRef.current = handler;

  const entryRef = useRef<HandlerEntry | null>(null);
  if (!entryRef.current) {
    entryRef.current = {
      seq: hub.nextSeq++,
      layer,
      depth,
      active: isActive,
      handlerRef,
      id,
    };
  }
  const entry = entryRef.current;
  // Keep layer/depth/active synchronously up to date on every render so rapid keystrokes
  // never observe stale focus flags between render and effect commit.
  entry.layer = layer;
  entry.depth = depth;
  entry.active = isActive;
  entry.id = id;

  const [, setOwnerTick] = useState(0);

  useEffect(() => {
    hub.entries.set(entry.seq, entry);
    const onOwnerChange = () => setOwnerTick((n) => n + 1);
    hub.ownerListeners.add(onOwnerChange);
    reconcileFallbackOwner(hub);
    return () => {
      hub.ownerListeners.delete(onOwnerChange);
      hub.entries.delete(entry.seq);
      reconcileFallbackOwner(hub);
    };
  }, [hub, entry]);

  // Synchronously elect self on initial render if no bridge and no owner yet so even
  // immediate keystrokes before effects flush are captured strictly once.
  if (hub.bridgeCount === 0 && hub.fallbackOwnerSeq === null) {
    hub.fallbackOwnerSeq = entry.seq;
  }
  const ownsFallback = hub.bridgeCount === 0 && hub.fallbackOwnerSeq === entry.seq;

  useInkInput(
    (input, key) => {
      dispatchToHub(hub, input, key);
    },
    { isActive: ownsFallback },
  );
}

/** Testing helper: create an isolated in-memory hub for deterministic priority tests. */
export function createTestKeyHub(): DispatcherHub {
  return createHub();
}

/** Testing helper: register a handler directly on a test hub. */
export function registerTestHandler(
  hub: DispatcherHub,
  handler: ScopedKeyHandler,
  opts: { layer?: number; depth?: number; active?: boolean; id?: string } = {},
): () => void {
  const seq = hub.nextSeq++;
  const entry: HandlerEntry = {
    seq,
    layer: opts.layer ?? KEY_LAYER_VIEW,
    depth: opts.depth ?? 0,
    active: opts.active ?? true,
    handlerRef: { current: handler },
    id: opts.id,
  };
  hub.entries.set(seq, entry);
  return () => {
    hub.entries.delete(seq);
  };
}

/** Testing helper: register a scope barrier directly on a test hub. */
export function registerTestBarrier(hub: DispatcherHub, depth: number): () => void {
  const id = hub.nextBarrierId++;
  hub.barriers.set(id, { id, depth });
  return () => {
    hub.barriers.delete(id);
  };
}
