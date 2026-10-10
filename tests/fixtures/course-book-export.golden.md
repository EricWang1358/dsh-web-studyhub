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
| **可用性**（可用性、可用率、宕机、停机、故障、MTBF） · 在哪里：[H2](#h2)（H2-Q2） | ① List the components on the path and the availability of each (quoted from the stem, or an explicit assumption) ② Compute each component with A = MTBF / (MTBF + MTTR) when the stem gives MTBF and MTTR ③ Combine: series multiplies, independent parallel replicas give 1 - product of (1 - Ai) ④ Turn the result into yearly downtime with (1 - A) x 8760 h ⑤ Compare with the target and change the weakest part (redundancy, faster repair) if it is not met 公式：A = MTBF / (MTBF + MTTR)；independent components in series: A = A1 x A2 x ... x An；independent components in parallel: A = 1 - (1 - A1)(1 - A2)...(1 - An)；yearly downtime = (1 - A) x 8760 h | Adding availabilities instead of multiplying them in series；Treating replicas as independent when they share a failure (power, region, software)；No downtime in hours, so the target cannot be compared；Redundancy without its cost (more hardware, failover complexity)；把串联的可用性相加；代价：多一台服务器的费用。 |

### 按概念 {#lookup-concepts}

- **MTTR**：[H2](#h2)
- **串联**：[H2](#h2)
- **可用性**：[H2](#h2)
- **吞吐量**：[H3](#h3)

### 易错点 {#lookup-mistakes}

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
