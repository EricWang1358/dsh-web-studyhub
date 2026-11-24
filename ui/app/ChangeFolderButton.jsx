import React, { useContext } from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { AppContext } from './app-context.js';
import { useStudyBusy } from '../study-context.jsx';

/* The one control that moves the library folder: the host's own folder picker, then the app's binding (Settings › 学习库与模型 and the desktop's first-use card both
   draw it as 「更换目录…」). Where there is no picker, or it cannot open, `onUnavailable` is the way to type the path instead. */

/** Pick a folder with the host's picker and make it the library. A cancelled pick does nothing. */
export async function chooseLibraryFolder({ host, updateBinding, notify, onUnavailable }) {
  if (!host.pickDirectory) { onUnavailable(); return; }
  try {
    const picked = await host.pickDirectory();
    if (picked) await updateBinding({ root: picked });
  } catch {
    onUnavailable();
    notify(ui('无法打开目录选择器，请直接输入路径。'));
  }
}

/** Outside the app (a preview, a pane under test) it draws nothing, like the panel that holds it. */
export default function ChangeFolderButton({ children, variant, disabled, onUnavailable }) {
  const app = useContext(AppContext);
  const busy = useStudyBusy();
  if (!app) return null;
  const { host, core, connection } = app;
  return (
    <Button variant={variant} lock={busy} disabled={disabled}
      onClick={() => chooseLibraryFolder({ host, updateBinding: connection.updateBinding, notify: core.notify, onUnavailable })}>
      {children}
    </Button>
  );
}
