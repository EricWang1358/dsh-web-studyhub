/**
 * Centralized SGR 1006 mouse parsing, hit-testing, Z-layer modal isolation, and stdin tap.
 *
 * Design:
 * - Clickable elements register a DOMElement ref + layer + handler in a global registry.
 * - No layout measurement happens during render — `measureElement()` is called lazily ONLY
 *   when a mouse click arrives (O(active regions) per click, 0 render overhead).
 * - Modals provide `MouseLayerContext` (+100 per nesting level) and register a modal barrier
 *   so clicks outside an open modal are swallowed and NEVER bleed through to the page below.
 * - One ref-counted `stdin.read` tap per stream dispatches both wheel and click events cleanly.
 */
import React, {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import { Box, measureElement, useStdin, type DOMElement } from 'ink';
import { KEY_LAYER_MOUSE } from '../input/dispatcher.js';
import { useScopedInput } from '../input/hooks.js';

export const MOUSE_LAYER_BASE = 0;
export const MOUSE_LAYER_MODAL = 100;
export const MOUSE_LAYER_CONFIRM = 200;

export const MouseLayerContext = createContext<number>(MOUSE_LAYER_BASE);

export function useMouseLayer(): number {
  return useContext(MouseLayerContext);
}

export interface SgrMouseEvent {
  button: number;
  /** 0-based terminal column. */
  col: number;
  /** 0-based terminal row. */
  row: number;
  /** true for press (`M`), false for release (`m`). */
  press: boolean;
  /** Modifier bits from SGR button field: Shift (+4), Alt/Meta (+8), Ctrl (+16). */
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** true for primary left-button click (not motion/drag, not wheel, not release). */
  isLeftClick: boolean;
  /** Non-zero for scroll wheel events (-step up, +step down). */
  wheelDelta: number;
}

/**
 * Alt-compatible click gate (#1311):
 * Default `true` — only Alt+left-click (`button & 8`) triggers TUI actions, while plain clicks are
 * ignored so the terminal keeps native text selection/copy. Set to `false` via `--mouse-alt=0` or
 * `STUDYHUB_TUI_MOUSE_ALT=0` to allow plain clicks too. Wheel events are always unaffected.
 */
let altClickOnly = true;

export function setMouseAltClickOnly(enabled: boolean): void {
  altClickOnly = Boolean(enabled);
}

export function isMouseAltClickOnly(): boolean {
  return altClickOnly;
}

export function shouldHandleMouseClick(
  ev: Pick<SgrMouseEvent, 'isLeftClick' | 'alt'>,
  requireAlt: boolean = altClickOnly,
): boolean {
  return ev.isLeftClick && (!requireAlt || ev.alt);
}

export interface MouseClickEvent {
  /** 0-based screen column. */
  col: number;
  /** 0-based screen row. */
  row: number;
  /** Column relative to the hit element's top-left corner. */
  localX: number;
  /** Row relative to the hit element's top-left corner. */
  localY: number;
  /** True when clicking the same region (and same localY) twice within 450ms. */
  doubleClick: boolean;
}

const SGR_MOUSE_GLOBAL_RE = /(?:\u001b+\[|\[)?<(\d+);(\d+);(\d+)([Mm])/g;
const INTACT_SGR_MOUSE_RE = /\u001b+\[<\d+;\d+;\d+[Mm]/g;
const SGR_MOUSE_CHUNK_RE = /^(?:(?:\u001b+\[|\[)?<\d+;\d+;\d+[Mm])+$/;

/** Parse intact or ESC-stripped SGR 1006 mouse sequences into structured events. */
export function parseSgrMouseEvents(input: string, wheelStep = 3): SgrMouseEvent[] {
  if (!input || !input.includes('<')) return [];
  const unit = Number.isFinite(wheelStep) && wheelStep > 0 ? Math.floor(wheelStep) : 3;
  const out: SgrMouseEvent[] = [];
  SGR_MOUSE_GLOBAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SGR_MOUSE_GLOBAL_RE.exec(input)) !== null) {
    const button = Number.parseInt(match[1], 10);
    const col1 = Number.parseInt(match[2], 10);
    const row1 = Number.parseInt(match[3], 10);
    const press = match[4] === 'M';
    if (!Number.isFinite(button) || !Number.isFinite(col1) || !Number.isFinite(row1)) continue;
    const isMotion = (button & 32) !== 0;
    const shift = (button & 4) !== 0;
    const alt = (button & 8) !== 0;
    const ctrl = (button & 16) !== 0;
    const code = button & 0x43;
    let wheelDelta = 0;
    if (press && code === 64) wheelDelta = -unit;
    else if (press && code === 65) wheelDelta = unit;
    const isLeftClick = press && !isMotion && (button & 64) === 0 && (button & 3) === 0;
    out.push({
      button,
      col: Math.max(0, col1 - 1),
      row: Math.max(0, row1 - 1),
      press,
      shift,
      alt,
      ctrl,
      isLeftClick,
      wheelDelta,
    });
  }
  return out;
}

/** True when `raw` consists exclusively of SGR 1006 mouse sequence(s) (intact or ESC-stripped). */
export function isSgrMouseSequence(raw: string): boolean {
  return Boolean(raw && raw.includes('<') && SGR_MOUSE_CHUNK_RE.test(raw));
}

/** Strip any intact or ESC-stripped SGR 1006 mouse sequences from a text chunk. */
export function stripSgrMouseSequences(raw: string): string {
  if (!raw || !raw.includes('<')) return raw;
  return raw.replace(SGR_MOUSE_GLOBAL_RE, '');
}

// ---------------------------------------------------------------------------------------------
// Centralized Hit-Test Registry & Modal Barriers
// ---------------------------------------------------------------------------------------------

interface HitRegion {
  id: number;
  ref: RefObject<DOMElement | null>;
  layer: number;
  order: number;
  onClick: (ev: MouseClickEvent) => void;
}

interface ModalBarrier {
  id: number;
  layer: number;
}

let nextRegionId = 1;
let nextBarrierId = 1;
const regions = new Map<number, HitRegion>();
const barriers = new Map<number, ModalBarrier>();
let lastClickMeta: { regionId: number; localY: number; at: number } | null = null;
const DOUBLE_CLICK_MS = 450;

export function currentModalBarrierLayer(): number {
  let maxLayer = 0;
  for (const b of barriers.values()) {
    if (b.layer > maxLayer) maxLayer = b.layer;
  }
  return maxLayer;
}

/**
 * Hit-test and dispatch a left click at 0-based screen coordinates `(col, row)`.
 * Returns true if a registered region handled the click (or a modal barrier swallowed it).
 */
export function dispatchMouseClick(col: number, row: number): boolean {
  const minLayer = currentModalBarrierLayer();
  if (regions.size === 0) return minLayer > 0;

  // Sort candidates by highest layer first, then most recently registered (innermost child first).
  const candidates = [...regions.values()]
    .filter((r) => r.layer >= minLayer)
    .sort((a, b) => b.layer - a.layer || b.order - a.order);

  for (const region of candidates) {
    const node = region.ref.current;
    if (!node) continue;
    let m: { x: number; y: number; width: number; height: number };
    try {
      m = measureElement(node);
    } catch {
      continue;
    }
    if (m.width <= 0 || m.height <= 0) continue;
    if (col >= m.x && col < m.x + m.width && row >= m.y && row < m.y + m.height) {
      const localX = col - m.x;
      const localY = row - m.y;
      const now = Date.now();
      const doubleClick =
        lastClickMeta !== null &&
        lastClickMeta.regionId === region.id &&
        lastClickMeta.localY === localY &&
        now - lastClickMeta.at <= DOUBLE_CLICK_MS;
      lastClickMeta = { regionId: region.id, localY, at: now };
      region.onClick({ col, row, localX, localY, doubleClick });
      return true;
    }
  }

  // If a modal barrier is open, swallow clicks outside the modal so the underlying page never responds.
  return minLayer > 0;
}

// ---------------------------------------------------------------------------------------------
// Shared per-stdin SGR mouse tap (handles BOTH wheel & click without conflicting wrappers)
// ---------------------------------------------------------------------------------------------

type ReadFn = (size?: number) => unknown;
interface StdinMouseTapState {
  origRead: ReadFn;
  wrappedRead: ReadFn;
  wheelListeners: Set<(delta: number) => void>;
  clickSubscribers: number;
  lastTapClickSig: string;
  lastTapClickAt: number;
}

const stdinMouseTaps = new WeakMap<object, StdinMouseTapState>();

function ensureStdinTap(stream: NodeJS.ReadStream & { read?: ReadFn }): StdinMouseTapState {
  const state = stdinMouseTaps.get(stream);
  if (state) return state;

  const origRead = (stream.read as ReadFn).bind(stream);
  const wheelListeners = new Set<(delta: number) => void>();
  const tapState: StdinMouseTapState = {
    origRead,
    wrappedRead: () => null,
    wheelListeners,
    clickSubscribers: 0,
    lastTapClickSig: '',
    lastTapClickAt: 0,
  };

  tapState.wrappedRead = (size?: number) => {
    const chunk = origRead(size);
    if (chunk !== null && chunk !== undefined && (wheelListeners.size > 0 || tapState.clickSubscribers > 0)) {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      if (text.includes('\u001b') && text.includes('[<')) {
        const matches = text.match(INTACT_SGR_MOUSE_RE);
        if (matches && matches.length > 0) {
          const events = parseSgrMouseEvents(matches.join(''));
          if (wheelListeners.size > 0) {
            let wheelTotal = 0;
            for (const ev of events) wheelTotal += ev.wheelDelta;
            if (wheelTotal !== 0) {
              const clamped = Math.max(-24, Math.min(24, wheelTotal));
              for (const fn of [...wheelListeners]) fn(clamped);
            }
          }
          if (tapState.clickSubscribers > 0) {
            for (const ev of events) {
              if (shouldHandleMouseClick(ev)) {
                tapState.lastTapClickSig = `${ev.col}:${ev.row}`;
                tapState.lastTapClickAt = Date.now();
                dispatchMouseClick(ev.col, ev.row);
              }
            }
          }
        }
      }
    }
    return chunk;
  };

  stdinMouseTaps.set(stream, tapState);
  stream.read = tapState.wrappedRead;
  return tapState;
}

function maybeCleanupStdinTap(stream: NodeJS.ReadStream & { read?: ReadFn }, state: StdinMouseTapState): void {
  if (state.wheelListeners.size === 0 && state.clickSubscribers <= 0) {
    if (stream.read === state.wrappedRead) {
      stream.read = state.origRead;
    }
    stdinMouseTaps.delete(stream);
  }
}

/** Subscribe to intact SGR 1006 wheel events on Ink's stdin stream. */
export function useSgrWheelTap(isActive: boolean, onWheel: (delta: number) => void): void {
  const { stdin } = useStdin();
  const onWheelRef = useRef(onWheel);
  onWheelRef.current = onWheel;

  useEffect(() => {
    const stream = stdin as (NodeJS.ReadStream & { read?: ReadFn }) | undefined;
    if (!isActive || !stream || typeof stream.read !== 'function') return undefined;
    const state = ensureStdinTap(stream);
    const listener = (delta: number) => onWheelRef.current(delta);
    state.wheelListeners.add(listener);
    return () => {
      state.wheelListeners.delete(listener);
      maybeCleanupStdinTap(stream, state);
    };
  }, [isActive, stdin]);
}

function useEnsureClickTap(active: boolean): void {
  const { stdin } = useStdin();
  useEffect(() => {
    const stream = stdin as (NodeJS.ReadStream & { read?: ReadFn }) | undefined;
    if (!active || !stream || typeof stream.read !== 'function') return undefined;
    const state = ensureStdinTap(stream);
    state.clickSubscribers += 1;
    return () => {
      state.clickSubscribers = Math.max(0, state.clickSubscribers - 1);
      maybeCleanupStdinTap(stream, state);
    };
  }, [active, stdin]);
}

/**
 * Fallback listener for ESC-stripped SGR mouse clicks (`[<0;c;rM`) flowing through the single
 * input dispatcher (#1354 D1). Mount once at the root (`AppShell`). Deduplicates against the
 * `stdin.read` tap and consumes non-wheel mouse frames so they never leak into views or inputs.
 */
export function useMouseClickInputFallback(active = true): void {
  const { stdin } = useStdin();
  useEnsureClickTap(active);

  useScopedInput(
    (input) => {
      if (!input || !input.includes('<') || !isSgrMouseSequence(input)) return false;
      const stream = stdin as (NodeJS.ReadStream & { read?: ReadFn }) | undefined;
      const tapState = stream ? stdinMouseTaps.get(stream) : undefined;
      const events = parseSgrMouseEvents(input);
      const hasWheel = events.some((ev) => ev.wheelDelta !== 0);
      const now = Date.now();
      for (const ev of events) {
        if (!shouldHandleMouseClick(ev)) continue;
        const sig = `${ev.col}:${ev.row}`;
        if (tapState && tapState.lastTapClickSig === sig && now - tapState.lastTapClickAt < 80) {
          continue;
        }
        dispatchMouseClick(ev.col, ev.row);
      }
      // Consume pure click/release/motion frames so they never leak into keyboard handlers;
      // let wheel frames flow through to VirtualList / ScrollView / SelectList.
      return !hasWheel;
    },
    { isActive: active, layer: KEY_LAYER_MOUSE, id: 'Mouse:sgrFallback' },
  );
}

/** Block mouse clicks from bleeding through to regions at layers `< layer` while active. */
export function useMouseModalBarrier(active: boolean, layer?: number): void {
  const ctxLayer = useMouseLayer();
  const effectiveLayer = layer ?? ctxLayer;
  useLayoutEffect(() => {
    if (!active) return undefined;
    const id = nextBarrierId++;
    barriers.set(id, { id, layer: effectiveLayer });
    return () => {
      barriers.delete(id);
    };
  }, [active, effectiveLayer]);
}

export interface ClickRegionOptions {
  active?: boolean;
  layer?: number;
}

/** Register a `<Box ref={ref}>` as a clickable hit-test target in the centralized registry. */
export function useClickRegion(
  ref: RefObject<DOMElement | null>,
  onClick: ((ev: MouseClickEvent) => void) | undefined,
  opts?: ClickRegionOptions,
): void {
  const ctxLayer = useMouseLayer();
  const active = (opts?.active ?? true) && Boolean(onClick);
  const layer = opts?.layer ?? ctxLayer;
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  useEnsureClickTap(active);

  useLayoutEffect(() => {
    if (!active) return undefined;
    const id = nextRegionId++;
    regions.set(id, {
      id,
      ref,
      layer,
      order: id,
      onClick: (ev) => onClickRef.current?.(ev),
    });
    return () => {
      regions.delete(id);
    };
  }, [active, layer, ref]);
}

export interface ClickableBoxProps extends ComponentProps<typeof Box> {
  onClick?: (ev: MouseClickEvent) => void;
  clickActive?: boolean;
  clickLayer?: number;
  children?: ReactNode;
}

/** Convenience `<Box>` wrapper that registers itself with the centralized mouse click registry. */
export const ClickableBox = memo(function ClickableBox({
  onClick,
  clickActive = true,
  clickLayer,
  children,
  ...boxProps
}: ClickableBoxProps) {
  const ref = useRef<DOMElement | null>(null);
  useClickRegion(ref, onClick, { active: clickActive && Boolean(onClick), layer: clickLayer });
  return (
    <Box ref={ref} {...boxProps}>
      {children}
    </Box>
  );
});

/** Test helper: inspect currently registered region count. */
export function _debugMouseRegistryStats(): { regions: number; barriers: number } {
  return { regions: regions.size, barriers: barriers.size };
}
