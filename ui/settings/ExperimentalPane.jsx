import React from 'react';
import { ExperimentalSection } from '../ExperimentalSettings.jsx';
import JevSettings from '../JevSettings.jsx';
import { experimentalShown } from '../experimental-flag.js';

/** 实验性功能: the one switch, and Jev under it once it is on. */
export default function ExperimentalPane({ data, busy, act, call }) {
  return (
    <ExperimentalSection enabled={experimentalShown(data)} busy={busy} onChange={(enabled) => act('experimental.set', { enabled })}>
      <JevSettings busy={busy} call={call} />
    </ExperimentalSection>
  );
}
