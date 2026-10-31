/* The English interface: every ui/locales/en*.json fragment (one per work package, plan §4 C2) and the English table of the application's own
   messages (lib/application-messages-en.js). Chinese is the source language, so a Chinese interface needs none of this. ui/i18n.js imports this
   module normally, so Node and the tests have it at once; the DSH host build (scripts/build.mjs `englishOnDemand`) turns that import into an
   empty one and keeps this module in a chunk of its own, loaded when the interface is English (ui/i18n.js loadEnglishCatalogue).

   esbuild cannot glob, so a new fragment must be imported and listed here; tests/wp1-i18n-fragments fails when a file in ui/locales is missing
   from ENGLISH_SOURCES. */
import base from './locales/en.json';
import components from './locales/en.components.json';
import importCopy from './locales/en.import.json';
import generate from './locales/en.generate.json';
import generationFill from './locales/en.generation-fill.json';
import audio from './locales/en.audio.json';
import audioPipeline from './locales/en.audio-pipeline.json';
import practice from './locales/en.practice.json';
import agent from './locales/en.agent.json';
import host from './locales/en.host.json';
import shell from './locales/en.shell.json';
import onboarding from './locales/en.onboarding.json';
import guidance from './locales/en.guidance.json';
import guided from './locales/en.guided.json';
import copy from './locales/en.copy.json';
import caseCopy from './locales/en.case.json';
import course from './locales/en.course.json';
import stats from './locales/en.stats.json';
import flow from './locales/en.flow.json';
import skeletonCopy from './locales/en.skeleton.json';
import snappy from './locales/en.snappy.json';
import board from './locales/en.board.json';
import update from './locales/en.update.json';
import wrongbook from './locales/en.wrongbook.json';
import usage from './locales/en.usage.json';
import renameCopy from './locales/en.rename.json';
import peekCopy from './locales/en.peek.json';
import largedocs from './locales/en.largedocs.json';
import mineruCopy from './locales/en.mineru.json';
import reader from './locales/en.reader.json';
import wave4 from './locales/en.wave4.json';
import wave5a from './locales/en.wave5a.json';
import wave5b from './locales/en.wave5b.json';
import selectionCopy from './locales/en.selection.json';
import original from './locales/en.original.json';
import links from './locales/en.links.json';
import tiers from './locales/en.tiers.json';
import translationCopy from './locales/en.translation.json';
import jevCopy from './locales/en.jev.json';
import loop from './locales/en.loop.json';
import frequency from './locales/en.frequency.json';
import generationSettings from './locales/en.generation-settings.json';
import calculation from './locales/en.calculation.json';
import science from './locales/en.science.json';
import feedback from './locales/en.feedback.json';
import overlays from './locales/en.overlays.json';
import shared from './locales/en.shared.json';
import appShell from './locales/en.app.json';
import materials from './locales/en.materials.json';
import fields from './locales/en.fields.json';
import canvas from './locales/en.canvas.json';
import examCopy from './locales/en.exam.json';
import feedbackLoop from './locales/en.feedback-loop.json';
import pages from './locales/en.pages.json';
import markerInstall from './locales/en.marker-install.json';
import mineruInstall from './locales/en.mineru-install.json';
import layoutStability from './locales/en.layout-stability.json';
import taskConsole from './locales/en.task-console.json';
import coverageCopy from './locales/en.coverage.json';
import integration from './locales/en.integration.json';
import deckParts from './locales/en.deck-parts.json';
import examPrep from './locales/en.exam-prep.json';
import examPrepSettings from './locales/en.exam-prep-settings.json';
import modelSetup from './locales/en.model-setup.json';
import generateShort from './locales/en.generate-short.json';
import outlineCopy from './locales/en.outline.json';
import deleteCopy from './locales/en.delete.json';
import liveLocal from './locales/en.live-local.json';
import nextStepCopy from './locales/en.next-step.json';
import appMessages from '../lib/application-messages-en.js';

export const ENGLISH_SOURCES = {
  'en.json': base,
  'en.components.json': components,
  'en.import.json': importCopy,
  'en.generate.json': generate,
  'en.generation-fill.json': generationFill,
  'en.audio.json': audio,
  'en.audio-pipeline.json': audioPipeline,
  'en.practice.json': practice,
  'en.agent.json': agent,
  'en.host.json': host,
  'en.shell.json': shell,
  'en.onboarding.json': onboarding,
  'en.guidance.json': guidance,
  'en.guided.json': guided,
  'en.copy.json': copy,
  'en.case.json': caseCopy,
  'en.course.json': course,
  'en.stats.json': stats,
  'en.flow.json': flow,
  'en.skeleton.json': skeletonCopy,
  'en.snappy.json': snappy,
  'en.board.json': board,
  'en.update.json': update,
  'en.wrongbook.json': wrongbook,
  'en.usage.json': usage,
  'en.rename.json': renameCopy,
  'en.peek.json': peekCopy,
  'en.largedocs.json': largedocs,
  'en.mineru.json': mineruCopy,
  'en.reader.json': reader,
  'en.wave4.json': wave4,
  'en.wave5a.json': wave5a,
  'en.wave5b.json': wave5b,
  'en.selection.json': selectionCopy,
  'en.original.json': original,
  'en.links.json': links,
  'en.tiers.json': tiers,
  'en.translation.json': translationCopy,
  'en.jev.json': jevCopy,
  'en.loop.json': loop,
  'en.frequency.json': frequency,
  'en.generation-settings.json': generationSettings,
  'en.calculation.json': calculation,
  'en.science.json': science,
  'en.feedback.json': feedback,
  'en.overlays.json': overlays,
  'en.shared.json': shared,
  'en.app.json': appShell,
  'en.materials.json': materials,
  'en.fields.json': fields,
  'en.canvas.json': canvas,
  'en.exam.json': examCopy,
  'en.feedback-loop.json': feedbackLoop,
  'en.pages.json': pages,
  'en.marker-install.json': markerInstall,
  'en.mineru-install.json': mineruInstall,
  'en.layout-stability.json': layoutStability,
  'en.task-console.json': taskConsole,
  'en.coverage.json': coverageCopy,
  'en.integration.json': integration,
  'en.deck-parts.json': deckParts,
  'en.exam-prep.json': examPrep,
  'en.exam-prep-settings.json': examPrepSettings,
  'en.model-setup.json': modelSetup,
  'en.generate-short.json': generateShort,
  'en.outline.json': outlineCopy,
  'en.delete.json': deleteCopy,
  'en.live-local.json': liveLocal,
  'en.next-step.json': nextStepCopy,
};

/** The English of lib/application-messages.js (localizeAppMessage), handed to it once this module is here. */
export const APP_MESSAGES = appMessages;
