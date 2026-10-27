/* The facts the case study quotes, read from the code that defines them. A number in the document is never typed by hand when a constant,
   a table or a file can say it: the document is generated from this object, so it cannot fall behind the code in these respects.
   `structural` facts describe the design (limits, counts of contexts, switches, views, tools); a change to one of them changes the committed
   snapshot (docs/case-study/facts.snapshot.json), and tests/case-study.test.mjs then asks for `npm run case-study`.
   `volatile` facts (version, dates, sizes of the tree) change with every release and are never compared. */
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MB = 1024 * 1024;

const text = (root, file) => readFile(resolve(root, file), 'utf8');
const grab = (source, pattern, what) => {
  const hit = pattern.exec(source);
  if (!hit) throw new Error(`case study facts: could not read ${what}; the code changed shape, so update scripts/case-study/facts.mjs`);
  return hit;
};

export async function computeFacts(root = REPO) {
  const load = (file) => import(pathToFileURL(resolve(root, file)).href);
  const [builtins, runtimeConfig, generationSettings, limits, largeDocuments, contractSchema, store, generationLimits, generationFailure, audioFormats, audioFile, audioUpload, officeLimits, jobArchive, dailyRecap, pollSchedule, liveProtocol, sourceQuery] = await Promise.all([
    'lib/runtime/builtins.js', 'lib/runtime-config.js', 'lib/generation-settings.js', 'lib/limits.js', 'lib/large-documents.js', 'lib/jobs/contract-schema.js', 'lib/store.js',
    'lib/generation-limits.js', 'lib/generation-failure.js', 'lib/audio-formats.js', 'lib/audio-file.js', 'lib/audio-upload.js', 'lib/office/limits.js', 'lib/job-archive.js', 'lib/daily-recap.js',
    'ui/poll-schedule.js', 'lib/live-protocol.js', 'lib/source-query.js',
  ].map(load));
  const [toolsSource, indexSource, tasksSource, liveSource, viewsSource, importHubSource, packageSource, changelog, contractSource] = await Promise.all([
    'lib/runtime/tools.js', 'lib/index.js', 'lib/runtime/tasks.js', 'lib/live.js', 'ui/workspace-views.jsx', 'ui/ImportHub.jsx', 'package.json', 'CHANGELOG.md', 'lib/job-contract.js',
  ].map((file) => text(root, file)));
  const pkg = JSON.parse(packageSource);
  const defaults = generationSettings.GENERATION_PERFORMANCE_DEFAULTS, bounds = generationSettings.GENERATION_SETTINGS_LIMITS;
  const poll = pollSchedule.POLL_BACKOFF.map(([unchanged, delayMs]) => ({ afterSeconds: unchanged * pollSchedule.POLL_FAST_MS / 1000, delaySeconds: delayMs / 1000 })).sort((a, b) => a.afterSeconds - b.afterSeconds);
  const translate = grab(liveSource, /TRANSLATE_BATCH = (\d+), TRANSLATE_CHARS = (\d+), TRANSLATE_TRIES = (\d+)/, 'the live translation batch');
  const rotateLead = Number(grab(liveSource, /rotateAfterMs: SESSION_LIMIT_MS - ([\d_]+)/, 'the live rotation lead').pop().replaceAll('_', ''));
  const backlog = Number(grab(liveSource, /const BACKLOG_MS = ([\d_]+)/, 'the live backlog').pop().replaceAll('_', ''));
  const toolNames = [...toolsSource.matchAll(/name: *'(study_[a-z_]+)'/g)].map((hit) => hit[1]);
  if (/name: *["']study_workspace["']/.test(indexSource)) toolNames.push('study_workspace');
  const capabilityPlugins = Object.keys(pkg.exports).filter((key) => /^\.\/plugins\/[a-z]+$/.test(key) && key !== './plugins/workbench').map((key) => key.slice('./plugins/'.length));
  const structural = {
    contextCount: builtins.fullContextIds.length,
    contextIds: [...builtins.fullContextIds],
    capabilityPlugins,
    toolNames,
    migrationSwitches: Object.keys(runtimeConfig.MIGRATION_SWITCHES).length,
    jobStates: contractSchema.STATUSES.length,
    jobStatesList: [...contractSchema.STATUSES],
    deferredViews: [...viewsSource.matchAll(/deferredView\(/g)].length,
    storeVersion: store.LATEST_VERSION,
    generation: {
      parallelParts: defaults.concurrency, partSize: defaults.batchSize, partSizeMax: bounds.batchSize.max, jobMinutes: defaults.jobTimeoutMinutes, jobMinutesRange: [bounds.jobTimeoutMinutes.min, bounds.jobTimeoutMinutes.max],
      fillRounds: defaults.fillRounds, fillRoundsMax: bounds.fillRounds.max, phaseMinutes: generationLimits.GENERATION_TIMEOUT_MS / 60000, reviewReasks: generationFailure.REVIEW_REASKS,
      groupChars: limits.CALL_CHARS, groupTargets: limits.CALL_TARGETS, retrieveAboveChars: largeDocuments.RETRIEVE_ABOVE_CHARS, applySuggestionsDefault: defaults.applySuggestions,
    },
    limits: {
      textMb: officeLimits.MAX_TEXT_DOCUMENT_BYTES / MB, officeMb: officeLimits.MAX_OFFICE_BYTES / MB, pdfPages: largeDocuments.LARGE_DOCUMENT_LIMITS.pdfPages, pdfMb: largeDocuments.LARGE_DOCUMENT_LIMITS.pdfBytes / MB,
      jsonDeckMb: Number(grab(importHubSource, /MAX_DECK_BYTES = ([\d_]+)/, 'the JSON deck file limit').pop().replaceAll('_', '')) / 1_000_000,
      audioMb: audioFormats.MAX_AUDIO_BYTES / MB, audioHours: audioFile.MAX_AUDIO_SECONDS / 3600, audioExtensions: [...audioFormats.AUDIO_EXTENSIONS],
      convertPdfMb: audioUpload.MAX_PDF_UPLOAD_BYTES / MB,
    },
    jobArchive: { maxRecords: jobArchive.ARCHIVE.maxRecords, maxDays: jobArchive.ARCHIVE.maxDays },
    taskHistory: Number(grab(tasksSource, /finished\.length - (\d+)/, 'the task history size').pop()),
    poll: { fastSeconds: pollSchedule.POLL_FAST_MS / 1000, backoff: poll },
    live: {
      sessionMinutes: liveProtocol.SESSION_LIMIT_MS / 60000, rotateAtSeconds: (liveProtocol.SESSION_LIMIT_MS - rotateLead) / 1000, backlogSeconds: backlog / 1000,
      translateSentences: Number(translate[1]), translateChars: Number(translate[2]), translateTries: Number(translate[3]),
    },
    dailyRecapMinimum: dailyRecap.DAILY_RECAP_MINIMUM,
    snapshotExcerptChars: sourceQuery.SOURCE_EXCERPT_CHARS,
    pauseCheckpointKinds: [...contractSource.matchAll(/^ *'?([a-z-]+)'?: { cancel: (?:true|false), pause: 'checkpoint'/gm)].map((hit) => hit[1]),
    node: pkg.engines.node,
  };
  const entries = [...changelog.matchAll(/^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})/gm)];
  const tracked = (folder) => { try { return execFileSync('git', ['ls-files', folder], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).length; } catch { return null; } };
  const commits = (() => { try { return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()); } catch { return null; } })();
  const volatile = {
    version: pkg.version, releaseDate: entries[0]?.[2] ?? null, changelogEntries: entries.length, firstChangelogDate: entries.at(-1)?.[2] ?? null,
    libFiles: tracked('lib'), uiFiles: tracked('ui'), commits,
  };
  return { structural, volatile };
}
