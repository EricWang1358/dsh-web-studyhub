/* The model of ONE running question run (「仅本任务生效」): the 即时控制 box can switch the model its next calls use, for this job only.

   Value. The run's control (lib/job-control.js generationControl) has one more live value, `model`: 'follow' (the default: the generation
   model the host resolves, Settings › 学习库与模型 or the session, exactly as before) or a model KEY, JSON.stringify([provider, model]),
   the encoding Settings' 生成模型 select already uses for its options. Its rule is `{ type: 'model' }`: a key of two non-empty strings,
   and the control asks the host whether it offers that provider (ctx.llm.listProviders, the check assertHostModelRoute makes); a host that
   cannot say is permissive, as lib/host.js modelStatus is. It is never saved: 存为默认 writes the other values, Settings stay as they are.

   Route. lib/reasoning-effort.js `routeOnModel()` is the host route moved onto the chosen provider and model. The learner's Settings level
   (its marker) rides on it; the session's own level only when the chosen model offers that id (it named a level of another model).
   Legacy executor: legacy-model.js hands `model` to the host completion beside the stage levels and lib/index.js builds the route per
   call. Unified runtime: gateway-model.js passes the step option `route` and lib/jobs/gateway.js builds it per step. Either way it is
   read when a call is about to start, so a call in flight finishes on the model it started with. The light lane (section weights) keeps
   the host route: it is the host's lowest-latency helper, not the run's writing.

   Box (ui/tasks/task-control.js, ControlRow.jsx). The 模型 select sits with the run's other choices and lists host.modelGroups, the catalog
   Settings' 生成模型 lists, by display name under its provider; its first choice 「跟随设置」 names the generation model in force. A host that
   lists no models draws no select. The bar's line says the model is for this task only; 存为默认 never includes it.

   Reasoning. The four per-stage selects stay and nothing is added: a whole-task 推理等级 would say the same thing twice. What they offer
   is the levels of the model in force through the one mapping (lib/model-effort.js effortChoices/chooseEffort, as 出题偏好's
   EffortSelect): the box asks the host (`model.efforts`, lib/host.js) for the levels of that model, so switching the model re-derives them;
   a host that cannot describe models keeps today's list, a model without levels says the existing "unsupported" sentence.

   Retry, failure. The change is the control's usual log line. A retry / 接着做 prepares a new control from the run's settings, like every
   other live value, so it starts again on 'follow'. A model the host no longer offers, or one the provider refuses (no key, no quota), fails
   that call with the words every model failure has (lib/generation-failure.js). */

export const FOLLOW_MODEL = 'follow';
const MAX_ID = 200;
const id = (value) => typeof value === 'string' && value.trim() && value.length <= MAX_ID ? value : '';

/** The key of a route (the value of the `model` control and of Settings' 生成模型 options), or '' when it is not one. */
export function modelKey(route) {
  const provider = id(route?.provider), model = id(route?.model);
  return provider && model ? JSON.stringify([provider, model]) : '';
}

/** The { provider, model } a key names, or null for 'follow' and for anything that is not a key. */
export function modelOfKey(value) {
  if (typeof value !== 'string' || value === FOLLOW_MODEL || !value.startsWith('[')) return null;
  let pair;
  try { pair = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [provider, model] = pair.map(id);
  return provider && model ? { provider, model } : null;
}

/** Whether a value is what the `model` control may hold: 'follow' or a well-formed key. */
export const isModelValue = (value) => value === FOLLOW_MODEL || modelOfKey(value) !== null;

