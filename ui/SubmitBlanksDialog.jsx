import React from 'react';
import { ui } from './i18n.js';
import { ConfirmDialog } from './components/index.js';

/** The one question both exams (the typed paper and the case paper) ask before grading with questions still empty. */
export default function SubmitBlanksDialog({ children, onConfirm, onClose }) {
  return (
    <ConfirmDialog tone="primary" title={ui('还有题目没有作答')} confirmLabel={ui('仍然交卷')} cancelLabel={ui('继续作答')}
      onConfirm={onConfirm} onClose={onClose}>
      {children}
    </ConfirmDialog>
  );
}
