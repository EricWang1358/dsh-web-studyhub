/**
 * React Hooks & Scope Stack Boundary for the Unified Input Dispatcher (#1354 D1 / P1).
 *
 * Primary API for views & modals:
 *   - `<KeyScope id="..." opaque active={...}>`: pushes an opaque LIFO scope onto the stack
 *     so child modals/drawers/inline editors automatically mask underlying views and siblings.
 *   - `useKeyScope({ id, active, layer, keys, onKey })`: registers a single key handler AND
 *     automatically claims `keys` for SideNav/AppShell while active & unmasked — eliminating
 *     separate `useInput`, `useClaimKeys`, and manual `mainActive` / `anyModalOpen` guards.
 *   - `useScopeActive(baseActive)`: reactively reports whether the current scope is unmasked.
 *
 * Also hosts the single application-wide Ink `useInput` bridge (`useKeyDispatcherBridge`) and
 * compatibility exports (`useScopedInput`, `KeyScopeProvider`) for legacy unmigrated views.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useInput as useInkInput, useStdin } from 'ink';
import { claimKeys } from '../components/focus.js';
import {
  KEY_LAYER_VIEW,
  allocateScopeId,
  dispatchToHub,
  getHub,
  isScopeMasked,
  pushOpaqueScope,
  reconcileFallbackOwner,
  subscribeScopeStack,
  type HandlerEntry,
  type ScopedKeyHandler,
} from './dispatcher.js';

export interface KeyScopeFrame {
  readonly depth: number;
  readonly scopeId: number;
}

const ROOT_SCOPE_FRAME: KeyScopeFrame = Object.freeze({ depth: 0, scopeId: 0 });

/** Current scope frame context (depth + LIFO scopeId). */
export const KeyScopeContext = createContext<KeyScopeFrame>(ROOT_SCOPE_FRAME);

export function useKeyScopeFrame(): KeyScopeFrame {
  return useContext(KeyScopeContext);
}

export function useKeyScopeDepth(): number {
  return useContext(KeyScopeContext).depth;
}

export interface KeyScopeProps {
  /** Optional debug identifier for the scope frame. */
  id?: string;
  /** Override depth (defaults to parentDepth + 1). */
  depth?: number;
  /** When true (default), pushes an opaque LIFO barrier blocking lower/earlier scopes. */
  opaque?: boolean;
  /** When false, renders children without pushing an opaque barrier (default true). */
  active?: boolean;
  children: ReactNode;
}

export const KeyScope: React.FC<KeyScopeProps> = ({
  id,
  depth,
  opaque = true,
  active = true,
  children,
}) => {
  const { stdin } = useStdin();
  const hub = getHub(stdin);
  const parent = useContext(KeyScopeContext);
  const nextDepth = depth ?? parent.depth + 1;

  const scopeIdRef = useRef<number | null>(null);
  if (scopeIdRef.current === null) {
    scopeIdRef.current = allocateScopeId(hub);
  }
  const ownScopeId = scopeIdRef.current;

  useLayoutEffect(() => {
    if (!opaque || !active || nextDepth <= 0) return undefined;
    return pushOpaqueScope(hub, { depth: nextDepth, scopeId: ownScopeId, label: id });
  }, [hub, opaque, active, nextDepth, ownScopeId, id]);

  // When opaque & active, descendants inherit `ownScopeId` so they run inside this barrier;
  // when passive (`!opaque || !active`), descendants keep `parent.scopeId` so they remain in parent scope.
  const effectiveFrame: KeyScopeFrame = opaque && active
    ? { depth: nextDepth, scopeId: ownScopeId }
    : { depth: depth ?? parent.depth, scopeId: parent.scopeId };

  return React.createElement(KeyScopeContext.Provider, { value: effectiveFrame }, children);
};

/** Legacy alias for `<KeyScope>` used by `AppShell` and `Modal`. */
export type KeyScopeProviderProps = KeyScopeProps;
export const KeyScopeProvider = KeyScope;

export function useKeyScopeBarrier(active: boolean, depthOverride?: number): void {
  const { stdin } = useStdin();
  const hub = getHub(stdin);
  const ctx = useContext(KeyScopeContext);
  const depth = depthOverride ?? ctx.depth;
  const scopeId = ctx.scopeId;

  useLayoutEffect(() => {
    if (!active || depth <= 0) return undefined;
    return pushOpaqueScope(hub, { depth, scopeId });
  }, [hub, active, depth, scopeId]);
}

/**
 * Reactively reports whether the current scope frame is active AND not masked by any
 * higher-depth or newer sibling opaque `<KeyScope>` on the stack.
 */
export function useScopeActive(baseActive = true, depthOverride?: number): boolean {
  const { stdin } = useStdin();
  const hub = getHub(stdin);
  const ctx = useContext(KeyScopeContext);
  const effectiveDepth = depthOverride ?? ctx.depth;

  const subscribe = useCallback((listener: () => void) => subscribeScopeStack(hub, listener), [hub]);
  const getSnapshot = useCallback(
    () => !isScopeMasked(hub, effectiveDepth, ctx.scopeId),
    [hub, effectiveDepth, ctx.scopeId],
  );

  const unmasked = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return baseActive && unmasked;
}

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

