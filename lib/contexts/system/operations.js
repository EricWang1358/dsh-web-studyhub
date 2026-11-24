import { checkSettings } from "../../domain.js";
import { mergeGenerationSettings } from "../../generation-settings.js";
import { mergeDailyRecapSettings } from "../../daily-recap-settings.js";
import { mergeExamPrepSettings, resolveExamPrepSettings } from "../../exam-prep-settings.js";
import { mergePracticeSettings, resolvePracticeSettings } from "../../practice-settings.js";
import { mergeBookSettings } from "../../book-settings.js";
import { checkForUpdate, setUpdatePreferences } from "../../update-check.js";
import { createJevOperations } from "../../jev-operations.js";
import { readExperimental, setExperimental } from "../../experimental.js";
import { createUsageFrequencyOperations } from "../../usage-frequency-operations.js";



/** system operations close over only the ports declared by this context. */
export function createOperations(ports = {}) {
const backupUploads = ports.uploads || ports.worker?.uploads || null;
const storageRoot = ports.state?.root || "";
const handlers = {
// Chunked portable backup upload for >64 MiB backups (#1367-10).
"backup.upload.start": async function (a = {}) {
      if (!backupUploads?.startUpload) throw new Error("当前运行环境不支持分片上传备份");
      return backupUploads.startUpload(storageRoot, { name: a.name, size: a.size, kind: "backup" });
    },
"backup.upload.chunk": async function (a = {}) {
      if (!backupUploads?.appendUpload) throw new Error("当前运行环境不支持分片上传备份");
      return backupUploads.appendUpload(storageRoot, { uploadId: a.uploadId, offset: a.offset, data: a.data });
    },
"backup.upload.finish": async function (a = {}) {
      if (!backupUploads?.finishUpload) throw new Error("当前运行环境不支持分片上传备份");
      return backupUploads.finishUpload(storageRoot, a.uploadId);
    },
"backup.upload.cancel": async function (a = {}) {
      if (!backupUploads?.cancelUpload) return { cancelled: false };
      return backupUploads.cancelUpload(storageRoot, a.uploadId);
    },
// Library-independent: the release check is cached per DSH home, not per study library.
"update.check": async function (a = {}) {
      const transport = ports.httpFetch ?? ports.fetch;
      return checkForUpdate({ force: a.force === true, ...(transport ? { httpFetch: transport } : {}) });
    },
"update.preferences": async function (a = {}) {
      return setUpdatePreferences({ ...(a.autoCheck !== undefined ? { autoCheck: a.autoCheck } : {}), ...(a.snooze !== undefined ? { snooze: a.snooze } : {}) });
    },
// "Show experimental features" (Settings › Advanced): the one switch that makes anything experimental visible. Off by default.
"experimental.get": async function () { return { enabled: await readExperimental() }; },
"experimental.set": async function (a = {}) { return { enabled: await setExperimental(a.enabled) }; },
// Experimental Jev decision layer (settings, key test, usage): library-independent, off until the learner switches it on.
...createJevOperations(ports),
// Usage frequency record (Settings › Advanced): opt-in, local, counts only; library-independent. Panel operations: the assistant's tool refuses them.
...createUsageFrequencyOperations(ports),
};
const mutations = {
"settings": (s, a) => {
      // The 考前对齐 switch has its own write, which also moves the stored due dates (course.examAlignment.set, lib/exam-alignment.js).
      if (a && Object.hasOwn(a, "exam_alignment")) throw new Error("exam_alignment is switched by course.examAlignment.set, which also moves the stored due dates");
      s.settings = checkSettings({ ...s.settings, ...a,
        ...(a.generation !== undefined ? { generation: mergeGenerationSettings(s.settings.generation, a.generation) } : {}),
        ...(a.dailyRecap !== undefined ? { dailyRecap: mergeDailyRecapSettings(s.settings.dailyRecap, a.dailyRecap) } : {}),
        ...(a.examPrep !== undefined ? { examPrep: mergeExamPrepSettings(s.settings.examPrep, a.examPrep) } : {}),
        ...(a.practice !== undefined ? { practice: mergePracticeSettings(s.settings.practice, a.practice) } : {}) });
      return s.settings;
    },
// 备考补习 personal defaults (lib/exam-prep-settings.js): one optional key of the library settings, absent until saved; reset takes the key out again.
"settings.examPrep.set": (s, a = {}) => (s.settings.examPrep = mergeExamPrepSettings(s.settings.examPrep, a.patch)),
"settings.examPrep.reset": (s) => {
  // The learner's switch is not a personal default: forgetting the defaults keeps the page as it is (off stays off).
  if (s.settings.examPrep?.enabled === false) s.settings.examPrep = { enabled: false }; else delete s.settings.examPrep;
  return resolveExamPrepSettings(s.settings.examPrep);
},
// 练习 personal defaults (lib/practice-settings.js): the same shape, one more optional key.
"settings.practice.set": (s, a = {}) => (s.settings.practice = mergePracticeSettings(s.settings.practice, a.patch)),
// 恢复默认 forgets the defaults, not the learner's own 修题 phrases (lib/fix-phrases.js): those are kept.
"settings.practice.reset": (s) => {
  const { fixPhrases } = resolvePracticeSettings(s.settings.practice);
  if (fixPhrases) s.settings.practice = mergePracticeSettings(undefined, { fixPhrases }); else delete s.settings.practice;
  return resolvePracticeSettings(s.settings.practice);
},
// 复习全书 settings (lib/book-settings.js): 自动加入复习全书, saved on demand like the others.
"settings.book.set": (s, a = {}) => (s.settings.book = mergeBookSettings(s.settings.book, a.patch))
};
  return { handlers, mutations };
}
