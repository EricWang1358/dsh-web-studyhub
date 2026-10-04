import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { sourceMatchesCourse } from '../../lib/source-courses.js';
import { bigDocuments } from '../../lib/large-documents.js';
import { courseNamesOf } from '../PageScope.jsx';

/* 课程准备 (ui/SetupChecklist.jsx): each step reuses a page or dialog that already exists. Making the first questions opens
   创建题组 with the course filled in and the course's ordinary materials ticked (a long book is left for the chapter picker). */
export function createSetupHandlers({ data, nav, set, intents, drafts, settingsEntry }) {
  return {
    import: (course) => set.setModal({ type: 'add', course: course ?? '' }),
    sources: () => nav.navigate('sources'),
    index: () => settingsEntry.openSettings('settings-extensions'),
    generate: (course) => {
      const items = groupSourcesByDocument(data.sources.filter((source) => sourceMatchesCourse(source, course, courseNamesOf(data))));
      const long = new Set(bigDocuments(items).map((item) => item.key));
      intents.goGenerate({ sourceIds: items.filter((item) => !long.has(item.key)).flatMap((item) => item.sourceIds), genPatch: { course } });
    },
    draft: (id) => { const found = data.drafts.find((item) => item.id === id); if (found) drafts.openDraft(found, { navigation: true }); },
    course: settingsEntry.setCourseSettings,
    skeleton: () => nav.navigate('skeleton'),
  };
}
