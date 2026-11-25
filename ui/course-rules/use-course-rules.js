import { useMemo } from 'react';
import { uiFormat } from '../i18n.js';
import { useToast } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { generationRulesOf, ownGenerationRulesOf } from '../../lib/courses.js';
import { addGenerationRule } from '../../lib/course-rules.js';

/* The 出题守则 of one course (#889) as the practice page needs them: `rules` are the effective rules (inheriting from parent courses) and `add(texts)` writes
   only this course's own rules (`ownGenerationRulesOf`) plus the new ones through `course.save` so parent rules are never copied dirty into child courses. */
export function useCourseRules(data, course) {
  const { act } = useStudy();
  const toast = useToast();
  const savedKey = JSON.stringify(course ? generationRulesOf(data, course) : []);
  const ownKey = JSON.stringify(course ? ownGenerationRulesOf(data, course) : []);
  const rules = useMemo(() => JSON.parse(savedKey), [savedKey]);
  const ownRules = useMemo(() => JSON.parse(ownKey), [ownKey]);
  const add = async (texts) => {
    if (!course) return false;
    const effectiveNext = texts.reduce((list, text) => addGenerationRule(list, text), rules);
    if (effectiveNext === rules) return false;
    const next = texts.reduce((list, text) => addGenerationRule(list, text), ownRules);
    if (next === ownRules) return false;
    try {
      const result = await act('course.save', { name: course, generationRules: next }, undefined, { rethrow: true });
      if (result === undefined) return undefined;
      toast.success(uiFormat('已加入「{0}」的出题守则', [course]));
      return true;
    } catch (cause) { toast.error(cause); return false; }
  };
  return { course, rules, add };
}
