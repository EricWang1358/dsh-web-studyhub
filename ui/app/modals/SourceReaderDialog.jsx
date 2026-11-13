import React from 'react';
import { ui } from '../../i18n.js';
import { Dialog } from '../../components/index.js';
import { DocumentViewer } from '../../workspace-views.jsx';
import QuestionStrip from '../../review/QuestionStrip.jsx';
import { useApp } from '../app-context.js';
import { useSourceReader } from './source-reader.jsx';

/** The reader: a material full-size, with the questions and tasks that belong to it. Opens at a quote or where the learner stopped reading. Its props are
    the one reader's (./source-reader.jsx), shared with the 对照栏 beside a question on a wide practice page (#1012). Opened from a question (`back`), its
    题干条 keeps that question in view at the top of the text (ui/review/QuestionStrip.jsx). */
export default function SourceReaderDialog({ modal, onClose }) {
  const app = useApp();
  const { source, title, viewer } = useSourceReader({ modal, onClose });
  const run = app.session?.run;
  const strip = modal.back && app.nav?.page === 'review' && run?.card && !run.complete && run.mode !== 'exam' ? <QuestionStrip card={run.card} /> : null;
  return (
    <Dialog title={title} size="full" className="source-preview" bodyLabel={ui('资料内容')} guardDrops onClose={onClose}>
      {modal.quote && !source && <blockquote className="highlight-quote">{modal.quote}</blockquote>}
      {source ? <DocumentViewer {...viewer} strip={strip} /> : <p className="muted">{ui('无法找到此资料。')}</p>}
    </Dialog>
  );
}
