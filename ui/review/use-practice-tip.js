import { useCallback, useEffect, useRef, useState } from 'react';
import { reviewEntryKey } from '../async.js';
import { PRACTICE_TIP, markPracticeTipSeen, practiceTipFor, practiceTipState } from '../guidance/practice-tips.js';
import { isPassed } from './session-logic.js';

/*
 * The first-use tip of the practice page that is on screen now (ui/review/PracticeTip.jsx draws it; the rule is ui/guidance/practice-tips.js). The page says which
 * moments hold; this hook asks the rule, once the question has settled, and remembers what the learner did with the answer:
 *   知道了 or Esc            seen;
 *   the control it points at (a click on it, or the 修题 box opened by a tag of 「这题有问题」)   seen, quietly;
 *   the learner moves to another question while it was on screen   seen (it was shown once);
 *   the tour starts or an exam run is open   it goes away, unseen (it comes back at its next moment).
 * Moments that held while another tip was chosen wait for the next question: two tips never queue up behind each other on one question.
 */
const SHOW_AFTER_MS = 450; // the options of a just-answered question open one after another; the tip waits for them
const CONTROL_OF = Object.freeze({ 'review.help': PRACTICE_TIP.help, 'review.improve': PRACTICE_TIP.fix, 'review.derive-prereq': PRACTICE_TIP.prereq });

/** { tip, close, onShown }: `tip` is the id of the tip to draw, or null. `answerShown`: an answer of 帮我弄懂 or 追问 stands under the question; `votedDown`: 「这题有问题」 is marked. */
export function usePracticeTip({ run, votedDown = false, answerShown = false, tourRunning = false, assistMode = '' }) {
  const [tip, setTip] = useState(null);
  const active = useRef({ id: null, shown: false });
  const held = useRef({ key: '', ids: [] });
  const key = reviewEntryKey(run), exam = run?.mode === 'exam', feedbackWrong = !!run?.feedback && !isPassed(run);
  const choose = useCallback(id => { active.current = { id, shown: false }; setTip(id); }, []);
  const seen = useCallback(id => { markPracticeTipSeen(id); if (active.current.id === id) choose(null); }, [choose]);

  // Leaving the question with a tip on screen: it was shown, so it is seen.
  useEffect(() => () => { if (active.current.id && active.current.shown) markPracticeTipSeen(active.current.id); choose(null); }, [key, choose]);
  // Using the control a tip points at.
  useEffect(() => {
    const used = event => { const id = CONTROL_OF[event.target?.closest?.('[data-usage]')?.getAttribute('data-usage')]; if (id) seen(id); };
    document.addEventListener('click', used, true);
    return () => document.removeEventListener('click', used, true);
  }, [seen]);
  useEffect(() => { if (assistMode === 'improve') seen(PRACTICE_TIP.fix); }, [assistMode, seen]);
  // The tour or an exam run takes it away without spending it.
  useEffect(() => { if ((tourRunning || exam) && active.current.id) choose(null); }, [tourRunning, exam, choose]);
  // Which one, if any, once the question has settled.
  useEffect(() => {
    if (tip) return undefined;
    const timer = setTimeout(() => {
      const state = practiceTipState(), waiting = held.current.key === key ? held.current.ids : [];
      const next = practiceTipFor({ feedbackWrong, votedDown, answerShown, exam, tourRunning, seen: [...state.seen, ...waiting], allowed: state.allowed });
      if (!next) return;
      const holding = Object.entries({ [PRACTICE_TIP.help]: feedbackWrong, [PRACTICE_TIP.fix]: votedDown, [PRACTICE_TIP.prereq]: answerShown }).filter(([, now]) => now).map(([id]) => id);
      held.current = { key, ids: [...new Set([...waiting, ...holding])].filter(id => id !== next) };
      choose(next);
    }, SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [tip, key, feedbackWrong, votedDown, answerShown, exam, tourRunning, choose]);

  return {
    tip,
    close: useCallback(() => { if (active.current.id) seen(active.current.id); }, [seen]),
    onShown: useCallback(() => { active.current.shown = true; }, []),
  };
}
