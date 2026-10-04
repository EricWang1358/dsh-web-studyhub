import React from 'react';
import { ui } from '../../i18n.js';
import { Dialog } from '../../components/index.js';
import { hasContext } from '../../capabilities.js';
import { parseCourses } from '../../CourseField.jsx';
import ImportHub from '../../ImportHub.jsx';
import AudioImport from '../../AudioImport.jsx';
import { useApp } from '../app-context.js';

/** The one add-material entry (ImportHub), for the 添加资料 dialog and the empty Sources page. */
export function SourceForm() {
  const { data, host, core, nav, set, sources, learn, settingsEntry } = useApp();
  if (!hasContext(data, 'materials')) return <p role="status">{ui('请在 DSH 插件管理器中启用资料组件，再导入资料。')}</p>;
  const { call, act, busy, askInChat, refresh } = core;
  return (
    <ImportHub key={data?.root} data={data} call={call} busy={busy} course={sources.formCourse} onCourseChange={sources.changeFormCourse}
      pasteDraft={sources.paste} onPasteDraftChange={(draft) => sources.setPaste({ title: draft.title, text: draft.text })}
      onImported={() => refresh().catch(() => {})} onComplete={sources.finishImport}
      onOpenSettings={(section) => { set.setModal(null); settingsEntry.openSettings(section === 'settings-marker' ? section : 'settings-mineru'); }}
      onOpenSources={(ids) => { nav.navigate('sources'); learn.openAudioSources(ids); }}
      audio={hasContext(data, 'audio') ? <AudioImport data={data} defaultCourses={parseCourses(sources.formCourse)} busy={busy} act={act} call={call}
        askInChat={askInChat} canAsk={!!host.askInChat} openAgent={host.openAgent} onOpenSources={learn.openAudioSources}
        onOpenSettings={() => { set.setModal(null); nav.navigate('settings'); }} /> : undefined} />
  );
}

export default function AddSourceDialog({ onClose }) {
  // guardDrops: a file dropped on the dialog's header or margins is refused instead of reaching the browser or the host chat.
  return <Dialog title={ui('添加资料')} size="md" guardDrops onClose={onClose}><SourceForm /></Dialog>;
}
