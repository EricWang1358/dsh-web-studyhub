import React from 'react';
import { ui } from '../i18n.js';
import RemoveDeckDialog from '../RemoveDeckDialog.jsx';
import CourseSettings from '../CourseSettings.jsx';
import FocusIntakeDialog from '../FocusIntakeDialog.jsx';
import { RemoveSampleDialog } from '../tour/SampleControls.jsx';
import AddSourceDialog from './modals/AddSourceDialog.jsx';
import FlagDialog from './modals/FlagDialog.jsx';
import SourceListDialog from './modals/SourceListDialog.jsx';
import SourceReaderDialog from './modals/SourceReaderDialog.jsx';
import { practiceArgs } from '../learning-navigation.js';
import { appendFocus } from '../generate-form.js';
import { useApp } from './app-context.js';

/* The app's dialogs, each in its own file. `modal` (library state) says which one is open; any other value is the reader. */
const DIALOGS = {
  add: ({ onClose }) => <AddSourceDialog onClose={onClose} />,
  sources: ({ modal, onClose, app }) => <SourceListDialog modal={modal} run={app.session.run} data={app.data} onClose={onClose}
    onOpenSource={(source) => app.set.setModal({ type: 'source', source })} />,
  flag: ({ onClose, app }) => <FlagDialog run={app.session.run} onClose={onClose} />,
  source: ({ modal, onClose }) => <SourceReaderDialog modal={modal} onClose={onClose} />,
  focusIntake: ({ modal, onClose, app }) => (
    <FocusIntakeDialog
      data={app.data}
      initialCourse={modal.course ?? app.data?.focus?.course ?? ''}
      initialTab={modal.tab || 'image'}
      initialGenerateAfter={!!modal.generateAfter}
      onClose={onClose}
      onStartFocusPractice={(course) => {
        onClose();
        app.intents.startReview(practiceArgs(undefined, { ...(course ? { course } : {}), focusOnly: true, fresh: true }));
      }}
      onGenerateCourse={(course) => app.intents.goGenerate({ genPatch: course ? { course } : undefined, closeModal: true })}
      onOpenPdfImport={(pdfFile, course) => app.set.setModal({ type: 'add', ...(course ? { course } : {}), resumeConversion: pdfFile })}
    />
  ),
};

/** Is the reader (a material full-size) the open dialog? The daily plan listens while it is. */
export const readerOpen = (modal) => modal?.type === 'source';

/** ModalRouter: the one open dialog of the library state. */
export function ModalRouter() {
  const app = useApp();
  const modal = app.lib.modal;
  if (!modal) return null;
  const render = DIALOGS[modal.type] || DIALOGS.source;
  return render({ modal, app, onClose: () => app.set.setModal(null) });
}

export default function AppModalHost() {
  const app = useApp();
  const { data, core, nav, lib, set, tour, settingsEntry, intents } = app;
  const { courseSettings, setCourseSettings } = settingsEntry;
  const openCourseId = courseSettings?.id || courseSettings;
  const openCourse = openCourseId ? (data?.courses || []).find((item) => item.id === openCourseId) : null;
  const removing = lib.removingDeck?.root === data?.root ? data?.decks.find((deck) => deck.id === lib.removingDeck?.id) : null;
  return (
    <>
      {courseSettings && (
        <CourseSettings key={courseSettings.id ? `${courseSettings.id}:${courseSettings.mergeFrom.join(',')}` : courseSettings} data={data}
          courseId={openCourseId} mergeFrom={courseSettings.mergeFrom}
          onClose={() => setCourseSettings(null)}
          onGenerateTopic={openCourse && intents?.goGenerate ? (topic) => {
            setCourseSettings(null);
            intents.goGenerate({ genPatch: (cur) => ({ ...cur, course: openCourse.name, focus: appendFocus(cur.focus, topic) }), remember: true });
          } : undefined} />
      )}
      {tour.removingSample && <RemoveSampleDialog busy={tour.sampleBusy} onConfirm={tour.removeSampleData} onClose={() => tour.setRemovingSample(false)} />}
      {removing && (
        <RemoveDeckDialog key={`${data.root}:${removing.id}`} deck={removing} onClose={() => {
          // Opened from an archive notice (its button is gone): the focus goes back to the control the caller names, not to the page.
          const back = lib.removingDeck?.returnFocus;
          set.setRemovingDeck(null);
          if (back) setTimeout(() => document.querySelector(back)?.focus?.(), 30);
        }}
          onRemoved={(deck) => {
            set.setRemovingDeck(null);
            if (lib.managedDeck?.id === deck.id) set.setManagedDeck(null);
            if (nav.page === 'manage') nav.navigate('library');
            core.notify(ui('题组已永久删除，原始资料和作答记录已保留。'));
          }} />
      )}
      <ModalRouter />
    </>
  );
}
