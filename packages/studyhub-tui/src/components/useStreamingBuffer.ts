import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface StreamingCoalescer {
  push(chunk: string): void;
  set(fullText: string): void;
  flush(): string;
  finish(): string;
  reset(): void;
  dispose(): void;
  getText(): string;
}

export interface StreamingBufferResult {
  text: string;
  push(chunk: string): void;
  set(fullText: string): void;
  flush(): string;
  finish(): string;
  reset(): void;
}

/**
 * Pure trailing-edge coalescer for high-frequency streaming text chunks.
 * Accumulates incoming deltas in memory and flushes at most once per `intervalMs`,
 * while `flush()` / `finish()` synchronously deliver any pending text immediately.
 */
export function createStreamingCoalescer(
  onFlush: (text: string) => void,
  intervalMs = 24,
): StreamingCoalescer {
  const delay = Math.max(0, intervalMs);
  let text = '';
  let dirty = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = (): string => {
    clearTimer();
    if (disposed) return text;
    if (dirty) {
      dirty = false;
      onFlush(text);
    }
    return text;
  };

  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
  };

  const push = (chunk: string) => {
    if (disposed || !chunk) return;
    text += chunk;
    dirty = true;
    schedule();
  };

  const set = (fullText: string) => {
    if (disposed) return;
    if (fullText === text && !dirty) return;
    text = fullText;
    dirty = true;
    schedule();
  };

  const finish = (): string => flush();

  const reset = () => {
    clearTimer();
    text = '';
    dirty = false;
  };

  const dispose = () => {
    disposed = true;
    clearTimer();
    dirty = false;
  };

  const getText = (): string => text;

  return { push, set, flush, finish, reset, dispose, getText };
}

/**
 * React hook wrapping `createStreamingCoalescer` for 60fps-capped Ink re-renders
 * during token streaming, with automatic timer cleanup on unmount.
 */
export function useStreamingBuffer(intervalMs = 24): StreamingBufferResult {
  const [text, setText] = useState('');
  const mountedRef = useRef(true);
  const coalescerRef = useRef<StreamingCoalescer | null>(null);

  const getCoalescer = useCallback((): StreamingCoalescer => {
    if (!coalescerRef.current) {
      coalescerRef.current = createStreamingCoalescer((next) => {
        if (mountedRef.current) {
          setText(next);
        }
      }, intervalMs);
    }
    return coalescerRef.current;
  }, [intervalMs]);

  useEffect(() => {
    mountedRef.current = true;
    if (!coalescerRef.current) {
      coalescerRef.current = createStreamingCoalescer((next) => {
        if (mountedRef.current) {
          setText(next);
        }
      }, intervalMs);
    }
    return () => {
      mountedRef.current = false;
      coalescerRef.current?.dispose();
      coalescerRef.current = null;
    };
  }, [intervalMs]);

  const push = useCallback((chunk: string) => {
    getCoalescer().push(chunk);
  }, [getCoalescer]);

  const set = useCallback((fullText: string) => {
    getCoalescer().set(fullText);
  }, [getCoalescer]);

  const flush = useCallback(() => getCoalescer().flush(), [getCoalescer]);

  const finish = useCallback(() => getCoalescer().finish(), [getCoalescer]);

  const reset = useCallback(() => {
    coalescerRef.current?.reset();
    if (mountedRef.current) {
      setText('');
    }
  }, []);

  return useMemo(
    () => ({ text, push, set, flush, finish, reset }),
    [text, push, set, flush, finish, reset],
  );
}
