import { Store } from './store.js';
import { StudyRuntime } from './runtime.js';
import { createBuiltinEnvironment, fullContextIds } from './runtime/builtins.js';
import { createJobNotifier } from './runtime/job-notice.js';
import { modelServices } from './runtime/models.js';

/** Historical external facade. Context implementations never receive this object. */
export class StudyService {
  #options;
  #store;
  constructor(root, options = {}) {
    const { runtime, storage, contexts, ...services } = options;
    this.#options = services;
    this.#store = storage || runtime?.storage || new Store(root);
    this.runtime = runtime || new StudyRuntime(root, { storage: this.#store });
    if (!runtime) {
      const environment = createBuiltinEnvironment(root, this.runtime);
      for (const id of contexts || fullContextIds) environment.install(id);
    }
  }
  get store() { return this.#store; }
  set store(storage) { this.#store = storage; this.runtime.replaceStorage(storage); }
  get complete() { return modelServices(this.#options).complete; }
  set complete(model) { this.#options.complete = model; }
  get light() { return modelServices(this.#options).light; }
  set light(model) { this.#options.light = model; }
  get coach() { return !!this.#options.coach; }
  set coach(enabled) { this.#options.coach = !!enabled; }
  get language() { return this.#options.language; }
  set language(language) { this.#options.language = language; }
  get fetch() { return modelServices(this.#options).fetch; }
  set fetch(fetch) { this.#options.fetch = fetch; }
  get WebSocket() { return modelServices(this.#options).WebSocket; }
  set WebSocket(WebSocket) { this.#options.WebSocket = WebSocket; }
  get notify() { return typeof this.#options.notify === 'function' ? this.#options.notify : null; }
  set notify(notify) { this.#options.notify = notify; }
  announceJob(job) { return createJobNotifier(this.notify)({ ...job, language: job.language || this.language }); }
  get modelOptions() { return { ...this.#options }; }
  call(action, args = {}) {
    if (!this.runtime.hasAction(action)) return Promise.reject(new Error(`Unknown study action: ${action}`));
    return this.runtime.call(action, args, this.#options);
  }
  saveAssistResult(args) { return this.runtime.invoke('study.v1', 'assist.commit', args, this.#options); }
  coachIdle() { return this.runtime.invoke('coach.v1', 'coach.idle', {}, this.#options); }
  flushPrep() { return this.runtime.invoke('coach.v1', 'coach.flush', {}, this.#options); }
  queuePrep(target) { return this.runtime.invoke('coach.v1', 'coach.queue', target, this.#options); }
  nudgeFor(runId, index) { return this.call('coach.nudge', { runId, index }); }
  get audioSettings() { return this.#options.audioSettings || (() => this.runtime.invoke('audio.v1', 'settings.resolved', {}, this.#options)); }
  set audioSettings(resolve) { this.#options.audioSettings = resolve; }
  dispose() { return this.runtime.dispose(); }
}
