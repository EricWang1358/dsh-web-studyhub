/** Explicit preview fixture, never auto-imported into a real learner library. */
import { resolve } from "node:path";
import { StudyService } from "../lib/service.js";
const root = process.argv[2];
if (!root)
  throw new Error(
    "Usage: node scripts/seed-demo.mjs <preview-library-directory>",
  );
const service = new StudyService(resolve(root));
const source = {
  id: "patterns-notes",
  title: "Design patterns · ownership & variation",
  text: "The Caretaker manages snapshot history without inspecting snapshot contents. A Memento stores an opaque snapshot of internal state. The Originator creates and restores its own snapshots. A narrow interface hides snapshot internals from the Caretaker, while the Originator needs access to restore state. Bridge separates abstraction from implementation so both can vary independently. In a report rendering system, report types and rendering backends are two independent dimensions. Subclassing every report-backend combination produces a cross product of classes.",
};
const citation = (quote) => [{ sourceId: source.id, quote }];
const cards = [
  {
    id: "memento-owner",
    kind: "quiz",
    topic: "Memento",
    objective: "区分历史管理者和快照容器",
    prompt:
      "在 Memento 模式中，哪个组件负责管理历史状态，同时不检查快照内部内容？",
    answer: "Caretaker（管理者）",
    hint: "区分“一份快照”和“管理多份快照的对象”。",
    explanation:
      "Caretaker 保存和管理快照历史；快照的创建与恢复仍由 Originator 负责。",
    misconception: "把保存状态的容器 Memento 当成管理历史的对象。",
    citations: citation(
      "The Caretaker manages snapshot history without inspecting snapshot contents.",
    ),
    options: [
      {
        id: "caretaker",
        text: "Caretaker · 管理者",
        correct: true,
        explanation:
          "它负责维护快照历史，通过不透明接口保存快照，避免破坏封装。",
      },
      {
        id: "memento",
        text: "Memento · 备忘录",
        correct: false,
        explanation: "它表示某一时刻的状态快照，本身不负责管理整个历史。",
      },
      {
        id: "originator",
        text: "Originator · 原发器",
        correct: false,
        explanation:
          "它创建和恢复自己的快照，历史列表的管理由 Caretaker 承担。",
      },
    ],
  },
  {
    id: "memento-interface",
    kind: "quiz",
    topic: "Memento",
    objective: "解释快照接口访问边界",
    prompt: "为什么 Caretaker 和 Originator 对同一份快照需要不同的访问权限？",
    answer: "Caretaker 只管理快照；Originator 需要访问状态来恢复对象。",
    hint: "比较“保管快照”和“恢复对象”分别需要知道什么。",
    explanation:
      "窄接口让 Caretaker 无须了解内部状态，Originator 则保留恢复所需的访问能力。",
    misconception: "以为所有接触快照的对象都必须知道其内部字段。",
    citations: citation(
      "A narrow interface hides snapshot internals from the Caretaker, while the Originator needs access to restore state.",
    ),
    options: [
      {
        id: "boundary",
        text: "分离快照保管与状态恢复的访问需要",
        correct: true,
        explanation: "管理历史不要求读取内容，而恢复状态需要访问内容。",
      },
      {
        id: "inheritance",
        text: "让 Caretaker 直接继承原对象的状态",
        correct: false,
        explanation: "继承不解决封装边界，反而把状态表示泄露给管理者。",
      },
      {
        id: "mutation",
        text: "让 Caretaker 随时修改快照中的状态",
        correct: false,
        explanation: "直接修改状态违反了不透明快照的封装目的。",
      },
    ],
  },
  {
    id: "bridge-render",
    kind: "flashcard",
    topic: "Bridge",
    objective: "识别报表渲染中两个独立变化维度",
    prompt: "在报表渲染系统中，Bridge 设计模式主要解决什么问题？",
    answer:
      "将报表类型与渲染后端分离，让两个维度独立变化，避免为每一种组合创建子类。",
    hint: "如果有 5 种报表和 4 种后端，组合继承会产生多少种类型？",
    explanation:
      "报表抽象持有渲染实现。新增后端时不必为每一种报表重复创建子类。",
    misconception: "把两个独立变化的维度绑定到同一条继承层次中。",
    citations: citation(
      "In a report rendering system, report types and rendering backends are two independent dimensions.",
    ),
  },
];
const state = await service.call("snapshot");
if (!state.sources.some((s) => s.id === source.id))
  await service.call("source.add", source);
if (!state.decks.some((d) => d.id === "patterns-demo")) {
  await service.call("draft.save", {
    deck: { id: "patterns-demo", title: "Patterns · 理解与迁移", cards },
  });
  await service.call("draft.publish", { id: "patterns-demo" });
}
console.log("Explicit preview library ready:", resolve(root));
