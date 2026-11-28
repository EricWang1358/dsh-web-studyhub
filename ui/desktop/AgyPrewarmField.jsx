import React from 'react';
import { ui } from '../i18n.js';
import { Disclosure, Field, SegmentedControl } from '../components/index.js';

/* When agy is started ahead of the next call. It trades memory for waiting time, so the choice is the learner's: the line under the
   control says what the chosen one does and costs, and 「怎么选」 holds the rest. Numbers are one computer's measurement and are
   said as such. */
const CHOICES = Object.freeze([
  {
    value: 'off',
    label: '关闭',
    effect: '每次调用现启动 agy：不多占内存，每次都要多等它启动的几秒。',
    pick: '内存紧张、同时开着很多程序，或很少用 AI 功能：选「关闭」。',
  },
  {
    value: 'after-use',
    label: '用过之后',
    effect: '默认。用过一次就提前启动好下一个：之后 10 分钟内的下一次调用少等几秒，第一次照常等。闲置 10 分钟自动退出；等着的时候约占 200 MB 内存。',
    pick: '拿不准就保持「用过之后」：连续追问、带学、出题时省时间，停下 10 分钟后不再占内存。',
  },
  {
    value: 'always',
    label: '一直',
    effect: '打开 StudyHub 且启用 agy 时就备好一个，第一次也少等；开着软件就一直约占 200 MB 内存（闲置约 30 分钟换一个新的）。',
    pick: '经常隔一阵问一两句（带学、帮我弄懂），内存宽裕：选「一直」。',
  },
]);

const FACTS = Object.freeze([
  '省下的是 agy 的启动时间，模型思考和写回答的时间不变。在一台电脑上几次实测一句话回复：现启动约 11–20 秒，用备好的约 5–10 秒；回答越长，省下的占比越小。',
  '预热只是先把程序启动好，StudyHub 在你提问之前不向它发任何内容。每个备用进程只回答一次，前后两个问题不会串在一起。',
  '回答进行中会同时有一个在答、一个在备用，内存按两个算。改过模型或推理强度后的第一次调用照常现启动。只在启用本机 agy 时生效。',
  '如果一次要等半分钟以上，多半是 agy 里某个插件连接太慢：在命令行运行 agy plugin list 查看，停用用不到的。',
]);

export default function AgyPrewarmField({ value, disabled, onChange }) {
  const chosen = CHOICES.find((item) => item.value === value) || CHOICES[1];
  return (
    <div className="desktop-cli__prewarm" data-desktop-agy-prewarm={chosen.value}>
      <Field group label={ui('提前启动 agy（预热）')} width="full" hint={ui(chosen.effect)}>
        <SegmentedControl label={ui('提前启动 agy（预热）')} size="sm" wrap value={chosen.value} disabled={disabled}
          options={CHOICES.map((item) => ({ value: item.value, label: ui(item.label) }))} onChange={onChange} />
      </Field>
      <Disclosure summary={ui('怎么选')}>
        <ul className="desktop-cli__prewarm-guide">
          {CHOICES.map((item) => <li key={item.value}>{ui(item.pick)}</li>)}
          {FACTS.map((fact) => <li key={fact}>{ui(fact)}</li>)}
        </ul>
      </Disclosure>
    </div>
  );
}
