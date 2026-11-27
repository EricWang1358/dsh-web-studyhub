import React, { useEffect } from 'react';
import { ui, uiFormat } from '../i18n.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { useStudy } from '../study-context.jsx';
import RemoveDeckDialog from '../RemoveDeckDialog.jsx';
import CourseSettings from '../CourseSettings.jsx';
import FocusIntakeDialog from '../FocusIntakeDialog.jsx';
import VoicePackDialog from '../VoicePackDialog.jsx';
import { RemoveSampleDialog } from '../tour/SampleControls.jsx';
import AddSourceDialog from './modals/AddSourceDialog.jsx';
import FlagDialog from './modals/FlagDialog.jsx';
import SourceListDialog from './modals/SourceListDialog.jsx';
import SourceReaderDialog from './modals/SourceReaderDialog.jsx';
import CompanionViewer from '../companions/CompanionViewer.jsx';
import { useCompanionInlinePractice } from './modals/CompanionInlineRun.jsx';
import CompanionBuildDialog from '../companions/CompanionBuildDialog.jsx';
import { practiceArgs } from '../learning-navigation.js';
import { appendFocus } from '../generate-form.js';
import { useApp } from './app-context.js';

function CompanionModal({ modal, onClose }) {
  const inlinePractice = useCompanionInlinePractice();
  return <CompanionViewer key={modal.id || modal.companionId || 'companion'} modal={modal} onClose={onClose} inlinePractice={inlinePractice} />;
}

/* The question before a start (intents.confirmStart, ui/app/use-intents.js). No question count: review.start pulls unlearned prerequisites into the
   round, which the snapshot does not tell, so a row's number is not always what its round holds. A dialog left over from another library is closed. */
const START_TITLES = {
  deck: (name) => uiFormat('开始练「{0}」？', [name]),
  topic: (name) => uiFormat('开始练主题「{0}」？', [name]),
  today: () => ui('开始今日学习？'),
};
function StartConfirm({ modal, onClose, root }) {
  const { busy } = useStudy();
  const stale = modal.root !== root;
  useEffect(() => { if (stale) onClose(); }, [stale, onClose]);
  if (stale) return null;
  // The start is not awaited: the dialog closes at once and the round opens as it does from any start button. While another write runs the start would be dropped, so it waits.
  return <ConfirmDialog className="confirm-start" tone="primary" title={START_TITLES[modal.ask.kind](modal.ask.name)} confirmLabel={ui('开始练习')} blocked={busy}
    onConfirm={() => { modal.start(); }} onClose={onClose}>
    {modal.ask.kind === 'today' ? <p>{ui('现在没有没做完的练习。')}</p> : null}
  </ConfirmDialog>;
}

/* The app's dialogs, each in its own file. `modal` (library state) says which one is open; any other value is the reader. */
const DIALOGS = {
  confirmStart: ({ modal, onClose, app }) => <StartConfirm modal={modal} onClose={onClose} root={app.data?.root} />,
  add: ({ onClose }) => <AddSourceDialog onClose={onClose} />,
  sources: ({ modal, onClose, app }) => <SourceListDialog modal={modal} run={app.session.run} data={app.data} onClose={onClose}
    onOpenSource={(source) => app.set.setModal({ type: 'source', source, ...(modal.pickPages ? { pickPages: true } : {}), ...(modal.back ? { back: true } : {}) })} />,
  flag: ({ onClose, app }) => <FlagDialog run={app.session.run} onClose={onClose} onUpdated={(nextFlag) => app.session.patchRun?.((prev) => (prev?.card?.id === app.session.run?.card?.id ? { ...prev, card: { ...prev.card, flag: nextFlag || undefined } } : prev))} />,
  source: ({ modal, onClose }) => <SourceReaderDialog modal={modal} onClose={onClose} />,
  companion: ({ modal, onClose }) => <CompanionModal modal={modal} onClose={onClose} />,
  companionBuild: ({ modal, onClose }) => <CompanionBuildDialog key={modal.course || 'companionBuild'} modal={modal} onClose={onClose} />,
  voicePack: ({ modal, onClose }) => <VoicePackDialog key={modal.deckId || modal.course || 'voicePack'} modal={modal} onClose={onClose} />,
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

/** Is the reader the open dialog? (ui/app/app-context.js, where the practice page reads it too.) */
export { readerOpen } from './app-context.js';

/** ModalRouter: the one open dialog of the library state. */
export function ModalRouter() {
  const app = useApp();
  const modal = app.lib.modal;
  if (!modal) return null;
  const render = DIALOGS[modal.type] || DIALOGS.source;
  return render({ modal, app, onClose: () => app.set.setModal(null) });
}

const AppModalHost = React.memo(function AppModalHost() {
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
});

export default AppModalHost;
