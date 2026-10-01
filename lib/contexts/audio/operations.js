import { LIVE_NEEDS_GEMINI, NO_PAID_KEY, NO_TRANSCRIPTION_KEY, hasTranscriptionKey, publicAudioSettings, readAudioSettings, saveAudioSettings } from "../../audio-settings.js";
import { GeminiTiers } from "../../gemini.js";
import { assertTextModel, audioContext, courseTopics, jobTextModel, storeDocuments } from "../../audio-job.js";
import { executeReviewJob, reviewTarget } from "../../audio-review.js";
import { executeSubtitleJob, prepareSubtitles } from "../../subtitle-job.js";
import { SUBTITLE_EXTENSIONS } from "../../subtitles.js";
import { prepareAudioBatch, prepareSingleAudioRecord, removeAudioBatch, readAudioBatch } from "../../audio-batch.js";
import { isAbsolute, extname, basename } from "node:path";
import { AUDIO_EXTENSIONS } from "../../audio-file.js";
import { readSaved, LiveSession, writeSaved, deleteSaved } from "../../live.js";
import { resolveCourse, importCourses } from "../../source-courses.js";
import { currentCourse } from "../../focus.js";
import { buildVocabulary, termList } from "../../transcript.js";
import { defaultTitle as liveDefaultTitle, excerptText as liveExcerpt, digest as liveDigest, clock as liveClock, quickDocuments as liveQuickDocuments } from "../../live-save.js";
import { RollingCorrection } from "../../live-correction.js";
import { executeLiveSaveJob, liveSourceId, storeLiveNotes } from "../../live-job.js";
import { audioDashboard } from "../../audio-dashboard.js";
import { ownWork } from "../../runtime/work-ownership.js";



