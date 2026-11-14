import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Button, ConfirmDialog } from './components/index.js';

/** The one question both exams (the typed paper and the case paper) ask before grading with questions still empty. */
export default function SubmitBlanksDialog({ children, firstBlankNumber = 0, onJumpFirstBlank, onConfirm, onClose }) {
  return (
    <ConfirmDialog tone="primary" title={ui('还有题目没有作答')} confirmLabel={ui('仍然交卷')} cancelLabel={ui('继续作答')}
      onConfirm={onConfirm} onClose={onClose}>
      {children}
      {firstBlankNumber > 0 && typeof onJumpFirstBlank === 'function' && (
        <p>
          <Button variant="link" size="sm" iconEnd="arrow-right" data-testid="exam-jump-first-blank" onClick={onJumpFirstBlank}>
            {uiFormat('跳到第 {0} 题补答', [firstBlankNumber])}
          </Button>
        </p>
      )}
    </ConfirmDialog>
  );
}
