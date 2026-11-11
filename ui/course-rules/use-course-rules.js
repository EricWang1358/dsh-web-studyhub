import { useMemo } from 'react';
import { uiFormat } from '../i18n.js';
import { useToast } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { generationRulesOf } from '../../lib/courses.js';
import { addGenerationRule } from '../../lib/course-rules.js';

/* The 出题守则 of one course (#889) as the practice page needs them: the saved list (the snapshot's course record) and `add(texts)`, which writes the list with
   the new rules at the end through the course's own validated save (course.save; the course gets a record if it had none). Adding a rule already there
   changes nothing. `add` answers true when it saved, false when the library refused (the toast says why), undefined when another write held the lock. */
export function useCourseRules(data, course) {
  const { act } = useStudy();
  const toast = useToast();
  const savedKey = JSON.stringify(course ? generationRulesOf(data, course) : []);
  const rules = useMemo(() => JSON.parse(savedKey), [savedKey]);
  const add = async (texts) => {
    const next = texts.reduce((list, text) => addGenerationRule(list, text), rules);
    if (!course || next === rules) return false;
    try {
      const result = await act('course.save', { name: course, generationRules: next }, undefined, { rethrow: true });
      if (result === undefined) return undefined;
      toast.success(uiFormat('已加入「{0}」的出题守则', [course]));
      return true;
    } catch (cause) { toast.error(cause); return false; }
  };
  return { course, rules, add };
}
