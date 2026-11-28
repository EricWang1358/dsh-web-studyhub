import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERATION_TIMEOUT_MS } from '../../../../lib/generation-limits.js';
import { buildAgyStreamArgs } from '../../domain/agy-protocol.js';
import { agyConfigSpec, agyWarmPlanForCall, agyWarmPlanForConfig } from '../../domain/agy-warm-policy.js';
import { createAgyWarmPool } from './agy-warm-pool.mjs';

/** The time limit a spare is started with: the longest an ordinary call asks for. A call's own, shorter limit is kept by the runner. */
export const AGY_SPARE_TIMEOUT_MS = GENERATION_TIMEOUT_MS;

/** A fresh empty folder for one agy process, and how to remove it. */
export async function createAgyWorkDir() {
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-agy-'));
  return { dir, remove: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}) };
}

/**
 * Start one agy that waits for its single question, with the flags and the empty folder a fresh call gets.
 * Returns at once and never throws: a program that cannot start shows up as `exited` and as the result of `run`, which is null
 * when there is no process at all (no folder, a refused spawn).
 */
export function openAgySpare(runner, spec) {
  const work = createAgyWorkDir();
  const held = work.then(({ dir }) => runner.hold({
    command: spec.executablePath,
    args: buildAgyStreamArgs({ timeoutMs: spec.timeoutMs, model: spec.model, effort: spec.effort }),
    cwd: dir,
  }));
  held.catch(() => {});
  let closing = null;
  return Object.freeze({
    spec,
    exited: held.then((child) => child.exited, () => {}),
    run: async (turn) => {
      const child = await held.catch(() => null);
      return child ? child.run(turn) : null;
    },
    close() {
      closing ||= (async () => {
        await held.then((child) => child.terminate(), () => {});
        await work.then(({ remove }) => remove(), () => {});
      })();
      return closing;
    },
  });
}

/**
 * The spare agy of one running app. It goes to the agy adapter, which calls `claim` for each call and `fault` when one fails;
 * `sync()` after the settings are read or saved; `dispose()` when the app closes. A runner that cannot hold a process gives no
 * pre-warming (null). The pre-warm choice is read from `getConfig` at every use.
 * @param {object} ports
 * @param {object} ports.runner the process runner every agy call uses
 * @param {() => import('../../domain/contracts.js').DesktopConfig | null} ports.getConfig the settings as they are now
 * @param {() => string} ports.findExecutablePath the discovered program, for settings that name none
 */
export function createAgyWarm({ runner, getConfig, findExecutablePath }) {
  if (typeof runner?.hold !== 'function') return null;
  const specNow = () => agyConfigSpec(getConfig(), { executablePath: findExecutablePath() || '', timeoutMs: AGY_SPARE_TIMEOUT_MS });
  const planNow = (trigger) => agyWarmPlanForConfig(getConfig(), trigger, specNow());
  const pool = createAgyWarmPool({
    open: (spec) => openAgySpare(runner, spec),
    planOnExpiry: () => planNow('expiry'),
  });
  let seen = null;
  return Object.freeze({
    /** The waiting process when it can answer this call, else null; also settles what waits for the next one. */
    claim: (callSpec) => pool.claim(callSpec, agyWarmPlanForCall(getConfig(), callSpec, AGY_SPARE_TIMEOUT_MS)),
    fault: () => pool.fault(),
    sync() {
      const { executablePath, model, effort } = specNow();
      const flags = JSON.stringify([executablePath, model, effort]);
      // A spare started for other settings would only be passed by; calls that ask for their own effort do not change these.
      if (seen !== null && seen !== flags) pool.drop();
      seen = flags;
      pool.apply(planNow('config'));
    },
    dispose: () => pool.dispose(),
  });
}
