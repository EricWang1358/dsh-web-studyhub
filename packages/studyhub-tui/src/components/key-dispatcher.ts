/**
 * Compatibility re-export for the Unified Input Dispatcher & Scope Stack (#1354 D1 / P1).
 * The canonical single dispatcher and LIFO scope stack now live in `src/input/dispatcher.ts`
 * and `src/input/hooks.ts`; all views share the exact same per-stdin dispatcher hub.
 */
export {
  KEY_LAYER_DRAWER,
  KEY_LAYER_GLOBAL,
  KEY_LAYER_MODAL,
  KEY_LAYER_MODAL_FRAME,
  KEY_LAYER_MOUSE,
  KEY_LAYER_SYSTEM,
  KEY_LAYER_TEXT_INPUT,
  KEY_LAYER_VIEW,
  KEY_LAYER_WIDGET,
  KEY_SCOPE_DEPTH_QUIT_CONFIRM,
  KEY_SCOPE_DEPTH_SHELL_OVERLAY,
  KEY_SCOPE_DEPTH_TOO_SMALL,
  createTestKeyHub,
  dispatchToHub,
  getHub,
  getOpaqueStackSnapshot,
  getTopOpaqueScope,
  isScopeMasked,
  pushTestOpaqueScope,
  registerTestBarrier,
  registerTestHandler,
  type KeyDispatchContext,
  type OpaqueScopeEntry,
  type ScopedKeyHandler,
} from '../input/dispatcher.js';
export {
  KeyScope,
  KeyScopeContext,
  KeyScopeProvider,
  useKeyDispatcherBridge,
  useKeyScope,
  useKeyScopeBarrier,
  useKeyScopeDepth,
  useKeyScopeFrame,
  useScopeActive,
  useScopedInput,
  type KeyScopeFrame,
  type KeyScopeProps,
  type KeyScopeProviderProps,
  type ScopedInputOptions,
  type UseKeyScopeOptions,
} from '../input/hooks.js';
