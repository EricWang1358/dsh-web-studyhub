/* Pieces a host other than DSH puts into the shared UI, so a host-only feature lives in that host's own files and the
   shared pages carry one line that asks for it. Only an entry (ui/zcode.jsx) registers parts, before the app renders;
   the DSH client and the preview register none, and every shared page then draws exactly what it drew before.

   Parts used now (all optional):
     ModelSetup         component under Settings › 学习库与模型 in place of DSH's 生成模型 choice ({ }).
     ModelGateForm      component inside the block model gate before a model step ({ feature }).
     modelSetupSteps    (model, pick) => the gate's steps ([{ text, hint? }]) in place of DSH's model-panel steps.
     UpgradeGuide       component in place of the DSH plugin-manager steps of the upgrade dialog ({ update, host }).
     runningNote        () => the top bar's hover words while background work runs.
     LibraryNotice      component under the library folder in Settings › 学习库与模型 ({ binding }). */
const parts = {};

/** Add or replace parts (an entry calls this once, before rendering). */
export function registerHostParts(next = {}) { Object.assign(parts, next); }

/** One part, or undefined when this host has none. */
export const hostPart = (name) => parts[name];
