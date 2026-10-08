import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_CATEGORIES, SETTINGS_GROUPS, categoriesFor, categoryForAnchor, initialCategory, settingsGroupState } from '../ui/settings-groups.js';

/* Settings is a list of categories on the left and ONE category on the right, instead of one long page of folded groups and sections of different shapes.
   The pure part: which categories exist for this library, where a deep link or the tour points, what starts selected and which ones need attention. */

const full = { audio: true, generation: true, system: true };

test('settings categories under the three group headings, each with a plain title', () => {
  assert.deepEqual(SETTINGS_GROUPS.map(group => group.id), ['common', 'once', 'advanced']);
  assert.deepEqual(SETTINGS_CATEGORIES.map(category => category.id),
    ['appearance', 'science', 'model', 'generation', 'daily-recap', 'practice', 'courses', 'exam-prep', 'audio', 'mineru', 'retrieval', 'profile', 'data', 'update', 'usage', 'experimental']);
  for (const category of SETTINGS_CATEGORIES) {
    assert.ok(SETTINGS_GROUPS.some(group => group.id === category.group), `${category.id} sits in a group`);
    assert.ok(category.title && /[㐀-鿿]/.test(category.title), `${category.id} has a Chinese title`);
  }
  assert.equal(new Set(SETTINGS_CATEGORIES.map(category => category.id)).size, SETTINGS_CATEGORIES.length);
});

test('a host without a component shows no category for it', () => {
  const ids = capabilities => categoriesFor(capabilities).map(category => category.id);
  assert.deepEqual(ids(full), SETTINGS_CATEGORIES.map(category => category.id));
  assert.ok(!ids({ generation: true, system: true }).includes('audio'));
  assert.ok(ids({ generation: true, system: true }).includes('mineru'), 'external Marker remains available without the audio component');
  assert.ok(!ids({ audio: true, system: true }).includes('retrieval'));
  assert.ok(!ids({ audio: true, system: true }).includes('generation'));
  assert.ok(!ids({ audio: true, system: true }).includes('exam-prep'), '备考补习 needs the generation component');
  assert.ok(!ids({ audio: true, generation: true }).includes('usage'));
  assert.ok(!ids({ audio: true, generation: true }).includes('experimental'));
  assert.deepEqual(ids({}).slice(0, 6), ['appearance', 'science', 'model', 'daily-recap', 'practice', 'courses'], 'the basics are always there');
});

test('every deep link and tour anchor lands on its category', () => {
  const expected = { 'settings-model': 'model', 'settings-generation': 'generation', 'settings-audio': 'audio', 'settings-mineru': 'mineru', 'settings-extensions': 'retrieval', 'settings-update': 'update', 'settings-usage': 'usage', 'settings-experimental': 'experimental', 'settings-jev': 'experimental' };
  for (const [anchor, id] of Object.entries(expected)) assert.equal(categoryForAnchor(anchor), id, anchor);
  assert.equal(categoryForAnchor('settings-generation-time'), 'generation', 'the 任务 page links to the field of the time limit (ui/tasks/time-limit.js LIMIT_ANCHOR)');
  assert.equal(categoryForAnchor('settings-nowhere'), null);
  assert.equal(categoryForAnchor('settings-science'), 'science');
  assert.equal(categoryForAnchor('settings-daily-recap'), 'daily-recap');
  assert.equal(categoryForAnchor('settings-practice'), 'practice', 'the result page, the toolbar and the 错题 page link here');
  assert.equal(categoryForAnchor('settings-marker'), 'mineru');
  assert.equal(categoryForAnchor('settings-exam-prep'), 'exam-prep', '备考补习 page links here');
  assert.equal(categoryForAnchor(''), null);
});

test('the tour finish selects the profile category that owns the sample controls', () => {
  assert.equal(categoryForAnchor('settings-sample'), 'profile');
  assert.equal(initialCategory({ available: categoriesFor(full), focusSection: 'settings-sample', last: 'retrieval' }), 'profile');
});

test('what starts selected: the deep link, else the first category that needs attention, else the one the learner used last, else the first', () => {
  const available = categoriesFor(full);
  assert.equal(initialCategory({ available, focusSection: 'settings-mineru', missing: ['model'], last: 'update' }), 'mineru');
  assert.equal(initialCategory({ available, missing: ['audio', 'model'], last: 'update' }), 'model', 'the first in the list that is missing');
  assert.equal(initialCategory({ available, missing: [], last: 'update' }), 'update');
  assert.equal(initialCategory({ available, missing: [], last: 'gone' }), 'appearance');
  assert.equal(initialCategory({ available: categoriesFor({}), missing: ['audio'], last: 'audio' }), 'appearance', 'a category the host does not have cannot be selected');
});

test('what needs attention is still read from the library (the group state keeps working and names the categories)', () => {
  const state = settingsGroupState({ data: { modelReady: false, sources: [], jobs: [] }, status: {} });
  assert.deepEqual(state.common.missing, ['model']);
});
