import React, { useContext } from 'react';
import { errorMessage, ui, uiFormat } from '../i18n.js';
import { Button, InlineMessage, Panel } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { AppContext } from '../app/app-context.js';
import { openLibrarySettings } from '../app/AppTopbar.jsx';
import ChangeFolderButton from '../app/ChangeFolderButton.jsx';
import { writeWarmBinding } from '../app/warm-session.js';
import { WorkspaceNote } from './DesktopLibraryNotice.jsx';
import css from './desktop.css';

/* The first-use card at the top of the home (ui/host-parts.js HomeLead): where the library lives. It is drawn until the learner has settled it (picked a folder, or
   said 就用这里), so everyone who updates sees it once. The host says whether it is settled and whether the folder is on the system drive (`binding.libraryPlace`). */

/** 就用这里: the learner accepts the library where it is. The binding that comes back says it is confirmed, which takes the card away; a failure keeps it. */
export async function confirmLibraryPlace({ call, setBinding, setBusy, setError }) {
  setError('');
  setBusy(true);
  try {
    setBinding(await call('desktop.library.confirm', {}));
  } catch (failure) {
    setError(errorMessage(failure));
  } finally {
    setBusy(false);
  }
}

const driveOf = (root) => /^[a-z]:/i.exec(String(root || ''))?.[0].toUpperCase() || '';

/** Whether the library already holds something a move would have to take along. */
const hasContent = (data) => (data?.decks?.length || 0) + (data?.sources?.length || 0) > 0;

const shouldHideLibraryPlace = (binding) => {
  const place = binding?.libraryPlace;
  return !place || place.confirmed || Boolean(binding.libraryProblem) || Boolean(binding.configProblem);
};

export default function DesktopLibraryPlace({ data }) {
  useInjectCss(css, 'study-desktop');
  const app = useContext(AppContext);
  const binding = app?.connection.binding;
  if (shouldHideLibraryPlace(binding)) return null;
  const place = binding.libraryPlace;
  const { host, core, connection } = app;
  const confirm = () => confirmLibraryPlace({
    call: core.call, setBusy: core.setBusy, setError: core.setError,
    setBinding: (value) => { connection.setBinding(value); writeWarmBinding(host.warmKey, value); },
  });
  const onSystem = place.onSystemDrive;
  return (
    <Panel tone="paper" density="compact" title={ui('先确认学习库放在哪')} className="desktop-library-place" data-desktop-library-place="">
      <p>{ui('资料、题组和复习记录都存在这个文件夹：')}<code translate="no">{binding.root}</code></p>
      <WorkspaceNote binding={binding} />
      {/* Said only while it can still help: a learner already on the DSH workspace reads the note above instead. */}
      {!(binding.pickedRoot && binding.pickedRoot !== binding.root) && <p>{ui('在 DSH 里用过 StudyHub？选那个工作区文件夹，原来的题组和记录都会出现。')}</p>}
      {onSystem && (
        <InlineMessage tone="warning" data-desktop-library-system-drive="">
          {uiFormat('它在系统盘（{0}）。学习库会越用越大，建议放到其他盘。', [driveOf(binding.root)])}
        </InlineMessage>
      )}
      {hasContent(data) && <p>{ui('换文件夹不会搬动已有内容；要搬，先退出 StudyHub，把整个文件夹移到新位置，再回来选它。')}</p>}
      <div className="desktop-library-place__actions">
        {/* The same control as Settings' 更换目录…; with no picker to open, the typed path of Settings is the way. */}
        <ChangeFolderButton variant={onSystem ? 'primary' : undefined} onUnavailable={() => openLibrarySettings(app.settingsEntry, app.nav)}>{ui('更换目录…')}</ChangeFolderButton>
        <Button variant={onSystem ? undefined : 'primary'} lock={core.busy} onClick={confirm}>{ui('就用这里')}</Button>
      </div>
    </Panel>
  );
}
