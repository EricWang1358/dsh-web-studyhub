import React from 'react';
import GenerationSettings from '../GenerationSettings.jsx';

export default function GenerationPane({ data, busy, act }) {
  return <GenerationSettings root={data.root} saved={data.settings?.generation} busy={busy} act={act} />;
}