/**
 * Single root bridge mounted once in `AppShell`.
 * Holds the single Ink `useInput` subscription for the entire application.
 */
export function useKeyDispatcherBridge(active = true): void {
  const { stdin } = useStdin();
  const hub = getHub(stdin);

  useLayoutEffect(() => {
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
 * Low-level keyboard subscription hook (used by `useKeyScope`, widgets, and legacy unmigrated views).
 * Registers the handler in the per-stdin unified dispatcher hub.
 */
export function useScopedInput(handler: ScopedKeyHandler, options?: ScopedInputOptions): void {
  const isActive = options?.isActive ?? true;
  const layer = options?.layer ?? KEY_LAYER_VIEW;
  const ctx = useContext(KeyScopeContext);
  const depth = options?.depth ?? ctx.depth;
  const scopeId = ctx.scopeId;
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
      scopeId,
      active: isActive,
      handlerRef,
      id,
    };
  }
  const entry = entryRef.current;
  // Keep routing metadata synchronously up to date on every render so rapid keystrokes
  // never observe stale focus flags between render and effect commit.
  entry.layer = layer;
  entry.depth = depth;
  entry.scopeId = scopeId;
  entry.active = isActive;
  entry.id = id;

  const [, setOwnerTick] = useState(0);

  // Synchronously elect self on initial render if no bridge and no owner yet so even
  // immediate keystrokes before effects flush are captured strictly once.
  if (hub.bridgeCount === 0 && hub.fallbackOwnerSeq === null) {
    hub.fallbackOwnerSeq = entry.seq;
  }
  const ownsFallback = hub.bridgeCount === 0 && hub.fallbackOwnerSeq === entry.seq;
  const ownsFallbackRef = useRef(ownsFallback);
  ownsFallbackRef.current = ownsFallback;

  // Register in useLayoutEffect (same commit phase as KeyScope's opaque barrier push) so there is
  // never a post-paint race window where the barrier masks lower scopes before this handler exists.
  useLayoutEffect(() => {
    hub.entries.set(entry.seq, entry);
    const onOwnerChange = () => setOwnerTick((n) => n + 1);
    hub.ownerListeners.add(onOwnerChange);
    reconcileFallbackOwner(hub);
    const shouldOwn = hub.bridgeCount === 0 && hub.fallbackOwnerSeq === entry.seq;
    if (shouldOwn !== ownsFallbackRef.current) {
      setOwnerTick((n) => n + 1);
    }
    return () => {
      hub.ownerListeners.delete(onOwnerChange);
      hub.entries.delete(entry.seq);
      reconcileFallbackOwner(hub);
    };
  }, [hub, entry]);

  useInkInput(
    (input, key) => {
      if (hub.bridgeCount > 0) return;
      dispatchToHub(hub, input, key);
    },
    { isActive: ownsFallback },
  );
}

export interface UseKeyScopeOptions {
  /** Debug identifier for diagnostics and conflict tracing. */
  id: string;
  /** Key handler; return `true` (or call `ctx.consume()`) to stop propagation. */
  onKey: ScopedKeyHandler;
  /** Whether this scope is active (default true). Automatically masked by child opaque `<KeyScope>`s. */
  active?: boolean;
  /** Priority layer within the current scope depth (default KEY_LAYER_VIEW). */
  layer?: number;
  /** Optional explicit depth override. */
  depth?: number;
  /**
   * Keys claimed by this scope while active and unmasked.
   * Automatically synced with `SideNav` (hides overridden jump hints) and `AppShell:global`
   * without calling `useClaimKeys` separately.
   */
  keys?: readonly string[];
}

/**
 * Declarative scope hook replacing `useInput` + `useClaimKeys` + manual `mainActive` guards.
 * Returns `true` iff `active` is true AND no child/sibling opaque `<KeyScope>` masks this scope.
 */
export function useKeyScope(options: UseKeyScopeOptions): boolean {
  const { id, onKey, active = true, layer = KEY_LAYER_VIEW, depth, keys } = options;
  const effectiveActive = useScopeActive(active, depth);

  useScopedInput(onKey, {
    isActive: active,
    layer,
    depth,
    id,
  });

  const keysRef = useRef<readonly string[] | undefined>(keys);
  keysRef.current = keys;
  const keySig = keys && keys.length > 0 ? keys.join('\u0000') : '';

  useEffect(() => {
    if (!effectiveActive || !keySig) return undefined;
    const currentKeys = keysRef.current;
    if (!currentKeys || currentKeys.length === 0) return undefined;
    return claimKeys(currentKeys);
  }, [effectiveActive, keySig]);

  return effectiveActive;
}
