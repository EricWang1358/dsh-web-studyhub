/* Pieces a host other than DSH puts into the shared UI, so a host-only feature lives in that host's own files and the
   shared pages carry one line that asks for it. Only an entry (e.g. ui/desktop.jsx) registers parts, before the app renders;
   the DSH client and the preview register none, and every shared page then draws exactly what it drew before.

   Parts used now (all optional):
     ModelSetup         component under Settings › 学习库与模型 in place of DSH's 生成模型 choice ({ }).
     ModelGateForm      component inside the block model gate before a model step ({ feature }).
     ModelQuickEnable   component in step 1 of the first-run line: the host's one-click way to a model, or nothing ({ onOffer(isOffering) }).
     recheckNote        () => what 重新检查 says when it still found no usable model, in place of DSH wording.
     appearanceDefaults { scale? … } appearance defaults of this host (设置 › 界面), each one of the allowed values.
     modelSetupSteps    (model, pick) => the gate's steps ([{ text, hint? }]) in place of DSH's model-panel steps.
     modelFact          (model) => one-sentence reason when a chosen model cannot be used, in place of DSH wording.
     UpgradeGuide       component in place of the DSH plugin-manager steps of the upgrade dialog ({ update, host }).
     runningNote        () => the top bar's hover words while background work runs.
     LibraryNotice      component under the library folder in Settings › 学习库与模型 ({ binding }). */
const parts = {};

/** Add or replace parts (an entry calls this once, before rendering). */
export function registerHostParts(next = {}) { Object.assign(parts, next); }

/** One part, or undefined when this host has none. */
export const hostPart = (name) => parts[name];
