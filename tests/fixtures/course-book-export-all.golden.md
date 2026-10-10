# 复习全书 · SA {#book}

## 查找 {#lookup}

### 目录 {#lookup-toc}

- [H1](#h1) 1 Introduction
  - [H2](#h2) 1.1 Availability
    - [H9](#h9) 我的推导
  - [H3](#h3) 1.2 Performance
- [U](#unplaced) 未归位

### 按题型 {#lookup-types}

**答题顺序**：题干事实 → 明示假设 → 设计/计算 → 为什么满足目标 → 失败与代价 → 如何验证

| 题型 · 题干信号 | 检查顺序 · 公式 | 最常见错误 · 必须交代的代价 |
| --- | --- | --- |
| **可用性**（可用性、可用率、宕机、停机、故障、MTBF） · 在哪里：[H2](#h2)（H2-Q2） | ① 列出路径上的部件和每个的可用性（引题干原话，或明示假设） ② 题干给了 MTBF 和 MTTR 时，用 A = MTBF / (MTBF + MTTR) 算每个部件 ③ 组合：串联相乘；独立的并联副本是 1 − ∏(1 − Ai) ④ 用 (1 − A) × 8760 小时换算成每年停机时间 ⑤ 和目标比较；达不到就改最弱的一环（冗余、更快修复） 公式：A = MTBF / (MTBF + MTTR)；独立部件串联：A = A1 × A2 × … × An；独立部件并联：A = 1 − (1 − A1)(1 − A2)…(1 − An)；每年停机 = (1 − A) × 8760 小时 | 串联时把可用性相加，而不是相乘；副本有共同故障（电源、机房、软件）却当成相互独立；没有换算成停机小时，无法和目标比较；只说冗余，不说代价（更多硬件、切换的复杂度）；把串联的可用性相加；代价：多一台服务器的费用。 |

### 按概念 {#lookup-concepts}

- **MTTR**：[H2](#h2)
- **串联**：[H2](#h2)
- **可用性**：[H2](#h2)
- **吞吐量**：[H3](#h3)

### 易错点（按知识点） {#lookup-mistakes}

- [H2](#h2) 1.1 Availability
  - 问过：为什么串联要相乘？
  - 易错：把串联的可用性相加（H2-Q2）

## 1 Introduction 〔H1〕 {#h1}

### 1.1 Availability 〔H2〕 {#h2}

关于：「Availability」

An AI paragraph under the heading.

**知识梳理**

- **可用性**：系统能提供服务的时间比例 [^h2g-1]。

**讲解**

串联时 A = A1 x A2。

**出处**

[^h2g-1]: 「Availability is the proportion of time」 · Lecture 4

**本节的题**

- **H2-Q1** Which is right?
  - A. Add them
  - B. Multiply them
  - C. Average them
- **H2-Q2** 一个系统由两台串联的服务器组成，求可用性。

#### 我的推导 〔H9〕 {#h9}

**MTTR** is the mean time to repair [^h2m-1].

串联 的可用性相乘。

- 另见 **H2-Q3** Fill the blank. A = MTBF / (MTBF + ＿＿)

[^h2m-1]: my own footnote

- **H2-Q1** Which is right?

> **追问：** 为什么串联要相乘？
>
> **答：** 因为相互独立。

### 1.2 Performance 〔H3〕 {#h3}

**讲解**

**吞吐量**是单位时间处理的请求数 [^h3g-1]。

**出处**

[^h3g-1]: 「Throughput is requests per second」

## 未归位 〔U〕 {#unplaced}

### Old point（已无对应知识点）

An old note [^unplaced-1].

[^unplaced-1]: an old footnote

## 答案册 {#answers}

### 1.1 Availability 〔H2〕 {#answers-h2}

**H2-Q1** 答案：B. Multiply them

解析：Independent parts in series multiply.

**H2-Q2** 答案：约 99.8%。

**题型**：可用性

**概念**

- **可用性**：「Availability is the proportion of time」

**假设**

- MTTR 为 2 小时

**推理链**

1. A = 1000 / (1000 + 2) = 0.998

**结论**

可用性约 99.8%。

**为什么满足目标**

达到目标。

**代价**

多一台服务器的费用。

**失败处理**

主备切换。

**如何验证**

做一次故障演练。

**易错检查**

- 把串联的可用性相加

**H2-Q3** 答案：MTTR
