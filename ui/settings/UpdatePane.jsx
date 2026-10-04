import React from 'react';
import { UpdateSettingsPanel } from '../UpdateCenter.jsx';

export default function UpdatePane({ call, host }) {
  return <UpdateSettingsPanel call={call} host={host} />;
}
