import React from 'react';
import UsageSettings from '../UsageSettings.jsx';

export default function UsagePane({ call, busy }) {
  return <UsageSettings call={call} busy={busy} />;
}
