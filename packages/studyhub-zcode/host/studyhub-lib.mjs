/* The lib/ modules the ZCode host uses, loaded from wherever StudyHub's code is (lib-root.mjs). */
import { importLib } from './lib-root.mjs';

export const [hostLib, boundary, updateCheck, usageScope, tokenUsage, appMessages, tools, audioFiles, skeletonDiagrams] = await Promise.all([
  importLib('host.js'), importLib('assistant-boundary.js'), importLib('update-check.js'), importLib('usage-scope.js'),
  importLib('token-usage.js'), importLib('application-messages.js'), importLib('runtime/tools.js'), importLib('audio-files.js'),
  importLib('skeleton-diagrams.js'),
]);
