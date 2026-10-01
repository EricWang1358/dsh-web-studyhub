/* Sample course for the StudyHub tour, Chinese edition (plan §3 D4). A
   faithful translation of lib/sample/en.js: the same cards (same keys, kinds,
   correct options and citations), so both editions teach the same thing.
   Every quote below appears verbatim in `document.markdown` after rendering. */

const markdown = `# 设计模式讲义 · Memento 与 Bridge

> StudyHub 功能导览使用的示例讲义。课程内容为虚构的课堂笔记，可以随时一键移除。

## 一、Memento（备忘录）：撤销而不破坏封装

Memento 让对象在不暴露内部细节的前提下保存和恢复自身状态。

- Originator（原发器）创建并恢复自己的快照。
- Memento（备忘录）保存一份不透明的内部状态快照。
- Caretaker（管理者）负责管理快照历史，但不检查快照的内容。

窄接口向 Caretaker 隐藏快照内部，而 Originator 需要访问快照才能恢复状态。

**例子。** 文本编辑器在每次修改前保存一份快照。用户按下撤销时，历史记录把最近的快照交回编辑器，由编辑器自己恢复状态。

## 二、Bridge（桥接）：两个独立变化的维度

Bridge 将抽象与实现分离，使两者可以独立变化。

在报表渲染系统中，报表类型与渲染后端是两个独立的维度。为每一种「报表 × 后端」组合建立子类，会产生类的笛卡尔积。

使用 Bridge 后，报表持有一个渲染实现的引用，并把绘制工作委托给它。新增一种渲染后端，不再需要为每种报表类型各建一个子类。

## 三、如何选择

Memento 关注状态的保存与恢复；Bridge 关注让两个变化维度各自演进。先说清要解决的问题，再选择模式。
`;

const option = (id, text, correct, explanation) => ({ id, text, correct, explanation });

