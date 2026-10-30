import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { HandOff } from '../hand-off/HandOff.jsx';
import { GUIDED_DEFAULTS, GUIDED_EXAMPLES } from './examples.js';
import './guided-start.css';

/** 「怎么开始带学」(#549): sentences the learner can send to the main chat as they are, and, with `defaults`, what a guided session leaves off until they agree. */
export default function GuidedStudyStart({ defaults = false, compact = false }) {
  return (
    <div className={`guided-start${compact ? ' guided-start--compact' : ''}`} data-guided-start="">
      <ul className="guided-start__examples">
        {GUIDED_EXAMPLES.map((example) => (
          <li key={example.id} className="guided-start__example" data-example={example.id}>
            <span className="guided-start__text">{uiFormat('「{0}」', [ui(example.text)])}</span>
            {!compact && <small className="guided-start__note">{ui(example.note)}</small>}
            <HandOff id="guided.start" input={{ example: example.id }} shape="secondary" what={ui('把这句话发给主会话，开始 AI 带学')} />
          </li>
        ))}
      </ul>
      {defaults && <ul className="guided-start__defaults">{GUIDED_DEFAULTS.map((line) => <li key={line}>{ui(line)}</li>)}</ul>}
    </div>
  );
}
