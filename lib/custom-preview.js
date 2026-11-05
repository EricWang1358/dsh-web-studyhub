import { courseOf as bookCourseOf } from './course-book-files.js';
import { CUSTOM_PURPOSES, checkedCustom, customDefaults } from './custom-plan.js';
import { chosenChapters, courseSkeleton } from './custom-skeleton.js';
import { estimateCustom } from './custom-estimate.js';

/* course.custom.preview { course?, custom? } (深度定制, lib/custom-plan.js): the read-only question the main chat asks BEFORE anything is spent. No model call, no
   write, no price.
     -> { status: 'ok' | 'no-course', course, skeleton, defaults, estimate, saved, unknownChapters }
     skeleton   the course's materials and their chapters as the library holds them now (lib/custom-skeleton.js); the chapter ids are what a scope names.
     defaults   customDefaults(purpose) for every purpose, the one table.
     estimate   { book: { points, calls, readTokens }, questions: { count, calls, readTokens }, total: { calls, readTokens }, rough } for `custom` when given (checked
                as course.save would, so a refusal reads the same), else the course's saved one, else the review defaults; only the chosen chapters and the ticked parts
                count (lib/custom-estimate.js). rough: it rests on characters, not on an inventory.
     saved      the course's own 定制方案 as saved, or null.
     unknownChapters  the chapter ids of the estimated plan that name no chapter of the course now (they are left out of the estimate). */

const courseRecord = (state, name) => (state.courses || []).find(item => item && item.name === name) ?? null;
const defaults = () => Object.fromEntries(CUSTOM_PURPOSES.map(purpose => [purpose, customDefaults(purpose)]));

const nothing = (course = null) => ({ status: 'no-course', course, skeleton: { documents: [] }, defaults: defaults(), estimate: null, saved: null, unknownChapters: [] });

export function customPreview(state, args = {}) {
  const name = bookCourseOf(state, args), asked = checkedCustom(args.custom);
  if (name === null || name === undefined) return nothing();
  const record = courseRecord(state, name), skeleton = courseSkeleton(state, name);
  // A name no course record and no material of the library carries is no course (a typo), not an empty one.
  if (!record && !skeleton.documents.length) return nothing(name);
  const saved = record?.custom ?? null, plan = asked ?? checkedCustom(saved ?? customDefaults('review')), picked = chosenChapters(skeleton, plan.scope);
  return { status: 'ok', course: name, skeleton, defaults: defaults(), estimate: estimateCustom(picked, plan, state.settings?.generation), saved: structuredClone(saved),
    unknownChapters: picked.unknown };
}
