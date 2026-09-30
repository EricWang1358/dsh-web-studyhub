import { publicAudioSettings, readAudioSettings, saveAudioSettings } from "../../audio-settings.js";
import { GeminiTiers } from "../../gemini.js";
import { startUpload, appendUpload, finishUpload, cancelUpload, claimUpload, releaseUpload } from "../../audio-upload.js";
import { audioContext, courseTopics, storeDocuments } from "../../audio-job.js";
import { prepareAudioBatch, prepareSingleAudioRecord, removeAudioBatch, readAudioBatch } from "../../audio-batch.js";
import { isAbsolute, extname, basename } from "node:path";
import { AUDIO_EXTENSIONS } from "../../audio-file.js";
import { activeSession, registered, readSaved, LiveSession, writeSaved, unregister, register, listSaved, deleteSaved } from "../../live.js";
import { resolveCourse, importCourses } from "../../source-courses.js";
import { currentCourse } from "../../focus.js";
import { buildVocabulary, termList } from "../../transcript.js";
import { defaultTitle as liveDefaultTitle, excerptText as liveExcerpt, digest as liveDigest, clock as liveClock, quickDocuments as liveQuickDocuments } from "../../live-save.js";
import { RollingCorrection } from "../../live-correction.js";
import { executeLiveSaveJob, liveSourceId, storeLiveNotes } from "../../live-job.js";
import { audioDashboard } from "../../audio-dashboard.js";
import { ownWork } from '../../runtime/work-ownership.js';
import { jobs, preparedAudioSettings, startBatch, startSingleAudio, retryable, activeJob, startAudioJob, liveTranslation, liveCorrector, liveSessionOf } from "../../legacy-kernel.js";

