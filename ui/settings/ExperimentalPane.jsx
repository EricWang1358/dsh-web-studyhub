import React from 'react';
import { ExperimentalSection } from '../ExperimentalSettings.jsx';
import JevSettings from '../JevSettings.jsx';
import { experimentalShown } from '../experimental-flag.js';
import { useStudy } from '../study-context.jsx';

/** 实验性功能: the one switch, and Jev under it once it is on. */
export default function ExperimentalPane({ data }) {
  const { act } = useStudy();
  return (
    <ExperimentalSection enabled={experimentalShown(data)} onChange={(enabled) => act('experimental.set', { enabled })}>
      <JevSettings />
    </ExperimentalSection>
  );
}
