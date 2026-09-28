/* The hand-off that asks the main chat to fold fine-grained topics into topic
   groups. Shared by the knowledge-skeleton page and the library's reminder.
   Topics are read a page at a time: a whole large library in one result is
   spilled to a file that the chat would then try to parse with a shell. */

const NO_SHELL = "每次返回都可以直接阅读，不要用命令行或脚本去解析结果。";

export function groupPrompt({ mode, topicCount, ungrouped }) {
  if (mode === "merge")
    return (
      `学习库里有 ${ungrouped} 个主题还没归入主题组，请帮我归并：\n` +
      "1. 分批读取：用 study_workspace 的 skeleton.topics，payload 为 {\"compact\": true, \"samples\": 1, \"ungrouped\": true, \"limit\": 150}，每次只返回 150 个还没归入的主题；返回的 groups.groups 是已有主题组的标题。" + NO_SHELL + "\n" +
      "2. 能放进已有组的，沿用那个组的 title；放不进的新建组（组名是知识域名称，≤20 字，description 一句话说明范围）。\n" +
      "3. 每读一批就用 topic.groups.save 保存这一批，payload 为 {\"mode\": \"merge\", \"groups\": [{title, description?, topics: [主题 key]}]}；保存后用同样的 payload（offset 仍为 0）读下一批，直到 total 为 0。不要修改题目本身。\n" +
      "4. 最后告诉我它们分别归到了哪里。"
    );
  return (
    `学习库的主题太碎了（共 ${topicCount} 个，很多只有 1–2 题），请帮我按知识域归并成主题组：\n` +
    "1. 用 study_workspace 的 skeleton.topics 分页读取全部主题：payload 为 {\"compact\": true, \"samples\": 1, \"limit\": 200, \"offset\": 0}，按返回的 nextOffset 继续，直到没有 nextOffset；每条有 key、名称、题数、所在题组和一条示例题干。" + NO_SHELL + "\n" +
    "2. 归并成 12–30 个主题组：同一概念的不同叫法、中英文混写、被拆开的细主题（例如「XX 的定义」「XX 的计算」「XX 例题」「XX 与 YY 的区别」）放进同一组；按课程里的知识域划分（例如可用性度量与计算、冗余与容错、安全与风险、架构描述与视图、架构方法论、集成与通信……以实际主题为准）。组名用学习者熟悉的说法（≤20 字），description 用一句话说明范围。每个主题只进一个组；实在归不进去的放进「其他」组。\n" +
    "3. 用 topic.groups.save 保存，payload 为 {\"mode\": \"replace\", \"groups\": [{title, description, topics: [主题 key]}]}。这只是题目之上的分组，不要修改题目本身。\n" +
    "4. 最后列出分了哪些组、每组大概多少题。"
  );
}
