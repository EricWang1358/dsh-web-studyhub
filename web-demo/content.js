import { cards as originals, source } from './fixtures.js';
export { source };
const en = [
  { prompt: 'In the Memento pattern, which component manages the history without inspecting snapshot contents?', answer: 'Caretaker', hint: 'Distinguish a single snapshot from the object that manages many snapshots.', explanation: 'The Caretaker keeps the history. The Originator still creates and restores its own snapshots.', misconception: 'Mistaking the Memento snapshot for the history manager.', objective: 'Distinguish the history manager from the snapshot container',
    options: ['Caretaker|It maintains the history through an opaque snapshot interface.', 'Memento|It represents one snapshot; it does not manage the history.', 'Originator|It creates and restores state. The Caretaker manages the history.'] },
  { prompt: 'Why do the Caretaker and Originator need different access to the same snapshot?', answer: 'The Caretaker only manages snapshots; the Originator must access their state to restore the object.', hint: 'Compare what you need to know to keep a snapshot versus restore state.', explanation: 'A narrow interface hides internal state from the Caretaker while the Originator retains access for restoration.', misconception: 'Assuming every object that holds a snapshot must know its internal fields.', objective: 'Explain the access boundary around snapshots',
    options: ['Separate snapshot storage from state restoration|Keeping history requires no access to contents; restoring state does.', 'Make the Caretaker inherit the original state|Inheritance does not establish the required encapsulation boundary.', 'Let the Caretaker modify snapshot contents|Direct mutation breaks the opaque snapshot boundary.'] },
  { prompt: 'What problem does the Bridge pattern solve in a report-rendering system?', answer: 'It separates report types from rendering backends so the two dimensions can vary independently, without a subclass for every combination.', hint: 'With five report types and four backends, how many combinations would inheritance produce?', explanation: 'The report abstraction holds a rendering implementation. Adding a backend does not require a new subclass for every report type.', misconception: 'Tying two independent dimensions into one inheritance hierarchy.', objective: 'Identify independent dimensions in report rendering' },
];
export const sampleCards = originals.map((c, i) => ({ ...c, ...en[i],
  options: c.options?.map((o,j) => ({ ...o, text: en[i].options[j].split('|')[0], explanation: en[i].options[j].split('|')[1] })),
  zh: c, demoKey: c.id,
}));
const extra = (id, topic, prompt, answer, explanation, quote, zh) => ({ id, topic, kind:'flashcard', prompt, answer, explanation,
  objective: prompt, hint: 'Think about the responsibility of each role.', misconception: 'Do not confuse the role that owns state with the role that keeps its history.',
  citations:[{sourceId:source.id,quote}], demoKey:id, zh:{prompt,answer,explanation,...zh} });
