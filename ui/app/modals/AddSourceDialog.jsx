import React from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Dialog, InlineMessage } from '../../components/index.js';
import { hasContext } from '../../capabilities.js';
import { parseCourses } from '../../CourseField.jsx';
import ImportHub from '../../ImportHub.jsx';
import AudioImport from '../../AudioImport.jsx';
import { useApp } from '../app-context.js';

/** The add-material form while the host has the materials component off: why, and the way to switch it on when the host has one. */
function MaterialsOff({ host }) {
  return (
    <InlineMessage tone="info" boxed
      action={host?.openPluginManager ? { label: ui('打开 DSH 插件管理器'), onClick: () => host.openPluginManager() } : undefined}>
      {ui('请在 DSH 插件管理器中启用资料组件，再导入资料。')}
    </InlineMessage>
  );
}

/** The one add-material entry (ImportHub), for the 添加资料 dialog and the empty Sources page. */
export function SourceForm() {
  const { data, host, core, nav, lib, set, sources, learn, settingsEntry } = useApp();
  if (!hasContext(data, 'materials')) return <MaterialsOff host={host} />;
  const { refresh, notify } = core;
  /* Settings opened from the form with a PDF in hand: the dialog closes (Settings is a page), and the page it opens carries one notice that
     reopens the dialog with that PDF and its course, so setting a converter up does not cost the learner the file. */
  const openSettings = (section, resume) => {
    const file = resume?.file, course = resume?.courses;
    set.setModal(null);
    settingsEntry.openSettings(typeof section !== 'string' ? 'settings-extensions' : section === 'settings-marker' ? section : 'settings-mineru');
    if (file?.name) notify({ text: uiFormat('设置好之后回来继续解析「{0}」：文件还在。', [file.name]), persistent: true,
      action: { label: ui('继续解析'), run: () => set.setModal({ type: 'add', ...(course !== undefined ? { course } : {}), resumeConversion: file }) } });
  };
  return (
    <ImportHub key={data?.root} data={data} course={sources.formCourse} onCourseChange={sources.changeFormCourse} courseFrom={sources.courseFrom}
      pasteDraft={sources.paste} onPasteDraftChange={(draft) => sources.setPaste({ title: draft.title, text: draft.text })}
      resumeFile={lib.modal?.resumeConversion}
      onImported={() => refresh().catch(() => {})} onComplete={sources.finishImport}
      onOpenSettings={openSettings}
      onOpenSources={(ids) => { nav.navigate('sources'); learn.openAudioSources(ids); }}
      audio={hasContext(data, 'audio') ? <AudioImport data={data} defaultCourses={parseCourses(sources.formCourse)}
        canAsk={!!host.askInChat} openAgent={host.openAgent} onOpenSources={learn.openAudioSources} onStarted={sources.finishAudioStart}
        onOpenSettings={() => { set.setModal(null); nav.navigate('settings'); }} /> : undefined} />
  );
}

export default function AddSourceDialog({ onClose }) {
  // guardDrops: a file dropped on the dialog's header or margins is refused instead of reaching the browser or the host chat.
  return <Dialog title={ui('添加资料')} size="md" guardDrops onClose={onClose}><SourceForm /></Dialog>;
}
