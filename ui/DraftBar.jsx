import React from 'react';
import { ui } from './i18n.js';
import { Button, Menu } from './components/index.js';
import { useStudy } from './study-context.jsx';

/* The draft page's one action bar: the primary 发布并开始练 and one secondary 保存并校验, and, behind a ⋯ menu, the dangerous one (删除草稿): it has no place beside the primary action (#668).
   The menu item only opens the page's dialog (ui/DeleteDraftDialog.jsx asks, as before). Where the bar stands is the page's business (ui/Draft.jsx, #669); `children` is what the bar says on its left.
   `describedBy`: the id of the line that says why publishing waits (the page's hold banner). The page decides what is disabled; the single-flight lock is the app's (useStudy). */
export default function DraftBar({ children, publishLabel, saveDisabled = false, publishDisabled = false, publishTitle, describedBy, deleteDisabled = false, onSave, onPublish, onDelete, defaultMenuOpen = false }) {
  const { busy } = useStudy();
  return (
    <div className="sticky-actions" data-tour="draft-publish" data-draft-bar>
      {children}
      <div className="sticky-actions__buttons">
        <Menu className="sticky-actions__more" label={ui('更多')} defaultOpen={defaultMenuOpen} data-draft-more data-tour="draft-more" onSelect={onDelete}
          items={[{ id: 'delete', label: ui('删除草稿'), danger: true, disabled: deleteDisabled, attrs: { 'data-draft-delete': '' } }]} />
        <Button disabled={saveDisabled} lock={busy} onClick={onSave}>{ui('保存并校验')}</Button>
        <Button variant="primary" disabled={publishDisabled} lock={busy} title={publishTitle} aria-describedby={describedBy} onClick={onPublish}>{publishLabel}</Button>
      </div>
    </div>
  );
}
