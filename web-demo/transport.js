import { StudyService } from '../lib/service.js';
import { boardAction } from '../lib/board.js';
import { normalizeAssistRequest } from '../lib/assist.js';
import { courseIdFor, courseIndex, courseKey } from '../lib/courses.js';
import { applyFirstPassCredit } from '../lib/companion/companion-lesson.js';
import { demoModel } from './model.js';
import { sampleCards, stripDemoCardFields } from './content.js';
import { getSampleCompanionBundle, sampleCompanionTitle } from './sample-companions.js';
import { getUiLanguage } from '../ui/i18n.js';
import { summarizeAudioUsage } from '../lib/audio-dashboard.js';
import { AUDIO_DEFAULTS, publicAudioSettings } from '../lib/audio-settings.js';

const service = new StudyService('/demo', { complete: demoModel, coach: true });
const jobs = [];
const assist = [];
const companionStateMemory = new Map();
const COMPANION_STATE_PREFIX = 'daily-flashcard-demo-companion-state:';

const activeLang = args => {
  const explicit = args?.uiLanguage || args?.language;
  if (explicit === 'zh' || explicit === 'en') return explicit;
  return getUiLanguage() === 'zh' ? 'zh' : 'en';
};

const message = (lang = getUiLanguage()) => lang === 'en'
  ? 'This feature needs the installed plugin. Use the built-in sample material in this static demo.'
  : '此功能需要安装插件，静态体验版请使用内置示例资料。';

const companionBuildMessage = lang => lang === 'en'
  ? 'Custom AI companion generation requires the installed StudyHub plugin. To explore full interactive HTML companions right now in this browser demo, open "Course outline" and launch the 3 preloaded Mathematics/Physics, Philosophy/CS & Design Patterns companions!'
  : '自定义 AI 生成交互伴学课需要安装本地 StudyHub 插件。想在当前网页体验版立即试玩完整的交互 HTML 伴学舞台，请打开左侧「总纲」直接体验预置的「数理与控制」「哲学与计算机」与「设计模式与架构」三节跨学科样课！';

const companionAttachMessage = lang => lang === 'en'
  ? 'Attaching local HTML files or folders requires the installed StudyHub plugin. Open "Course outline" in this browser demo to play through the 3 preloaded cross-discipline Interactive Companions right away, or install StudyHub locally to mount your own labs!'
  : '挂载本地 HTML 文件或目录需要安装本地 StudyHub 插件。在当前网页体验版中，请打开左侧「总纲」直接体验预置的三节跨学科交互伴学样课，或安装本地插件挂载自己的伴学包！';

function readDemoCompanionState(companionId) {
  try {
    const raw = globalThis.localStorage?.getItem?.(COMPANION_STATE_PREFIX + companionId);
    if (raw) return JSON.parse(raw);
  } catch { /* fallback to memory */ }
  return structuredClone(companionStateMemory.get(companionId) || { memory: {}, checkResults: {}, doubts: [] });
}

function writeDemoCompanionState(companionId, patch = {}) {
  const prev = readDemoCompanionState(companionId);
  const next = {
    memory: patch.memory !== undefined ? patch.memory : (prev.memory || {}),
    checkResults: patch.checkResults ? { ...(prev.checkResults || {}), ...patch.checkResults } : (prev.checkResults || {}),
    doubts: Array.isArray(patch.doubts) ? patch.doubts.slice(-200) : (prev.doubts || []),
    updatedAt: new Date().toISOString(),
  };
  companionStateMemory.set(companionId, structuredClone(next));
  try {
    globalThis.localStorage?.setItem?.(COMPANION_STATE_PREFIX + companionId, JSON.stringify(next));
  } catch { /* keep in memory */ }
  return next;
}

function removeDemoCompanionState(companionId) {
  companionStateMemory.delete(companionId);
  try {
    globalThis.localStorage?.removeItem?.(COMPANION_STATE_PREFIX + companionId);
  } catch { /* ignore */ }
}

