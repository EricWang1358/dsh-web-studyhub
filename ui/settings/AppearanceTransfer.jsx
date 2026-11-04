import React, { useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { Button, Dialog, Field, Hint, InlineMessage, TextArea } from '../components/index.js';
import { downloadText } from '../book/download.js';
import { useCopyFeedback } from '../use-copy-feedback.js';

/* 带到另一台电脑: the whole look as one small piece of text. Export is a copy button (and a saved file, for a browser that will not write the clipboard);
   import is a dialog that opens on demand (paste, or choose the saved file), so no raw text box sits on the settings page. Both directions go through the
   same whitelist (appearance-prefs.js exportAppearance / importAppearance): the dialog applies only what that list accepts and says so when it does not. */

const FILE_NAME = 'studyhub-appearance.json';

/** The paste dialog: the text, or the file, read back through the whitelist by `onImport(text)` (true when applied). */
function ImportDialog({ onImport, onClose }) {
  const [text, setText] = useState(''), [error, setError] = useState(''), picker = useRef(null);
  const apply = (value) => {
    if (!onImport(value)) return void setError(ui('这不是 StudyHub 的外观设置，没有改动。'));
    onClose('imported');
  };
  const read = async (file) => {
    if (!file) return;
    try { setText(await file.text()); setError(''); } catch { setError(ui('没能读取这个文件。')); }
  };
  return (
    <Dialog size="sm" title={ui('导入外观')} onClose={onClose}
      footer={<>
        <Button variant="quiet" onClick={() => onClose('button')}>{ui('取消')}</Button>
        <Button variant="primary" icon="upload" disabled={!text.trim()} onClick={() => apply(text)}>{ui('导入外观')}</Button>
      </>}>
      <Hint>{ui('粘贴在另一台电脑上复制的外观设置，或选择保存下来的文件。')}</Hint>
      <Field width="full">
        <TextArea rows={3} spellCheck={false} value={text} onChange={(event) => { setText(event.target.value); setError(''); }}
          aria-label={ui('外观设置（一小段文字，可粘贴到另一台电脑）')} placeholder={ui('外观设置（一小段文字，可粘贴到另一台电脑）')} />
      </Field>
      <input ref={picker} type="file" hidden accept=".json,application/json,text/plain" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void read(file); }} />
      <div className="settings-actions"><Button size="sm" icon="file" onClick={() => picker.current?.click()}>{ui('选择文件…')}</Button></div>
      {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </Dialog>
  );
}

export default function AppearanceTransfer({ appearance }) {
  const [note, setNote] = useState(null), [importing, setImporting] = useState(false);
  const exported = appearance.onExport ? appearance.onExport() : '';
  const { copy } = useCopyFeedback(exported);
  if (!appearance.onExport && !appearance.onImport) return null;
  return (
    <div className="appearance-backup" data-tour="settings-appearance-transfer">
      <Hint>{ui('把整套外观带到另一台电脑：这里复制，那边点「导入外观」粘贴。')}</Hint>
      <div className="settings-actions">
        {appearance.onExport && <Button icon="copy" onClick={async () => setNote(await copy()
          ? { tone: 'success', text: ui('已复制外观设置，可以粘贴到另一台电脑。') }
          : { tone: 'error', text: ui('没能复制：浏览器不让写剪贴板。可以改用「下载为文件」。') })}>{ui('复制外观设置')}</Button>}
        {appearance.onExport && <Button icon="download" variant="quiet" onClick={() => { downloadText(FILE_NAME, exported, 'application/json'); setNote({ tone: 'success', text: ui('已下载外观设置文件。') }); }}>{ui('下载为文件')}</Button>}
        {appearance.onImport && <Button icon="upload" variant="quiet" onClick={() => { setNote(null); setImporting(true); }}>{ui('导入外观')}</Button>}
      </div>
      {note && <InlineMessage tone={note.tone}>{note.text}</InlineMessage>}
      {importing && <ImportDialog onImport={appearance.onImport}
        onClose={(reason) => { setImporting(false); if (reason === 'imported') setNote({ tone: 'success', text: ui('已应用这份外观设置。') }); }} />}
    </div>
  );
}
