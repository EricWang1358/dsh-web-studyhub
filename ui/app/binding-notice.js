import { ui } from '../i18n.js';

/** True while the desktop's STUDYHUB_LIBRARY decides the library folder: a folder picked in Settings is saved but cannot apply until the variable is gone. */
export const libraryPinnedByEnv = (binding, host) => binding?.rootSource === 'config' && host?.capabilities?.edition === 'desktop';

/**
 * What a saved binding change says (ui/app/use-library-connection.js): `patch` is what was asked, `moved` whether the library folder is another one now,
 * `value` the binding that came back. A folder that was asked for and did not move says so, and why when the variable decides it.
 */
export function bindingNotice({ patch, moved, value, host }) {
  if (moved) return ui('已切换学习库');
  if (Object.hasOwn(patch, 'root')) {
    return libraryPinnedByEnv(value, host) ? ui('学习库由环境变量 STUDYHUB_LIBRARY 指定，这里选的目录没有生效。') : ui('学习库目录没有变化。');
  }
  return Object.hasOwn(patch, 'reasoningEffort') ? ui('已更新推理程度') : ui('已更新生成模型');
}
