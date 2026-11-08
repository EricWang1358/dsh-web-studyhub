import { useContext, useState } from 'react';
import { StudyServicesContext } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import { activePlanCourse } from './today-header.js';

/**
 * Fetches `course.plan` once for the active planned course when `planAnswer === undefined`,
 * so `TodayFocusStrip` and `TodayUpcomingPlan` share one read-only schedule without duplicate RPCs.
 */
export function useTodayCoursePlan(library, today, planAnswer) {
  const services = useContext(StudyServicesContext);
  const course = activePlanCourse(library);
  const courseName = course ? course.name : null;
  const [fetchedPlan, setFetchedPlan] = useState(null);

  useLiveEffect((isLive) => {
    if (planAnswer !== undefined || courseName === null || !services?.call) {
      setFetchedPlan(null);
      return;
    }
    services.call('course.plan', { course: courseName, date: today })
      .then((res) => { if (isLive()) setFetchedPlan(res); })
      .catch(() => { if (isLive()) setFetchedPlan(null); });
  }, [planAnswer, courseName, today, library?.revision, services]);

  return planAnswer !== undefined ? planAnswer : fetchedPlan;
}
