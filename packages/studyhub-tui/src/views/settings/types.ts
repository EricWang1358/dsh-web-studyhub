import type { UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';

export type SettingsTabId = 'models' | 'workspace' | 'study' | 'appearance';

export interface SettingsTabMeta {
  id: SettingsTabId;
  num: string;
  labelZh: string;
  labelEn: string;
}

export const SETTINGS_TABS: readonly SettingsTabMeta[] = Object.freeze([
  { id: 'models', num: '1', labelZh: '模型配置', labelEn: 'Models' },
  { id: 'workspace', num: '2', labelZh: '学习库与工作区', labelEn: 'Workspace' },
  { id: 'study', num: '3', labelZh: '复习与出题', labelEn: 'Study & Gen' },
  { id: 'appearance', num: '4', labelZh: 'TUI 外观与偏好', labelEn: 'Appearance' },
]);

export const AGY_EFFORTS: readonly string[] = Object.freeze(['', 'low', 'medium', 'high', 'xhigh', 'max']);
export const CODEX_EFFORTS: readonly string[] = Object.freeze(['', 'low', 'medium', 'high', 'xhigh']);
export const OPENAI_EFFORTS: readonly string[] = Object.freeze(['', 'low', 'medium', 'high', 'xhigh']);

export function effortLabel(effort: string, lang: UiLanguage): string {
  if (!effort) return t(lang, '自动 (auto)', 'auto');
  return effort;
}