function locateDemoCompanion(state, { id, course }, lang = 'en') {
  const courses = Array.isArray(state?.courses) ? state.courses : [];
  if (course) {
    const target = courseIndex(state).resolve(course);
    const stored = target ? courses.find(c => c.id === target.id) : null;
    const hit = (stored?.companions || []).find(item => item.id === id);
    if (hit) return { course: stored, record: hit };
  }
  for (const c of courses) {
    const hit = (c.companions || []).find(item => item.id === id);
    if (hit) return { course: c, record: hit };
  }
  throw new Error(lang === 'en' ? 'Interactive companion not found.' : '找不到这个交互伴学页');
}

function localizeCompanionTitle(item, lang) {
  if (!item || typeof item !== 'object') return item;
  const localized = sampleCompanionTitle(item.id, lang);
  return localized ? { ...item, title: localized } : item;
}

function findCompanionRefInDecks(decks, deckId, cardId) {
  if (!cardId || !Array.isArray(decks)) return null;
  if (deckId) {
    const deck = decks.find(d => d?.id === deckId);
    const hit = deck?.cards?.find(c => c?.id === cardId);
    if (hit?.companionRef) return hit.companionRef;
  }
  for (const deck of decks) {
    const hit = deck?.cards?.find(c => c?.id === cardId);
    if (hit?.companionRef) return hit.companionRef;
  }
  return null;
}

function enrichRunCompanionRef(proj, decks) {
  if (!proj || typeof proj !== 'object') return;
  if (proj.solution && !proj.solution.companionRef && proj.card?.id) {
    const ref = findCompanionRefInDecks(decks, proj.deckId, proj.card.id);
    if (ref) proj.solution = { ...proj.solution, companionRef: ref };
  }
}