export default {
  language: "zh",
  course: "示例课程 · 设计模式",
  document: {
    title: "示例 · 设计模式讲义",
    filename: "示例-设计模式讲义.md",
    markdown,
  },
  deck: {
    title: "示例 · Memento 与 Bridge",
    cards: [
      { key: "memento-owner", kind: "quiz", topic: "Memento",
        objective: "区分历史管理者和快照容器",
        prompt: "在 Memento 模式中，哪个组件负责管理历史状态，同时不检查快照内部内容？",
        answer: "Caretaker（管理者）",
        hint: "区分「一份快照」和「管理多份快照的对象」。",
        explanation: "Caretaker 保存和管理快照历史；快照的创建与恢复仍由 Originator 负责。",
        misconception: "把保存状态的容器 Memento 当成管理历史的对象。",
        quote: "Caretaker（管理者）负责管理快照历史，但不检查快照的内容。",
        options: [
          option("caretaker", "Caretaker · 管理者", true, "它负责维护快照历史，通过不透明接口保存快照，避免破坏封装。"),
          option("memento", "Memento · 备忘录", false, "它表示某一时刻的状态快照，本身不负责管理整个历史。"),
          option("originator", "Originator · 原发器", false, "它创建和恢复自己的快照，历史列表的管理由 Caretaker 承担。"),
        ] },
      { key: "memento-interface", kind: "quiz", topic: "Memento",
        objective: "解释快照接口的访问边界",
        prompt: "为什么 Caretaker 和 Originator 对同一份快照需要不同的访问权限？",
        answer: "Caretaker 只管理快照；Originator 需要访问状态来恢复对象。",
        hint: "比较「保管快照」和「恢复对象」分别需要知道什么。",
        explanation: "窄接口让 Caretaker 无须了解内部状态，Originator 则保留恢复所需的访问能力。",
        misconception: "以为所有接触快照的对象都必须知道其内部字段。",
        quote: "窄接口向 Caretaker 隐藏快照内部，而 Originator 需要访问快照才能恢复状态。",
        options: [
          option("boundary", "保管快照与恢复状态需要的访问权限不同", true, "管理历史不要求读取内容，而恢复状态需要访问内容。"),
          option("inheritance", "让 Caretaker 直接继承原对象的状态", false, "继承不解决封装边界，反而把状态表示泄露给管理者。"),
          option("mutation", "让 Caretaker 随时修改快照中的状态", false, "直接修改状态违反了不透明快照的封装目的。"),
        ] },
      { key: "bridge-render", kind: "flashcard", topic: "Bridge",
        objective: "识别报表渲染中两个独立变化的维度",
        prompt: "在报表渲染系统中，Bridge 设计模式主要解决什么问题？",
        answer: "将报表类型与渲染后端分离，让两个维度独立变化，避免为每一种组合创建子类。",
        hint: "如果有 5 种报表和 4 种后端，组合继承会产生多少种类型？",
        explanation: "报表抽象持有渲染实现。新增后端时不必为每一种报表重复创建子类。",
        misconception: "把两个独立变化的维度绑定到同一条继承层次中。",
        quote: "在报表渲染系统中，报表类型与渲染后端是两个独立的维度。" },
      { key: "snapshot-restore", kind: "flashcard", topic: "Memento",
        objective: "说出创建和恢复快照的角色",
        prompt: "Memento 中由谁创建和恢复快照？",
        answer: "Originator（原发器）创建并恢复自己的快照。",
        hint: "谁最了解对象的内部状态？",
        explanation: "拥有状态的对象知道如何保存和恢复它；Caretaker 只管理历史。",
        misconception: "以为保管历史的 Caretaker 也负责恢复状态。",
        quote: "Originator（原发器）创建并恢复自己的快照。" },
      { key: "snapshot-opaque", kind: "flashcard", topic: "Memento",
        objective: "解释为什么快照可以只保存不读取",
        prompt: "为什么 Caretaker 可以保存快照而不读取内容？",
        answer: "快照对 Caretaker 是不透明的，窄接口隐藏了内部内容。",
        hint: "保管信封需要先读信吗？",
        explanation: "持有快照和解释快照内容是不同的职责。",
        misconception: "以为保存快照就必须理解快照内容。",
        quote: "Memento（备忘录）保存一份不透明的内部状态快照。" },
      { key: "bridge-dimensions", kind: "flashcard", topic: "Bridge",
        objective: "说出报表例子中的两个维度",
        prompt: "报表例子中两个独立变化的维度是什么？",
        answer: "报表类型与渲染后端。",
        hint: "用户要什么报表？系统用什么方式渲染？",
        explanation: "Bridge 分离抽象与实现，让双方可以独立变化。",
        misconception: "把渲染后端当成每种报表的内部细节。",
        quote: "Bridge 将抽象与实现分离，使两者可以独立变化。" },
      { key: "bridge-cross-product", kind: "flashcard", topic: "Bridge",
        objective: "计算组合继承需要的子类数量",
        prompt: "5 种报表、4 种渲染后端，按每种组合建子类会得到多少种？",
        answer: "20 种组合：5 × 4。",
        hint: "把两个维度的数量相乘。",
        explanation: "为每种组合建子类会产生类的笛卡尔积；Bridge 避免把每种组合都写成子类。",
        misconception: "把两个维度的数量相加（5 + 4），而不是相乘。",
        quote: "为每一种「报表 × 后端」组合建立子类，会产生类的笛卡尔积。" },
      { key: "bridge-delegate", kind: "quiz", topic: "Bridge",
        objective: "描述 Bridge 中抽象如何使用实现",
        prompt: "引入 Bridge 后，新增一种渲染后端时，报表如何完成绘制？",
        answer: "报表把绘制工作委托给它持有的渲染实现。",
        hint: "找组合，而不是继承。",
        explanation: "报表持有渲染实现的引用并委托给它，所以新后端可以直接接入，不需要新增报表子类。",
        misconception: "以为每种报表都要继承新的后端类。",
        quote: "使用 Bridge 后，报表持有一个渲染实现的引用，并把绘制工作委托给它。",
        options: [
          option("delegate", "委托给它持有的渲染实现", true, "组合让任意报表都能使用任意后端。"),
          option("subclass", "为每种报表各写一个新子类", false, "这正是 Bridge 要避免的笛卡尔积。"),
          option("copy", "把后端的绘制代码复制进报表", false, "复制代码会让两个维度重新耦合。"),
        ] },
      { key: "memento-roles", kind: "cloze", topic: "Memento",
        objective: "回忆恢复状态和保管历史的角色",
        prompt: "由 {{a}} 创建并恢复快照，由 {{b}} 保管历史而不读取内容。",
        answer: "Originator；Caretaker",
        hint: "一个角色拥有状态，另一个只保管历史。",
        explanation: "Originator 创建并恢复快照；Caretaker 只保存快照，不查看内部。",
        misconception: "把恢复状态的角色和保管历史的角色弄反。",
        quote: "Originator（原发器）创建并恢复自己的快照。",
        cloze: { text: "由 {{a}} 创建并恢复快照，由 {{b}} 保管历史而不读取内容。",
          answers: [{ id: "a", value: "Originator", accept: ["原发器", "Originator（原发器）"] },
            { id: "b", value: "Caretaker", accept: ["管理者", "Caretaker（管理者）"] }] } },
    ],
  },
  weak: ["memento-owner", "bridge-render"],
  fresh: ["bridge-delegate", "memento-roles"],
  prerequisites: [["memento-interface", "snapshot-opaque"], ["memento-owner", "snapshot-restore"],
    ["bridge-cross-product", "bridge-dimensions"], ["bridge-render", "bridge-dimensions"]],
  draft: {
    title: "示例草稿 · 选对设计模式",
    cards: [
      { key: "draft-undo", kind: "quiz", topic: "选择模式",
        objective: "判断撤销需求适合 Memento",
        prompt: "一个绘图应用要支持撤销笔画，同时不暴露画布的内部结构。最适合用哪种模式？",
        answer: "Memento",
        hint: "撤销就是回到之前的某个状态。",
        explanation: "Memento 把画布状态保存为不透明快照，撤销时再交回画布恢复。",
        misconception: "因为应用里有多种笔刷就选了 Bridge。",
        quote: "Memento 让对象在不暴露内部细节的前提下保存和恢复自身状态。",
        options: [
          option("memento", "Memento", true, "快照让画布自行恢复，而不暴露内部状态。"),
          option("bridge", "Bridge", false, "Bridge 分离两个变化维度，不负责恢复状态。"),
          option("subclass", "每种笔画各建一个子类", false, "子类无法记录运行时状态来支持撤销。"),
        ] },
      { key: "draft-charts", kind: "quiz", topic: "选择模式",
        objective: "判断两个维度都会增长时适合 Bridge",
        prompt: "一个图表库要在两种渲染器（SVG 与 Canvas）上支持三种图表，两边都还会增加。哪种设计能避免为每种组合各建一个类？",
        answer: "Bridge",
        hint: "数一数有几个独立变化的维度。",
        explanation: "图表类型和渲染器是两个独立维度；Bridge 让两边各自增长，而不是成倍增加类。",
        misconception: "现在只有 6 种组合，就接受每种组合一个子类。",
        quote: "Bridge 将抽象与实现分离，使两者可以独立变化。",
        options: [
          option("bridge", "Bridge", true, "图表类型持有渲染器，并把绘制委托给它。"),
          option("memento", "Memento", false, "Memento 负责保存状态，不分离变化维度。"),
          option("cross", "每种「图表 × 渲染器」组合一个子类", false, "类的数量按笛卡尔积增长：今天 6 个，明天更多。"),
        ] },
      { key: "draft-compare", kind: "flashcard", topic: "选择模式",
        objective: "对比 Memento 与 Bridge 解决的问题",
        prompt: "用一句话说出 Memento 和 Bridge 的区别。",
        answer: "Memento 保存并恢复状态；Bridge 让两个变化维度各自独立变化。",
        hint: "一个关于时间，一个关于变化。",
        explanation: "先说清问题：要回到之前的状态，用 Memento；要让两个维度独立变化，用 Bridge。",
        misconception: "把两者都笼统地当成「解耦」，却说不出要解决的问题。",
        quote: "Memento 关注状态的保存与恢复；Bridge 关注让两个变化维度各自演进。" },
    ],
  },
  skeleton: {
    title: "示例 · 设计模式：角色与边界",
    overview: "把「状态恢复」和「独立变化」连起来的示例骨架。点一个概念，查看与它关联的题目。",
    classNote: "Memento 把历史管理和状态访问分开；Bridge 把两个独立变化的维度分开。",
    nodes: [
      { id: "originator", term: "Originator（原发器）", meaning: "拥有状态，负责创建并恢复快照。", attributes: ["拥有内部状态", "创建与恢复快照"], cards: ["snapshot-restore", "memento-interface", "memento-roles"] },
      { id: "memento", term: "Memento（备忘录）", meaning: "某一时刻状态的不透明快照。", attributes: ["内容不透明", "一份保存的状态"], cards: ["snapshot-opaque"] },
      { id: "caretaker", term: "Caretaker（管理者）", meaning: "保管快照历史，但不读取快照内容。", attributes: ["管理历史", "不检查状态"], cards: ["memento-owner"] },
      { id: "abstraction", term: "报表抽象", meaning: "描述报表本身，与渲染后端无关。", attributes: ["报表类型", "委托渲染"], cards: ["bridge-render", "bridge-cross-product", "bridge-delegate"] },
      { id: "implementation", term: "渲染实现", meaning: "提供可以独立于报表类型变化的渲染后端。", attributes: ["渲染后端", "独立变化"], cards: ["bridge-dimensions"] },
    ],
    relations: [
      { from: "originator", to: "memento", type: "related", note: "创建并恢复" },
      { from: "caretaker", to: "memento", type: "related", note: "保存但不检查" },
      { from: "abstraction", to: "implementation", type: "related", note: "通过组合委托" },
      { from: "memento", to: "abstraction", type: "contrasts", note: "状态恢复与独立变化" },
    ],
    sequences: [{ title: "文本编辑器中的撤销", explanation: "示例讲义的一个应用：由编辑器自己恢复状态。",
      participants: [{ id: "history", label: "历史记录", node: "caretaker" }, { id: "editor", label: "编辑器", node: "originator" }],
      steps: [{ from: "history", to: "editor", message: "修改前请求一份快照" },
        { from: "editor", to: "history", message: "交回不透明的快照", kind: "return" },
        { from: "history", to: "editor", message: "撤销：交回保存的快照" }] }],
  },
  notes: [
    { key: "memento", topic: "Memento", title: "示例笔记 · 为什么 Caretaker 不能读取快照",
      markdown: "# Memento：管理历史而不暴露状态\n\n> 示例学习笔记。可以随意修改，移除示例课程时会一并删除。\n\n## 三个职责\n\n- **Originator：** 创建并恢复自己的状态。\n- **Memento：** 一份不透明的快照。\n- **Caretaker：** 保存并取回快照。\n\n## 信封类比\n\n管理者可以保管封好的信封，而不必读信。只有原发器知道如何解读里面的内容。这是类比，不是字面上的实现。\n\n## 常见误区\n\nMemento 是一份快照，不是历史管理者；管理历史的是 Caretaker。\n\n## 下一道回忆题\n\n为什么保管快照所需的访问权限比恢复状态少？" },
    { key: "bridge", topic: "Bridge", title: "示例笔记 · 如何避免 20 个报表子类",
      markdown: "# Bridge：两个变化维度\n\n> 示例学习笔记。可以随意修改，移除示例课程时会一并删除。\n\n## 算一算\n\n5 种报表、4 种渲染后端，如果每种组合都要一个子类，就会得到 **20 种组合**。\n\n## 设计决定\n\n把报表类型和渲染后端分开。报表持有一个渲染实现，把后端相关的工作委托给它。\n\n## 两个模式对比\n\nMemento 处理快照与恢复，Bridge 处理独立变化。先认清问题，再选择模式。\n\n## 动手试试\n\n修改这份笔记，然后练习它关联的题目。" },
  ],
  lesson: {
    goal: "讲清 Memento 的三个角色，并能判断什么时候该用 Bridge。",
    title: "示例 · 先讲后练",
    note: "预先准备的示例讲解，没有调用模型。",
    sections: [
      ["从熟悉的撤销功能开始", "想象一个文本编辑器。在把「你好」改成「你好世界」之前，它保存一份快照。按撤销时，之前的快照被交回编辑器，由编辑器恢复自身状态。这是为了说明示例讲义中的角色而构造的例子。"],
      ["三个角色，一条清晰的边界", "Originator 拥有状态，创建并恢复快照。Memento 是一份不透明的状态快照。Caretaker 管理历史，不检查快照内部。可以把快照想成封好的信封：保管信封并不需要阅读信件。"],
      ["为什么访问权限不同", "Caretaker 只需要保存和交回快照，Originator 则需要读取快照才能恢复状态。窄接口向管理者隐藏内部字段，使历史管理功能不依赖对象的内部表示。"],
      ["另一个问题：独立变化", "在报表系统中，报表类型与渲染后端可以独立变化。如果每一种组合都建立子类，5 种报表与 4 种后端会得到 20 种组合。Bridge 将抽象与实现分离，让双方各自变化。"],
      ["检查两者的区别", "Memento 关注状态快照和恢复，Bridge 关注两个维度的独立变化。先确定要解决的问题，再选择模式。接下来用自己的话复述这些角色，然后在练习步骤里检验自己。"],
    ],
  },
  followup: { card: "memento-owner", question: "为什么快照不是历史管理者？",
    answer: "Memento 表示一份保存下来的状态；Caretaker 管理多份快照组成的历史；Originator 负责创建和恢复快照。\n\n*预先准备的示例讲解。*" },
  inbox: [
    { key: "help", kind: "followup", card: "memento-owner", detail: "示例讲解：快照与历史管理者的区别", minutesAgo: 20, read: false },
    { key: "note", kind: "note", card: "memento-owner", note: "memento", detail: "示例学习笔记已备好，可以编辑", minutesAgo: 35, read: false },
    { key: "link", kind: "link", card: "bridge-render", detail: "已关联前置题：两个独立变化的维度", minutesAgo: 1440, read: true },
  ],
};
