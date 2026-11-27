/**
 * Transactional single-write / rollback helpers for StudyHub TUI (#1354 P3-b).
 *
 * Guarantees that multi-step mutations across settings, decks, board, drafts, notes,
 * and exam focus either succeed cleanly, roll back prior steps in LIFO order on failure,
 * or cache step-1 results so retries never duplicate records.
 */

export interface TxStepResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
}

export interface TxStep<T = unknown> {
  name: string;
  run: (prevResults: readonly unknown[]) => Promise<TxStepResult<T>>;
  rollback?: (value: T, prevResults: readonly unknown[]) => Promise<void>;
}

export type AtomicStepsOutcome =
  | { ok: true; results: unknown[] }
  | {
      ok: false;
      failedStep: string;
      failedIndex: number;
      error: string;
      results: unknown[];
      rolledBack: boolean;
      rollbackErrors: string[];
    };

/**
 * Execute sequential steps; if any step fails or throws, roll back all prior completed
 * steps with a `rollback` handler in reverse (LIFO) order.
 */
export async function runAtomicSteps(steps: readonly TxStep[]): Promise<AtomicStepsOutcome> {
  const results: unknown[] = [];
  const completed: Array<{ step: TxStep; value: unknown }> = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    let res: TxStepResult;
    try {
      res = await step.run(results);
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) {
      const rollbackErrors: string[] = [];
      let hadRollback = false;
      for (let j = completed.length - 1; j >= 0; j -= 1) {
        const entry = completed[j];
        if (!entry.step.rollback) continue;
        hadRollback = true;
        try {
          await entry.step.rollback(entry.value, results);
        } catch (rbErr) {
          rollbackErrors.push(
            `${entry.step.name}: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`,
          );
        }
      }
      return {
        ok: false,
        failedStep: step.name,
        failedIndex: i,
        error: res.error || `${step.name} failed`,
        results,
        rolledBack: hadRollback && rollbackErrors.length === 0,
        rollbackErrors,
      };
    }
    results.push(res.value);
    completed.push({ step, value: res.value });
  }

  return { ok: true, results };
}

export type IdempotentTwoStepOutcome<A, B> =
  | { ok: true; step1Value: A; step2Value: B }
  | { ok: false; step1Succeeded: false; error: string }
  | { ok: false; step1Succeeded: true; step1Value: A; error: string; rolledBack: boolean };

/**
 * Execute a two-step write with idempotent step-1 caching (or optional rollback on step-2 failure).
 * Prevents duplicate step-1 creation if the user retries after a transient step-2 error.
 */
export async function runIdempotentTwoStep<A, B>(opts: {
  cachedStep1: A | null;
  setCachedStep1: (value: A | null) => void;
  step1: () => Promise<TxStepResult<A>>;
  step2: (step1Value: A) => Promise<TxStepResult<B>>;
  rollbackStep1?: (step1Value: A) => Promise<boolean>;
}): Promise<IdempotentTwoStepOutcome<A, B>> {
  let v1: A;
  if (opts.cachedStep1 !== null) {
    v1 = opts.cachedStep1;
  } else {
    let r1: TxStepResult<A>;
    try {
      r1 = await opts.step1();
    } catch (err) {
      r1 = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!r1.ok || r1.value === undefined) {
      return { ok: false, step1Succeeded: false, error: r1.error || 'Step 1 failed' };
    }
    v1 = r1.value;
    opts.setCachedStep1(v1);
  }

  let r2: TxStepResult<B>;
  try {
    r2 = await opts.step2(v1);
  } catch (err) {
    r2 = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!r2.ok) {
    let rolledBack = false;
    if (opts.rollbackStep1) {
      try {
        rolledBack = await opts.rollbackStep1(v1);
        if (rolledBack) opts.setCachedStep1(null);
      } catch {
        rolledBack = false;
      }
    }
    return {
      ok: false,
      step1Succeeded: true,
      step1Value: v1,
      error: r2.error || 'Step 2 failed',
      rolledBack,
    };
  }

  opts.setCachedStep1(null);
  return { ok: true, step1Value: v1, step2Value: r2.value as B };
}

/**
 * Execute a single atomic write with optimistic UI state and guaranteed snapshot rollback on error.
 */
export async function runOptimisticWrite<S, R>(opts: {
  getSnapshot: () => S;
  applyOptimistic: () => void;
  write: () => Promise<TxStepResult<R>>;
  restoreSnapshot: (snapshot: S) => void;
}): Promise<TxStepResult<R>> {
  const snapshot = opts.getSnapshot();
  opts.applyOptimistic();
  try {
    const res = await opts.write();
    if (!res.ok) {
      opts.restoreSnapshot(snapshot);
    }
    return res;
  } catch (err) {
    opts.restoreSnapshot(snapshot);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