export async function call(action, args = {}) {
  const lang = activeLang(args);

  if (['audio.usage', 'audio.settings.get', 'audio.settings.set'].includes(action)) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('daily-flashcard-demo-audio-settings') || '{}'); } catch { /* defaults */ }
    if (action === 'audio.settings.set') {
      for (const field of ['proofreadReasoning', 'translateReasoning', 'dailyLimits']) if (args[field] !== undefined) saved[field] = args[field];
      localStorage.setItem('daily-flashcard-demo-audio-settings', JSON.stringify(saved));
    }
    const settings = { ...AUDIO_DEFAULTS, ...saved };
    return action === 'audio.usage' ? summarizeAudioUsage([], settings) : publicAudioSettings(settings);
  }
  if (action.startsWith('audio.') || action.startsWith('live.')) throw new Error(message(lang));
  if (action === 'binding.get') return { root: '/demo', rootSource: 'workspace', workspaceRoot: '/demo', provider: 'demo', model: 'preset', modelSource: 'session', route: { provider: 'demo', model: 'preset' } };
  if (action === 'binding.set') throw new Error(message(lang));
  if (action.startsWith('board.')) return boardAction(action, args, '/demo');
  if (action === 'notebook.list') return { notebooks: [], current: null };
  if (action === 'notebook.search') return { items: [], total: 0 };
  if (action.startsWith('notebook.') || action === 'source.import' || action === 'legacy.import' || action === 'restore' || action.startsWith('blog.lookup') || action === 'card.translate' || action === 'focus.images.stage') {
    throw new Error(message(lang));
  }

  // Interactive Companions showcase in static web demo
  if (action === 'generation.companion.build' || action === 'companion.build') {
    if (args.estimate === true) {
      return {
        status: 'estimate',
        estimate: { calls: 4, inputTokens: 5800, outputTokens: 8600 },
        steps: 4,
        grounded: Boolean(args.sourceIds?.length),
        scopeHash: `demo-companion-${args.archetype || 'auto'}`,
      };
    }
    throw new Error(companionBuildMessage(lang));
  }
  if (['companion.attach', 'companion.compile', 'companion.scan', 'companion.sync', 'companion.feedback.sync', 'companion.roots.set'].includes(action)) {
    throw new Error(companionAttachMessage(lang));
  }
  if (action === 'companion.roots.get') return { roots: [] };

  if (action === 'companion.list') {
    const res = await service.call('companion.list', args);
    return {
      ...res,
      companions: (res.companions || []).map(item => localizeCompanionTitle(item, lang)),
    };
  }

  if (action === 'companion.get') {
    const state = await service.store.read();
    const { course, record } = locateDemoCompanion(state, args, lang);
    const bundle = getSampleCompanionBundle(record.id, lang);
    if (!bundle) throw new Error(lang === 'en' ? 'Sample companion asset is unavailable.' : '示例交互伴学内容不可用。');
    const savedState = readDemoCompanionState(record.id);
    const courseId = course.id || courseIdFor(course.name);
    const index = courseIndex(state);
    const relatedCards = (state.decks || [])
      .filter(d => !d.archived && !d.systemKind && (d.courseId === courseId || courseKey(d.course ?? d.folder) === courseKey(course.name) || index.resolve(d.course ?? d.folder)?.id === courseId))
      .flatMap(d => (d.cards || []).map(card => ({
        deckId: d.id,
        deckTitle: d.title,
        cardId: card.id,
        topic: card.topic,
        prompt: String(card.prompt || '').slice(0, 180),
        answer: String(card.answer || '').slice(0, 320),
      })))
      .slice(0, 120);

    return {
      companion: {
        ...record,
        title: bundle.title,
        bytes: bundle.bytes,
        sha256: bundle.sha256,
        course: course.name,
        courseId: course.id,
      },
      html: bundle.html,
      file: `/demo/companions/${bundle.slug}.html`,
      changedOnDisk: false,
      lesson: {
        id: bundle.lesson.id,
        title: bundle.lesson.title,
        lead: bundle.lesson.lead,
        language: bundle.lesson.language,
        template: bundle.lesson.template || 'interactive',
        slideCount: bundle.lesson.slides.length,
        needs: bundle.lesson.needs || [],
        after: bundle.lesson.after || [],
        terms: bundle.lesson.terms || {},
      },
      savedState,
      relatedCards,
    };
  }

  if (action === 'companion.progress') {
    const stateView = await service.store.read();
    const { record: existing } = locateDemoCompanion(stateView, args, lang);
    const saved = writeDemoCompanionState(existing.id, {
      ...(args.memory && typeof args.memory === 'object' ? { memory: args.memory } : {}),
      ...(args.checkResults && typeof args.checkResults === 'object' ? { checkResults: args.checkResults } : {}),
    });
    const slide = Math.max(1, Math.floor(Number(args.slide) || 1));
    const slideTotal = Math.max(slide, Math.floor(Number(args.slideTotal) || existing.slideCount || 1));
    const completed = Boolean(args.completed || existing.progress?.completed);
    const newlyCompleted = Boolean(args.completed) && !existing.progress?.completed;

    return service.store.update(state => {
      const { record } = locateDemoCompanion(state, { id: existing.id, course: args.course }, lang);
      record.progress = {
        slide,
        slideTotal,
        completed,
        updatedAt: new Date().toISOString(),
      };
      const credited = newlyCompleted
        ? applyFirstPassCredit(state, { companionId: record.id, checkResults: saved.checkResults || {} })
        : 0;
      return { progress: record.progress, firstPassCredited: credited };
    });
  }

  if (action === 'companion.ask') {
    const question = String(args.question || '').trim();
    if (!question) throw new Error(lang === 'en' ? 'Enter your question first.' : '请先输入你的疑问。');
    const bundle = getSampleCompanionBundle(args.id || args.companionId, lang);
    if (!bundle?.tutorPreset) throw new Error(companionBuildMessage(lang));
    return structuredClone(bundle.tutorPreset);
  }

  if (action === 'companion.catchup.save') {
    return service.call('companion.catchup.save', { ...args, syncFeedback: false, language: lang });
  }

  if (action === 'companion.catchup.remove') {
    return service.call('companion.catchup.remove', args);
  }

  if (action === 'companion.remove') {
    let removedId = null;
    await service.store.update(state => {
      const { course, record } = locateDemoCompanion(state, args, lang);
      removedId = record.id;
      const removedSourceId = record.sourceId || `src-companion-${record.id}`;
      course.companions = (course.companions || []).filter(item => item.id !== record.id);
      for (const collection of [state.decks, state.drafts]) {
        for (const deck of collection || []) {
          if (deck?.companionId === record.id) delete deck.companionId;
          for (const card of deck?.cards || []) {
            if (card.companionRef?.companionId === record.id) delete card.companionRef;
          }
        }
      }
      const stillReferenced = (state.courses || []).some(c =>
        (c.companions || []).some(item => (item.sourceId || `src-companion-${item.id}`) === removedSourceId));
      if (!stillReferenced) {
        const projected = (state.sources || []).find(s => s.id === removedSourceId);
        if (projected) projected.archived = true;
      }
    });
    if (removedId) removeDemoCompanionState(removedId);
    return { removed: removedId };
  }

  if (action === 'assist.start') {
    const request = normalizeAssistRequest(args.mode, String(args.text || ''), args.helpChoices);
    if (args.mode !== 'ask') throw new Error(message(lang));
    const { card } = await service.call('card.get', args);
    if (!sampleCards.some(c => c.prompt === card.prompt)) throw new Error(message(lang));
    const en = lang === 'en';
    const question = en ? 'Preset explanation · ' + (request.question || request.choices.join(', ')) : '预置讲解 · ' + (request.question || request.choices.join('、'));
    const answer = (en ? 'This is a prerecorded reference, not an AI response to your request.\n\n' : '以下是预置参考，不是针对你的请求生成的 AI 回答。\n\n') + card.explanation;
    const task = { id: crypto.randomUUID(), mode: 'ask', deckId: args.deckId, cardId: args.cardId, prompt: card.prompt, label: en ? 'Preset help' : '预置帮助', status: 'done', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    await service.call('card.followup.add', { deckId: args.deckId, cardId: args.cardId, question, answer, source: 'assistant' });
    assist.push(task);
    return task;
  }

  if (action === 'generate') {
    if (args.language && args.language !== 'English') {
      throw new Error(lang === 'en'
        ? 'This demo has English preset questions only. Select English; the installed plugin supports other content languages.'
        : '体验版只提供英文预置题，请选择 English；插件本体支持其他出题语言。');
    }
    if (args.sourceIds?.some(id => id !== 'patterns-notes')) throw new Error(message(lang));
    const stamp = Date.now(), id = `demo-generated-${stamp}`;
    const kind = args.kind || 'mixed';
    const eligible = sampleCards.filter(c => kind === 'mixed' || kind === c.kind);
    if (!eligible.length) {
      throw new Error(lang === 'en'
        ? 'The preset generation supports single choice, flashcards and mixed decks.'
        : '预置出题支持单选、闪卡和混合题组。');
    }
    const deck = await service.call('draft.save', {
      deck: {
        id,
        title: lang === 'en' ? 'Preset generation · sample deck' : '预置出题 · 示例题组',
        folder: 'Design patterns',
        cards: eligible.slice(0, Math.min(7, Number(args.count) || 7)).map(c => ({ ...stripDemoCardFields(c), id: `demo-${stamp}-${c.id}` })),
      },
    });
    const job = { id: `demo-job-${stamp}`, status: 'completed', draftId: id, title: deck.title, requested: Number(args.count) || 7, generated: deck.cards.length, stage: 'complete', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    jobs.push(job);
    return { jobId: job.id, status: 'completed', draftId: id };
  }

  const result = await service.call(action, args);
  if (action === 'snapshot' && !result.unchanged) {
    result.jobs = [...(result.jobs || []), ...jobs];
    result.assist = [...assist];
    if (Array.isArray(result.courses)) {
      result.courses = result.courses.map(c => Array.isArray(c?.companions)
        ? { ...c, companions: c.companions.map(item => localizeCompanionTitle(item, lang)) }
        : c);
    }
    if (result.run?.solution) {
      const state = await service.store.read();
      enrichRunCompanionRef(result.run, state.decks);
    }
  } else if (action.startsWith('review.') && (result?.solution || Array.isArray(result?.rows))) {
    const state = await service.store.read();
    enrichRunCompanionRef(result, state.decks);
    if (Array.isArray(result.rows)) {
      for (const row of result.rows) {
        if (row?.solution && !row.solution.companionRef && row.cardId) {
          const ref = findCompanionRefInDecks(state.decks, row.deckId, row.cardId);
          if (ref) row.solution = { ...row.solution, companionRef: ref };
        }
      }
    }
  }
  return result;
}
