import { uiFormat } from '../i18n.js';
import { joinMeta } from '../format.js';
import { formatCompactTokens } from '../../lib/token-usage.js';
import { batchReason } from './call-model.js';

/** One batch of a day of 为你定制 in one line: what it wrote and kept (or what it is writing, or why it wrote nothing), and the tokens it used. 批次 and 实时输出 both read it. */
export function batchSummary(batch) {
  const used = batch.tokens ? batch.tokens.input + batch.tokens.output + batch.tokens.cache : 0;
  return joinMeta([batch.status === 'ok' ? uiFormat('写了 {0} 道，留下 {1} 道', [batch.generated, batch.passed])
    : batch.status === 'running' ? uiFormat('为 {0} 道题备变式', [batch.targets]) : batchReason(batch), used > 0 ? uiFormat('{0} tok', [formatCompactTokens(used)]) : '']);
}
