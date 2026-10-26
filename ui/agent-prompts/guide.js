import { getUiLanguage } from '../i18n.js';
import { say } from './say.js';

/* 'guide.start': the message behind the home screen's 「不知道从哪开始」 link (ui/study-map/DeskIntro.jsx). It is the main chat's front door: the learner
   asks for their bearings, and the entry's skill (skills/study-guide/SKILL.md) says how to answer — read library.context once, say what they have and what
   they can do in plain words, then offer two or three ways to start. Nothing is generated here, so the sentence asks for a reading, not for content. */

const ASK = '我刚打开 StudyHub，还不太清楚自己现在有什么、能做什么。先看一眼我的学习库，用几句话告诉我现在的情况，再给我两三个可以马上开始的方向。';

/** input: none. */
export function guideStartPrompt(input = {}, language = getUiLanguage()) {
  return { ask: say(language, ASK) };
}
