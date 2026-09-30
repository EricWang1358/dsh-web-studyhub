import { workflowTeachingHandlers, teachingSession } from "../../workflow-teaching.js";
import { workflowGuideHandlers } from "../../workflow-guide.js";
import { workflowSkeletonHandlers } from "../../workflow-skeleton.js";
import { workflowList, workflowContext, saveWorkflow, deleteWorkflow, startSession, saveSessionRecord, saveSessionMaterial, restoreSessionMaterial, advanceSession, goToStep, setSessionStatus, deleteSession, editableSession, currentStep, sessionCards } from "../../workflows.js";
import { required, get, id } from "../../util.js";
import { parseJson } from "../../generation.js";
import { checkNoteRevision, noteView, publishNoteLink, createNote, saveNote } from "../../blog-notes.js";
import { blogGenerationInput, blogGenerationSystem, checkedBlogMarkdown } from "../../blog-generation.js";
import { notify, inboxView, markRead } from "../../inbox.js";
import { lookupCsdnArticle, csdnRecentIds, csdnHome } from "../../adapters/csdn-public.js";
import { getTeaching, startTeaching, answerTeaching } from "../../teaching.js";
import { courseRoute } from "../../course-route.js";
import { studyMap, studyStats, wrongBook, graphData } from "../../insights.js";
import { ensureLearner, writeFollowup, threadView, FEEDBACK_TAGS, trimLogs, REWRITE_TAGS, debriefRules, runMetrics, GOALS, LEVEL_NAMES } from "../../coach.js";
import { findCard, linkPrerequisite } from "../../prereq.js";
import { parseSparInput, captureQuestion, samePrompt } from "../../capture.js";
import { currentCourse, setFocus } from "../../focus.js";
import { resolveCourse, importCourses } from "../../source-courses.js";
import { initialReview, shuffled, validateDeck } from "../../domain.js";
import { learningState, learningScope } from "../../learning-scope.js";
import { skeletonTopics, topicGroupsView, lintScope, skeletonContext, skeletonSummary, saveSkeleton, patchSkeleton, saveTopicGroups } from "../../skeleton.js";
import { MAX_INGEST_CHARS, INGEST_KINDS, parseIngest } from "../../ingest.js";
import { noteJobs, coachTasks, coachInflight, inTurn, currentCard, cleanFolder, ingestView, recordingDestination, MISTAKES, projection, applyCardContent } from "../../legacy-kernel.js";

