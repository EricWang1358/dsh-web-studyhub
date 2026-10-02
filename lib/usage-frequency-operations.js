import { usageFrequency, localDay } from './usage-frequency.js';
import { buildReport, exportUsage, REPORT_PERIODS } from './usage-report.js';
import { currentVersion } from './update-check.js';

/* The operations of the usage frequency record: library-independent (one file per DSH home), mounted by the system context
   (lib/contexts/system/operations.js). Panel operations only: lib/index.js refuses them to the assistant's tool. Input checks live in the
   contracts (lib/contexts/system/contracts.js); the record itself validates every count again (lib/usage-frequency.js). */

const periodOf = value => {
  const period = value === undefined ? 30 : value;
  if (!REPORT_PERIODS.includes(period)) throw new Error('period 必须是 7、30 或 all');
  return period;
};
const languageOf = (a, fallback) => (a.language === 'en' || a.language === 'zh' ? a.language : fallback === 'en' ? 'en' : 'zh');

export function createUsageFrequencyOperations({ language: serviceLanguage } = {}) {
  const store = () => usageFrequency();
  return {
    'usage.frequency.status': async () => store().status(),
    'usage.frequency.set': async (a = {}) => store().set({ enabled: a.enabled, paused: a.paused }),
    'usage.frequency.record': async (a = {}) => {
      if (!Array.isArray(a.records)) throw new Error('records 必须是数组');
      return store().record(a.records);
    },
    'usage.frequency.report': async (a = {}) => buildReport(await store().read(), { period: periodOf(a.period), today: localDay(Date.now()), language: languageOf(a, serviceLanguage) }),
    'usage.frequency.export': async (a = {}) => {
      const labels = {};
      if (a.labels && typeof a.labels === 'object' && !Array.isArray(a.labels))
        for (const [key, value] of Object.entries(a.labels).slice(0, 900)) if (typeof value === 'string' && value.length <= 120) labels[key] = value;
      return exportUsage(await store().read(), { format: a.format ?? 'json', period: periodOf(a.period), today: localDay(Date.now()), language: languageOf(a, serviceLanguage), version: currentVersion(), labels });
    },
    'usage.frequency.clear': async () => store().clear(),
  };
}
