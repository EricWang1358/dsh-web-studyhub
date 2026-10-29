/* What a learner can say to start AI 带学 (#549): one list for the tour, Settings › 引导 and the empty workbench, so the three never tell different
   stories. Chinese source text, English in ui/locales/en.guided.json; each example is sent to the main chat as it is (the study-tutor skill takes it). */

export const GUIDED_EXAMPLES = Object.freeze([
  Object.freeze({ id: 'topic', text: '带我学条件概率，每讲完一个点就出一道题考我。', note: '讲一段，当场出一道经过审核的题，在右侧做' }),
  Object.freeze({ id: 'chapter', text: '用《概率讲义》第 3 章边讲边测，新题放进我「概率论」课程的题组。', note: '指定资料和题组' }),
  Object.freeze({ id: 'mistake', text: '这道题我错了，先讲为什么错，再给我出一道类似的。', note: '做错之后' }),
  Object.freeze({ id: 'resume', text: '继续上次的带学。', note: '接着上一次' }),
]);

/** The defaults of a guided session, said once: what the main chat needs the learner's yes for. */
export const GUIDED_DEFAULTS = Object.freeze([
  '现场出新题：默认关。主会话会先问你要不要出题、题放进哪个题组；你同意了才打开。新题按资料出、核对引文并独立审核，通过后进你已有的题组，之后和别的题一样进入每日复习。',
  '问答自动归位：默认关。答疑里值得留下的内容，要你同意才会放进那道题的问答。',
  '修改笔记：默认关。带学不会改你的笔记，除非你明确同意。',
]);
