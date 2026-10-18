import React from 'react';
import { Icon } from '../components/index.js';

/* The steps of a one-click install as a list with a mark each (done, the one in hand, failed, waiting): one component for Marker and MinerU.
   `stages`: [{ id, name, state: 'done' | 'active' | 'failed' | 'pending' }]. The classes are the caller's, so each card keeps its own look. */
export default function InstallStages({ stages, label, className, markClassName }) {
  return <ol className={className} aria-label={label}>
    {stages.map(item => <li key={item.id} data-state={item.state} aria-current={item.state === 'active' ? 'step' : undefined}>
      <span className={markClassName} aria-hidden="true">{item.state === 'done' ? <Icon name="success" size={14} /> : item.state === 'failed' ? <Icon name="error" size={14} /> : null}</span>
      {item.name}
    </li>)}
  </ol>;
}
