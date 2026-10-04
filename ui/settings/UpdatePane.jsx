import React from 'react';
import { UpdateSettingsPanel } from '../UpdateCenter.jsx';

export default function UpdatePane({ call, host, setNotice }) {
  return <UpdateSettingsPanel call={call} host={host} notify={setNotice} />;
}
