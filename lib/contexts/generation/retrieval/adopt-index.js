import { readRetrievalSettingsSafe, saveRetrievalSettings } from '../../../retrieval-settings.js';
import { describeProviders } from '../../../retrieval.js';
import { INDEX_TOOLS } from '../../../retrieval-index.js';

/** The search extension's own provider id: the one its index answers. */
export const COMPANION_PROVIDER = `mcp:${INDEX_TOOLS.query}`;

/** After a build the extension's index is what searches should use, unless the learner has chosen another provider. */
export async function adoptIndexProvider(port) {
  const foundSettings = await readRetrievalSettingsSafe();
  // #1354 D11: never attempt passive adoption over a corrupt, unreadable, or newer-version retrieval.json.
  if (foundSettings.status !== 'ok' && foundSettings.status !== 'missing') return;
  const settings = foundSettings.settings;
  if (settings.explicit || settings.provider !== 'builtin') return;
  const found = describeProviders({ tools: port?.tools?.() ?? [], service: port?.service?.() });
  if (found.providers.some(provider => provider.id === COMPANION_PROVIDER)) await saveRetrievalSettings({ ...settings, provider: COMPANION_PROVIDER });
}
