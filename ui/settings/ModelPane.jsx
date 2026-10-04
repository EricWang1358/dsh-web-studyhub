import React from 'react';
import { ui } from '../i18n.js';
import { SettingsSection } from '../components/index.js';

/** 学习库与模型: the library binding and the model choice, built by the app and handed in as `workspacePanel`. */
export default function ModelPane({ workspacePanel }) {
  return <SettingsSection title={ui('学习库与模型')} tour="settings-model">{workspacePanel}</SettingsSection>;
}