export const handlers = {
"audio.settings.get": async function () {
      return publicAudioSettings(await readAudioSettings());
    },
"audio.settings.set": async function (a) {
      const saved = await saveAudioSettings(a);
      return publicAudioSettings(saved);
    },
"audio.test": async function () {
      const settings = await readAudioSettings(), tiers = new GeminiTiers({ fetch: this.fetch }), report = {};
      for (const tier of ["free", "groq", "paid"]) {
        const key = settings[`${tier}Key`];
        report[tier] = key ? await tiers.check(key, tier).catch((error) => ({ ok: false, message: String(error.message).slice(0, 200) }))
          : { ok: false, configured: false, message: "未配置" };
      }
      return report;
    },
"audio.upload.start": async function (a) { return startUpload(this.store.root, { name: a.name, size: a.size }); },
"audio.upload.chunk": async function (a) { return appendUpload(this.store.root, { uploadId: a.uploadId, offset: a.offset, data: a.data }); },
"audio.upload.finish": async function (a) { return finishUpload(this.store.root, a.uploadId); },
"audio.upload.cancel": async function (a) { return cancelUpload(this.store.root, String(a.uploadId)); },
"audio.import": async function (a) {
      const legacy = a.recoveryJobId === undefined ? null : jobs.get(String(a.recoveryJobId));
      if (a.recoveryJobId !== undefined && (!legacy?.legacy || legacy.root !== this.store.root))
        throw new Error('旧任务已不可恢复，请刷新任务列表');
      if (a.files !== undefined) {
        if (legacy) throw new Error('旧版单音频任务请选择同一份录音文件');
        for (const [field, limit] of [['title', 200], ['subject', 300], ['course', 200]])
          if (a[field] !== undefined && (typeof a[field] !== 'string' || a[field].length > limit)) throw new Error(`${field} 必须是不超过 ${limit} 字的字符串`);
        if (a.terms !== undefined && typeof a.terms !== 'string' && !Array.isArray(a.terms)) throw new Error('terms 必须是字符串或字符串数组');
        const args = audioContext(await this.store.read(), a);
        await preparedAudioSettings(this, args);
        const batch = await prepareAudioBatch(this.store.root, args);
        return startBatch(this, batch);
      }
      if (a.uploadId !== undefined && a.path !== undefined) throw new Error("path 和 uploadId 只能给一个");
      const upload = a.uploadId === undefined ? null : claimUpload(this.store.root, a.uploadId);
      try {
        const args = audioContext(await this.store.read(), upload ? { ...a, path: upload.path } : a);
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
          const settings = await this.audioSettings();
          if (!settings.freeKey && !settings.paidKey && !settings.groqKey)
            throw new Error("还没有配置 Gemini API 密钥（转写至少要有一把 Gemini 或 Groq 密钥）：请在「设置 › 音频转写」里填写（不要贴到对话里），或设置环境变量 GEMINI_FREE_API_KEY / GEMINI_PAID_API_KEY / GROQ_API_KEY");
          if (a.paidOnly === true && !settings.paidKey) throw new Error("选择了只用付费密钥，但还没有配置付费密钥");
          if (settings.textProvider === "host" && !this.complete) throw new Error("当前没有可用的对话模型；请在设置里把文本处理改为 Gemini");
          return settings;
        };
        await prepare();
        // Reuse the existing one-file pipeline and checkpoints; persist only its submitted context and job card.
        const record = await prepareSingleAudioRecord(this.store.root, args, upload);
        let started;
        try { started = await startSingleAudio(this, record); }
        catch (error) { await removeAudioBatch(this.store.root, record.id); throw error; }
        if (legacy) {
          jobs.delete(legacy.id);
          await this.store.update(s => { s.inbox = (s.inbox || []).filter(item => !(item.kind === 'audio-failed' && item.jobId === legacy.id)); })
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
      if (!old || old.root !== this.store.root || old.type !== "audio-import" || !entry) throw new Error("这个任务不能重试：它已经完成，或已被清除");
      if (activeJob(old)) throw new Error("任务还在进行，请等它结束");
      jobs.delete(old.id);
      retryable.delete(old.id);
      let started;
      try { started = old.singleId
        ? await startSingleAudio(this, await readAudioBatch(this.store.root, old.singleId), { retry: true })
        : old.batchId
        ? await startBatch(this, await readAudioBatch(this.store.root, old.batchId), { retry: true })
        : startAudioJob(this, entry.filename, entry.work, { cleanup: entry.cleanup }); }
      catch (error) { jobs.set(old.id, old); retryable.set(old.id, entry); throw error; }
      // The letter about the failure is superseded by the retry; if that fails too, it brings its own.
      await this.store.update((s) => { if (Array.isArray(s.inbox)) s.inbox = s.inbox.filter((m) => !(m.kind === 'audio-failed' && m.jobId === old.id)); });
      return started;
    },
"live.start": async function (a) {
      for (const [field, limit] of [["title", 200], ["subject", 300], ["course", 200], ["resumeId", 64]])
        if (a[field] !== undefined && (typeof a[field] !== "string" || a[field].length > limit)) throw new Error(`${field} 必须是不超过 ${limit} 字的字符串`);
      if (a.terms !== undefined && typeof a.terms !== "string" && !Array.isArray(a.terms)) throw new Error("terms 必须是字符串或字符串数组");
      const state = await this.store.read();
      const settings = await this.audioSettings();
      if (!settings.freeKey && !settings.paidKey)
        throw new Error("还没有配置 Gemini API 密钥：请在「设置 › 音频转写」里填写（不要贴到对话里）");
      if (a.paidOnly === true && !settings.paidKey) throw new Error("选择了只用付费密钥，但还没有配置付费密钥");
      if (typeof this.WebSocket !== "function") throw new Error("这个 Node 版本没有内置 WebSocket，实时转录需要 Node 22 或更新");
      const hostModel = this.light || this.complete;
      if (settings.textProvider === "host" && !hostModel) throw new Error("当前没有可用的对话模型；请在设置里把校对与翻译改为 Gemini");
      const root = this.store.root;
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
      const { tiers, translate } = liveTranslation(this, settings, { subject, vocabulary, paidOnly: a.paidOnly === true });
      if (activeSession(root)) throw new Error("已经有一场实录在进行，请先结束它");
      const session = new LiveSession({
        id: saved?.id, title: String(a.title || "").trim() || saved?.title || liveDefaultTitle(), tiers, WebSocketImpl: this.WebSocket,
        translate, correct: liveCorrector(this, settings, { subject, vocabulary, paidOnly: a.paidOnly === true }), save: (data) => writeSaved(root, data),
        vocabulary, subject, course, languageCodes: settings.languageCodes, model: settings.liveModel, paidOnly: a.paidOnly === true, saved,
      });
      ownWork(session, this.workOwner);
      unregister(root, session.id);
      register(root, session);
      try { await session.start(); }
      catch (error) { unregister(root, session.id); throw new Error(String(error.message || error).slice(0, 300)); }
      return session.snapshot(0);
    },
"live.audio": async function (a) {
      const session = registered(this.store.root, a.id);
      if (!session?.active) throw new Error("这场实录已经结束或不存在");
      if (typeof a.data !== "string" || a.data.length > 700000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new Error("音频数据无效");
      const bytes = Buffer.from(a.data, "base64");
      session.push(bytes.subarray(0, bytes.length - (bytes.length % 2)));
      return { status: session.status, revision: session.rev };
    },
"live.poll": async function (a) {
      return (await liveSessionOf(this, a.id)).snapshot(Number.isInteger(a.since) && a.since >= 0 ? a.since : 0);
    },
"live.get": async function (a) { return (await liveSessionOf(this, a.id)).snapshot(0); },
"live.pause": async function (a) { const s = await liveSessionOf(this, a.id); s.pause(); return { status: s.status }; },
"live.resume": async function (a) { const s = await liveSessionOf(this, a.id); s.resume(); return { status: s.status }; },
"live.retry": async function (a) {
      const s = await liveSessionOf(this, a.id);
      if (!s.translate) {
        const { tiers, translate } = liveTranslation(this, await this.audioSettings(), { subject: s.subject, vocabulary: s.vocabulary });
        s.tiers = tiers; s.translate = translate;
      }
      s.retryFailed(); return { status: s.status };
    },
"live.stop": async function (a) {
      const session = await liveSessionOf(this, a.id);
      await session.stop();
      void session.settled();
      return session.snapshot(Number.isInteger(a.since) && a.since >= 0 ? a.since : 0);
    },
"live.correct": async function (a) {
      const session = await liveSessionOf(this, a.id);
      if (!session.correction.correct) {
        const settings = await this.audioSettings();
        if (settings.textProvider === 'host' ? !(this.light || this.complete) : !settings.freeKey && !settings.paidKey) throw new Error('请先配置校正使用的模型');
        session.correction = new RollingCorrection(session, liveCorrector(this, settings, { subject: session.subject, vocabulary: session.vocabulary, paidOnly: session.paidOnly }), { saved: session.correction.saved() });
      }
      void session.correction.run();
      return session.snapshot();
    },
"live.correct.background": async function (a) {
      const session = await liveSessionOf(this, a.id);
      const settings = await this.audioSettings();
      // Refresh host capabilities when the user reconnects a conversation model.
      const correct = liveCorrector(this, settings, { subject: session.subject, vocabulary: session.vocabulary, paidOnly: session.paidOnly });
      if (session.correction.correct) session.correction.correct.background = correct.background;
      else session.correction = new RollingCorrection(session, correct, { saved: session.correction.saved() });
      void session.correction.retryBackground();
      return session.snapshot();
    },
"live.list": async function () { return { sessions: await listSaved(this.store.root) }; },
"live.archive": async function (a) {
      if (typeof a.archived !== 'boolean') throw new Error('archived 必须为 true 或 false');
      const session = await liveSessionOf(this, a.id);
      if (session.active) throw new Error('请先结束这场实录，再归档');
      session.archivedAt = a.archived ? session.archivedAt || new Date().toISOString() : null;
      await session.saveNow();
      if (session.storageError) throw new Error(session.storageError);
      return session.snapshot();
    },
"live.delete": async function (a) {
      const root = this.store.root, session = registered(root, a.id);
      if (session?.active) throw new Error("这场实录还在进行，请先结束");
      if (session) await session.retirePersistence();
      if (registered(root, a.id) !== session || registered(root, a.id)?.active)
        throw new Error('这场实录状态已更新，请重新打开后再删除');
      unregister(root, String(a.id));
      await deleteSaved(root, a.id);
      return { deleted: a.id };
    },
"live.generate": async function (a) {
      const session = await liveSessionOf(this, a.id);
      const wanted = a.segmentIds;
      if (!Array.isArray(wanted) || !wanted.length || wanted.length > 400 || wanted.some((n) => !Number.isInteger(n))) throw new Error("请先选中要出题的句子");
      const chosen = session.segments.filter((s) => wanted.includes(s.id) && s.en).sort((x, y) => x.id - y.id);
      if (chosen.length !== new Set(wanted).size) throw new Error("有选中的句子已经不存在，请重新选择");
      if (chosen.reduce((n, s) => n + s.en.length, 0) < 120) throw new Error("选中的内容太少，请多选几句再出题（至少约 120 个字符）");
      if (!this.complete) throw new Error("当前没有可用的对话模型，无法出题；请先连接模型");
      const kind = a.kind ?? "mixed", difficulty = a.difficulty ?? "mixed", language = a.language ?? "中文", count = Number(a.count ?? 5);
      if (!["mixed", "quiz", "multi", "flashcard", "open", "cloze"].includes(kind)) throw new Error("不支持的题型");
      if (!["mixed", "foundation", "application", "advanced"].includes(difficulty)) throw new Error("不支持的难度");
      if (!["中文", "English", "中英双语"].includes(language)) throw new Error("不支持的题目语言");
      if (!Number.isInteger(count) || count < 1 || count > 15) throw new Error("课堂出题每次 1–15 道");
      if (a.focus !== undefined && (typeof a.focus !== "string" || a.focus.length > 300)) throw new Error("focus 必须是不超过 300 字的字符串");
      const text = liveExcerpt(session.title, chosen, { includeChinese: a.includeChinese !== false });
      const sourceId = `live-${session.id.slice(0, 8)}-${liveDigest(text)}`, range = `${liveClock(chosen[0].t)}–${liveClock(chosen.at(-1).t)}`;
      await this.audioStore.publishSources([{ id: sourceId, title: `${session.title} · 片段 ${range}`, text, createdAt: new Date().toISOString(),
        courses: importCourses({ course: session.course }), live: { sessionId: session.id, segmentIds: chosen.map((x) => x.id) } }]);
      const job = await this.call("generate", { sourceIds: [sourceId], count, kind, difficulty, language,
        course: a.course === undefined ? session.course : a.course,
        ...(a.focus ? { focus: a.focus } : {}), title: String(a.title || "").trim() || `${session.title} · ${range}`, ...(a.folder ? { folder: a.folder } : {}) });
      session.markGenerated(chosen.map((x) => x.id));
      return { sourceId, jobId: job.jobId, status: job.status, queuedBehind: job.queuedBehind, chars: text.length, segments: chosen.length };
    },
"live.save": async function (a) {
      const session = await liveSessionOf(this, a.id);
      if (session.active) throw new Error("请先结束这场实录，再保存为资料");
      if (session.correction.snapshot().running || (session.correction.correct && session.correction.snapshot().pending)) throw new Error('上下文校正尚未覆盖全部句子，请等待或重试校正后保存');
      if (session.correction.snapshot().background.pending) throw new Error('历史歧义还在后台校正；完成后即可保存，课堂实录可以继续');
      const segments = session.segments.filter((s) => s.en);
      if (!segments.length) throw new Error("这场实录没有内容");
      if (a.proofread === true) {
        const prepare = async () => {
          const settings = await this.audioSettings();
          if (settings.textProvider === "host" ? !this.complete : !settings.freeKey && !settings.paidKey && !settings.groqKey)
            throw new Error(settings.textProvider === "host" ? "当前没有可用的对话模型" : "还没有配置 Gemini API 密钥（或 Groq 密钥）：请在「设置 › 音频转写」里填写");
          if (a.paidOnly === true && settings.textProvider !== "host" && !settings.paidKey) throw new Error("选择了只用付费密钥，但还没有配置付费密钥");
          return settings;
        };
        await prepare();
        return startAudioJob(this, session.title, async (job, signal) =>
          executeLiveSaveJob({ job, session, args: a, settings: await prepare(), store: this.audioStore, complete: this.complete, fetch: this.fetch, signal }));
      }
      const pending = session.translate ? session.pendingSegments().length : 0;
      if (pending) throw new Error(`还有 ${pending} 句正在翻译，请稍等几秒再保存`);
      const documents = liveQuickDocuments(session.title, segments), whole = documents.join("\n");
      const ids = documents.map((_, index) => liveSourceId(session, "quick", whole, index));
      await storeDocuments({
        store: this.audioStore, ids, documents, title: session.title, courses: importCourses({ course: session.course }), corrections: { applied: [], skipped: [] },
        meta: { live: true, sessionId: session.id, filename: session.title, seconds: Math.round(session.elapsedMs / 1000), titleEn: "Live Class Transcript", partCount: documents.length, proofread: false },
      });
      const noteSourceId = await storeLiveNotes(this.audioStore, session);
      return { sourceIds: [...ids, ...(noteSourceId ? [noteSourceId] : [])], noteSourceId, proofread: false };
    },
"audio.usage": async function () { return audioDashboard(await readAudioSettings()); }
};
export const mutations = {

};
