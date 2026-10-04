import React from 'react';
import { ui } from '../i18n.js';
import { SettingsSection } from '../components/index.js';
import WorkspaceBindingPanel from '../app/WorkspaceBindingPanel.jsx';

/** 学习库与模型: the library binding and the model choice (the panel reads the app's binding itself). */
export default function ModelPane() {
  return <SettingsSection title={ui('学习库与模型')} tour="settings-model"><WorkspaceBindingPanel /></SettingsSection>;
}
