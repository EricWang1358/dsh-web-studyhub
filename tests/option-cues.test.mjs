import test from "node:test";
import assert from "node:assert/strict";
import { optionCues, optionCueIssues } from "../lib/option-cues.js";

/* Choice options a learner can rule out without knowing the content (owner, 2026-11-05: 「选项还是有一点点太容易区分错误了」). Haladyna, Downing & Rodriguez (2002)
   list the cues test-wise students use; the program catches the mechanical ones (a repeated option, "all of the above", the correct option clearly the longest,
   an absolute word only in wrong options, a stem phrase echoed only by the correct option) and leaves everything fuzzy to the reviewer. Each check has options
   that must pass and options that must not. */

const card = (prompt, texts, correctAt = [0], kind = "quiz") => ({ id: "q", kind, prompt, topic: "t", objective: "o", answer: texts[correctAt[0]], hint: "h",
  explanation: "e", misconception: "m",
  options: texts.map((text, at) => ({ id: "abcdef"[at], text, correct: correctAt.includes(at), explanation: "why" })) });
const codes = (c, opts) => optionCues(c, opts).map((cue) => cue.code);

test("homogeneous options with a different misconception each pass, in Chinese and in English", () => {
  const zh = card("哈希索引为什么不适合范围查询？", ["哈希值不保留键的大小顺序，相邻的键会散落在不同的桶里", "哈希索引只能存放数字类型的键，范围条件无法比较大小",
    "哈希索引需要先对键排序，排序代价随范围变大而上升", "哈希索引的桶数固定，范围一大就会触发整张表重建"]);
  const en = card("Why does a hash index handle range queries badly?", ["Hashing scatters neighbouring keys, so their order is lost",
    "The index stores only numeric keys, so ranges cannot compare them", "The index must sort the keys first, and sorting cost grows with the range",
    "The bucket count is fixed, so a wide range forces a table rebuild"]);
  assert.deepEqual(optionCues(zh), []);
  assert.deepEqual(optionCues(en), []);
  assert.deepEqual(optionCueIssues({ cards: [zh, en] }), []);
});

test("short numeric and symbolic options are never an outlier or a repeat of one another", () => {
  assert.deepEqual(optionCues(card("The worst-case cost of heapsort?", ["O(n log n)", "O(n)", "O(n^2)", "O(log n)"])), []);
  assert.deepEqual(optionCues(card("12 m 还是 12 cm？", ["12 m", "12 cm", "120 m", "1.2 cm"])), []);
  assert.deepEqual(optionCues(card("哪个操作符是整除？", ["`//`", "`/`", "`%`", "`**`"])), []);
  assert.deepEqual(optionCues(card("Which language has the ++ operator?", ["C++", "C", "C#", "Go"])), []);
});

test("options that differ only in punctuation, case, width or a letter label are one option", () => {
  const zh = card("哪种结构按键有序？", ["B+ 树。", "哈希表", "无序堆", "b+树"]);
  assert.deepEqual(codes(zh), ["duplicate"]);
  assert.deepEqual(codes(card("Which keeps keys sorted?", ["A B+ tree", "A hash table", "An unsorted heap", "A. a b+ tree!"])), ["duplicate"]);
  assert.match(optionCueIssues({ cards: [zh] })[0], /^Card 1: option cue \(duplicate\): options a and d /);
});

test("'all of the above', 'none of the above' and 'A and B are both right' are not answers", () => {
  const stem = "下列哪项描述了事务的隔离性？", others = ["并发事务互不干扰", "事务提交后永久保存", "事务内的操作要么全做要么全不做"];
  for (const text of ["以上都对", "以上都正确", "以上皆是", "以上均不正确", "上述说法都不对", "以上全部", "都不正确", "A和B都对", "选项 A 与 C 均正确",
    "All of the above", "none of the above", "None of these", "Both A and C", "A and B are both correct", "all the above"])
    assert.ok(codes(card(stem, [...others, text])).includes("catchall"), text);
  for (const text of ["年龄在 18 岁以上的用户", "三个以上的节点", "Both operands must be integers", "None is returned when the key is missing",
    "All keys are unique within one bucket"])
    assert.ok(!codes(card(stem, [...others, text])).includes("catchall"), text);
});