sampleCards.push(
  extra('snapshot-restore','Memento','Who creates and restores the snapshots in Memento?','The Originator creates and restores its own snapshots.','The object that owns the state understands how to capture and restore it. The Caretaker only manages the history.','The Originator creates and restores its own snapshots.',{prompt:'Memento 中由谁创建和恢复快照？',answer:'Originator（原发器）创建并恢复自己的快照。',explanation:'拥有状态的对象知道如何保存和恢复它；Caretaker 只管理历史。',hint:'谁最了解对象的内部状态？'}),
  extra('snapshot-opaque','Memento','Why can the Caretaker store a snapshot without reading it?','The snapshot is opaque to the Caretaker; a narrow interface hides its internal contents.','Holding a snapshot and interpreting its contents are separate responsibilities.','A Memento stores an opaque snapshot of internal state.',{prompt:'为什么 Caretaker 可以保存快照而不读取内容？',answer:'快照对 Caretaker 是不透明的，窄接口隐藏了内部内容。',explanation:'持有快照和解释快照内容是不同的职责。',hint:'保管信封需要先读信吗？'}),
  extra('bridge-dimensions','Bridge','Name the two independent dimensions in the report example.','Report types and rendering backends.','Bridge separates the abstraction from the implementation so either dimension can change independently.','In a report rendering system, report types and rendering backends are two independent dimensions.',{prompt:'报表例子中两个独立变化的维度是什么？',answer:'报表类型与渲染后端。',explanation:'Bridge 分离抽象与实现，让双方可以独立变化。',hint:'用户要什么报表？系统用什么方式渲染？'}),
  extra('bridge-cross-product','Bridge','With five report types and four rendering backends, how many combination subclasses would be needed?','Twenty combinations: 5 × 4.','This is a constructed application of the source: subclassing every pair produces a cross product. Bridge avoids encoding every combination as a subclass.','Subclassing every report-backend combination produces a cross product of classes.',{prompt:'5 种报表、4 种渲染后端，按每种组合建子类会得到多少种？',answer:'20 种组合：5 × 4。',explanation:'这是根据资料构造的应用例子：组合继承会产生笛卡尔积，Bridge 避免为每种组合建立子类。',hint:'把两种维度的数量相乘。'}),
);
export function localCard(card, lang) {
  if (!card) return card;
  const original = sampleCards.find(c => c.id === (card.demoKey || card.id.replace(/^demo-\d+-/, '')));
  if (lang !== 'zh' || !original?.zh) return card;
  const localized = original.zh;
  return { ...card, ...localized, id: card.id,
    options: card.options?.map(o => ({ ...o, ...(localized.options?.find(z => z.id === o.id) || {}) })),
  };
}
export const lessons = {
 en: [
  ['A familiar problem: undo', 'Imagine a text editor. Before changing “Hello” to “Hello world”, it saves a snapshot. Pressing Undo hands the earlier snapshot back to the editor. The editor restores its own state. This is an illustrative example of the roles described in the sample source.'],
  ['Three roles, one clear boundary', 'The Originator owns the state and creates and restores snapshots. The Memento holds one opaque snapshot. The Caretaker keeps the history without inspecting snapshot contents. Think of sealed envelopes: storing the envelopes does not require reading the letters.'],
  ['Why different access matters', 'The Caretaker only needs to keep and return a snapshot. The Originator needs to read it to restore state. A narrow interface keeps internal fields hidden from the Caretaker, so history management does not depend on the object’s internal representation.'],
  ['A different problem: independent variation', 'In a report system, report types and rendering backends can vary independently. Five types and four backends create twenty combinations if every pair is a subclass. Bridge separates the abstraction from its implementation, allowing both to change independently.'],
  ['Check the distinction', 'Memento concerns state snapshots and restoration. Bridge concerns independent dimensions of variation. Before naming a pattern, identify the problem it solves. Next, explain these roles in your own words, then test your understanding with the actual practice engine.'],
 ],
 zh: [
  ['从熟悉的撤销功能开始','想象一个文本编辑器。在把「你好」改成「你好世界」之前，它保存一份快照。按撤销时，之前的快照被交回编辑器，由编辑器恢复自身状态。这是为了说明示例资料中的角色而构造的例子。'],
  ['三个角色，一条清晰的边界','Originator 拥有状态，创建并恢复快照。Memento 是一份不透明的状态快照。Caretaker 管理历史，不检查快照内部。可以把快照想成封好的信封：保管信封并不需要阅读信件。'],
  ['为什么访问权限不同','Caretaker 只需要保存和交回快照，Originator 则需要读取快照才能恢复状态。窄接口向管理者隐藏内部字段，使历史管理功能不依赖对象的内部表示。'],
  ['另一个问题：独立变化','在报表系统中，报表类型与渲染后端可以独立变化。如果每一种组合都建立子类，5 种报表与 4 种后端会得到 20 种组合。Bridge 将抽象与实现分离，让双方各自变化。'],
  ['检查两者的区别','Memento 关注状态快照和恢复，Bridge 关注两个维度的独立变化。先确定要解决的问题，再选择模式。接下来用自己的话复述这些角色，然后进入真实判分的练习。'],
 ],
};