export const handlers = {
...workflowTeachingHandlers,
...workflowGuideHandlers,
...workflowSkeletonHandlers,
"workflow.list": async function () { return workflowList(await this.store.read(), this.language); },
"workflow.context": async function (a) { return workflowContext(await this.store.read(), a); },
"workflow.session.get": async function (a) {
      return teachingSession(this, a.id);
    },
"focus.suggest": async function (a) {
      const state = await this.store.read();
      const role = required(a.role || state.focus?.role, "岗位方向").slice(0, 200);
      const jd = typeof a.jd === "string" ? a.jd.slice(0, 20000) : state.focus?.jd || "";
      const topics = [...new Set(state.decks.flatMap((deck) => deck.cards.map((card) => card.topic)).filter(Boolean))].slice(0, 250);
      const model = this.light || this.complete;
      if (!model) return { role, jd, targetTopics: [], method: "rules" };
      try {
        const response = parseJson(await model("Given a target job and optional job description, choose up to 20 relevant knowledge topic names from the provided existing list. Return JSON {role:string,targetTopics:string[]}. Do not invent topic names or alter study cards.",
          JSON.stringify({ role, jd, availableTopics: topics })));
        const selected = Array.isArray(response.targetTopics) ? response.targetTopics
          .filter((topic) => topics.includes(topic)).slice(0, 20) : [];
        return { role: typeof response.role === "string" ? response.role.slice(0, 200) : role,
          jd, targetTopics: selected, method: "ai" };
      } catch { return { role, jd, targetTopics: [], method: "rules" }; }
    },
"note.generate": async function (a) {
      if (!this.complete) throw new Error("请先选择用于起草笔记的模型");
      const state = await this.store.read();
      const note = get(state.notes, a.id, "笔记");
      if (note.status !== "draft") throw new Error("已发布文章不能重新起草");
      checkNoteRevision(note, a.expectedRevision);
      const revision = note.revision || 0;
      const key = `${this.store.root}:${note.id}`;
      if (noteJobs.has(key) && note.generation?.status === 'running') return { id: note.id, status: "running" };
      const cards = blogGenerationInput(state, note);
      const jobId = id();
      await this.store.update((current) => {
        const latest = get(current.notes, note.id, "笔记");
        checkNoteRevision(latest, revision);
        latest.generation = { id: jobId, status: "running", startedAt: new Date().toISOString() };
      });
      const work = Promise.resolve().then(async () => {
        try {
          const raw = await this.complete(blogGenerationSystem,
            JSON.stringify({ articleTitle: note.title, cards }));
          const markdown = checkedBlogMarkdown(raw);
          await this.store.update((current) => {
            const latest = get(current.notes, note.id, "笔记");
            if (latest.status !== "draft" || latest.generation?.id !== jobId || (latest.revision || 0) !== revision) return;
            latest.markdown = markdown;
            latest.revision = revision + 1;
            latest.updatedAt = new Date().toISOString();
            latest.generation = { id: jobId, status: "done", finishedAt: latest.updatedAt };
            notify(current, { kind: "note", ...latest.cards[0], noteId: note.id,
              detail: `笔记草稿「${note.title}」已生成，请审阅后发布` });
          });
        } catch (error) {
          await this.store.update((current) => {
            const latest = get(current.notes, note.id, "笔记");
            if (latest.generation?.id === jobId && latest.generation.status === "running")
              latest.generation = { id: jobId, status: "failed", message: String(error.message).slice(0, 300) };
          });
        } finally { if (noteJobs.get(key) === work) noteJobs.delete(key); }
      });
      noteJobs.set(key, work);
      return { id: note.id, jobId, status: "running" };
    },
"note.list": async function () {
      const state = await this.store.read();
      return { home: state.csdnHome || "", notes: (state.notes || []).map(note => noteView(state, note)) };
    },
"note.get": async function (a) {
      const state = await this.store.read();
      return noteView(state, get(state.notes, a.id, "笔记"));
    },
"note.lookup": async function (a) {
      const state = await this.store.read();
      const note = get(state.notes, a.id, "笔记");
      checkNoteRevision(note, a.expectedRevision);
      if (!state.csdnHome) throw new Error("请先设置 CSDN 公开博客主页");
      const result = await lookupCsdnArticle(state.csdnHome, note.title);
      const candidate = result.matches[0];
      const articleId = candidate && Number(candidate.split("/").at(-1));
      if (result.matches.length === 1 && Number.isSafeInteger(note.publishBaselineMaxId) &&
          articleId > note.publishBaselineMaxId) {
        const linked = await this.store.update((current) => {
          const latest = get(current.notes, a.id, "笔记");
          if (latest.status !== "draft" || latest.publishBaselineMaxId !== note.publishBaselineMaxId || (latest.revision || 0) !== (note.revision || 0))
            return null;
          return publishNoteLink(current, { id: a.id, url: candidate });
        });
        if (linked) return { ...result, linked };
      }
      return { ...result, matched: false,
        reason: result.matches.length === 1 ? "找到同名文章，但无法确认它是在本次草稿之后发布的，请核对后关联" : result.reason };
    },
"note.preparePublish": async function (a) {
      const state = await this.store.read();
      const note = get(state.notes, a.id, "笔记");
      if (note.status !== "draft") throw new Error("这篇笔记已发布");
      if (!state.csdnHome) return { autoLookupReady: false,
        reason: "尚未设置 CSDN 公开主页，发布后可手动关联" };
      const ids = await csdnRecentIds(state.csdnHome);
      if (!ids.length) return { autoLookupReady: false,
        reason: "暂时无法确认公开主页的文章列表，发布后请手动核对链接" };
      await this.store.update((current) => {
        const latest = get(current.notes, a.id, "笔记");
        if (latest.status !== "draft") throw new Error("这篇笔记已发布");
        latest.publishBaselineMaxId = Math.max(...ids);
      });
      return { autoLookupReady: true };
    },
"teach.get": async function (a) {
      return getTeaching(await this.store.read(), a);
    },
"teach.start": async function (a) {
      return startTeaching(this.store, this.complete, a);
    },
"teach.answer": async function (a) {
      return answerTeaching(this.store, this.complete, a);
    },
"course.route": async function (a) {
      const state = await this.store.read();
      return courseRoute(state, { ...(a.course !== undefined ? { course: a.course } : {}), language: this.language }) || { course: null, chapters: [] };
    },
"map": async function (a) {
      return studyMap(await this.store.read());
    },
"stats": async function (a) {
      return studyStats(await this.store.read(), a);
    },
"wrongbook": async function (a) {
      return wrongBook(await this.store.read(), a);
    },
"graph": async function (a) {
      return graphData(await this.store.read(), a);
    },
"coach.status": async function () {
      return this.coachStatus(await this.store.read());
    },
"coach.profile": async function () {
      const s = await this.store.read(),
        { consent, goal, summary, signals, updatedAt } = ensureLearner(s);
      return { consent: consent.prep, goal, summary, signals, updatedAt, ready: s.prepared.filter((p) => p.status === "ready").length };
    },
"coach.nudge": async function (a) {
      if (!this.light) throw new Error("当前会话没有可用模型");
      return this.nudgeFor(a.runId, a.index);
    },
"coach.reply": async function (a) {
      const reply = a.reply;
      if (!["got", "confused", "check"].includes(reply)) throw new Error("Unknown reply");
      let followup = null;
      if (reply === "confused") {
        if (!this.light) throw new Error("当前会话没有可用模型");
        const s = await this.store.read(),
          learner = ensureLearner(s),
          note = get(s.coach, a.noteId, "陪学记录");
        // Two extra angles at most; after that the thread offers the chat instead.
        if ((note.followups || []).length < 2) {
          let card;
          try {
            card = findCard(s, note).card;
          } catch {
            card = s.runs.find((r) => r.id === note.runId)?.entries[note.entryIndex]?.card;
          }
          if (!card) throw new Error("这道题已经不在题库里");
          followup = await writeFollowup(this.light, { card, note, learner });
        }
      }
      return this.store.update((st) => {
        const learner = ensureLearner(st),
          note = get(st.coach, a.noteId, "陪学记录");
        if (reply === "got" && note.reply !== "got") {
          note.reply = "got";
          learner.signals.got++;
        } else if (reply === "confused") {
          note.reply = "confused";
          learner.signals.confused++;
          if (followup) {
            note.followups = [...(note.followups || []), { ...followup, at: new Date().toISOString() }];
            notify(st, { kind: "coach", deckId: note.deckId, cardId: note.cardId, detail: `换个角度再讲：${followup.explain}` });
          }
        } else if (reply === "check" && note.check && !note.checked) {
          const choice = Number(a.choice);
          if (!Number.isInteger(choice) || choice < 0 || choice >= note.check.options.length) throw new Error("Invalid choice");
          note.checked = { choice, correct: choice === note.check.answer };
          learner.signals[note.checked.correct ? "got" : "confused"]++;
        }
        return { thread: threadView(st, note.cardId) };
      });
    },
"coach.feedback": async function (a) {
      const vote = a.vote;
      if (!["up", "down"].includes(vote)) throw new Error("vote must be up or down");
      const tags = [...new Set(Array.isArray(a.tags) ? a.tags : [])].filter((t) => Object.hasOwn(FEEDBACK_TAGS, t));
      if (vote === "up" && tags.length) throw new Error("Tags describe a problem; use vote down");
      const result = await this.store.update((s) => {
        const learner = ensureLearner(s),
          { deck, card } = findCard(s, a),
          now = new Date().toISOString();
        // Taps within ten minutes on the same card refine one record.
        const recent = s.feedback.findLast((f) => f.cardId === card.id && Date.now() - Date.parse(f.at) < 600000);
        let added = tags;
        if (recent?.vote === vote) {
          added = tags.filter((t) => !recent.tags.includes(t));
          recent.tags.push(...added);
          recent.at = now;
        } else {
          s.feedback.push({ id: id(), deckId: deck.id, cardId: card.id, vote, tags, at: now });
          learner.signals[vote]++;
        }
        for (const t of added) if (t === "too-easy") learner.signals.easy++;
        else if (t === "too-hard") learner.signals.hard++;
        trimLogs(s);
        return { ref: { deckId: deck.id, cardId: card.id }, added, consent: learner.consent.prep };
      });
      const scheduled = [];
      if (this.coach && this.light) {
        const rewrite = result.added.filter((t) => REWRITE_TAGS.has(t));
        if (rewrite.length) {
          this.scheduleRewrite(result.ref, rewrite);
          scheduled.push("rewrite");
        }
        for (const reason of result.added.filter((t) => t === "too-easy" || t === "too-hard"))
          if (result.consent === true) {
            this.queuePrep({ ...result.ref, reason });
            scheduled.push("prep");
          }
      }
      return { vote, tags: result.added, scheduled, status: this.coachStatus(await this.store.read()) };
    },
"coach.consent": async function (a) {
      if (typeof a.prep !== "boolean") throw new Error("prep must be true or false");
      const recentWrong = await this.store.update((s) => {
        const learner = ensureLearner(s);
        learner.consent.prep = a.prep;
        learner.updatedAt = new Date().toISOString();
        const seen = new Set();
        return s.attempts.slice(-40).reverse().filter((x) => x.grade < 3 && !seen.has(x.quiz_id) && seen.add(x.quiz_id))
          .slice(0, 4).map((x) => ({ deckId: x.deckId, cardId: x.quiz_id, reason: "wrong" }));
      });
      // Opting in prepares variants of what was just missed, in one batch. From
      // a result page it also covers what that round's debrief would have
      // prepared had consent already been given (application variants).
      if (a.prep && this.coach) {
        if (a.runId) {
          const s = await this.store.read(),
            run = s.runs.find((r) => r.id === a.runId);
          if (run && run.mode !== "exam" &&
            debriefRules(runMetrics(s, run), { consent: true, modelReady: !!this.light }).wantsPrep)
            this.queueApplicationGaps(run, ensureLearner(s));
        }
        recentWrong.forEach((t) => this.queuePrep(t));
        this.flushPrep();
      }
      return this.coachStatus(await this.store.read());
    },
"coach.rewrite.retry": async function (a) {
      const { deck, card } = findCard(await this.store.read(), a);
      if (!this.coach || !this.light) throw new Error("当前会话没有可用模型");
      const root = this.store.root,
        last = (coachTasks.get(root) || []).findLast((task) => task.kind === "rewrite" && task.cardId === card.id);
      if (!last) throw new Error("这道题没有待重试的改题");
      if (last.status === "failed") this.scheduleRewrite({ deckId: deck.id, cardId: card.id }, last.tags);
      return this.coachStatus(await this.store.read());
    },
"coach.prepare": async function () {
      await this.flushPrep();
      return this.coachStatus(await this.store.read());
    },
"coach.debrief": async function (a) {
      // The panel prefetches on the last answer and asks again on the summary;
      // concurrent requests for the same state share one model call.
      const key = `${this.store.root}:debrief:${a.runId}`;
      if (!coachInflight.has(key))
        coachInflight.set(key, this.debrief(a).finally(() => coachInflight.delete(key)));
      return coachInflight.get(key);
    },
"capture": async function (a) {
      if (!this.complete)
        throw new Error("A model is required to file questions");
      const parsed =
        a.question !== undefined
          ? { question: String(a.question).trim(), kind: a.kind || "flashcard" }
          : parseSparInput(a.input);
      if (parsed.question.length < 2 || parsed.question.length > 2000)
        throw new Error("Question must be 2–2000 characters");
      if (!["flashcard", "quiz", "multi", "open"].includes(parsed.kind))
        throw new Error("Unknown question kind");
      // Start the scope read at receipt but reserve FIFO order before awaiting it.
      const submission = this.store.read();
      const startedAt = Date.now();
      return inTurn(this.store.root, async () => {
        const timings = { queueMs: Date.now() - startedAt, modelCalls: [] };
        const submitted = await submission;
        const requestedDeckId = typeof a.deckId === 'string' ? a.deckId : undefined;
        const requestedDeck = requestedDeckId && submitted.decks.find(deck => deck.id === requestedDeckId && !deck.archived && !deck.systemKind);
        if (requestedDeckId && !requestedDeck) throw new Error('Requested capture deck does not exist or is archived');
        const dependent = a.requiredBy === 'current' || parsed.prerequisite ? currentCard(submitted)
          : a.requiredBy ? (({ deck, card }) => ({ deckId: deck.id, cardId: card.id }))(findCard(submitted, a.requiredBy)) : null;
        const originDeck = requestedDeck || (dependent && findCard(submitted, dependent).deck);
        const preferred = currentCourse(submitted);
        const course = resolveCourse(submitted, originDeck ? {} : a,
          { course: originDeck ? originDeck.course ?? originDeck.folder ?? '' : undefined,
            preferred: preferred ?? '' });
        const state = await this.store.read();
        const plan = await captureQuestion(async (system, prompt) => {
          const start = Date.now();
          try { return await this.complete(system, prompt); }
          finally { timings.modelCalls.push({ stage: system.startsWith("You file") ? "placement" : "author", elapsedMs: Date.now() - start, inputChars: system.length + prompt.length }); }
        }, state, {
          ...parsed,
          deckId: requestedDeckId,
          course,
          answer: typeof a.answer === "string" ? a.answer.slice(0, 8000) : "",
          related: dependent && { ...dependent, prompt: findCard(state, dependent).card.prompt },
          notes: typeof a.notes === "string" ? a.notes.slice(0, 4000) : "",
        });
        const link = (s, result) => {
          if (!dependent) return result;
          try {
            const linked = linkPrerequisite(s, dependent, result);
            if (!linked.existing)
              notify(s, { ...linked.dependent, kind: "link", detail: `新增前置题：${result.prompt}` });
            return {
              ...result,
              prerequisiteFor: { ...dependent, prompt: findCard(s, dependent).card.prompt },
              alreadyLinked: !!linked.existing,
            };
          } catch (e) {
            return { ...result, linkError: e.message };
          }
        };
        const result = await this.store.update((s) => link(s, (() => {
          const at = (deck, card) => ({
            deckId: deck.id,
            deckTitle: deck.title,
            folder: deck.folder || "",
            course: deck.course ?? deck.folder ?? '',
            topic: card.topic,
            cardId: card.id,
            prompt: card.prompt,
            kind: card.kind,
          });
          if (plan.duplicate) {
            const deck = get(s.decks, plan.duplicate.deckId, "Deck");
            return {
              status: "duplicate",
              ...at(deck, get(deck.cards, plan.duplicate.cardId, "Question")),
            };
          }
          let deck = plan.deckId && get(s.decks, plan.deckId, 'Deck');
          if (deck && (deck.archived || deck.systemKind)) throw new Error('Requested capture deck does not exist or is archived');
          const created = !deck;
          if (!deck) {
            deck = {
              id: id(),
              title: plan.newDeck?.title || "随手问",
              folder: cleanFolder(plan.newDeck?.folder),
              course,
              cards: [],
            };
            s.decks.push(deck);
          }
          const same = deck.cards.find((c) => samePrompt(c.prompt, plan.card.prompt));
          if (same) return { status: "duplicate", ...at(deck, same) };
          if (plan.note) s.sources.push({ createdAt: new Date().toISOString(), ...plan.note, courses: importCourses({ course }) });
          const card = {
            ...plan.card,
            review: initialReview(s.settings),
            capturedAt: new Date().toISOString(),
          };
          deck.cards.push(card);
          // Keep an open editing draft in step so publishing it cannot drop the new card.
          const editing = s.drafts.find((d) => d.editingDeckId === deck.id);
          if (editing) {
            editing.cards.push(structuredClone(card));
            editing.draftVersion = (editing.draftVersion || 0) + 1;
          }
          return {
            status: "added",
            ...at(deck, card),
            answer: card.answer,
            grounded: !plan.note,
            newDeck: created,
          };
        })()));
        return { ...result, performance: { ...timings, totalMs: Date.now() - startedAt } };
      });
    },
"skeleton.topics": async function (a) {
      const s = learningState(await this.store.read(), a),
        samples = Math.max(0, Math.min(3, Number(a.samples) || 0));
      const topics = skeletonTopics(s, { samples });
      const groups = topicGroupsView(s, topics);
      // A large library is read a page at a time (optionally only the topics not
      // yet in a group), so each result stays small enough to use directly
      // instead of spilling to a file the conversation then has to parse.
      const paged = a.ungrouped !== undefined || a.offset !== undefined || a.limit !== undefined;
      const waiting = new Set(groups.ungrouped);
      const pool = a.ungrouped ? topics.filter((t) => waiting.has(t.key)) : topics;
      const offset = Math.max(0, Math.floor(Number(a.offset) || 0));
      const limit = a.limit === undefined ? pool.length : Math.max(1, Math.min(500, Math.floor(Number(a.limit) || 1)));
      const page = pool.slice(offset, offset + limit);
      // compact: what the conversation needs to group topics, without deck lists.
      const list = a.compact
        ? page.map(({ key, topic, count, decks, samples: examples }) => ({ key, topic, count, decks: decks.map((d) => d.deckTitle), ...(examples ? { samples: examples } : {}) }))
        : page;
      if (!paged) return { topics: list, groups };
      return { topics: list, total: pool.length, ...(offset + limit < pool.length ? { nextOffset: offset + limit } : {}),
        groups: { groups: groups.groups.map(({ id, title, description, count }) => ({ id, title, description, count })),
          ungroupedCount: groups.ungrouped.length } };
    },
"skeleton.lint": async function (a) {
      return lintScope(await this.store.read(), a.scope);
    },
"skeleton.context": async function (a) {
      return skeletonContext(await this.store.read(), a.scope);
    },
"skeleton.list": async function (a) {
      const state = await this.store.read(), selection = learningScope(state, a);
      const matches = ref => state.decks.find(deck => deck.id === ref.deckId)?.cards.some(card =>
        (!ref.cardId || card.id === ref.cardId) && (!ref.topic || (card.topic || '未分类') === ref.topic) && selection.matches(ref.deckId, card));
      return { skeletons: (state.skeletons || []).filter(skeleton => selection.all || skeleton.scope.some(matches)).map(skeletonSummary).reverse() };
    },
"skeleton.get": async function (a) {
      return get((await this.store.read()).skeletons || [], a.id, "Skeleton");
    },
"inbox": async function () {
      return inboxView(await this.store.read());
    },
"ingest.status": async function (a) {
      // Tool results must be JSON objects; the snapshot keeps `ingest: null`.
      return ingestView(await this.store.read()) || { active: false };
    },
"ingest": async function (a) {
      if (!this.complete) throw new Error("A model is required to record questions");
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (text.length < 8) throw new Error("Paste at least one question");
      if (text.length > MAX_INGEST_CHARS)
        throw new Error(`Pasted text is ${text.length} characters; send at most ${MAX_INGEST_CHARS} per batch`);
      // Queue admission must not race the asynchronous submission snapshot.
      const submission = this.store.read();
      return inTurn(this.store.root, async () => {
        const submitted = await submission;
        const mode = submitted.ingest?.active ? structuredClone(submitted.ingest) : {};
        const destination = recordingDestination(submitted, a, mode);
        const kind = a.kind ?? mode.kind ?? "auto", mistakes = a.mistakes ?? mode.mistakes ?? "auto";
        if (!INGEST_KINDS.includes(kind)) throw new Error("Unknown question kind");
        if (!MISTAKES.includes(mistakes)) throw new Error("mistakes must be auto, all or none");
        const state = await this.store.read();
        const resolved = recordingDestination(state, destination);
        const target = resolved.deckId ? get(state.decks, resolved.deckId, 'Deck') : null;
        const { deckTitle, folder, course } = destination;
        const source = {
          id: id(),
          title: String(a.title || `对话录入 · ${deckTitle} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`).slice(0, 200),
          text,
          origin: "conversation",
          courses: importCourses({ course }),
          createdAt: new Date().toISOString(),
        };
        const parsed = await parseIngest(this.complete, {
          text,
          kind,
          mistakes,
          source,
          existing: target ? target.cards.map((c) => c.objective) : [],
        });
        return this.store.update((s) => {
          let deck = target && get(s.decks, target.id, 'Deck');
          if (deck && (deck.archived || deck.systemKind)) throw new Error('请选择未归档的普通题组');
          const created = !deck;
          const report = { added: [], duplicates: [], skipped: [], ignored: parsed.ignored };
          const fresh = [];
          for (const r of parsed.results) {
            const label = String(r.card.prompt || "").slice(0, 80);
            if (r.errors.length) {
              report.skipped.push({ prompt: label, reason: r.errors.join("; ") });
              continue;
            }
            const twin = (deck ? [deck] : [])
              .flatMap((d) => d.cards.map((c) => ({ d, c })))
              .find(({ c }) => samePrompt(c.prompt, r.card.prompt));
            if (twin || fresh.some((x) => samePrompt(x.card.prompt, r.card.prompt))) {
              report.duplicates.push({ prompt: label, deckTitle: twin?.d.title || deckTitle, topic: twin?.c.topic });
              continue;
            }
            fresh.push(r);
          }
          if (fresh.length) {
            if (!deck) {
              deck = { id: id(), title: deckTitle, folder, course, cards: [] };
              s.decks.push(deck);
            }
            s.sources.push(source);
            const timestamp = new Date().toISOString();
            for (const r of fresh) {
              const card = {
                ...r.card,
                review: initialReview(s.settings),
                capturedAt: timestamp,
                origin: "conversation",
                ...(r.inferred ? { flag: "答案由模型推断，待核对" } : {}),
              };
              deck.cards.push(card);
              if (r.wrong)
                s.attempts.push({
                  id: id(),
                  quiz_id: card.id,
                  deckId: deck.id,
                  topic: card.topic,
                  timestamp,
                  grade: 1,
                  imported: "mistake",
                });
              report.added.push({
                cardId: card.id,
                kind: card.kind,
                topic: card.topic,
                prompt: card.prompt.slice(0, 80),
                mistake: r.wrong,
                answerInferred: r.inferred,
              });
            }
            const editing = s.drafts.find((d) => d.editingDeckId === deck.id);
            if (editing) {
              editing.cards.push(...fresh.map((r) => structuredClone(deck.cards.find((c) => c.id === r.card.id))));
              editing.draftVersion = (editing.draftVersion || 0) + 1;
            }
            if (mode.active && s.ingest?.active && (mode.id ? s.ingest.id === mode.id : s.ingest.startedAt === mode.startedAt)) {
              s.ingest.added = (s.ingest.added || 0) + fresh.length;
              if (!s.ingest.deckId && !a.deckId && !a.deckTitle) s.ingest.deckId = deck.id;
            }
          }
          return {
            deckId: deck?.id || null,
            deckTitle,
            folder,
            course,
            newDeck: !!deck && created,
            sourceId: fresh.length ? source.id : null,
            ...report,
          };
        });
      });
    }
};
export const mutations = {
"workflow.save": saveWorkflow,
"workflow.delete": deleteWorkflow,
"workflow.session.start": startSession,
"workflow.session.record": saveSessionRecord,
"workflow.session.material": saveSessionMaterial,
"workflow.session.material.restore": restoreSessionMaterial,
"workflow.session.advance": advanceSession,
"workflow.session.goto": goToStep,
"workflow.session.status": setSessionStatus,
"workflow.session.delete": deleteSession,
"workflow.practice.start": (s, a) => {
      const session = editableSession(s, a), step = currentStep(session);
      if (step.kind !== "practice") throw new Error("当前不是练习步骤");
      const previous = session.records[step.id]?.runId;
      const earlier = previous && s.runs.find((r) => r.id === previous);
      // A finished or ended round is kept; "练一轮新的" starts another for the same step.
      if (earlier && !(a.fresh && (earlier.closedAt || earlier.entries.every((e) => e.feedback))))
        return { session, run: projection(s, earlier) };
      if (earlier) earlier.closedAt ||= new Date().toISOString();
      const cards = sessionCards(s, session).slice(0, step.count);
      if (!cards.length) throw new Error("本次学习范围没有可练习的题目，可以先补充资料或跳过本步");
      const run = { id: id(), mode: "path", workflowSessionId: session.id,
        deckId: new Set(cards.map((c) => c.deckId)).size === 1 ? cards[0].deckId : null,
        scope: session.scope, key: `workflow:${session.id}:${step.id}`, index: 0, startedAt: new Date().toISOString(),
        entries: cards.map(({ deckId, card }) => ({ deckId, card: structuredClone(card),
          order: card.options ? shuffled(card.options.map((o) => o.id)) : undefined,
          startedAt: Date.now(), feedback: null, revealed: false, selected: null })) };
      s.runs.push(run);
      session.records[step.id] = { ...session.records[step.id], runId: run.id };
      session.version++;
      session.updatedAt = new Date().toISOString();
      return { session, run: projection(s, run) };
    },
"note.home": (s, a) => {
      s.csdnHome = csdnHome(required(a.home, "CSDN 公开主页"));
      return { home: s.csdnHome };
    },
"note.create": (s, a) => createNote(s, a),
"note.save": (s, a) => saveNote(s, a),
"note.link": (s, a) => publishNoteLink(s, a),
"note.delete": (s, a) => {
      const note = get(s.notes, a.id, "笔记");
      s.notes.splice(s.notes.indexOf(note), 1);
      return { id: a.id };
    },
"focus.set": (s, a) => setFocus(s, a),
"coach.forget": (s) => {
      // Clears the profile and pending prepared cards; practice history stays.
      s.learner = null;
      const learner = ensureLearner(s);
      s.prepared = s.prepared.filter((p) => p.status !== "ready");
      return { consent: learner.consent.prep, goal: "", summary: "", signals: learner.signals, updatedAt: null, ready: 0 };
    },
"coach.goal": (s, a) => {
      const learner = ensureLearner(s);
      if (a.goal !== "" && !Object.hasOwn(GOALS, a.goal)) throw new Error("Unknown goal");
      learner.goal = a.goal;
      learner.updatedAt = new Date().toISOString();
      return { goal: learner.goal };
    },
"coach.practice": (s, _a, ports) => {
      ensureLearner(s);
      const ready = s.prepared.filter((p) => p.status === "ready");
      if (!ready.length) throw new Error("还没有备好的定制题");
      let deck = s.decks.find((d) => d.systemKind === "coach");
      if (!deck) {
        deck = { id: id(), title: "为你定制", systemKind: "coach", folder: "", cards: [], createdAt: new Date().toISOString() };
        s.decks.push(deck);
      }
      deck.archived = false;
      const added = [];
      for (const p of ready) {
        const card = { ...p.card, review: initialReview(s.settings), origin: { deckId: p.originDeckId, cardId: p.originCardId, reason: p.reason } };
        const cards = [...deck.cards, card];
        if (validateDeck({ title: deck.title, cards }, s.sources).errors.some((e) => e.startsWith(`Card ${cards.length}:`))) {
          p.status = "invalid";
          continue;
        }
        deck.cards.push(card);
        s.learner.levels[card.id] = LEVEL_NAMES[p.level] ? p.level : "apply";
        // A 太难 scaffold is exactly a prerequisite of the card it was written for.
        if (p.reason === "too-hard")
          try {
            linkPrerequisite(s, { deckId: p.originDeckId, cardId: p.originCardId }, { deckId: deck.id, cardId: card.id });
          } catch {
            // The original was removed or the link would cycle; the card still stands alone.
          }
        p.status = "used";
        added.push({ deckId: deck.id, cardId: card.id });
      }
      if (!added.length) throw new Error("备好的题没有通过校验，请稍后再试");
      return ports.mutate("review.start", s, { mode: "path", scope: added, fresh: true });
    },
"coach.revert": (s, a) => {
      const { card } = findCard(s, a);
      const last = card.revisions?.at(-1);
      if (!last) throw new Error("This question has no earlier version");
      const result = applyCardContent(s, a, last.content, null, { keepAnswered: true });
      for (const n of s.coach || []) if (n.cardId === card.id && n.revertable) n.revertable = false;
      return { ...result, reverted: last.reason };
    },
"ingest.start": (s, a) => {
      const kind = a.kind ?? "auto",
        mistakes = a.mistakes ?? "auto";
      if (!INGEST_KINDS.includes(kind)) throw new Error("Unknown question kind");
      if (!MISTAKES.includes(mistakes)) throw new Error("mistakes must be auto, all or none");
      if (!a.deckId && !String(a.deckTitle || '').trim()) throw new Error("Choose a deck or name a new one");
      const destination = recordingDestination(s, a);
      s.ingest = {
        id: id(),
        active: true,
        ...destination,
        kind,
        mistakes,
        added: 0,
        startedAt: new Date().toISOString(),
      };
      return ingestView(s);

    },
"ingest.stop": (s, a) => {
      const was = ingestView(s);
      if (s.ingest) s.ingest.active = false;
      return { stopped: !!was, added: was?.added || 0, deckTitle: was?.deckTitle || null };

    },
"skeleton.save": (s, a) => saveSkeleton(s, a.skeleton ?? a),
"skeleton.patch": (s, a) => patchSkeleton(s, a),
"topic.groups.save": (s, a) => saveTopicGroups(s, a),
"skeleton.delete": (s, a) => {
      get(s.skeletons || [], a.id, "Skeleton");
      s.skeletons = s.skeletons.filter((k) => k.id !== a.id);
      return { deleted: a.id };
    },
"inbox.read": (s, a) => {
      const changed = markRead(s, a);
      return { changed, ...inboxView(s) };
    },
"inbox.open": (s, a, ports) => {
      const item = get(s.inbox, a.id, "这条消息");
      markRead(s, { ids: [item.id] });
      if (item.kind.startsWith('audio-')) return { kind: 'audio', jobId: item.jobId,
        sourceIds: (item.sourceIds || []).filter(id => s.sources.some(source => source.id === id)) };
      if (item.kind === "note") {
        get(s.notes || [], item.noteId, "笔记草稿");
        return { kind: "note", noteId: item.noteId };
      }
      if (item.kind === "variant" && s.prepared.some((p) => p.status === "ready" && p.originCardId === item.cardId))
        return ports.mutate("coach.practice", s, {});
      let found;
      try {
        found = findCard(s, item);
      } catch {
        throw new Error("这道题已经不在题库里了");
      }
      const { deck, card } = found;
      const open = (r) => r && !r.workflowSessionId && !r.closedAt && r.mode !== "exam";
      const current = open(s.runs.find((r) => r.id === a.runId)) ? s.runs.find((r) => r.id === a.runId) : null;
      for (const run of [current, ...[...s.runs].reverse()].filter(open)) {
        const index = run.entries.findIndex((e) => e.card.id === card.id && (e.deckId ?? run.deckId) === deck.id);
        if (index >= 0) return ports.mutate("review.move", s, { runId: run.id, index });
      }
      return ports.mutate("review.start", s, {
        mode: "path",
        scope: [{ deckId: deck.id, cardId: card.id }],
        fresh: true,
        purpose: "inbox",
        ...(current ? { returnTo: current.id } : {}),
      });
    }
};
