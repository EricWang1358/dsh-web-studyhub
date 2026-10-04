import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// WP-S2 (#91 #88 #135): the files this package migrated hand no notice setter down, draw no .warning element and carry no legacy button class.
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('migrated files use useToast instead of notice props', () => {
  const files = ['ui/AudioSettings.jsx', 'ui/CourseSettings.jsx', 'ui/DailyRecapSettings.jsx', 'ui/ExtensionsSettings.jsx', 'ui/GenerationPath.jsx',
    'ui/GenerationSettings.jsx', 'ui/JevSettings.jsx', 'ui/MineruSettings.jsx', 'ui/UsageSettings.jsx', 'ui/UpdateCenter.jsx', 'ui/JsonImport.jsx',
    'ui/settings/CoachSection.jsx', 'ui/settings/ScheduleSection.jsx', 'ui/settings/LegacyImportSection.jsx', 'ui/settings/UpdatePane.jsx', 'ui/settings/DataPane.jsx',
    'ui/document-preview/DocumentLearning.jsx', 'ui/document-preview/DocumentViewer.jsx', 'ui/document-preview/translation/useBilingual.jsx'];
  for (const file of files) assert.doesNotMatch(read(file), /\b(setNotice|notify|onNotice)\b\s*[=,}?(]/, `${file} still takes or passes a notice setter`);
});

test('migrated files draw no .warning element', () => {
  for (const file of ['ui/document-preview/DocumentLearning.jsx', 'ui/document-preview/OriginalFile.jsx', 'ui/document-preview/reader/SegmentDialog.jsx',
    'ui/document-preview/links/PassageLinksPanel.jsx', 'ui/ReferenceQuestions.jsx'])
    assert.doesNotMatch(read(file), /className="[^"]*\b(warning|is-warning|original-notice)\b/, `${file} still draws a .warning element`);
});

test('migrated surfaces carry no legacy button class', () => {
  for (const file of ['ui/ExplanationFollowup.jsx', 'ui/SkeletonSpine.jsx', 'ui/SkeletonCanvas.jsx', 'ui/PageScope.jsx', 'ui/Ingest.jsx', 'ui/JsonImport.jsx',
    'ui/CourseRoute.jsx', 'ui/CourseActive.jsx', 'ui/ArchivedDeckRow.jsx', 'ui/document-preview/DocumentLearning.jsx', 'ui/document-preview/practice/ReadingReturn.jsx', 'ui/charts/DashboardCharts.jsx'])
    assert.doesNotMatch(read(file), /className="[^"]*(?<![\w-])(primary|link-btn|ghost-btn|pill|danger-text|wf-danger)(?![\w-])/, `${file} has a legacy button class`);
});

test('the translate failure message comes from the model setup gate table', () => {
  assert.doesNotMatch(read('ui/document-preview/translation/useBilingual.jsx'), /当前没有可用模型/);
  assert.match(read('ui/ModelSetupGate.jsx'), /export const gateMessage/);
});
