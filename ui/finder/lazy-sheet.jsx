import React from 'react';
import { ui } from '../i18n.js';
import { Dialog, LoadingState } from '../components/index.js';
import { deferredView } from '../deferred-view.jsx';

/* 找功能 (#653): the sheet and the index it shows (ui/finder/entries.js, the largest input of the study workspace) are a chunk of their own, fetched the first
   time the finder is opened, so the first screen does not carry them. Until the chunk is there the learner sees the same dialog (title, close, Esc) with the
   loading state in it, never an empty list or "nothing found". The finder is opened by a key or a click, so the wait is the one chunk. */
export default deferredView(() => import('./FinderSheet.jsx'), {
  loading: ({ onClose }) => (
    <Dialog title={ui('找功能')} size="md" onClose={onClose}>
      <LoadingState label={ui('正在打开…')} />
    </Dialog>
  ),
});
