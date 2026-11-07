// Only pure product rules; no library, credentials, network or model access.
import {
  FSRS6_WEIGHTS,
  FOCUS_RETENTION_BOOST,
  LIMITS,
  defaults,
  focusScheduleSettings,
  initialReview,
  memoryState,
  nextIntervals,
  previewSchedule,
  ratingOfGrade,
  schedule,
} from '../lib/sm2.js';
import {
  FAMILIAR_DAYS,
  LEVELS,
  MASTERED_DAYS,
  MASTERED_STREAK,
  cardLevel,
} from '../lib/mastery.js';

globalThis.STUDY_DEMO = {
  FSRS6_WEIGHTS,
  FOCUS_RETENTION_BOOST,
  LIMITS,
  defaults,
  focusScheduleSettings,
  initialReview,
  memoryState,
  nextIntervals,
  previewSchedule,
  ratingOfGrade,
  schedule,
  FAMILIAR_DAYS,
  LEVELS,
  MASTERED_DAYS,
  MASTERED_STREAK,
  cardLevel,
  intervals: previewSchedule(defaults, { grade: 4, reviews: 6 }).map(point => point.interval),
};