test("the correct option clearly longer than every wrong one is a cue; a small or shared difference is not", () => {
  const long = "它先按键的字典序排好所有数据页，再在页上建立稀疏层级，所以范围扫描只需顺着叶子链表读取";
  const covering = "在查询列上建立索引并让它覆盖所需的所有列，避免回表读取整行";
  assert.deepEqual(codes(card("为什么 B+ 树适合范围扫描？", [long, "它把键散列到桶里", "它按插入顺序追加", "它只存放最小值"])), ["length"]);
  assert.deepEqual(codes(card("Why do B+ trees suit range scans?", ["The leaves are chained in key order, so a scan walks them in sequence",
    "Keys are hashed into buckets", "Rows are appended in insertion order", "Only minimum values are stored"])), ["length"]);
  // a few characters more is within what writers do by hand; the cue needs both a ratio and a gap
  assert.deepEqual(codes(card("Why?", ["Because of the sorted leaf chain", "Because keys are hashed", "Because rows are appended",
    "Because only minima are kept"])), []);
  // a long wrong option beside a long correct one hides nothing
  const spread = "它把所有的键散列到桶里，再按桶号依次读出每一个桶中的全部内容，最后合并";
  assert.deepEqual(codes(card("为什么 B+ 树适合范围扫描？", [long, spread, "它按插入顺序追加", "它只存放最小值"])), []);
  // the shortest correct option of a multi against the longest wrong one
  assert.deepEqual(codes(card("哪些做法能加快查询？", [long, covering, "它把键散列到桶里", "它按插入顺序追加"], [0, 1], "multi")), ["length"]);
  assert.deepEqual(codes(card("哪些做法能加快查询？", [long, "它把键散列到桶里", covering, "它按插入顺序追加"], [0, 2], "multi")), ["length"]);
  assert.deepEqual(codes(card("哪些做法能加快查询？", [long, "它把键散列到桶里", "它按插入顺序追加", "它只存放最小值"], [0, 1], "multi")), []);
});

test("absolute words in several wrong options but none in the correct one are a cue", () => {
  const right = "能减少需要读取的数据页，但写入要多维护一份";
  assert.deepEqual(codes(card("索引对查询有什么影响？", [right, "索引一定会让所有的查询都变得更快", "索引永远不会占用任何额外的空间", "索引总是比全表扫描要慢得多"])),
    ["absolute"]);
  assert.deepEqual(codes(card("What does an index do?", ["Cuts the pages read, at the cost of extra writes", "It always makes every query faster",
    "It never takes extra space", "It makes writes cheaper"])), ["absolute"]);
  // one such wrong option is a style choice, not a cue
  assert.deepEqual(codes(card("索引对查询有什么影响？", [right, "索引一定会让所有的查询都变得更快", "索引会降低读取的速度和命中率", "索引只在内存中才会生效使用"])), []);
  // the correct option using one as well hides it
  assert.deepEqual(codes(card("A UNIQUE index guarantees what?", ["Each key value appears at most once, always", "It never repeats a key and always sorts",
    "It always compresses the data", "It lowers write cost"])), []);
  // words that only look absolute: 完全二叉树, 唯一索引, 所有者, 一定的范围, 绝对值
  assert.deepEqual(codes(card("哪种树按层从左到右填满？", ["完全二叉树", "唯一索引树", "所有者树", "平衡二叉树"])), []);
  assert.deepEqual(codes(card("哪个函数返回非负值？", ["取绝对值函数", "在一定的范围内取整", "绝对值不超过一的随机数", "按符号取反"])), []);
});

test("a stem phrase echoed only by the correct option is a cue; terms every option shares are not", () => {
  const stem = "事务隔离级别为什么需要可重复读？";
  const echoing = ["事务隔离级别可重复读保证同一事务内两次读取一致", "避免脏页写回磁盘时因为断电而丢失更新", "减少锁等待时间并因此提高系统的吞吐量",
    "保证已经提交的数据在崩溃之后永久保存"];
  assert.deepEqual(codes(card(stem, echoing)), ["clang"]);
  assert.deepEqual(codes(card(stem, ["事务隔离级别可重复读保证同一事务内两次读取一致", "事务隔离级别串行化让并发事务排队执行",
    "事务隔离级别读未提交允许读到未提交数据", "事务隔离级别读已提交每次读取最新提交"])), []);
  assert.deepEqual(codes(card("Which property does a transaction isolation level guarantee?", ["Transaction isolation levels keep transactions apart",
    "Durability of committed rows after a crash", "Atomic commit of every single statement", "Referential integrity of foreign keys"])), ["clang"]);
  // a short, common word of the stem is not a cue, nor are the words every stem is made of
  assert.deepEqual(codes(card("下列关于缓存的说法，哪一项是正确的？", ["缓存命中时可以省去一次磁盘读取", "缓存会让所有读取变慢", "缓存只能保存数字", "缓存没有容量上限"])), []);
  // a stem is only known once it is written: the answer stage has none
  assert.deepEqual(codes(card(stem, echoing), { stem: false }), []);
  // a multi has no single option to echo
  assert.deepEqual(codes(card(stem, echoing, [0, 1], "multi")), []);
});

test("the issue lines name the card, the cue and the options, and other kinds are left alone", () => {
  const bad = card("下列哪项描述了事务的隔离性？", ["并发事务互不干扰", "事务提交后永久保存", "事务内的操作要么全做要么全不做", "以上都对"]);
  const issues = optionCueIssues({ cards: [card("x", ["a1", "b2", "c3"]), bad] });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^Card 2: option cue \(catchall\): option d /);
  const open = { id: "o", kind: "open", prompt: "p", options: [{ id: "a", text: "以上都对", correct: true }] };
  assert.deepEqual(optionCueIssues({ cards: [open, { id: "n", kind: "quiz", prompt: "p" }, null] }), []);
});
