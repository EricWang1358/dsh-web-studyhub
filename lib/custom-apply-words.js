/* The words of course.custom.apply (lib/custom-apply.js): every sentence the chat reads out, in one place, in the learner's language (zh by default, en when asked). Pure.
   `RUNS_AT_ONCE` is the apply's own number, handed in. */

export function wordsOf(language) {
  const say = (zh, en) => (language === 'en' ? en : zh);
  return {
    examRange: say('考试范围只记在方案里：书和题按全课程做，没有办法按一段范围说明去圈章节。',
      'The exam range is only kept in the plan: the book and the questions are made for the whole course; nothing can pick chapters from a range note.'),
    parts: list => say(`复习全书的部分（${list.join('、')}）记在方案里；现在的构建不能单独省略某一部分。`,
      `The parts of the review book (${list.join(', ')}) are kept in the plan; the build cannot leave a single part out yet.`),
    noModel: say('没有可用的模型，现在什么都没法生成，方案先存着。', 'There is no model, so nothing can be made now; the plan stays saved.'),
    unknownChapters: ids => say(`这些章节编号现在找不到了：${ids.join('、')}。请重新选一次章节再开始。`, `These chapter ids name nothing now: ${ids.join(', ')}. Pick the chapters again first.`),
    sampleWaits: say('复习全书的样例已经写好，在等你看过：看完说「做完」，才会写完整本。',
      'The sample of the review book is written and waits for you: say 「做完」 after reading it and the rest is written.'),
    bookDone: say('复习全书已经写好。', 'The review book is already written.'),
    bookRunning: say('复习全书正在做，没有再开一个。', 'The review book is already being made; no second task was started.'),
    bookSample: say('开始写复习全书：先写两个知识点的样例，写完等你看。', 'Started the review book: a sample of two points first, then it waits for you.'),
    bookStarted: say('开始写复习全书。', 'Started the review book.'),
    noText: say('这些章节没有可以出题的资料文字，没有开始出题。', 'The chosen chapters have no material text to ask questions of; nothing was started.'),
    runGoing: title => say(`${title} 的题正在做，没有再开一个。`, `The questions of ${title} are already being made; no second task was started.`),
    runStarted: (title, goal, sample) => say(`开始出 ${title} 的题（约 ${goal} 道${sample ? '，先做第一轮当样例' : ''}）。`,
      `Started the questions of ${title} (about ${goal}${sample ? '; the first round only, as a sample' : ''}).`),
    runResumed: title => say(`${title} 的题上次只做了一轮，现在接着做完。`, `The questions of ${title} stopped after a round; they are carried on to the end now.`),
    uncut: titles => say(`${titles.join('、')}：这部分资料是没有分页的一段文字，章节没法单独切开，出题会读整段文字。`,
      `${titles.join(', ')}: this material is one text with no pages, so the chapter cannot be cut out; its questions read the whole text.`),
    runsKept: count => say(`${count} 组题已经做过，没有重做。`, `${count} group(s) of questions were already made and were not made again.`),
    runsSample: left => say(`样例先行：先做了第一组的第一轮题，其余 ${left} 组等你看过样例后再做（说「做完」）。`,
      `Sample first: the first round of the first group is made; the other ${left} group(s) wait for you (say 「做完」).`),
    runsLeft: (left, atOnce) => say(`还有 ${left} 组题没开始（一次最多开 ${atOnce} 组）；这些做完后再说一次就接着做。`,
      `${left} more group(s) of questions are not started (at most ${atOnce} at a time); say it again when these have finished.`),
    planSaved: say('备考计划已经存好。', 'The study plan is already saved.'),
    planOther: say('这门课已经有一份备考计划，没有改它；想换成方案里的，说一声再存。', 'This course already has a study plan, left as it is; say so to replace it with the one of the plan.'),
    planNeedsDate: say('按考试日期排计划要先有考试日期：在课程设置里填，再说一次。', 'A plan by the exam date needs the exam date: set it in the course settings, then say it again.'),
    planWeekly: perWeek => say(`已存备考计划：每周 ${perWeek} 章，从今天排起（复习全书写好后才有具体到天的排期）。`,
      `Saved the study plan: ${perWeek} chapter(s) a week from today (the day-by-day schedule appears once the review book exists).`),
    planByDate: say('已存备考计划：按考试日期排（复习全书写好后才有具体到天的排期）。', 'Saved the study plan by the exam date (the day-by-day schedule appears once the review book exists).'),
    variants: on => (on ? say('变式题：开。这门课做错的题会自动准备变式题。', 'Variants: on. The wrong answers of this course get variants prepared automatically.')
      : say('变式题：关。这门课做错的题不会自动准备变式题（你自己在错题本里要的不受影响）。',
        'Variants: off. The wrong answers of this course get no variants prepared automatically (the ones you ask for in the wrong book are not affected).')),
  };
}
