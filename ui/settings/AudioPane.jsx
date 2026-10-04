import React from 'react';
import AudioSettings from '../AudioSettings.jsx';

export default function AudioPane({ busy, act, call, setNotice }) {
  return <AudioSettings busy={busy} act={act} call={call} setNotice={setNotice} />;
}
