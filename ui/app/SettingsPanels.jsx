import React, { useContext } from 'react';
import { CourseList } from '../CourseSettings.jsx';
import { OnboardingPanel } from '../tour/SampleControls.jsx';
import { AppContext } from './app-context.js';

/* The parts of Settings that are the app's own wiring: the course list (opens the course panel) and the sample/tour controls.
   Each Settings pane renders its own, so the page's layout stays with Settings (ui-consistency #113). They read the app's
   controller directly and draw nothing when rendered outside the app (a static preview, a pane under test). */

/** 课程: every course, its last use, and the way into a course's settings or a merge. */
export function CoursesPanel() {
  const app = useContext(AppContext);
  if (!app) return null;
  const { data, core, settingsEntry } = app;
  return (
    <CourseList courses={data.courses || []} busy={core.busy} onOpen={settingsEntry.setCourseSettings} currentId={data.focus?.courseId}
      recent={Object.fromEntries((data.focus?.courses || []).map((course) => [course.name, course.lastUsedAt]))}
      onMerge={(id, mergeFrom) => settingsEntry.setCourseSettings({ id, mergeFrom })} />
  );
}

/** 学习画像与导览: the sample library and tour controls. */
export function OnboardingControls() {
  const app = useContext(AppContext);
  if (!app) return null;
  const { data, core, tour } = app;
  return (
    <OnboardingPanel sample={data.sample} progress={tour.tourResume} busy={core.busy || tour.sampleBusy} onTour={() => tour.startTour()}
      onRestart={() => tour.startTour({ restart: true })} onLoad={data.sample ? tour.loadSampleOnly : undefined} onRemove={() => tour.setRemovingSample(true)} />
  );
}
