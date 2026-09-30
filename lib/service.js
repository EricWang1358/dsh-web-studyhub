import { StudyRuntime } from './runtime.js';
import { createBuiltinEnvironment, fullContextIds } from './runtime/builtins.js';
import { LegacyKernel } from './legacy-kernel.js';

/** Historical workbench API; public plugins use the runtime's scoped APIs. */
export class StudyService extends LegacyKernel {
  constructor(root, options = {}) {
    super(root, options);
    const runtime = new StudyRuntime(root, { services: options, storage: this.store });
    const environment = createBuiltinEnvironment(root, runtime, { ...options, storage: this.store });
    for (const id of options.contexts || fullContextIds) environment.install(id);
    const legacy = environment.legacy;
    this.runtime = runtime;
    Object.assign(this, legacy.kernel);
    legacy.useKernel(this);
    this.call = async (action, args = {}) => {
      if (!runtime.hasAction(action)) throw new Error('Unknown study action');
      return runtime.call(action, args);
    };
    this.saveAssistResult = args => legacy.kernel.saveAssistResult(args);
  }
}
