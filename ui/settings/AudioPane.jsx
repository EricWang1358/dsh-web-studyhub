import React from 'react';
import AudioSettings from '../AudioSettings.jsx';

export default function AudioPane({ busy, act, call }) {
  return <AudioSettings busy={busy} act={act} call={call} />;
}
