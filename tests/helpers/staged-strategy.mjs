/* One pass is the default 出题方式 (lib/generation-settings.js strategy). A test that is about the mechanics of the staged pipeline (planning calls, a planner
   that clusters, the rounds of a run as the staged pipeline fills them) saves 'staged' as the library's default, as a learner would under 高级生成控制, and
   its runs are written the way it was written for. */
export const pinStaged = service => service.call('settings', { generation: { strategy: 'staged' } });
