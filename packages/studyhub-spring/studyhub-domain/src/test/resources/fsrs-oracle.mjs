import { writeFileSync } from 'node:fs';
import { fsrs, generatorParameters, createEmptyCard } from 'ts-fsrs';
import { schedule, ratingOfGrade, initialReview } from '../../../../../../lib/sm2.js';

// Each trajectory has its own fresh card. The deterministic clock crosses DST, local midnight and repeated-answer windows.
const lines = [];
let rng = 0x72a115;
function rand(max) { rng = (Math.imul(1664525, rng) + 1013904223) >>> 0; return Math.floor(rng / 2 ** 32 * max); }
for (let seed = 0; seed < 1000; seed++) {
  const zone = ['Asia/Shanghai', 'America/New_York', 'UTC'][seed % 3];
  process.env.TZ = zone;
  const settings = { request_retention: (.7 + rand(28) / 100).toFixed(2) * 1, maximum_interval: [7, 45, 36500][rand(3)],
    isolate_same_day: seed % 2 === 0 };
  const reference = fsrs(generatorParameters({ ...settings, enable_fuzz: false, enable_short_term: false }));
  let at = Date.UTC(2026, 1, 25, rand(24), rand(60));
  let study = initialReview(), rawCard;
  for (let step = 0; step < 14; step++) {
    at += [10, 180, 1200, 1440, 2880, 10080][rand(6)] * 60000;
    const instant = new Date(at), grade = rand(6);
    const shifted = new Date(at - instant.getTimezoneOffset() * 60000);
    rawCard = reference.next(rawCard || createEmptyCard(shifted), shifted, ratingOfGrade(grade)).card;
    study = schedule(study, grade, instant.toISOString(), settings);
    const row = [seed, step, zone, settings.request_retention, settings.maximum_interval, settings.isolate_same_day,
      grade, at, study.stability, study.difficulty, study.interval_days, Date.parse(study.due_at), study.reps,
      study.repetitions, study.spaced_reps, study.lapses, study.last_grade, Date.parse(study.last_lapse_at) || 0,
      rawCard.stability, rawCard.difficulty, Math.min(rawCard.scheduled_days, settings.maximum_interval), rawCard.lapses];
    lines.push(row.join('\t'));
  }
}
writeFileSync(process.argv[2], lines.join('\n'));