/** audio operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { startUpload, appendUpload, finishUpload, cancelUpload, claimUpload, releaseUpload } = ports.worker.uploads;
  const { activeSession, registered, unregister, register, listSaved } = ports.worker.sessions;
  const { state: storagePort, worker, fetch: providedFetch, audioSettings: providedAudioSettings, complete: providedComplete, WebSocket: providedWebSocket, light: providedLight, workOwner: providedWorkOwner, audioStore: providedAudioStore, call: providedCall, language: providedLanguage } = ports;
  const { jobs, retryable } = ports.work;
  const { activeJob } = ports.jobServices;
  const { startAudioJob, preparedAudioSettings, startBatch, startSingleAudio, liveTranslation, liveCorrector, liveSessionOf } = ports.audioServices;
const handlers = {
"audio.settings.get": async function () {
      return publicAudioSettings(await readAudioSettings());
    },
"audio.settings.set": async function (a) {
      const saved = await saveAudioSettings(a);
      return publicAudioSettings(saved);
    },
"audio.test": async function (a = {}) {
      const all = ["free", "siliconflow", "groq", "paid"];
      if (a.tier !== undefined && !all.includes(a.tier)) throw new Error("tier 只能是 free、siliconflow、groq 或 paid");
      const settings = await readAudioSettings(), tiers = new GeminiTiers({ fetch: providedFetch }), report = {};
      // A check proves the key and the network; it never sends audio.
      for (const tier of a.tier ? [a.tier] : all) {
        const key = settings[`${tier}Key`];
        report[tier] = key ? await tiers.check(key, tier).catch((error) => ({ ok: false, message: String(error.message).slice(0, 200) }))
          : { ok: false, configured: false, message: "未配置" };
      }
      return report;
    },
"audio.upload.start": async function (a) { return startUpload(storagePort.root, { name: a.name, size: a.size }); },
"audio.upload.chunk": async function (a) { return appendUpload(storagePort.root, { uploadId: a.uploadId, offset: a.offset, data: a.data }); },
"audio.upload.finish": async function (a) { return finishUpload(storagePort.root, a.uploadId); },
"audio.upload.cancel": async function (a) { return cancelUpload(storagePort.root, String(a.uploadId)); },
"audio.import": async function (a) {
      const legacy = a.recoveryJobId === undefined ? null : jobs.get(String(a.recoveryJobId));
      if (a.recoveryJobId !== undefined && (!legacy?.legacy || legacy.root !== storagePort.root))
        throw new Error('旧任务已不可恢复，请刷新任务列表');
      if (a.files !== undefined) {
        if (legacy) throw new Error('旧版单音频任务请选择同一份录音文件');
        for (const [field, limit] of [['title', 200], ['subject', 300], ['course', 200]])
          if (a[field] !== undefined && (typeof a[field] !== 'string' || a[field].length > limit)) throw new Error(`${field} 必须是不超过 ${limit} 字的字符串`);
        if (a.terms !== undefined && typeof a.terms !== 'string' && !Array.isArray(a.terms)) throw new Error('terms 必须是字符串或字符串数组');
        const args = audioContext(await storagePort.read(), a);
        await preparedAudioSettings(worker, args);
        const batch = await prepareAudioBatch(storagePort.root, args, worker.uploads);
        return startBatch(worker, batch);
      }
      if (a.uploadId !== undefined && a.path !== undefined) throw new Error("path 和 uploadId 只能给一个");
      const upload = a.uploadId === undefined ? null : claimUpload(storagePort.root, a.uploadId);
      try {
        const args = audioContext(await storagePort.read(), upload ? { ...a, path: upload.path } : a);
        if (typeof args.path !== "string" || !isAbsolute(args.path)) throw new Error("音频文件路径必须是绝对路径");
        if (!AUDIO_EXTENSIONS.includes(extname(args.path).toLowerCase()))
          throw new Error(`不支持的音频格式；支持 ${AUDIO_EXTENSIONS.join("、")}`);
        for (const [field, limit] of [["title", 200], ["subject", 300], ["course", 200]])
          if (a[field] !== undefined && (typeof a[field] !== "string" || a[field].length > limit))
            throw new Error(`${field} 必须是不超过 ${limit} 字的字符串`);
        if (a.terms !== undefined && typeof a.terms !== "string" && !Array.isArray(a.terms)) throw new Error("terms 必须是字符串或字符串数组");
        if (legacy && basename(args.path).toLowerCase() !== legacy.filename.toLowerCase())
          throw new Error('请选择原录音文件；文件名需与旧任务一致');
        const prepare = async () => {
          const settings = await providedAudioSettings();
          if (!hasTranscriptionKey(settings)) throw new Error(NO_TRANSCRIPTION_KEY);
          if (a.paidOnly === true && !settings.paidKey) throw new Error(NO_PAID_KEY);
          if (settings.textProvider === "host" && !providedComplete) throw new Error("当前没有可用的对话模型；请在设置里把文本处理改为 Gemini");
          return settings;
        };
        await prepare();
        // Reuse the existing one-file pipeline and checkpoints; persist only its submitted context and job card.
        const record = await prepareSingleAudioRecord(storagePort.root, args, upload);
        let started;
        try { started = await startSingleAudio(worker, record); }
        catch (error) { await removeAudioBatch(storagePort.root, record.id); throw error; }
        if (legacy) {
          jobs.delete(legacy.id);
          await storagePort.update(s => { s.inbox = (s.inbox || []).filter(item => !(item.kind === 'audio-failed' && item.jobId === legacy.id)); })
            .catch(() => {}); // The new resumable job is already running; do not invalidate its manifest.
        }
        return started;
      } catch (error) {
        // The import never started: keep the upload so the learner can fix the form and try again.
        if (upload) releaseUpload(upload);
        throw error;
      }
    },
"audio.retry": async function (a) {
      const old = jobs.get(String(a.jobId)), entry = retryable.get(String(a.jobId));
      if (!old || old.root !== storagePort.root || old.type !== "audio-import" || !entry) throw new Error("这个任务不能重试：它已经完成，或已被清除");
      if (activeJob(old)) throw new Error("任务还在进行，请等它结束");
      jobs.delete(old.id);
      retryable.delete(old.id);
      let started;
      try { started = old.singleId
        ? await startSingleAudio(worker, await readAudioBatch(storagePort.root, old.singleId), { retry: true })
        : old.batchId
        ? await startBatch(worker, await readAudioBatch(storagePort.root, old.batchId), { retry: true })
        : startAudioJob(worker, entry.filename, entry.work, { cleanup: entry.cleanup }); }
      catch (error) { jobs.set(old.id, old); retryable.set(old.id, entry); throw error; }
      // The letter about the failure is superseded by the retry; if that fails too, it brings its own.
      await storagePort.update((s) => { if (Array.isArray(s.inbox)) s.inbox = s.inbox.filter((m) => !(m.kind === 'audio-failed' && m.jobId === old.id)); });
      return started;
    },
"audio.subtitles.import": async function (a) {
      for (const [field, limit] of [["filename", 300], ["title", 200], ["subject", 300], ["course", 200]])
        if (a[field] !== undefined && (typeof a[field] !== "string" || a[field].length > limit)) throw new Error(`${field} 必须是不超过 ${limit} 字的字符串`);
      if (typeof a.filename !== "string" || !SUBTITLE_EXTENSIONS.includes(extname(a.filename).toLowerCase()))
        throw new Error(`不支持的字幕格式；支持 ${SUBTITLE_EXTENSIONS.join("、")}`);
      if (typeof a.text !== "string") throw new Error("text 必须是字幕文件的文字内容");
      if (a.terms !== undefined && typeof a.terms !== "string" && !Array.isArray(a.terms)) throw new Error("terms 必须是字符串或字符串数组");
      const input = prepareSubtitles({ text: a.text, filename: basename(a.filename) });
      const args = audioContext(await storagePort.read(), a);
      assertTextModel(await providedAudioSettings(), providedComplete);
      // Text only: no transcription slot to wait for, and the retained closure resumes from the proofread checkpoints.
      return startAudioJob(worker, input.filename, async (job, signal) => {
        const settings = await providedAudioSettings();
        assertTextModel(settings, providedComplete);
        await executeSubtitleJob({ job, input, args, settings, store: providedAudioStore, complete: providedComplete, fetch: providedFetch, signal });
      }, { fields: { subtitle: true }, orchestrates: true });
    },
"audio.corrections.review": async function (a) {
      const state = await storagePort.read(), target = reviewTarget(state, String(a.sourceId || ""));
      if (!target.pending) throw new Error("这份逐字稿没有待复核的存疑处");
      assertTextModel(await providedAudioSettings(), providedComplete);
      const vocabulary = buildVocabulary({ topics: courseTopics(state, target.course) });
      return startAudioJob(worker, `复核 · ${target.title}`, async (job, signal) => {
        const settings = await providedAudioSettings();
        assertTextModel(settings, providedComplete);
        const { model } = jobTextModel(job, settings, { complete: providedComplete, fetch: providedFetch });
        await executeReviewJob({ job, store: providedAudioStore, sourceId: target.ownerId, complete: model, vocabulary, signal });
      }, { fields: { review: { applied: 0, rejected: 0, unsure: 0 } }, orchestrates: true });
    },
"live.start": async function (a) {
      for (const [field, limit] of [["title", 200], ["subject", 300], ["course", 200], ["resumeId", 64]])
        if (a[field] !== undefined && (typeof a[field] !== "string" || a[field].length > limit)) throw new Error(`${field} 必须是不超过 ${limit} 字的字符串`);
      if (a.terms !== undefined && typeof a.terms !== "string" && !Array.isArray(a.terms)) throw new Error("terms 必须是字符串或字符串数组");
      const state = await storagePort.read();
      const settings = await providedAudioSettings();
      if (!settings.freeKey && !settings.paidKey) throw new Error(LIVE_NEEDS_GEMINI);
      if (a.paidOnly === true && !settings.paidKey) throw new Error("选择了只用付费密钥，但还没有配置付费密钥");
      if (typeof providedWebSocket !== "function") throw new Error("这个 Node 版本没有内置 WebSocket，实时转录需要 Node 22 或更新");
      const hostModel = providedLight || providedComplete;
      if (settings.textProvider === "host" && !hostModel) throw new Error("当前没有可用的对话模型；请在设置里把校对与翻译改为 Gemini");
      const root = storagePort.root;
      if (activeSession(root)) throw new Error("已经有一场实录在进行，请先结束它");
      const previous = a.resumeId ? registered(root, a.resumeId) : null;
      if (previous?.archivedAt) throw new Error('请先从归档中恢复这场课堂，再接着录');
      if (previous) await previous.retirePersistence();
      const saved = a.resumeId ? await readSaved(root, a.resumeId) : null;
      if (saved?.archivedAt) throw new Error('请先从归档中恢复这场课堂，再接着录');
      const course = saved ? saved.course ?? '' : resolveCourse(state, a, { preferred: currentCourse(state) });
      const subject = String(a.subject || saved?.subject || "").trim();
      const vocabulary = saved && a.terms === undefined
        ? saved.vocabulary || [] : buildVocabulary({ terms: termList(a.terms), topics: courseTopics(state, course) });
      const { tiers, translate } = liveTranslation(worker, settings, { subject, vocabulary, paidOnly: a.paidOnly === true });
      if (activeSession(root)) throw new Error("已经有一场实录在进行，请先结束它");
      const session = new LiveSession({
        id: saved?.id, title: String(a.title || "").trim() || saved?.title || liveDefaultTitle(new Date(), providedLanguage), tiers, WebSocketImpl: providedWebSocket,
        translate, correct: liveCorrector(worker, settings, { subject, vocabulary, paidOnly: a.paidOnly === true }), save: (data) => writeSaved(root, data),
        vocabulary, subject, course, languageCodes: settings.languageCodes, model: settings.liveModel, paidOnly: a.paidOnly === true, saved,
      });
      ownWork(session, providedWorkOwner);
      unregister(root, session.id);
      register(root, session);
      try { await session.start(); }
      catch (error) { unregister(root, session.id); throw new Error(String(error.message || error).slice(0, 300)); }
      return session.snapshot(0);
    },
"live.audio": async function (a) {
      const session = registered(storagePort.root, a.id);
      if (!session?.active) throw new Error("这场实录已经结束或不存在");
      if (typeof a.data !== "string" || a.data.length > 700000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new Error("音频数据无效");
      const bytes = Buffer.from(a.data, "base64");
      session.push(bytes.subarray(0, bytes.length - (bytes.length % 2)));
      return { status: session.status, revision: session.rev };
    },
"live.poll": async function (a) {
      return (await liveSessionOf(worker, a.id)).snapshot(Number.isInteger(a.since) && a.since >= 0 ? a.since : 0);
    },
"live.get": async function (a) { return (await liveSessionOf(worker, a.id)).snapshot(0); },
"live.pause": async function (a) { const s = await liveSessionOf(worker, a.id); s.pause(); return { status: s.status }; },
"live.resume": async function (a) { const s = await liveSessionOf(worker, a.id); s.resume(); return { status: s.status }; },
"live.retry": async function (a) {
      const s = await liveSessionOf(worker, a.id);
      if (!s.translate) {
        const { tiers, translate } = liveTranslation(worker, await providedAudioSettings(), { subject: s.subject, vocabulary: s.vocabulary });
        s.tiers = tiers; s.translate = translate;
      }
      s.retryFailed(); return { status: s.status };
    },
"live.stop": async function (a) {
      const session = await liveSessionOf(worker, a.id);
      await session.stop();
      void session.settled();
      return session.snapshot(Number.isInteger(a.since) && a.since >= 0 ? a.since : 0);
    },
"live.correct": async function (a) {
      const session = await liveSessionOf(worker, a.id);
      if (!session.correction.correct) {
        const settings = await providedAudioSettings();
        if (settings.textProvider === 'host' ? !(providedLight || providedComplete) : !settings.freeKey && !settings.paidKey) throw new Error('请先配置校正使用的模型');
        session.correction = new RollingCorrection(session, liveCorrector(worker, settings, { subject: session.subject, vocabulary: session.vocabulary, paidOnly: session.paidOnly }), { saved: session.correction.saved() });
      }
      void session.correction.run();
      return session.snapshot();
    },
"live.correct.background": async function (a) {
      const session = await liveSessionOf(worker, a.id);
      const settings = await providedAudioSettings();
      // Refresh host capabilities when the user reconnects a conversation model.
      const correct = liveCorrector(worker, settings, { subject: session.subject, vocabulary: session.vocabulary, paidOnly: session.paidOnly });
      if (session.correction.correct) session.correction.correct.background = correct.background;
      else session.correction = new RollingCorrection(session, correct, { saved: session.correction.saved() });
      void session.correction.retryBackground();
      return session.snapshot();
    },
"live.list": async function () { return { sessions: await listSaved(storagePort.root) }; },
"live.archive": async function (a) {
      if (typeof a.archived !== 'boolean') throw new Error('archived 必须为 true 或 false');
      const session = await liveSessionOf(worker, a.id);
      if (session.active) throw new Error('请先结束这场实录，再归档');
      session.archivedAt = a.archived ? session.archivedAt || new Date().toISOString() : null;
      await session.saveNow();
      if (session.storageError) throw new Error(session.storageError);
      return session.snapshot();
    },
"live.delete": async function (a) {
      const root = storagePort.root, session = registered(root, a.id);
      if (session?.active) throw new Error("这场实录还在进行，请先结束");
      if (session) await session.retirePersistence();
      if (registered(root, a.id) !== session || registered(root, a.id)?.active)
        throw new Error('这场实录状态已更新，请重新打开后再删除');
      unregister(root, String(a.id));
      await deleteSaved(root, a.id);
      return { deleted: a.id };
    },
"live.generate": async function (a) {
      const session = await liveSessionOf(worker, a.id);
      const wanted = a.segmentIds;
      if (!Array.isArray(wanted) || !wanted.length || wanted.length > 400 || wanted.some((n) => !Number.isInteger(n))) throw new Error("请先选中要出题的句子");
      const chosen = session.segments.filter((s) => wanted.includes(s.id) && s.en).sort((x, y) => x.id - y.id);
      if (chosen.length !== new Set(wanted).size) throw new Error("有选中的句子已经不存在，请重新选择");
      if (chosen.reduce((n, s) => n + s.en.length, 0) < 120) throw new Error("选中的内容太少，请多选几句再出题（至少约 120 个字符）");
      if (!providedComplete) throw new Error("当前没有可用的对话模型，无法出题；请先连接模型");
      const kind = a.kind ?? "mixed", difficulty = a.difficulty ?? "mixed", language = a.language ?? (providedLanguage === 'en' ? 'English' : '中文'), count = Number(a.count ?? 5);
      if (!["mixed", "quiz", "multi", "flashcard", "open", "cloze"].includes(kind)) throw new Error("不支持的题型");
      if (!["mixed", "foundation", "application", "advanced"].includes(difficulty)) throw new Error("不支持的难度");
      if (!["中文", "English", "中英双语"].includes(language)) throw new Error("不支持的题目语言");
      if (!Number.isInteger(count) || count < 1 || count > 15) throw new Error("课堂出题每次 1–15 道");
      if (a.focus !== undefined && (typeof a.focus !== "string" || a.focus.length > 300)) throw new Error("focus 必须是不超过 300 字的字符串");
      const text = liveExcerpt(session.title, chosen, { includeChinese: a.includeChinese !== false });
      const sourceId = `live-${session.id.slice(0, 8)}-${liveDigest(text)}`, range = `${liveClock(chosen[0].t)}–${liveClock(chosen.at(-1).t)}`;
      await providedAudioStore.publishSources([{ id: sourceId, title: `${session.title} · 片段 ${range}`, text, createdAt: new Date().toISOString(),
        courses: importCourses({ course: session.course }), live: { sessionId: session.id, segmentIds: chosen.map((x) => x.id) } }]);
      const job = await providedCall("generate", { sourceIds: [sourceId], count, kind, difficulty, language,
        course: a.course === undefined ? session.course : a.course,
        ...(a.focus ? { focus: a.focus } : {}), title: String(a.title || "").trim() || `${session.title} · ${range}`, ...(a.folder ? { folder: a.folder } : {}) });
      session.markGenerated(chosen.map((x) => x.id));
      return { sourceId, jobId: job.jobId, status: job.status, queuedBehind: job.queuedBehind, chars: text.length, segments: chosen.length };
    },
"live.save": async function (a) {
      const session = await liveSessionOf(worker, a.id);
      if (session.active) throw new Error("请先结束这场实录，再保存为资料");
      if (session.correction.snapshot().running || (session.correction.correct && session.correction.snapshot().pending)) throw new Error('上下文校正尚未覆盖全部句子，请等待或重试校正后保存');
      if (session.correction.snapshot().background.pending) throw new Error('历史歧义还在后台校正；完成后即可保存，课堂实录可以继续');
      const segments = session.segments.filter((s) => s.en);
      if (!segments.length) throw new Error("这场实录没有内容");
      if (a.proofread === true) {
        const prepare = async () => {
          const settings = await providedAudioSettings();
          if (settings.textProvider === "host" ? !providedComplete : !settings.freeKey && !settings.paidKey && !settings.groqKey)
            throw new Error(settings.textProvider === "host" ? "当前没有可用的对话模型" : "还没有配置 Gemini API 密钥（或 Groq 密钥）：请在「设置 › 音频转写」里填写");
          if (a.paidOnly === true && settings.textProvider !== "host" && !settings.paidKey) throw new Error("选择了只用付费密钥，但还没有配置付费密钥");
          return settings;
        };
        await prepare();
        return startAudioJob(worker, session.title, async (job, signal) =>
          executeLiveSaveJob({ job, session, args: a, settings: await prepare(), store: providedAudioStore, complete: providedComplete, fetch: providedFetch, signal }));
      }
      const pending = session.translate ? session.pendingSegments().length : 0;
      if (pending) throw new Error(`还有 ${pending} 句正在翻译，请稍等几秒再保存`);
      const documents = liveQuickDocuments(session.title, segments, providedLanguage), whole = documents.join("\n");
      const ids = documents.map((_, index) => liveSourceId(session, "quick", whole, index));
      await storeDocuments({
        store: providedAudioStore, ids, documents, title: session.title, courses: importCourses({ course: session.course }), corrections: { applied: [], skipped: [] }, language: providedLanguage,
        meta: { live: true, sessionId: session.id, filename: session.title, seconds: Math.round(session.elapsedMs / 1000), titleEn: "Live Class Transcript", partCount: documents.length, proofread: false },
      });
      const noteSourceId = await storeLiveNotes(providedAudioStore, session, providedLanguage);
      return { sourceIds: [...ids, ...(noteSourceId ? [noteSourceId] : [])], noteSourceId, proofread: false };
    },
"audio.usage": async function () { return audioDashboard(await readAudioSettings()); }
};
const mutations = {

};
  return { handlers, mutations };
}
