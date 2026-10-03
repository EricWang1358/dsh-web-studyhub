// Only pure product rules; no library, credentials, network or model access.
import { defaults, initialReview, previewSchedule, schedule } from '../lib/sm2.js';
import { cardLevel } from '../lib/mastery.js';
window.STUDY_DEMO = { defaults, initialReview, schedule, cardLevel,
  intervals: previewSchedule(defaults, { grade: 4, reviews: 6 }).map(point => point.interval) };
