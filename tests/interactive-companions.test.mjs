import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { compileMathExpression, evaluateSandboxPreview } from '../lib/companion-template/math-eval.js';
import { compileMathInLesson, renderTexToMathMl } from '../lib/companion-template/mathml.js';
import { buildLessonTemplateRuntimeJs, LESSON_TEMPLATE_RUNTIME_JS } from '../lib/companion-template/template-runtime.js';
import { LESSON_TEMPLATE_CSS } from '../lib/companion-template/template-styles.js';
import { normalizeLessonSpec, validateLessonSpec } from '../lib/companion-template/validate.js';
import { compileLessonHtml } from '../lib/companion-template/render-html.js';
import {
  applyFirstPassCredit,
  compileLessonCards,
  detokenizeLesson,
  extractEmbeddedLesson,
  extractWorkshopLesson,
  normalizeSandboxMathExpr,
  projectLessonSource,
} from '../lib/companion/companion-lesson.js';
import {
  MAX_COMPANION_BYTES,
  extractResilientLesson,
  readCheckedHtmlFile,
  readCompanionDocument,
  resolveUnbuiltLessonSources,
  sanitizeWindowsFilename,
  scopeCompanionArgs,
} from '../lib/companion/companions.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { mergeCourses } from '../lib/courses.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { estimateCalls, extractStructuredSourceExcerpt, planCompanionBuild } from '../lib/contexts/generation/companion/plan.js';
import { estimateOfCompanionPlan } from '../lib/contexts/generation/companion/start.js';
import { preRepairLessonSpec, preRepairLessonWithReport } from '../lib/contexts/generation/companion/jobs/companion-lesson-build.js';
import { StudyService } from '../lib/service.js';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const uiMod = await loadUi(`
  export { framedDocument, DiagramFrame } from './ui/diagram-frame.js';
  export { setUiLanguage } from './ui/i18n.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { default as CourseCompanionsBar } from './ui/companions/CourseCompanionsBar.jsx';
  export { default as CompanionBuildDialog, formatEstimateRange } from './ui/companions/CompanionBuildDialog.jsx';
  export { default as CompanionViewer } from './ui/companions/CompanionViewer.jsx';
  export { resolveCompanionTarget, resolveSourceCompanionTarget } from './ui/companions/companion-ref.js';
  export { default as LearningActions } from './ui/review/LearningActions.jsx';
  export { resultOpener } from './ui/tasks/task-actions.js';
  export { handOffText } from './ui/agent-prompts/index.js';
`);
const {
  framedDocument,
  DiagramFrame,
  setUiLanguage,
  StudyServicesContext,
  AppContext,
  CourseCompanionsBar,
  CompanionBuildDialog,
  formatEstimateRange,
  CompanionViewer,
  resolveCompanionTarget,
  resolveSourceCompanionTarget,
  LearningActions,
  resultOpener,
  handOffText,
} = uiMod;

const CJK_RE = /[\u3400-\u9fff]/;

function buildArchetypeLesson({ archetype = 'sandbox', language = 'zh', brokenSpotLine = false } = {}) {
  const en = language === 'en';
  const interactiveBlock = archetype === 'sandbox'
    ? {
        t: 'sandbox',
        caption: en ? 'Drag damping ratio $\\zeta$ to observe response' : '拖动阻尼比 $\\zeta$ 观察系统响应曲线',
        say: en ? 'Slide zeta from 0.2 to 1.2 and watch the oscillation vanish at critical damping.' : '把阻尼比从 0.2 拖到 1.2，亲眼看振荡在临界阻尼处消失。',
        knobs: [{ id: 'zeta', label: en ? 'Damping $\\zeta$' : '阻尼比 $\\zeta$', min: 0.1, max: 2.0, step: 0.05, default: 0.25, unit: '' }],
        domain: { variable: 't', min: 0, max: 10, steps: 60, label: 't' },
        series: [{ id: 'x', label: '$x(t)$', expr: 'exp(-zeta*t)*cos(sqrt(max(0.001, 1 - min(0.999, zeta^2)))*t)' }],
        readouts: [{ id: 'amp3', label: en ? 'Envelope at $t=3$' : '$t=3$ 包络幅值', expr: 'exp(-3*zeta)', unit: '' }],
        walk: [
          { set: { zeta: 0.2 }, say: en ? 'Underdamped: overshoots and rings.' : '欠阻尼：越过平衡位置来回振荡。' },
          { set: { zeta: 1.0 }, say: en ? 'Critically damped: fastest return without overshoot.' : '临界阻尼：最快回到平衡且零超调。', key: en ? '$\\zeta = 1$ separates oscillation from monotonic decay.' : '$\\zeta = 1$ 是振荡与单调衰减的分水岭。' },
        ],
      }
    : archetype === 'dialectic'
      ? {
          t: 'matrix',
          say: en ? 'Test both ethical theories against the same two edge cases.' : '把两种伦理学框架放进同一组极端思想实验里对撞。',
          frameworks: [
            { id: 'util', name: en ? 'Act Utilitarianism' : '行为功利主义' },
            { id: 'kant', name: en ? 'Kantian Deontology' : '康德义务论' },
          ],
          scenarios: [
            {
              id: 'transplant',
              title: en ? 'The Transplant Surgeon' : '器官移植医生困境',
              prompt: en ? 'Sacrifice one healthy visitor to save five dying patients?' : '牺牲一名健康体检者救活五名危重病人？',
              cells: [
                { badge: en ? 'Counterexample!' : '直觉反例', tone: 'bad', verdict: en ? 'Permitted by raw sum' : '纯算总账似乎允许', why: en ? 'Five lives outweigh one if rights are ignored.' : '只算净效用时五大于一，暴露忽视个体权利边界的漏洞。' },
                { badge: en ? 'Forbidden' : '绝对禁止', tone: 'ok', verdict: en ? 'Treats person as mere means' : '把人仅当作工具', why: en ? 'Violates the Humanity Formula.' : '违背人性公式，绝不可将无辜者当作纯粹手段。' },
              ],
            },
          ],
          walk: [
            { scenario: 'transplant', focus: 'util', say: en ? 'Notice where naive utility maximization collides with moral intuition.' : '看纯效用求和在哪里撞上道德直觉。', key: en ? 'Thought experiments isolate hidden axioms.' : '思想实验专门用来剥离理论的隐含前提。' },
          ],
        }
      : {
          t: 'schematic',
          say: en ? 'Step through the four-bar linkage force transmission up to the dead-point.' : '一步步跟着四杆机构的力流走到死点位置。',
          height: 260,
          nodes: [
            { id: 'crank', label: en ? 'Crank $AB$' : '曲柄 $AB$', sub: en ? 'Driver' : '主动件', x: 40, y: 100, w: 130, h: 52 },
            { id: 'coupler', label: en ? 'Coupler $BC$' : '连杆 $BC$', sub: en ? 'Collinear!' : '共线卡死', x: 240, y: 100, w: 130, h: 52 },
            { id: 'rocker', label: en ? 'Rocker $CD$' : '摇杆 $CD$', sub: en ? 'Follower' : '从动件', x: 440, y: 100, w: 130, h: 52 },
          ],
          edges: [
            { id: 'e1', from: 'crank', to: 'coupler', label: '$F_{BC}$' },
            { id: 'e2', from: 'coupler', to: 'rocker', label: '$\\gamma = 0^\\circ$' },
          ],
          walk: [
            { nodes: ['crank', 'coupler'], edges: ['e1'], tone: 'ok', say: en ? 'Crank drives coupler smoothly while transmission angle is large.' : '传动角充足时曲柄顺畅推动连杆。' },
            { nodes: ['coupler', 'rocker'], edges: ['e2'], tone: 'bad', states: { rocker: en ? 'Zero torque!' : '有效力矩归零！' }, say: en ? 'When coupler and crank align, transmission angle hits zero: dead point!' : '连杆与曲柄拉直共线时传动角归零，机构卡进死点！', key: en ? 'Dead point occurs when transmission angle $\\gamma = 0^\\circ$.' : '传动角 $\\gamma = 0^\\circ$ 时有效分力为零，形成死点。' },
          ],
        };

  return {
    format: 'studyhub-lesson/1',
    template: archetype,
    language,
    id: `${archetype}-${language}-demo`,
    course: en ? 'Cross-Discipline Lab' : '跨学科伴学实验课',
    title: en ? 'Why Critical Boundaries Break Naive Intuition' : '为什么临界边界会击穿朴素直觉？',
    lead: en ? 'See the failure first, then derive the exact invariant ($\\zeta = 1$).' : '先亲眼看见直觉翻车，再推导出精确不变量（$\\zeta = 1$）。',
    minutes: 25,
    needs: en ? ['Basic derivatives', ' Equilibrium'] : ['导数基础', '平衡态概念'],
    after: en ? ['Spot the hidden assumption', 'Apply the boundary criterion'] : ['揪出推导里的隐含前提', '用临界判据快速选型'],
    terms: en
      ? { 'Critical Damping': 'Smallest damping ratio $\\zeta = 1$ that prevents oscillation.', 'Transmission Angle': 'Acute angle $\\gamma$ governing force efficiency.' }
      : { '临界阻尼': '恰好不发生振荡的最小阻尼比 $\\zeta = 1$。', '传动角': '决定机构传力效率的锐角 $\\gamma$。' },
    slides: [
      { beat: 'open', title: en ? 'A Deceptively Simple Question' : '一个看似极其简单的问题', blocks: [{ t: 'text', md: en ? 'Consider energy cost $100 vs stability criterion $$\\Delta = \\zeta^2 - 1$$.' : '先看特征判别式 $$\\Delta = \\zeta^2 - 1$$ 与日常直觉的反差。', say: en ? 'Welcome! Let us start with a puzzle.' : '欢迎来到本节伴学课，我们先从一个反直觉现象切入。' }] },
      { beat: 'open', title: en ? 'Quick Foundation Check' : '两分钟地基热身', blocks: [{ t: 'recall', say: en ? 'Warm up two prerequisites before we dive in.' : '花一分钟唤醒两个前置直觉。', items: [{ have: en ? 'Derivative' : '导数符号', q: en ? 'If $dx/dt < 0$, $x(t)$ is...' : '当 $dx/dt < 0$ 时，$x(t)$ 正在…', options: [en ? 'Decreasing' : '减小', en ? 'Increasing' : '增大'], answer: 0, why: en ? 'Negative slope means decreasing.' : '导数为负代表函数单调下降。' }] }] },
      { beat: 'hook', title: en ? 'Everyday Intuition Mapping' : '生活场景映射', blocks: [{ t: 'scene', columns: [en ? 'Door Closer' : '自动闭门器', en ? 'System Model' : '系统模型'], story: en ? 'A heavy glass door swings back toward its frame.' : '一扇带液压闭门器的玻璃门松手后自动回弹。', say: en ? 'Map the door closer to our differential model.' : '把闭门器的松紧一一对应到方程参数。', picture: { actors: ['Spring', 'Damper'], shared: { name: 'zeta', value: '0.25' } }, map: [{ scene: en ? 'Oil viscosity' : '液压油阻尼阻力', code: 'zeta', on: 'shared', say: en ? 'Higher viscosity raises $\\zeta$.' : '油液阻力越大，阻尼比 $\\zeta$ 越高。' }] }] },
      { beat: 'code', title: en ? 'The Naive Derivation' : '第一版天真推导', blocks: [{ t: 'code', path: 'naive-proof.txt', lang: 'derivation', source: 'Step 1: Assume r1 != r2\nStep 2: Divide by (r1 - r2)\nStep 3: Take limit zeta -> 1', focusLines: [1, 2], say: en ? 'Read line 2 carefully.' : '仔细看第 2 行的除法操作。', walk: [{ focusLines: [2, 3], say: en ? 'What happens to the denominator at $\\zeta = 1$?' : '当 $\\zeta \\to 1$ 时分母会发生什么？' }] }] },
      { beat: 'predict', title: en ? 'Place Your Bet Before Testing' : '先盲猜下注，再跑实验', blocks: [{ t: 'predict', id: 'pred-crit', q: en ? 'What happens in Step 2 right when $\\zeta = 1$?' : '当 $\\zeta = 1$ 时，刚才第 2 步会发生什么？', options: [en ? 'Valid general solution' : '依然得到通解', en ? 'Division by zero (repeated root $r_1 = r_2$)' : '重根导致除以零失效'], answer: 1, say: en ? 'Commit to an answer first!' : '先凭直觉选一项，选错印象更深！' }] },
      { beat: 'run', title: en ? 'Interactive Exploration' : '亲手拉动交互实验台', blocks: [interactiveBlock, { t: 'reveal', of: 'pred-crit', say: en ? 'Compare your bet with the live model!' : '对照你刚才的盲猜结果看看！' }] },
      { beat: 'why', title: en ? 'Click the Exact Flawed Step' : '亲手点出藏雷的那一步', blocks: [{ t: 'spot', of: 'flaw-div0', path: 'flawed-derivation.txt', lang: 'proof', q: en ? 'Click the exact step with the hidden illegal division.' : '请点击左侧推导中隐含非法除零的那一行。', how: en ? 'Click a line on the left.' : '点击左侧行号。', source: '1. Characteristic eq: r^2 + 2*zeta*r + 1 = 0\n2. Divide both sides by (r1 - r2)\n3. Conclude x(t) = C1*exp(r1*t)', answerLines: [brokenSpotLine ? 99 : 2], hint: en ? 'Check where $r_1 - r_2 = 0$.' : '看看哪一行把可能为零的量放进了分母。', found: en ? 'Spot on! At $\\zeta=1$, $r_1=r_2=-1$, so dividing by $r_1-r_2$ divides by zero.' : '抓得准！$\\zeta=1$ 时出现重根，$r_1-r_2=0$ 不能作除数。', say: en ? 'Click the exact line where the proof breaks.' : '在左侧直接点出推导翻车的那一行。' }] },
      { beat: 'why', title: en ? 'Microscope Anatomy' : '显微镜逐行解剖', blocks: [{ t: 'inside', caption: en ? 'Boundary anatomy' : '重根边界解剖', command: 'Wronskian check', lang: 'derivation', source: 'x1(t) = exp(-t)\nx2(t) = t * exp(-t)\nW(t) = exp(-2t) != 0', say: en ? 'See why multiplying by $t$ restores linear independence.' : '看乘上因子 $t$ 后朗斯基行列式如何恢复非零。', walk: [{ focusLines: [2, 3], label: 'W != 0', say: en ? 'Non-zero Wronskian proves independence!' : '朗斯基行列式非零，两个解真正线性无关！', key: en ? 'Repeated roots require the secular factor $t e^{-t}$.' : '重根处必须引入长期项 $t e^{-t}$ 补齐解空间。' }] }] },
      { beat: 'fix', title: en ? 'Two Regimes Face to Face' : '双轨对照推演', blocks: [{ t: 'lanes', say: en ? 'Step through distinct roots vs repeated roots side by side.' : '左右并排推演异根与重根两条路径。', lanes: [en ? 'Case $\\zeta \\neq 1$' : '异根分支', en ? 'Boundary $\\zeta = 1$' : '临界重根分支'], shared: { name: 'Discriminant', start: 'zeta^2 - 1' }, steps: [{ lane: 0, op: 'read', text: 'r1 != r2', say: en ? 'Two independent exponentials.' : '两个不同指数解直接张成通解。' }, { lane: 1, op: 'write', value: '0 (double root)', tone: 'ok', text: '(C1 + C2*t)*exp(-t)', say: en ? 'Secular term $t e^{-t}$ completes the basis.' : '由 $t e^{-t}$ 补齐第二线性无关解。' }], verdict: en ? 'Always check discriminant zeros before dividing!' : '凡做参数除法，必先检验判别式为零的退化边界！', verdictSay: en ? 'That is the universal safeguard.' : '这就是防翻车的铁律。' }] },
      { beat: 'choose', title: en ? 'Regime Trade-offs' : '三种阻尼方案取舍对照', blocks: [{ t: 'choose', say: en ? 'Compare speed vs overshoot across regimes.' : '横向对比响应速度与超调代价。', columns: [en ? 'Strength' : '优势', en ? 'Cost' : '代价', en ? 'When to pick' : '适用场景'], options: [{ name: en ? 'Underdamped ($\\zeta < 1$)' : '欠阻尼 ($\\zeta < 1$)', solves: en ? 'Fast initial rise' : '初始上升快', cost: en ? 'Oscillatory overshoot' : '存在超调振荡', when: en ? 'overshoot is harmless' : '允许轻微摆动的场景', say: en ? 'Fast but rings.' : '快但会晃。' }, { name: en ? 'Critically damped ($\\zeta = 1$)' : '临界阻尼 ($\\zeta = 1$)', solves: en ? 'Fastest zero-overshoot settle' : '最快无超调收敛', cost: en ? 'Sensitive to parameter drift' : '对参数漂移敏感', when: en ? 'precision instruments & doors' : '精密仪表指针、闭门器', say: en ? 'The sweet spot!' : '快与稳的黄金临界点！' }], rule: en ? 'Need zero overshoot in minimum time? Target $\\zeta \\approx 1$.' : '要求零超调且最快复位时，锁定 $\\zeta \\approx 1$。', ruleSay: en ? 'Keep this one-line rule.' : '记住这条一句判准。' }] },
      { beat: 'choose', layout: 'split', title: en ? 'Decision Tree & Live Cases' : '决策树与实战选型', blocks: [{ t: 'decide', q: en ? 'Can the system tolerate overshoot?' : '系统允许越过平衡位置超调吗？', branches: [{ when: en ? 'No — collision or hard stop' : '绝不允许碰撞或超调', pick: 'Critical', eg: en ? 'Robotic surgical arm' : '手术机械臂定位' }, { when: en ? 'Yes — fast visual bounce ok' : '允许轻微回弹追求灵动感', pick: 'Underdamped', eg: en ? 'UI spring animation' : 'UI 弹性动效' }], say: en ? 'Follow the branch.' : '顺着条件往下走。' }, { t: 'cases', tools: ['Critical', 'Underdamped'], items: [{ text: en ? 'Precision CNC spindle homing against a fragile workpiece' : '精密数控主轴贴近易碎工件归零', answer: 0, why: en ? 'Any overshoot cracks the workpiece.' : '任何超调都会撞碎工件，必须临界/过阻尼。' }, { text: en ? 'Playful mobile card bounce animation' : '手机卡片轻快回弹动效', answer: 1, why: en ? 'Slight overshoot feels lively.' : '轻微欠阻尼回弹更有物理灵动感。' }], say: en ? 'Try two real engineering scenarios.' : '拿两个真实工程场景练练手。' }] },
      { beat: 'name', title: en ? 'Earning the Formal Name' : '最后再揭晓正式学名', blocks: [{ t: 'name', term: en ? 'Critical Damping' : '临界阻尼', alias: 'Critical Damping (zeta = 1)', oneLine: en ? 'The exact spectral degeneracy boundary separating oscillation from monotonic decay.' : '特征根发生重根退化、恰好分隔振荡与单调衰减的临界边界。', askedTitle: en ? 'Common exam & interview follow-ups' : '考试与面试高频追问', asked: [en ? 'Why does $t e^{-\\omega_n t}$ appear at $\\zeta = 1$?' : '为什么 $\\zeta=1$ 时通解会多出一个因子 $t$？', en ? 'Why do real designs often pick $\\zeta \\approx 0.707$?' : '工程上为什么常取 $\\zeta \\approx 0.707$？'], say: en ? 'Now the textbook definition feels obvious.' : '先看透机理再看定义，一行公式都不需要死记硬背。' }] },
      { beat: 'check', title: en ? 'Boundary Check 1' : '边界自测（一）', blocks: [{ t: 'quiz', q: en ? 'Why does the naive two-exponential formula fail at $\\zeta = 1$?' : '为什么在 $\\zeta = 1$ 处直接套双指数通解公式会丢解？', say: en ? 'Test your grasp of the degeneracy.' : '检验一下对重根退化的理解。', options: [{ text: en ? 'Energy is not conserved' : '因为能量守恒被破坏', ok: false, why: en ? 'Damped systems always dissipate energy.' : '任何正阻尼都在耗散能量，与丢解无关。' }, { text: en ? 'Both characteristic roots collapse to $-1$, leaving only a 1D span without $t e^{-t}$' : '两个特征根重合为 $-1$，不乘 $t$ 就只剩一维解空间', ok: true, why: en ? 'A 2nd-order ODE needs two linearly independent solutions.' : '二阶方程必须有两个线性无关解才能满足任意初值。' }, { text: en ? 'Complex numbers are undefined' : '因为复数域失效', ok: false, why: en ? 'Roots are real at $\\zeta = 1$.' : '此时特征根是实数 $-1$。' }, { text: en ? 'Mass becomes zero' : '因为等效质量归零', ok: false, why: en ? 'Mass is constant.' : '系统质量并未改变。' }] }] },
      { beat: 'check', title: en ? 'Boundary Check 2' : '边界自测（二）', blocks: [{ t: 'quiz', q: en ? 'As $t \\to \\infty$, why does $t e^{-t}$ still decay to $0$?' : '当 $t \\to \\infty$ 时，为什么 $t e^{-t}$ 依然收敛到 $0$？', say: en ? 'One more check on asymptotic growth.' : '再测一道渐近阶对比。', options: [{ text: en ? 'Because $t$ stops growing' : '因为 $t$ 有上界', ok: false, why: en ? '$t$ grows unboundedly.' : '时间 $t$ 趋于无穷大。' }, { text: en ? 'Exponential decay $e^{-t}$ dominates any polynomial growth $t$' : '指数衰减 $e^{-t}$ 的阶远快于线性增长 $t$', ok: true, why: en ? 'By L’Hôpital’s rule, $\\lim_{t\\to\\infty} t/e^t = 0$.' : '由洛必达法则，$\\lim_{t\\to\\infty} t/e^t = 0$。' }, { text: en ? 'Cosine cancels it' : '因为余弦项相消', ok: false, why: en ? 'There is no cosine factor at $\\zeta = 1$.' : '临界阻尼项不含余弦因子。' }, { text: en ? 'Initial velocity is always zero' : '因为初速度必为零', ok: false, why: en ? 'Holds for any finite initial state.' : '对任意有限初值均收敛回零。' }] }] },
      { beat: 'say', title: en ? 'Explain It Aloud in 2 Minutes' : '合上笔记，两分钟开口讲透', blocks: [{ t: 'say', seconds: 120, prompt: en ? 'Explain why $\\zeta = 1$ requires $t e^{-t}$ and how engineers choose $\\zeta$ in practice.' : '用你自己的话讲清：为什么 $\\zeta=1$ 会多出 $t e^{-t}$，以及工程上怎么选阻尼比？', points: [en ? 'Characteristic discriminant $\\zeta^2 - 1$ hits zero at $\\zeta = 1$' : '特征方程判别式在 $\\zeta=1$ 处归零出现重根', en ? 'Two exponentials collapse into one, requiring $t e^{-t}$ for Wronskian != 0' : '双指数退化为同一函数，需引入 $t e^{-t}$ 保证朗斯基行列式非零', en ? '$\\zeta < 1$ rings while $\\zeta > 1$ returns sluggishly' : '$\\zeta < 1$ 会超调振荡，$\\zeta > 1$ 回位拖沓', en ? 'Critical damping gives fastest non-overshooting return' : '临界阻尼实现最快无超调复位'], model: en ? 'At $\\zeta = 1$, the characteristic equation $(r+1)^2 = 0$ has a repeated root, so $e^{-t}$ alone spans only 1D; multiplying by $t$ yields $t e^{-t}$ with non-zero Wronskian, giving the fastest return without overshoot.' : '当 $\\zeta=1$ 时特征方程出现重根 $r=-1$，仅靠 $e^{-t}$ 只有一个独立解，乘上因子 $t$ 得到 $t e^{-t}$ 才能凑齐二阶方程所需的两个线性无关解；物理上它恰好压住振荡又比过阻尼更快回到平衡。', say: en ? 'Speak it out loud before checking the model answer!' : '先自己开口说一遍，再点开参考表达对照！' }] },
      { beat: 'take', title: en ? 'Three Takeaways for Your Pocket' : '装进口袋的三张带走卡', blocks: [{ t: 'cards', say: en ? 'Three crisp cards to lock this in.' : '三张精华卡片收尾。', items: [{ q: en ? 'What defines critical damping $\\zeta = 1$?' : '临界阻尼 $\\zeta = 1$ 的核心特征是什么？', a: en ? 'Repeated root $r_1 = r_2$; fastest return to equilibrium with zero overshoot.' : '特征根重合，系统以最快速度回到平衡位置且零超调。' }, { q: en ? 'Why must we check denominators in parametric proofs?' : '含参推导做除法前必须检查什么？', a: en ? 'Parameter values where the divisor vanishes (spectral degeneracy).' : '分母随参数退化为零的临界点（如重根、共振、共线死点）。' }, { q: en ? 'General solution of $\\ddot{x} + 2\\dot{x} + x = 0$?' : '$\\ddot{x} + 2\\dot{x} + x = 0$ 的通解形式？', a: '$(C_1 + C_2 t)e^{-t}$.' }] }] },
    ],
  };
}

test('Layer 1: safe AST math evaluator, offline KaTeX MathML compiler, 18-rule validator & 4-archetype HTML compiler', () => {
  // 0. Embedded browser runtime JS parses cleanly with zero syntax errors in both languages
  assert.doesNotThrow(() => new vm.Script(LESSON_TEMPLATE_RUNTIME_JS));
  assert.doesNotThrow(() => new vm.Script(buildLessonTemplateRuntimeJs('en')));

  // 1. Safe AST math evaluator (0 eval)
  const val = compileMathExpression('exp(-zeta * t) * cos(pi * t)').evaluate({ zeta: 0.5, t: 2 });
  assert.ok(Math.abs(val - Math.exp(-1)) < 1e-9);
  assert.ok(Number.isNaN(compileMathExpression('1 / 0').evaluate({})));
  assert.throws(() => compileMathExpression('process.exit(1)'), /Unexpected|Unsupported|Invalid/i);
  assert.throws(() => compileMathExpression('constructor'), /Forbidden identifier/i);

  const sampled = evaluateSandboxPreview({
    knobs: [{ id: 'zeta', min: 0.1, max: 2, default: 0.5 }],
    domain: { variable: 't', min: 0, max: 4, steps: 20 },
    series: [{ id: 'y', expr: 'exp(-zeta*t)' }],
  });
  assert.equal(sampled.series[0].samplePoints.length, 21);
  assert.equal(sampled.series[0].samplePoints[0][1], 1);

  // 2. Offline KaTeX -> MathML side table (preserving $100 currency & raw source/expr)
  const rawLesson = buildArchetypeLesson({ archetype: 'sandbox', language: 'en' });
  const withMath = compileMathInLesson(rawLesson);
  assert.ok(Array.isArray(withMath._math) && withMath._math.length >= 4);
  assert.ok(withMath._math.every(entry => entry.mathml.startsWith('<math') && entry.mathml.endsWith('</math>')));
  // Currency "$100" stays literal while "$$\\Delta = \\zeta^2 - 1$$" becomes a token
  assert.match(withMath.slides[0].blocks[0].md, /\$100/);
  assert.match(withMath.slides[0].blocks[0].md, /@@SHM_\d+@@/);
  // Sandbox expr must NEVER have math tokens substituted
  const sbBlock = withMath.slides[5].blocks[0];
  assert.equal(sbBlock.series[0].expr, 'exp(-zeta*t)*cos(sqrt(max(0.001, 1 - min(0.999, zeta^2)))*t)');

  // 3. All cross-discipline archetypes validate under strictPedagogy & compile to self-contained HTML
  for (const [arch, lang] of [['sandbox', 'zh'], ['dialectic', 'en'], ['mechanism', 'zh']]) {
    const spec = buildArchetypeLesson({ archetype: arch, language: lang });
    const check = validateLessonSpec(spec, { strictPedagogy: true });
    assert.equal(check.ok, true, `${arch}/${lang} failed validation: ${check.errors.join('; ')}`);

    const { html, lesson } = compileLessonHtml(spec, { strictPedagogy: true });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(!/https?:\/\/(?!www\.w3\.org\/)/i.test(html), 'Compiled HTML must have zero external CDN URLs');
    assert.ok(html.includes('studyhub-companion/1'), 'Compiled HTML must include native StudyHub bridge');
    assert.equal(lesson.slides.length, 16);
    if (lang === 'en') {
      assert.ok(!CJK_RE.test(html), 'English compiled HTML must contain zero Chinese characters');
    }
  }

  // 4. XSS resistance: hostile `<script>` / `<img onerror>` in prose never escapes JSON or renders raw tags
  const hostile = buildArchetypeLesson({ archetype: 'dialectic', language: 'en' });
  hostile.slides[0].blocks[0].md = '</script><img src=x onerror=alert(1)>';
  const compiledHostile = compileLessonHtml(hostile);
  assert.ok(!compiledHostile.html.includes('</script><img'), 'Embedded JSON must escape </script>');
});

test('Real-world Java Hood Lab compatibility: cas-aba.html embedded lesson round-trips cleanly when present', async () => {
  const realCasHtml = 'D:/A/1NUS/resume-workshop/八股项目/lab/pages/cas-aba.html';
  const info = await stat(realCasHtml).catch(() => null);
  if (!info?.isFile()) return;
  const rawHtml = await readFile(realCasHtml, 'utf8');
  const embedded = extractEmbeddedLesson(rawHtml);
  assert.ok(embedded, 'Should extract embedded #lesson-data from cas-aba.html');
  const check = validateLessonSpec(embedded, { strictPedagogy: false });
  assert.equal(check.ok, true, `cas-aba embedded lesson failed validation: ${check.errors.join('; ')}`);
  const compiled = compileLessonHtml(embedded, { strictPedagogy: false });
  assert.ok(compiled.html.includes('Compare-And-Swap'));
  assert.ok(compiled.lesson.slides.length >= 16);
});

test('Layer 2: companion.compile, directory pack attach (ADR-2/3), FSRS preservation, First-Pass Credit, catch-up cards & LWW feedback sync', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'sh-comp-l2-'));
  try {
    const storeDir = join(tmp, 'library');
    const workspaceDir = join(tmp, 'workspace');
    const externalLabDir = join(tmp, 'external-lab');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(join(externalLabDir, 'pages'), { recursive: true });
    await mkdir(join(externalLabDir, 'feedback'), { recursive: true });

    const mockLight = async () => JSON.stringify({
      answerMarkdown: 'At $\\zeta = 1$, repeated roots collapse $e^{-t}$ to 1D, so $t e^{-t}$ restores linear independence.',
      suggestedCard: {
        prompt: 'Why is $t e^{-t}$ needed at $\\zeta = 1$?',
        answer: 'Repeated characteristic roots collapse to one exponential; $t e^{-t}$ has non-zero Wronskian with $e^{-t}$.',
        misconception: 'Assuming $C_1 e^{-t} + C_2 e^{-t}$ still spans two dimensions.',
      },
    });
    const coordinator = new StudyService(storeDir, { complete: mockLight, light: mockLight });

    // 1. Security: scopeCompanionArgs strips spoofed workspace & blocks unauthorized external folders
    const scoped = scopeCompanionArgs('companion.attach', { path: externalLabDir, workspace: '/spoofed', allowRememberTrusted: true }, workspaceDir, '', { fromPanel: false });
    assert.equal(scoped.workspace, workspaceDir);
    assert.equal(scoped.allowRememberTrusted, undefined);
    await assert.rejects(
      () => coordinator.call('companion.attach', scoped),
      /不在当前工作区或已授权伴学目录内/,
    );

    // 2. Compile a Mathematics/Vibrations lesson on a blank course -> `full-pack` mode + dual workspace files (ADR-9)
    const mathSpec = buildArchetypeLesson({ archetype: 'sandbox', language: 'zh' });
    const compiledRes = await coordinator.call('companion.compile', {
      course: '机械振动',
      lesson: mathSpec,
      workspace: workspaceDir,
    });
    assert.equal(compiledRes.sync.mode, 'full-pack');
    assert.equal(compiledRes.sync.cardsAdded, 6); // 3 takeaways + 2 quizzes + 1 oral synthesis
    const diskHtml = await readFile(compiledRes.htmlPath, 'utf8');
    const diskJson = JSON.parse(await readFile(compiledRes.jsonPath, 'utf8'));
    assert.ok(diskHtml.includes('<!doctype html>'));
    assert.equal(diskJson.format, 'studyhub-lesson/1');

    // 3. First-Pass Credit on interactive walkthrough completion (passed check:0, failed check:1)
    const progRes = await coordinator.call('companion.progress', {
      id: compiledRes.companion.id,
      course: '机械振动',
      slide: 16,
      slideTotal: 16,
      completed: true,
      checkResults: { 'check:0': true, 'check:1': false },
    });
    assert.equal(progRes.firstPassCredited, 4); // 3 takeaways + 1 passed check; failed check:1 stays due!

    // 4. Re-compile with updated prose & one flipped quiz key -> 3-tier FSRS schedule preservation
    const updatedSpec = structuredClone(mathSpec);
    updatedSpec.slides[15].blocks[0].items[0].a = '更新后的精炼表述：重根临界、最快无超调复位。';
    // Flip answer key of Boundary Check 1 (slide index 12)
    updatedSpec.slides[12].blocks[0].options[1].ok = false;
    updatedSpec.slides[12].blocks[0].options[0].ok = true;

    await coordinator.call('companion.registerGenerated', {
      companionId: compiledRes.companion.id,
      course: '机械振动',
      title: updatedSpec.title,
      bytes: Buffer.byteLength(diskHtml),
      sha256: compiledRes.companion.sha256,
      workspacePath: compiledRes.htmlPath,
      lessonJsonPath: compiledRes.jsonPath,
      lesson: normalizeLessonSpec(updatedSpec),
      mountMode: 'full-pack',
      grounded: true,
    });
    const stateAfterUpdate = await coordinator.store.read();
    const vibDeck = stateAfterUpdate.decks.find(d => d.companionId === compiledRes.companion.id);
    const take0 = vibDeck.cards.find(c => c.companionRef?.slot === 'take:0');
    const check0 = vibDeck.cards.find(c => c.companionRef?.slot === 'check:0');
    assert.equal(take0.review.reps, 1, 'Prose-only update must preserve FSRS reps');
    assert.equal(check0.review.reps ?? 0, 0, 'Flipped quiz answer key must reset FSRS schedule');

    // 5. Directory pack mount on a course that ALREADY has an existing deck -> `enrich-existing` + high-confidence card matching (ADR-2 & ADR-3)
    const philSpec = buildArchetypeLesson({ archetype: 'dialectic', language: 'en' });
    philSpec.course = 'Moral Philosophy';
    const { html: philHtml } = compileLessonHtml(philSpec);
    await writeFile(join(externalLabDir, 'pages', 'ethics-clash.html'), philHtml, 'utf8');
    await writeFile(join(externalLabDir, 'feedback', 'questions.json'), JSON.stringify({
      version: 1,
      updatedAt: '2026-11-16T00:00:00.000Z',
      items: [{
        id: 'ext-1',
        lessonId: philSpec.id,
        lessonTitle: philSpec.title,
        course: 'Moral Philosophy',
        slide: 3,
        slideTotal: 16,
        slideTitle: 'Scene',
        tag: 'deepen',
        note: 'Existing question from study.mjs',
        status: 'open',
        createdAt: '2026-11-16T00:00:00.000Z',
        updatedAt: '2099-01-01T00:00:00.000Z', // newer timestamp: LWW must not overwrite!
      }],
    }, null, 2), 'utf8');

    // Seed an existing course deck with 1 matching card ("Critical Damping") and 1 unrelated card ("Plato Cave")
    await coordinator.store.update(st => {
      st.sources.push({ id: 'src-phil-1', title: 'Ethics Notes', text: 'Critical Damping and Transmission Angle are exact technical terms; Plato allegory of the cave is unrelated.', courses: ['Moral Philosophy'], createdAt: new Date().toISOString() });
      st.decks.push({
        id: 'deck-phil-existing',
        title: 'Philosophy Core',
        course: 'Moral Philosophy',
        cards: [
          {
            id: 'card-match',
            kind: 'flashcard',
            topic: 'Critical Damping',
            objective: 'Understand Critical Damping boundary',
            prompt: 'How does Critical Damping behave at the boundary?',
            answer: 'No oscillation.',
            explanation: 'Core boundary.',
            misconception: 'None',
            citations: [{ sourceId: 'src-phil-1', quote: 'Critical Damping and Transmission Angle are exact technical terms' }],
            review: { reps: 2, lapses: 0, state: 2, stability: 5, difficulty: 5, due: new Date().toISOString() },
          },
          {
            id: 'card-unrelated',
            kind: 'flashcard',
            topic: 'Plato Cave',
            objective: 'Understand Plato allegory',
            prompt: 'What do shadows represent in Plato allegory of the cave?',
            answer: 'Sensory appearances.',
            explanation: 'Book VII.',
            misconception: 'None',
            citations: [{ sourceId: 'src-phil-1', quote: 'Plato allegory of the cave is unrelated.' }],
            review: { reps: 1, lapses: 0, state: 2, stability: 3, difficulty: 5, due: new Date().toISOString() },
          },
        ],
      });
    });

    const packRes = await coordinator.call('companion.attach', {
      path: externalLabDir,
      course: 'Moral Philosophy',
      allowRememberTrusted: true,
    });
    assert.equal(packRes.kind, 'directory');
    assert.equal(packRes.attached, 1);
    assert.equal(packRes.cardsLinked, 1, 'Only high-confidence matching card should receive companionRef');
    assert.equal(packRes.cardsAdded, 1, 'Enrich-existing should only add the 1 oral synthesis drill, zero duplicate flashcards');

    const philList = await coordinator.call('companion.list', { course: 'Moral Philosophy' });
    const linkedCompId = philList.companions[0].id;

    // 6. In-page micro-context tutor (`companion.ask`) + 1-click Catch-up Card (`companion.catchup.save`) + LWW `questions.json` sync
    const askRes = await coordinator.call('companion.ask', {
      id: linkedCompId,
      course: 'Moral Philosophy',
      language: 'en',
      question: 'Why does raw utility sum allow the transplant?',
      context: { lessonTitle: philSpec.title, slide: 6, slideTitle: 'Interactive Exploration', quote: 'Sacrifice one healthy visitor' },
    });
    assert.ok(askRes.answerMarkdown.includes('Wronskian') || askRes.answerMarkdown.length > 10);
    assert.ok(askRes.suggestedCard?.prompt);

    const catchupRes = await coordinator.call('companion.catchup.save', {
      companionId: linkedCompId,
      course: 'Moral Philosophy',
      slide: 6,
      slideTotal: 16,
      slideTitle: 'Interactive Exploration',
      quote: 'Sacrifice one healthy visitor',
      prompt: askRes.suggestedCard.prompt,
      answer: askRes.suggestedCard.answer,
      misconception: askRes.suggestedCard.misconception,
      syncFeedback: true,
      language: 'en',
    });
    assert.equal(catchupRes.deckTitle, 'Companion Catch-ups');
    assert.equal(catchupRes.feedbackSynced, true);

    // Attempt stale overwrite on `ext-1` -> LWW keeps `2099` version intact!
    await coordinator.call('companion.feedback.sync', {
      id: linkedCompId,
      course: 'Moral Philosophy',
      item: { id: 'ext-1', note: 'Stale overwrite attempt', updatedAt: '2020-01-01T00:00:00.000Z' },
    });
    const mergedFeedback = JSON.parse(await readFile(join(externalLabDir, 'feedback', 'questions.json'), 'utf8'));
    assert.equal(mergedFeedback.items.length, 2);
    assert.equal(mergedFeedback.items.find(i => i.id === 'ext-1').note, 'Existing question from study.mjs');

    // Undo catch-up card
    const undoRes = await coordinator.call('companion.catchup.remove', { deckId: catchupRes.deckId, cardId: catchupRes.cardId });
    assert.equal(undoRes.removed, true);

    // 7. Portable backup & restore: `managed` companion included, `linked` directory pack adds 0 files
    const exported = await coordinator.call('export', {});
    assert.equal(exported.portableCompanions.files.length, 1, 'Only managed companions travel in portable backups; linked packs add 0 bloat');
    assert.equal(exported.portableCompanions.files[0].id, compiledRes.companion.id);

    const freshDir = join(tmp, 'restored-lib');
    const restoredSvc = new StudyService(freshDir, {});
    await restoredSvc.call('restore', { state: exported });
    const restoredDoc = await restoredSvc.call('companion.get', { id: compiledRes.companion.id, course: '机械振动' });
    assert.ok(restoredDoc.html.includes('<!doctype html>'));
    restoredSvc.dispose();
    coordinator.dispose();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Layer 3: 4-stage generation.companion.build Job (estimate, Stage 3 auto-repair, dual file output & resultOpener)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'sh-comp-l3-'));
  try {
    const storeDir = join(tmp, 'library');
    const workspaceDir = join(tmp, 'workspace');
    await mkdir(workspaceDir, { recursive: true });

    const brokenFull = buildArchetypeLesson({ archetype: 'mechanism', language: 'zh', brokenSpotLine: true });
    const fixedFull = buildArchetypeLesson({ archetype: 'mechanism', language: 'zh', brokenSpotLine: false });
    const act1Slides = brokenFull.slides.slice(0, 8);
    const act2Slides = brokenFull.slides.slice(8);

    const modelCalls = [];
    const mockComplete = async (system, prompt) => {
      modelCalls.push({ system: system.slice(0, 80), promptLen: prompt.length });
      if (system.includes('curriculum architect')) {
        return JSON.stringify({
          id: 'four-bar-dead-point',
          archetype: 'mechanism',
          title: fixedFull.title,
          lead: fixedFull.lead,
          minutes: 25,
          needs: fixedFull.needs,
          after: fixedFull.after,
          terms: fixedFull.terms,
          act1Slides: act1Slides.map((s, i) => ({ slide: i + 1, beat: s.beat, title: s.title })),
          act2Slides: act2Slides.map((s, i) => ({ slide: i + 9, beat: s.beat, title: s.title })),
        });
      }
      if (prompt.includes('You are authoring Act I ')) return JSON.stringify({ slides: act1Slides });
      if (prompt.includes('You are authoring Act II ')) return JSON.stringify({ slides: act2Slides });
      if (prompt.includes('repairing specific validation errors')) return JSON.stringify(fixedFull);
      throw new Error(`Unexpected prompt: ${system.slice(0, 60)}`);
    };

    const coordinator = new StudyService(storeDir, {
      complete: mockComplete,
      light: mockComplete,
      ...switchOptions('runtime', { complete: mockComplete }),
    });

    // 1. Zero-material free-topic estimate (`grounded: false`, 0 model calls)
    const est = await coordinator.call('generation.companion.build', {
      course: '机械原理',
      topic: '四杆机构的急回特性与死点成因',
      archetype: 'mechanism',
      estimate: true,
    });
    assert.equal(est.status, 'estimate');
    assert.equal(est.grounded, false);
    assert.deepEqual(est.estimate.calls, { low: 3, high: 4 });
    assert.ok(est.estimate.inputTokens.low > 500 && est.estimate.outputTokens.low > 1000, 'Companion estimate must produce non-zero token ranges');
    assert.ok(est.estimate.totalTokens.high > est.estimate.totalTokens.low, 'Companion estimate totalTokens must be a real range');
    assert.equal(modelCalls.length, 0);

    // 2. Submit real 4-stage Job (triggers Stage 3 repair because act1Slides has brokenSpotLine: 99!)
    const started = await coordinator.call('generation.companion.build', {
      course: '机械原理',
      topic: '四杆机构的急回特性与死点成因',
      archetype: 'mechanism',
      workspace: workspaceDir,
    });
    assert.equal(started.status, 'running');
    assert.ok(started.jobId.startsWith('companion-'));

    // Poll until Job completes
    let finalJob = null;
    for (let i = 0; i < 80; i++) {
      const snap = await coordinator.call('snapshot', {});
      const found = snap.jobs.find(j => j.id === started.jobId);
      if (found && (found.status === 'complete' || found.status === 'failed')) {
        finalJob = found;
        break;
      }
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(finalJob, 'Companion build job did not settle');
    assert.equal(finalJob.status, 'complete', `Job failed: ${finalJob.error?.message || JSON.stringify(finalJob)}`);
    assert.equal(modelCalls.length, 4, 'Should execute Blueprint + Act I + Act II + Stage 3 Repair');
    assert.equal(finalJob.contract.detail.repaired, true);

    // Verify resultOpener wires Task Console directly to CompanionViewer modal
    let openedModal = null;
    const opener = resultOpener(finalJob, { set: { setModal: m => { openedModal = m; } }, data: await coordinator.store.read() });
    assert.equal(opener?.kind, 'companion');
    opener.run();
    assert.equal(openedModal?.type, 'companion');

    // Verify dual files on disk & unverified provenance on free-topic build (ADR-9 & ADR-10)
    const state = await coordinator.store.read();
    const courseRec = state.courses.find(c => c.name === '机械原理');
    assert.equal(courseRec.companions.length, 1);
    assert.equal(courseRec.companions[0].grounded, false);
    const projectedSrc = state.sources.find(s => s.id === courseRec.companions[0].sourceId);
    assert.equal(projectedSrc.provenance, 'ai-drafted-unverified');
    coordinator.dispose();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Layer 4: DiagramFrame universal companion shim & zero-Chinese English UI SSR', () => {
  // 1. 1-arg framedDocument stays untouched; 2-arg injects boot JSON + strips relative study-notes.js
  const legacyLabHtml = '<!doctype html><html><head><title>CAS</title></head><body><script src="../assets/study-notes.js"></script><main>Slide</main></body></html>';
  const plain = framedDocument(legacyLabHtml);
  assert.ok(!plain.includes('sh-companion-boot'));

  const booted = framedDocument(legacyLabHtml, {
    channelToken: 'tok-123', theme: 'dark', initialAnchor: '#6', memory: {}, language: 'en',
  });
  assert.ok(booted.includes('id="sh-companion-boot"'));
  assert.ok(!booted.includes('../assets/study-notes.js'), 'Relative study-notes.js must be stripped in srcdoc');
  assert.ok(booted.includes('UNIVERSAL_COMPANION_SHIM') || booted.includes('studyhub-companion/1'));

  const iframeMarkup = renderToStaticMarkup(
    React.createElement(DiagramFrame, {
      html: legacyLabHtml,
      title: 'CAS Companion',
      companion: { channelToken: 'tok-123', theme: 'light', language: 'en' },
    }),
  );
  assert.match(iframeMarkup, /sandbox="allow-scripts"/);

  // 2. Render English UI components & hand-off prompt -> verify 0 Chinese characters
  setUiLanguage('en');
  try {
    const fakeStudy = {
      busy: false,
      call: async () => ({}),
      act: async () => ({}),
      notify: () => {},
      openModal: () => {},
    };
    const fakeApp = {
      data: {
        focus: { course: 'Moral Philosophy', courses: ['Moral Philosophy'] },
        courses: [{
          id: 'c-phil',
          name: 'Moral Philosophy',
          companions: [{ id: 'comp-1', title: 'Kantian Duty vs Utility', slideCount: 16, grounded: false, progress: { slide: 5, slideTotal: 16 } }],
        }],
        sources: [{ id: 's1', title: 'Groundwork Excerpt', courses: ['Moral Philosophy'], text: '...' }],
        decks: [],
      },
      core: { refresh: () => {} },
    };

    const barHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: fakeApp },
          React.createElement(CourseCompanionsBar, { course: 'Moral Philosophy', data: fakeApp.data }),
        ),
      ),
    );
    assert.ok(barHtml.includes('Interactive Companions'));
    assert.ok(barHtml.includes('AI-drafted'));
    assert.ok(!CJK_RE.test(barHtml), `Unexpected CJK in English CourseCompanionsBar: ${barHtml}`);

    const dialogHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: fakeApp },
          React.createElement(CompanionBuildDialog, { modal: { course: 'Moral Philosophy' }, onClose: () => {} }),
        ),
      ),
    );
    assert.ok(dialogHtml.includes('Build HTML Companion'));
    assert.ok(!CJK_RE.test(dialogHtml), `Unexpected CJK in English CompanionBuildDialog: ${dialogHtml}`);

    const actionsHtml = renderToStaticMarkup(
      React.createElement(LearningActions, {
        session: {
          run: {
            deckId: 'd1',
            mode: 'review',
            feedback: { correct: false },
            card: { id: 'c1', companionRef: { companionId: 'comp-1', anchor: '#6', slide: 6, label: 'Slide 6 · Matrix' } },
            solution: { citations: [] },
          },
          entry: {},
          teachingBusy: false,
          teachingError: null,
          actions: { teachingAct: () => {}, cancelTeaching: () => {}, retryTeaching: () => {} },
        },
        data: fakeApp.data,
        model: { ready: true, reason: 'ok', label: 'mock' },
        onModelSettings: () => {},
        openModal: () => {},
      }),
    );
    assert.ok(actionsHtml.includes('Open companion · Slide 6 · Matrix'));
    assert.ok(!CJK_RE.test(actionsHtml), `Unexpected CJK in English LearningActions: ${actionsHtml}`);

    const handoff = handOffText('companion.ask', {
      course: 'Moral Philosophy',
      title: 'Kantian Duty',
      slide: 6,
      slideTitle: 'Transplant Case',
      quote: 'Mere means',
      contextText: 'Slide 6',
      question: 'Why does universalizability fail?',
    }, 'en');
    assert.ok(!CJK_RE.test(handoff), `English companion.ask hand-off must contain zero CJK: ${handoff}`);
  } finally {
    setUiLanguage('zh');
  }
});

test('Wave 1 Stage Engine: university STEM & modal logic MathML, sandbox crosshair/threshold & schematic feedback Bezier curves', () => {
  // 1. Extended W3C MathML (Temml): cases, integrals, sums/limits, braces, norms/inner products, formal/modal logic, primes & text subscripts
  const casesMml = renderTexToMathMl('\\begin{cases} x^2 & x \\ge 0 \\\\ -x & x < 0 \\end{cases}', true);
  assert.match(casesMml, /<mtable\b[^>]*>[\s\S]*tml-left/);
  assert.match(casesMml, /<mo\b[^>]*stretchy="true"[^>]*>\{<\/mo>/);

  const calcMml = renderTexToMathMl('\\int_a^b f\'\'(x)\\,dx + \\oint_C \\vec{F}\\cdot d\\vec{r} + \\sum_{i=1}^n a_i + \\lim_{x\\to 0} \\frac{\\sin x}{x}', true);
  assert.match(calcMml, /<msubsup><mo\b[^>]*>∫<\/mo>/);
  assert.match(calcMml, /′[\s\S]*′/);
  assert.match(calcMml, /<mo\b[^>]*>∮<\/mo>/);
  assert.match(calcMml, /<munderover><mo\b[^>]*>∑<\/mo>/);
  assert.match(calcMml, /<munder><mi\b[^>]*>lim<\/mi>/);

  const structMml = renderTexToMathMl('\\overbrace{a+b}^{k} + \\underbrace{x+y}_{m} + \\overline{z} + \\underline{w} + \\|x\\| + \\langle u, v \\rangle', true);
  assert.match(structMml, /⏞/);
  assert.match(structMml, /⏟/);
  assert.match(structMml, /‖/);
  assert.match(structMml, /<mo\b[^>]*>⟨<\/mo>/);
  assert.match(structMml, /<mo\b[^>]*>⟩<\/mo>/);

  const logicMml = renderTexToMathMl('\\Gamma \\vdash \\Box P \\implies \\Diamond P, \\quad \\mathcal{M} \\models \\top \\equiv \\neg\\bot \\iff Q_{\\text{net gain}}', false);
  for (const sym of ['⊢', '□', '⟹', '⊨', '⊤', '≡', '⊥', '⟺']) {
    assert.ok(logicMml.includes(sym), `Expected "${sym}" in logic MathML: ${logicMml}`);
  }
  assert.match(logicMml, /[◇◊]/);
  assert.match(logicMml, /net[\s\u00A0]gain/);

  // Malformed TeX falls back safely without crashing or leaking raw HTML tags
  const malformedMml = renderTexToMathMl('\\frac{1}{ + \\left( x + } <script>alert(1)</script>', false);
  assert.ok(malformedMml.startsWith('<math') && malformedMml.endsWith('</math>'));
  assert.ok(!malformedMml.includes('<script>'));

  // Multi-currency "$100 to $250" stays literal alongside real inline math
  const multiCurr = compileMathInLesson({
    format: 'studyhub-lesson/1',
    id: 'curr-check',
    title: 'Budget $100 to $250',
    slides: [{ beat: 'open', title: 'Cost', blocks: [{ t: 'text', md: 'From $100 to $250 when $x > 0$.' }] }],
  });
  assert.match(multiCurr.slides[0].blocks[0].md, /\$100 to \$250 when @@SHM_0@@\./);

  // 2. Expanded safe AST functions + sandbox threshold + schematic node detail & feedback edge validation
  assert.ok(Math.abs(compileMathExpression('hypot(3, 4)').evaluate({}) - 5) < 1e-9);
  assert.equal(compileMathExpression('heaviside(2) - heaviside(-2)').evaluate({}), 1);
  assert.equal(compileMathExpression('lerp(10, 20, 0.25)').evaluate({}), 12.5);

  const sbSpec = buildArchetypeLesson({ archetype: 'sandbox', language: 'en' });
  sbSpec.slides[5].blocks[0].threshold = { value: 0.05, label: '5% band', band: 0.02 };
  assert.equal(validateLessonSpec(sbSpec, { strictPedagogy: true }).ok, true);
  const sbCompiled = compileLessonHtml(sbSpec, { strictPedagogy: true });
  assert.ok(sbCompiled.html.includes('sbox__curve'), 'Sandbox runtime must render SVG <path class="... sbox__curve">');
  assert.ok(sbCompiled.html.includes('sbox__cross'), 'Sandbox runtime must include interactive crosshair');
  assert.ok(sbCompiled.html.includes('sbox__threshold'), 'Sandbox runtime must include threshold band support');
  assert.ok(!CJK_RE.test(sbCompiled.html), 'English sandbox HTML must contain zero CJK');

  const badSb = structuredClone(sbSpec);
  badSb.slides[5].blocks[0].threshold = { value: 'not-a-number' };
  assert.equal(validateLessonSpec(badSb).ok, false, 'Non-numeric sandbox.threshold.value must fail validation');

  const mechSpec = buildArchetypeLesson({ archetype: 'mechanism', language: 'en' });
  const schemBlock = mechSpec.slides[5].blocks[0];
  schemBlock.nodes[0].detail = 'Driver crank input torque';
  schemBlock.edges.push({ id: 'e_feedback', from: 'rocker', to: 'crank', label: 'Closed-loop return', dashed: true });
  assert.equal(validateLessonSpec(mechSpec, { strictPedagogy: true }).ok, true);
  const mechCompiled = compileLessonHtml(mechSpec, { strictPedagogy: true });
  assert.ok(mechCompiled.html.includes('schem__inspect'), 'Schematic runtime must include node detail inspector');
  assert.match(mechCompiled.html, /" Q "/, 'Schematic runtime must route backward feedback loops with quadratic Bezier <path>');
  assert.ok(!CJK_RE.test(mechCompiled.html), 'English schematic HTML must contain zero CJK');

  const badMech = structuredClone(mechSpec);
  badMech.slides[5].blocks[0].edges.push({ id: 'e_ghost', from: 'rocker', to: 'nonexistent_node' });
  assert.equal(validateLessonSpec(badMech).ok, false, 'Schematic edge referencing unknown node must fail validation');
});

test('Wave 1 Companion Core: smart high-signal source chunking, deterministic pre-repair & pure-English projected cards', async () => {
  // 1. Smart source excerpting extracts headings, theorems, formulas & topic-keyword windows instead of blind head slice
  const fillerPara = Array.from({ length: 35 }, (_, i) => `Paragraph ${i + 1}: Historical administrative syllabus notes and general classroom logistics with no mathematical content whatsoever.`).join('\n\n');
  const longTextbook = [
    '# Chapter 1 Course Logistics',
    fillerPara,
    '# Chapter 4 Sequences and Series of Functions',
    fillerPara,
    '## 4.2 Uniform Convergence and Integral Exchange',
    '**Theorem 4.2 (Weierstrass Uniform Convergence Criterion)**: If $f_n \\to f$ uniformly on $[a, b]$ with $\\sup_{x \\in [a,b]} |f_n(x) - f(x)| \\to 0$, then $$\\lim_{n\\to\\infty} \\int_a^b f_n(x)\\,dx = \\int_a^b f(x)\\,dx.$$',
    'Counterexample: The moving bump $f_n(x) = n x (1 - x^2)^n$ converges pointwise to $0$ yet $\\int_0^1 f_n(x)\\,dx \\to \\frac{1}{2} \\neq 0$.',
  ].join('\n\n');
  assert.ok(longTextbook.length > 8000);

  const excerpt = extractStructuredSourceExcerpt(longTextbook, {
    cap: 2200,
    topic: 'Why uniform convergence is required to exchange limit and integral',
    course: 'Real Analysis',
  });
  assert.ok(excerpt.length <= 2200);
  assert.match(excerpt, /\[Outline:/);
  assert.match(excerpt, /4\.2 Uniform Convergence/);
  assert.match(excerpt, /Theorem 4\.2/);

  const plan = planCompanionBuild(
    { sources: [{ id: 'src-analysis', title: 'Analysis Notes', text: longTextbook }] },
    {
      course: 'Real Analysis',
      topic: 'Uniform convergence integral exchange',
      sourceIds: ['src-analysis'],
      language: 'en',
      maxSourceBudgetChars: 2400,
    },
  );
  assert.equal(plan.grounded, true);
  assert.ok(plan.excerpts[0].excerpt.includes('Theorem 4.2'));

  // 2. Deterministic pre-repair fixes off-by-one spot lines, case-mismatched decide/cases tools & duplicate predict IDs
  const glitchy = buildArchetypeLesson({ archetype: 'sandbox', language: 'en' });
  glitchy.slides[6].blocks[0].answerLines = [0, 4]; // 3-line source: off-by-one at both ends -> [1, 3]
  glitchy.slides[10].blocks[0].branches[0].pick = 'critical'; // lowercase vs 'Critical' in cases.tools
  const extraPredSlide = structuredClone(glitchy.slides[4]); // duplicate predict.id 'pred-crit'
  const extraRevSlide = { beat: 'run', title: 'Second Reveal', blocks: [{ t: 'reveal', of: 'pred-crit', say: 'Check second bet.' }] };
  glitchy.slides.splice(6, 0, extraPredSlide, extraRevSlide);

  const { lesson: preRepaired, fixes } = preRepairLessonWithReport(glitchy);
  assert.ok(fixes.length >= 3, `Expected deterministic pre-repair fixes, got: ${JSON.stringify(fixes)}`);
  assert.deepEqual(preRepaired.slides[8].blocks[0].answerLines, [1, 3]);
  assert.equal(preRepaired.slides[12].blocks[0].branches[0].pick, 'Critical');
  assert.notEqual(preRepaired.slides[4].blocks[0].id, preRepaired.slides[6].blocks[0].id);
  assert.equal(preRepaired.slides[7].blocks[0].of, preRepaired.slides[6].blocks[0].id);
  assert.equal(validateLessonSpec(normalizeLessonSpec(preRepaired), { strictPedagogy: true }).ok, true);

  // Verify generation.companion.build Job saves Stage 3 LLM repair call (3 calls total!) when pre-repair resolves off-by-one glitch
  const tmp = await mkdtemp(join(tmpdir(), 'sh-comp-prerepair-'));
  try {
    await mkdir(join(tmp, 'ws'), { recursive: true });
    const offByOneSpec = buildArchetypeLesson({ archetype: 'sandbox', language: 'en' });
    offByOneSpec.slides[6].blocks[0].answerLines = [0]; // off-by-one fixed deterministically
    const a1 = offByOneSpec.slides.slice(0, 8);
    const a2 = offByOneSpec.slides.slice(8);
    let calls = 0;
    const mockModel = async (system, prompt) => {
      calls++;
      if (system.includes('curriculum architect')) {
        return JSON.stringify({
          id: 'prerepair-demo',
          archetype: 'sandbox',
          title: offByOneSpec.title,
          lead: offByOneSpec.lead,
          minutes: 25,
          needs: offByOneSpec.needs,
          after: offByOneSpec.after,
          terms: offByOneSpec.terms,
          act1Slides: a1.map((s, i) => ({ slide: i + 1, beat: s.beat, title: s.title })),
          act2Slides: a2.map((s, i) => ({ slide: i + 9, beat: s.beat, title: s.title })),
        });
      }
      if (prompt.includes('You are authoring Act I ')) return JSON.stringify({ slides: a1 });
      if (prompt.includes('You are authoring Act II ')) return JSON.stringify({ slides: a2 });
      throw new Error(`Stage 3 LLM repair should NOT be called for off-by-one line index: ${system.slice(0, 60)}`);
    };
    const svc = new StudyService(join(tmp, 'lib'), {
      complete: mockModel,
      light: mockModel,
      ...switchOptions('runtime', { complete: mockModel }),
    });
    const started = await svc.call('generation.companion.build', {
      course: 'Differential Equations',
      topic: 'Critical damping boundary',
      archetype: 'sandbox',
      language: 'en',
      workspace: join(tmp, 'ws'),
    });
    let settled = null;
    for (let i = 0; i < 80; i++) {
      const snap = await svc.call('snapshot', {});
      const job = snap.jobs.find(j => j.id === started.jobId);
      if (job && (job.status === 'complete' || job.status === 'failed')) { settled = job; break; }
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(settled?.status, 'complete');
    assert.equal(calls, 3, 'Deterministic pre-repair must save the 4th LLM repair call');
    assert.equal(settled.contract.detail.preRepaired, true);
    assert.equal(settled.contract.detail.repaired, false);
    svc.dispose();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // 3. Pure-English projected Markdown source & optional scenario case cards (`includeCaseCards: true` with >=3 cases)
  const enSpec = buildArchetypeLesson({ archetype: 'dialectic', language: 'en' });
  enSpec.includeCaseCards = true;
  enSpec.slides[10].blocks[1].tools = ['Critical', 'Underdamped', 'Overdamped'];
  enSpec.slides[10].blocks[1].items.push({
    text: 'Heavy vault door settling slowly without any bounce',
    answer: 2,
    why: 'Overdamped prevents bounce with conservative margin.',
  });
  const normEn = compileMathInLesson(normalizeLessonSpec(enSpec));
  const projEn = projectLessonSource(normEn, { companionId: 'en-1', course: 'Moral Philosophy' });
  assert.ok(!CJK_RE.test(projEn.text), `English projected source leaked CJK: ${projEn.text}`);
  assert.ok(!/@@SHM_\d+@@/.test(projEn.text), 'Projected source must detokenize @@SHM_N@@ back to LaTeX');
  const enCards = compileLessonCards(normEn, { source: projEn, companionId: 'en-1', grounded: true });
  assert.equal(enCards.length, 9, '3 takeaways + 2 quizzes + 1 oral + 3 scenario case quizzes');
  assert.ok(enCards.every(c => !CJK_RE.test(JSON.stringify(c))), 'English compiled cards must contain zero CJK');
});

test('Wave 1 Companion UI: cross-discipline starter chips, ModelSetupGate & CompanionViewer SSR in English', () => {
  setUiLanguage('en');
  try {
    const fakeStudy = {
      busy: false,
      call: () => new Promise(() => {}),
      act: async () => ({}),
      notify: () => {},
      openModal: () => {},
      openSettings: () => {},
    };
    const readyApp = {
      data: {
        focus: { course: 'Moral Philosophy', courses: ['Moral Philosophy'] },
        courses: [{ id: 'c1', name: 'Moral Philosophy', companions: [] }],
        sources: [],
        decks: [],
        settings: { modelReady: true },
        modelStatus: { ready: true, reason: 'ok', label: 'Mock' },
      },
      core: { refresh: () => {} },
    };

    const buildDialogHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: readyApp },
          React.createElement(CompanionBuildDialog, { modal: { course: 'Moral Philosophy' }, onClose: () => {} }),
        ),
      ),
    );
    for (const chipLabel of [
      'Mathematics · Uniform Convergence',
      'Philosophy · Duty vs Utility',
      'Mechanical Engineering · Four-Bar &amp; PID',
      'Computer Science · Lock-Free CAS &amp; ABA',
    ]) {
      assert.ok(buildDialogHtml.includes(chipLabel), `Missing starter chip "${chipLabel}" in CompanionBuildDialog`);
    }
    assert.ok(!buildDialogHtml.includes('resume-workshop'), 'Personal local path must not appear in CompanionBuildDialog');
    assert.ok(!CJK_RE.test(buildDialogHtml), `Unexpected CJK in English CompanionBuildDialog: ${buildDialogHtml}`);

    // Unconfigured model on Build tab renders ModelSetupGate (`feature="companion"`), while Attach tab stays usable
    const unconfiguredApp = {
      data: { ...readyApp.data, settings: {}, model: { ready: false, reason: 'no-route', label: '' }, modelStatus: { ready: false, reason: 'no-route', label: '' } },
      core: { refresh: () => {} },
    };
    const buildGateHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: unconfiguredApp },
          React.createElement(CompanionBuildDialog, { modal: { course: 'Moral Philosophy', tab: 'build' }, onClose: () => {} }),
        ),
      ),
    );
    assert.match(buildGateHtml, /sh-setup|settings|model/i);
    assert.ok(!CJK_RE.test(buildGateHtml));

    const attachTabHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: unconfiguredApp },
          React.createElement(CompanionBuildDialog, { modal: { course: 'Moral Philosophy', tab: 'attach' }, onClose: () => {} }),
        ),
      ),
    );
    assert.ok(attachTabHtml.includes('Mount Companion'));
    assert.ok(!CJK_RE.test(attachTabHtml));

    // CompanionViewer loading frame in English renders cleanly with zero CJK
    const viewerLoadingHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: readyApp },
          React.createElement(CompanionViewer, { modal: { id: 'comp-1', course: 'Moral Philosophy', title: 'Ethics Stage' }, onClose: () => {} }),
        ),
      ),
    );
    assert.ok(viewerLoadingHtml.includes('Ethics Stage'));
    assert.ok(!CJK_RE.test(viewerLoadingHtml), `Unexpected CJK in English CompanionViewer: ${viewerLoadingHtml}`);
  } finally {
    setUiLanguage('zh');
  }
});

test('Wave 2: preRepairLessonSpec, resolveUnbuiltLessonSources & 1-click companion.sync disk reload with FSRS preservation', async () => {
  // 1. preRepairLessonSpec wrapper fixes off-by-one lines directly
  const rawGlitch = buildArchetypeLesson({ archetype: 'sandbox', language: 'en' });
  rawGlitch.slides[6].blocks[0].answerLines = [0];
  const fixedSpec = preRepairLessonSpec(rawGlitch);
  assert.deepEqual(fixedSpec.slides[6].blocks[0].answerLines, [1]);

  // 2. resolveUnbuiltLessonSources resolves `of: "demo.SpinLock"` inside `<pack>/projects/` & degrades unbuilt experiment blocks
  const tmp = await mkdtemp(join(tmpdir(), 'sh-comp-w2-'));
  try {
    const storeDir = join(tmp, 'lib');
    const packDir = join(tmp, 'unbuilt-pack');
    await mkdir(join(packDir, 'lessons'), { recursive: true });
    await mkdir(join(packDir, 'projects', 'demo'), { recursive: true });
    await writeFile(
      join(packDir, 'projects', 'demo', 'SpinLock.java'),
      'package demo;\npublic class SpinLock {\n  volatile int state = 0;\n  void lock() { while (state != 0) {} state = 1; }\n}\n',
      'utf8',
    );
    const unbuiltJson = {
      id: 'spinlock-race',
      title: 'Why Naive SpinLock Fails Without CAS',
      language: 'en',
      course: 'Concurrent Systems',
      slides: [
        { beat: 'code', title: 'Check-Then-Act', blocks: [{ t: 'code', of: 'demo.SpinLock', focus: ['while (state != 0)'], say: 'Inspect lock().' }] },
        { beat: 'why', title: 'Spot Race', blocks: [{ t: 'spot', of: 'demo.SpinLock', answer: ['while (state != 0)'], q: 'Click non-atomic check.', found: 'Two threads pass while simultaneously!' }] },
        { beat: 'run', title: 'Unbuilt Lab', blocks: [{ t: 'experiment', lab: 'missingLab', show: ['v1'], say: 'Fallback gracefully.' }] },
        { beat: 'take', title: 'Takeaways', blocks: [{ t: 'cards', items: [{ q: 'Why does check-then-act race?', a: 'Read and write are separate memory operations.' }, { q: 'What primitive fixes it?', a: 'Atomic Compare-And-Swap (CAS).' }] }] },
      ],
    };
    await writeFile(join(packDir, 'lessons', 'spinlock-race.json'), JSON.stringify(unbuiltJson, null, 2), 'utf8');

    const resolved = await resolveUnbuiltLessonSources(unbuiltJson, packDir);
    assert.match(resolved.slides[0].blocks[0].source, /class SpinLock/);
    assert.deepEqual(resolved.slides[0].blocks[0].focusLines, [4]);
    assert.deepEqual(resolved.slides[1].blocks[0].answerLines, [4]);
    assert.notEqual(resolved.slides[2].blocks[0].t, 'experiment', 'Unbuilt experiment without results must degrade cleanly');

    // Attach unbuilt pack directory + test 1-click `companion.sync` on linked HTML edit
    const linkedHtmlDir = join(tmp, 'linked-lab', 'pages');
    await mkdir(linkedHtmlDir, { recursive: true });
    const v1Spec = buildArchetypeLesson({ archetype: 'sandbox', language: 'en' });
    v1Spec.course = 'Concurrent Systems';
    const htmlFile = join(linkedHtmlDir, 'damping-v1.html');
    await writeFile(htmlFile, compileLessonHtml(v1Spec).html, 'utf8');

    const svc = new StudyService(storeDir, {});
    const unbuiltAttach = await svc.call('companion.attach', {
      path: packDir,
      course: 'Concurrent Systems',
      allowRememberTrusted: true,
    });
    assert.equal(unbuiltAttach.attached, 1, 'Unbuilt lessons/*.json directory should attach cleanly');

    const attached = await svc.call('companion.attach', {
      path: join(tmp, 'linked-lab'),
      course: 'Concurrent Systems',
      mountMode: 'full-pack',
      allowRememberTrusted: true,
    });
    assert.equal(attached.attached, 1);

    const listed = await svc.call('companion.list', { course: 'Concurrent Systems' });
    const linkedRec = listed.companions.find(c => c.title === v1Spec.title);
    assert.ok(linkedRec);

    // Credit first-pass on linkedRec so FSRS reps = 1 on take:0
    await svc.call('companion.progress', {
      id: linkedRec.id,
      course: 'Concurrent Systems',
      slide: 16,
      slideTotal: 16,
      completed: true,
      checkResults: { 'check:0': true, 'check:1': true },
    });

    // Edit the linked HTML on disk -> companion.get reports changedOnDisk: true -> companion.sync updates & clears changedOnDisk while keeping FSRS!
    const v2Spec = structuredClone(v1Spec);
    v2Spec.title = 'Updated On Disk: Critical Boundary Invariant';
    await writeFile(htmlFile, compileLessonHtml(v2Spec).html, 'utf8');

    const beforeSync = await svc.call('companion.get', { id: linkedRec.id, course: 'Concurrent Systems' });
    assert.equal(beforeSync.changedOnDisk, true);

    const synced = await svc.call('companion.sync', { id: linkedRec.id, course: 'Concurrent Systems', mountMode: 'full-pack' });
    assert.equal(synced.changed, true);
    assert.equal(synced.changedOnDisk, false);
    assert.equal(synced.companion.title, 'Updated On Disk: Critical Boundary Invariant');

    const stAfter = await svc.store.read();
    const deckAfter = stAfter.decks.find(d => d.companionId === linkedRec.id);
    const take0After = deckAfter.cards.find(c => c.companionRef?.slot === 'take:0');
    assert.ok((take0After.review?.reps || 0) >= 1, 'companion.sync must preserve existing FSRS reps');
    svc.dispose();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Wave 3 & 4: assistant boundary, normalizeSandboxMathExpr, workshop task cards, mergeCourses dedup, 1-hop credit guard & companion.compile/remove hygiene', async () => {
  // 1. Assistant boundary blocks `companion.catchup.remove` (#37)
  assert.match(assistantRefusal('companion.catchup.remove') || '', /companion\.catchup\.remove is internal/);
  assert.equal(assistantRefusal('companion.compile'), null);

  // 2. Scientific LLM expression pre-repair (`normalizeSandboxMathExpr` #47)
  const normExpr = normalizeSandboxMathExpr('$y(t) = Math.exp(−0.5 × t) · \\cos(2π · t) + \\frac{1}{\\sqrt{4}}$');
  const valAt0 = compileMathExpression(normExpr).evaluate({ t: 0 });
  assert.ok(Math.abs(valAt0 - 1.5) < 1e-9, `Expected 1.5 at t=0, got ${valAt0} from "${normExpr}"`);

  // 3. `extractWorkshopLesson` on real `workshop-lab.html` (when present) + inline workshop -> `kind: "task"` cards (#39)
  const realWorkshopPath = 'D:/A/1NUS/resume-workshop/八股项目/lab/projects/workshop-lab.html';
  const wsInfo = await stat(realWorkshopPath).catch(() => null);
  if (wsInfo?.isFile()) {
    const wsHtml = await readFile(realWorkshopPath, 'utf8');
    const wsLesson = extractWorkshopLesson(wsHtml, 'java-workshop-lab');
    assert.ok(wsLesson && Array.isArray(wsLesson.slides) && wsLesson.slides.length >= 1, 'Should extract workshop slides from real workshop-lab.html');
    const wsNorm = normalizeLessonSpec(wsLesson);
    const wsSource = projectLessonSource(wsNorm, { companionId: 'comp-ws', course: 'Java Concurrency' });
    const wsCards = compileLessonCards(wsNorm, { source: wsSource, companionId: 'comp-ws', grounded: true });
    assert.ok(wsCards.some(c => c.kind === 'task' && Array.isArray(c.rubricCriteria) && c.rubricCriteria.length >= 2), 'Workshop drills must compile into kind: "task" cards');
  }

  // 4. Standalone & course-attached `companion.compile`, out-of-bounds `outputPath` guard, 1-hop FSRS credit guard, `mergeCourses` dedup & `companion.remove` cleanup (#39 & #47)
  const tmp = await mkdtemp(join(tmpdir(), 'sh-comp-w34-'));
  try {
    const storeDir = join(tmp, 'lib');
    const wsDir = join(tmp, 'workspace');
    const outsideDir = join(tmp, 'outside-secret');
    await mkdir(wsDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const svc = new StudyService(storeDir, {});
    const rawSpec = buildArchetypeLesson({ archetype: 'sandbox', language: 'en' });
    // Inject Unicode/Math.* syntax into sandbox expr to prove companion.compile runs preRepairLessonWithReport automatically
    rawSpec.slides[5].blocks[0].series[0].expr = 'Math.exp(−zeta × t) * Math.cos(t)';

    // Out-of-bounds outputPath must be rejected
    await assert.rejects(
      () => svc.call('companion.compile', {
        lesson: rawSpec,
        attach: false,
        workspace: wsDir,
        outputPath: join(outsideDir, 'escape.html'),
      }),
      /工作区|目录|authorized|outside|路径/i,
    );

    // Standalone compile (`attach: false`) writes `.html` inside workspace without mutating state
    const standaloneOut = join(wsDir, 'standalone-oscillator.html');
    const standaloneRes = await svc.call('companion.compile', {
      lesson: rawSpec,
      attach: false,
      workspace: wsDir,
      outputPath: standaloneOut,
    });
    assert.equal(standaloneRes.attached, false);
    assert.equal(standaloneRes.preRepaired, true);
    assert.ok((await readFile(standaloneOut, 'utf8')).includes('<!doctype html>'));
    assert.equal((await svc.store.read()).courses.length, 0);

    // Course-attached `companion.compile` (`attach: true`)
    const attachedRes = await svc.call('companion.compile', {
      course: 'Vibrations A',
      lesson: rawSpec,
      attach: true,
      workspace: wsDir,
    });
    const compId = attachedRes.companion.id;
    assert.ok(compId);

    // 1-hop quick-jump FSRS credit guard: jumping straight from nothing to slide 16 with `{}` checkResults credits 0 cards!
    const stBeforeJump = await svc.store.read();
    assert.equal(applyFirstPassCredit(stBeforeJump, { companionId: compId, checkResults: {}, hadPriorProgress: false }), 0);

    // Seed a draft referencing `compId` + a duplicate course `'Vibrations B'` with same `lessonId` & supplement deck to test `mergeCourses`
    await svc.store.update(st => {
      st.courses.push({
        id: 'course-vib-b',
        name: 'Vibrations B',
        companions: [{
          id: 'comp-dup-older',
          lessonId: rawSpec.id,
          title: rawSpec.title,
          mode: 'managed',
          progress: { slide: 16, slideTotal: 16, completed: true },
          updatedAt: '2099-01-01T00:00:00.000Z',
        }],
      });
      const courseA = st.courses.find(c => c.name === 'Vibrations A');
      st.decks.push(
        { id: 'sup-a', title: 'Sup A', course: 'Vibrations A', courseId: courseA.id, companionDeck: true, companionSupplementFor: courseA.id, cards: [{ id: 'sa-1', kind: 'open', prompt: 'P1', answer: 'A1' }] },
        { id: 'sup-b', title: 'Sup B', course: 'Vibrations B', courseId: 'course-vib-b', companionDeck: true, companionSupplementFor: 'course-vib-b', cards: [{ id: 'sb-1', kind: 'open', prompt: 'P2', answer: 'A2' }] },
      );
      st.drafts.push({
        id: 'draft-linked',
        title: 'Draft With Companion Ref',
        course: 'Vibrations A',
        companionId: compId,
        cards: [{ id: 'dc-1', kind: 'flashcard', prompt: 'Q', answer: 'A', companionRef: { companionId: compId, slide: 6 } }],
      });
      mergeCourses(st, { into: courseA.id, from: ['course-vib-b'] });
    });

    const stMerged = await svc.store.read();
    const mergedCourse = stMerged.courses.find(c => c.name === 'Vibrations A');
    assert.equal(mergedCourse.companions.length, 1, 'mergeCourses must deduplicate companions sharing lessonId');
    assert.equal(mergedCourse.companions[0].progress?.completed, true, 'mergeCourses must retain completed progress');
    const supDecks = stMerged.decks.filter(d => d.companionSupplementFor === mergedCourse.id);
    assert.equal(supDecks.length, 1, 'mergeCourses must consolidate companionSupplementFor decks');
    assert.equal(supDecks[0].cards.length, 2);

    const survivingCompId = mergedCourse.companions[0].id;
    // Now remove surviving companion -> verify draft companionRef stripped & projected source archived!
    await svc.call('companion.remove', { id: survivingCompId, course: 'Vibrations A' });
    const stRemoved = await svc.store.read();
    assert.equal(stRemoved.drafts[0].companionId, undefined);
    assert.equal(stRemoved.drafts[0].cards[0].companionRef, undefined);
    const projSrc = stRemoved.sources.find(s => s.id === attachedRes.sync.sourceId);
    assert.equal(projSrc?.archived, true, 'companion.remove must archive projected src-companion-* when unreferenced');

    svc.dispose();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Wave 5 & 6: </script>+U+2028 lossless round-trip, advanced MathML, LLM alias pre-repair, NTFS/BOM/corrupt-ledger resilience & spoiler-free deep-links', async () => {
  // 1. `</script><script>` + `\u2028/\u2029` lossless round-trip & advanced MathML (`\binom`, `\substack`, `\cancel`) (#66)
  const hostileSpec = buildArchetypeLesson({ archetype: 'sandbox', language: 'en' });
  const trickyPayload = '</script><script>alert("xss")</script><!--\u2028\u2029-->&';
  hostileSpec.slides[6].blocks[0].source = `1. Safe line\n2. ${trickyPayload}\n3. End`;
  const compiledHostile = compileLessonHtml(hostileSpec);
  assert.ok(!compiledHostile.html.includes('</script><script>alert'), 'Raw </script> must never break out of #lesson-data');
  const roundTripped = extractResilientLesson('\uFEFF' + compiledHostile.html);
  assert.ok(roundTripped.slides[6].blocks[0].source.includes(trickyPayload), 'Hostile payload + U+2028/U+2029 must round-trip losslessly');

  const advMml = renderTexToMathMl('\\binom{n}{k} + \\sum_{\\substack{i \\ge 1 \\\\ j \\le n}} \\overset{!}{=} \\cancel{x}', true);
  assert.match(advMml, /linethickness="0(?:px)?"/);
  assert.match(advMml, /<mtable\b[^>]*class="tml-small"/);
  assert.match(advMml, /<menclose\b/);
  const deepBraces = renderTexToMathMl('{'.repeat(1200) + 'x', false);
  assert.ok(deepBraces.startsWith('<math') && deepBraces.endsWith('</math>'));

  // 2. LLM alias & preset pre-repair (`knobs` inverted min/max, `presets` unknown key pruning, `quiz` choices alias, `schematic` dangling edge prune) (#59)
  const aliased = buildArchetypeLesson({ archetype: 'mechanism', language: 'en' });
  aliased.slides.splice(5, 0, {
    beat: 'run',
    title: 'Aliased Sandbox',
    blocks: [{
      t: 'sandbox',
      knobs: [{ id: 'zeta', label: 'Damping', min: 2.0, max: 0.1, value: 5.0 }], // inverted min/max + `value` alias out of bounds
      presets: [
        { name: 'Underdamped', set: { zeta: 0.25, ghostKnob: 99 } },
        { name: 'AllGhost', set: { ghostOnly: 1 } },
      ],
      series: [{ id: 's1', label: 'Resp', expr: 'exp(-zeta*x)' }],
    }],
  });
  // Add dangling edge alongside valid edges on schematic (now slide index 6)
  aliased.slides[6].blocks[0].edges.push({ source: 'crank', target: 'nonexistent_ghost', label: 'bad' });
  // Use `choices` + `isCorrect` + `feedback` aliases on quiz (slide index 13)
  aliased.slides[13].blocks[0] = {
    t: 'quiz',
    question: 'Which angle defines the dead point?',
    choices: [
      { choice: 'Transmission angle $\\gamma = 0^\\circ$', isCorrect: true, feedback: 'Zero effective torque arm.' },
      { choice: 'Crank angle $90^\\circ$', isCorrect: false, feedback: 'Max velocity region.' },
      { choice: 'coupler length $0$', isCorrect: false, feedback: 'Geometric constant.' },
    ],
  };
  const { lesson: repairedAlias } = preRepairLessonWithReport(aliased);
  const repSb = repairedAlias.slides[5].blocks[0];
  assert.equal(repSb.knobs[0].min, 0.1);
  assert.equal(repSb.knobs[0].max, 2.0);
  assert.equal(repSb.knobs[0].default, 2.0);
  assert.equal(repSb.presets.length, 1, 'Empty ghost preset should be dropped');
  assert.deepEqual(repSb.presets[0].values, { zeta: 0.25 });
  assert.equal(validateLessonSpec(normalizeLessonSpec(repairedAlias), { strictPedagogy: true }).ok, true);

  // 3. Windows NTFS filename safety & corrupt `feedback/questions.json` backup + recovery (#71)
  assert.notEqual(sanitizeWindowsFilename('CON').toUpperCase(), 'CON');
  assert.ok(!/[<>:"/\\|?*]/.test(sanitizeWindowsFilename('math:ode*1?<>')));

  const tmp = await mkdtemp(join(tmpdir(), 'sh-comp-w56-'));
  try {
    const storeDir = join(tmp, 'lib');
    const packDir = join(tmp, 'pack');
    await mkdir(join(packDir, 'pages'), { recursive: true });
    await mkdir(join(packDir, 'feedback'), { recursive: true });
    const spec = buildArchetypeLesson({ archetype: 'dialectic', language: 'en' });
    spec.course = 'Ethics';
    await writeFile(join(packDir, 'pages', 'ethics.html'), compileLessonHtml(spec).html, 'utf8');
    await writeFile(join(packDir, 'feedback', 'questions.json'), '{CORRUPT_JSON!!!', 'utf8');

    const svc = new StudyService(storeDir, {});
    await svc.call('companion.attach', { path: packDir, course: 'Ethics', allowRememberTrusted: true });
    const list = await svc.call('companion.list', { course: 'Ethics' });
    const cid = list.companions[0].id;

    const fbSync = await svc.call('companion.feedback.sync', {
      id: cid,
      course: 'Ethics',
      item: { id: 'q-new', slide: 6, note: 'Recovered cleanly after corruption!' },
    });
    assert.equal(fbSync.total, 1);
    assert.equal(fbSync.open, 1);
    const backupStat = await stat(join(packDir, 'feedback', 'questions.corrupt.json'));
    assert.equal(backupStat.isFile(), true, 'Corrupt questions.json must be backed up to questions.corrupt.json');

    // Verify spoiler-free pre-reveal card vs post-reveal `solution.companionRef` forwarding (`lib/study-state.js` #73)
    const catchup = await svc.call('companion.catchup.save', {
      companionId: cid,
      course: 'Ethics',
      slide: 6,
      slideTotal: 16,
      slideTitle: 'Dialectical Matrix',
      prompt: 'What breaks naive utility aggregation?',
      answer: 'Separateness of persons.',
      language: 'en',
    });
    const run = await svc.call('review.start', {
      mode: 'path',
      fresh: true,
      scope: [{ deckId: catchup.deckId, cardId: catchup.cardId }],
    });
    assert.equal(run.card?.companionRef, undefined, 'Pre-reveal run.card must stay spoiler-free');
    const revealed = await svc.call('review.reveal', { runId: run.id, cardId: run.card.id });
    assert.equal(revealed.solution?.companionRef?.companionId, cid, 'Post-reveal solution must forward companionRef');
    assert.equal(revealed.solution?.companionRef?.slide, 6);

    svc.dispose();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // 4. Bidirectional target resolution (`resolveCompanionTarget` & `resolveSourceCompanionTarget`), empty-course discoverability & v2 `resultOpener` (#63 & #72)
  const appData = {
    courses: [
      { id: 'c-live', name: 'Ethics', companions: [{ id: 'comp-eth', title: 'Ethics Stage', slideCount: 16 }] },
      { id: 'c-empty', name: 'New Course', companions: [] },
    ],
    sources: [
      { id: 'src-companion-comp-eth', title: 'Ethics Stage', companionId: 'comp-eth', courses: ['Ethics'] },
      { id: 'src-companion-comp-dead', title: 'Archived', companionId: 'comp-dead', archived: true },
    ],
  };
  const cardHit = resolveCompanionTarget({
    card: { companionRef: { companionId: 'comp-eth', slide: 99 } }, // clamped to slideCount 16
    courses: appData.courses,
    sources: appData.sources,
  });
  assert.equal(cardHit?.companionId, 'comp-eth');
  assert.equal(cardHit?.slide, 16);

  const srcHit = resolveSourceCompanionTarget({
    source: appData.sources[0],
    quote: '## [Slide 7] Flaw Check',
    courses: appData.courses,
    sources: appData.sources,
  });
  assert.equal(srcHit?.companionId, 'comp-eth');
  assert.equal(srcHit?.slide, 7);
  assert.equal(resolveSourceCompanionTarget({ source: appData.sources[1], courses: appData.courses, sources: appData.sources }), null);

  // v2 JobSchema strips extra fields on `result.refs`; `resultOpener` recovers `course` & `title` via `contract.detail`
  let modalPayload = null;
  const v2Job = {
    kind: 'companion-lesson-build',
    status: 'complete',
    contract: {
      v: 2,
      kind: 'companion-lesson-build',
      status: 'complete',
      title: 'Ethics Stage',
      detail: { course: 'Ethics', companionId: 'comp-eth', slideCount: 16 },
      result: { refs: [{ kind: 'companion', id: 'comp-eth' }] },
    },
  };
  const v2Opener = resultOpener(v2Job, { openModal: m => { modalPayload = m; }, data: appData });
  assert.equal(v2Opener?.kind, 'companion');
  v2Opener.run();
  assert.equal(modalPayload?.type, 'companion');
  assert.equal(modalPayload?.course, 'Ethics');

  setUiLanguage('en');
  try {
    const emptyBarHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: { busy: false, call: async () => ({}), act: async () => ({}), notify: () => {}, openModal: () => {} } },
        React.createElement(AppContext.Provider, { value: { data: appData, core: { refresh: () => {} } } },
          React.createElement(CourseCompanionsBar, { course: 'New Course', data: appData }),
        ),
      ),
    );
    assert.ok(emptyBarHtml.includes('New interactive companion'), `Empty course should discoverably offer "New interactive companion": ${emptyBarHtml}`);
    assert.ok(!CJK_RE.test(emptyBarHtml));
  } finally {
    setUiLanguage('zh');
  }
});

test('Wave 7 Polish: non-zero blueprint estimate ranges, 60-page PDF document grouping, zero cross-course leak & [object Object] guard', () => {
  const pdfHash = 'a'.repeat(64);
  const pdfPages = Array.from({ length: 60 }, (_, idx) => ({
    id: `src-ra-p${idx + 1}`,
    title: `Real Analysis Lecture Notes.pdf · p. ${idx + 1}`,
    text: `Chapter ${Math.ceil((idx + 1) / 10)}: Uniform convergence page ${idx + 1} proof and theorem.`,
    courses: ['Real Analysis'],
    document: { id: pdfHash, materialId: `document-${pdfHash}-pdf`, format: 'pdf', page: idx + 1, totalPages: 60, bookTitle: 'Real Analysis Lecture Notes.pdf', extractionVersion: 2 },
    createdAt: '2026-11-16T00:00:00.000Z',
  }));
  const state = { sources: pdfPages, documents: [] };
  const plan = planCompanionBuild(state, {
    course: 'Real Analysis',
    topic: 'Uniform convergence and integral swapping',
    sourceIds: pdfPages.slice(0, 5).map(s => s.id),
    language: 'en',
  });
  const calls = estimateCalls(plan);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.id), ['plan', 'author', 'author']);
  assert.ok(calls.every(c => c.outputChars?.low > 0 && c.outputChars?.high > c.outputChars?.low));

  const est = estimateOfCompanionPlan(plan);
  assert.deepEqual(est.calls, { low: 3, high: 4 });
  assert.ok(est.inputTokens.low > 500);
  assert.ok(est.outputTokens.low > 1000);
  assert.ok(est.totalTokens.high > est.totalTokens.low);

  assert.equal(formatEstimateRange({ low: 3, high: 4 }, n => String(n)), '3–4');
  assert.equal(formatEstimateRange({ low: 3, high: 3 }, n => String(n)), '3');
  assert.equal(formatEstimateRange(5, n => String(n)), '5');
  assert.ok(!formatEstimateRange(est.totalTokens).includes('[object Object]'));

  setUiLanguage('en');
  try {
    const fakeStudy = { busy: false, call: () => new Promise(() => {}), act: async () => ({}), notify: () => {}, openModal: () => {}, openSettings: () => {} };
    const appWith60PagePdf = {
      data: {
        focus: { course: 'Real Analysis', courses: ['Real Analysis', 'Moral Philosophy'] },
        courses: [{ id: 'c-ra', name: 'Real Analysis', companions: [] }, { id: 'c-mp', name: 'Moral Philosophy', companions: [] }],
        sources: pdfPages,
        documents: [],
        decks: [],
        settings: { modelReady: true },
        modelStatus: { ready: true, reason: 'ok', label: 'Mock' },
      },
      core: { refresh: () => {} },
    };

    // 1. 60-page PDF in 'Real Analysis' groups into 1 document checkbox, counts as "1 selected", and formats { low, high } estimate cleanly
    const raHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: appWith60PagePdf },
          React.createElement(CompanionBuildDialog, {
            modal: {
              course: 'Real Analysis',
              topic: 'Uniform convergence',
              sourceIds: pdfPages.map(p => p.id),
              initialEstimate: { status: 'estimate', estimate: est },
            },
            onClose: () => {},
          }),
        ),
      ),
    );
    const checkboxMatches = raHtml.match(/type="checkbox"/g) || [];
    assert.equal(checkboxMatches.length, 1, `60-page PDF must collapse into 1 document checkbox, got ${checkboxMatches.length}`);
    assert.ok(raHtml.includes('Real Analysis Lecture Notes.pdf'));
    assert.ok(raHtml.includes('(1 selected;'), `60 selected page IDs of 1 PDF must display "(1 selected;", got: ${raHtml}`);
    assert.ok(raHtml.includes('~3–4 model calls'), `Expected "~3–4 model calls" in estimate banner, got: ${raHtml}`);
    assert.ok(!raHtml.includes('[object Object]'), 'Estimate banner must never render [object Object]');
    assert.ok(!raHtml.includes('questions.json'), 'Build dialog must not expose raw questions.json filename');
    assert.ok(!CJK_RE.test(raHtml), `English CompanionBuildDialog must contain zero Han chars: ${raHtml}`);

    // 2. Course 'Moral Philosophy' with 0 matching documents renders 0 source checkboxes (no fallback to 'Real Analysis' PDF!)
    const emptyCourseHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: appWith60PagePdf },
          React.createElement(CompanionBuildDialog, {
            modal: { course: 'Moral Philosophy', topic: 'Kantian duty' },
            onClose: () => {},
          }),
        ),
      ),
    );
    assert.ok(!emptyCourseHtml.includes('Real Analysis Lecture Notes.pdf'), 'Unrelated course materials must never leak when course has 0 matching documents');
    assert.equal((emptyCourseHtml.match(/type="checkbox"/g) || []).length, 0);
    assert.ok(!CJK_RE.test(emptyCourseHtml));
  } finally {
    setUiLanguage('zh');
  }
});

test('Wave 7 Polish: static WeakMap quiz & workshop slot IDs survive out-of-order jumps, back-navigation & beforeprint', () => {
  // Build a minimal DOM harness to run LESSON_TEMPLATE_RUNTIME_JS end-to-end across slides & print events
  function makeDomHarness(lessonSpec, initialHash = '#3') {
    const listeners = new Map();
    const winListeners = new Map();
    const idMap = new Map();
    const posted = [];
    const storage = new Map();

    class FakeNode {
      constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.localName = String(tag || 'div').toLowerCase();
        this.className = '';
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.events = new Map();
        this.dataset = {};
        this.style = { setProperty() {} };
        this._text = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.open = false;
        this.value = '';
        this.scrollTop = 0;
        this.clientHeight = 400;
        this.offsetTop = 0;
        this.offsetWidth = 120;
        this.offsetHeight = 32;
        this.classList = {
          add: (...cls) => {
            const set = new Set(this.className.split(/\s+/).filter(Boolean));
            for (const c of cls) if (c) set.add(c);
            this.className = [...set].join(' ');
          },
          remove: (...cls) => {
            const set = new Set(this.className.split(/\s+/).filter(Boolean));
            for (const c of cls) set.delete(c);
            this.className = [...set].join(' ');
          },
          toggle: (c, force) => {
            const set = new Set(this.className.split(/\s+/).filter(Boolean));
            const next = force === undefined ? !set.has(c) : Boolean(force);
            if (next) set.add(c); else set.delete(c);
            this.className = [...set].join(' ');
            return next;
          },
          contains: c => this.className.split(/\s+/).filter(Boolean).includes(c),
        };
      }
      get isConnected() { return true; }
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this._text + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join('');
      }
      set textContent(v) {
        this._text = String(v ?? '');
        this.children = [];
      }
      setAttribute(k, v) {
        const sv = String(v);
        this.attributes.set(k, sv);
        if (k === 'id') idMap.set(sv, this);
        if (k === 'hidden') this.hidden = true;
        if (k === 'disabled') this.disabled = true;
        if (k === 'checked') this.checked = true;
        if (k === 'open') this.open = true;
      }
      getAttribute(k) { return this.attributes.get(k) ?? null; }
      removeAttribute(k) {
        this.attributes.delete(k);
        if (k === 'hidden') this.hidden = false;
        if (k === 'disabled') this.disabled = false;
      }
      append(...kids) {
        for (const k of kids) {
          if (k === null || k === undefined || k === false) continue;
          if (k instanceof FakeFragment) {
            this.append(...k.children);
          } else if (typeof k === 'string' || typeof k === 'number') {
            const tn = new FakeNode('#text');
            tn._text = String(k);
            tn.parentNode = this;
            this.children.push(tn);
          } else {
            k.parentNode = this;
            this.children.push(k);
          }
        }
      }
      prepend(...kids) {
        const prev = this.children;
        this.children = [];
        this.append(...kids, ...prev);
      }
      insertBefore(newNode, refNode) {
        newNode.parentNode = this;
        const idx = this.children.indexOf(refNode);
        if (idx >= 0) this.children.splice(idx, 0, newNode);
        else this.children.push(newNode);
        return newNode;
      }
      replaceChildren(...kids) {
        this.children = [];
        this._text = '';
        this.append(...kids);
      }
      remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.children.indexOf(this);
        if (idx >= 0) this.parentNode.children.splice(idx, 1);
      }
      addEventListener(name, fn) {
        if (!this.events.has(name)) this.events.set(name, []);
        this.events.get(name).push(fn);
      }
      dispatch(name, ev = {}) {
        for (const fn of this.events.get(name) || []) {
          fn({ preventDefault() {}, stopPropagation() {}, currentTarget: this, target: this, ...ev });
        }
      }
      click() { this.dispatch('click'); }
      closest() { return null; }
      contains(target) {
        if (this === target) return true;
        return this.children.some(c => c instanceof FakeNode && c.contains(target));
      }
      getBoundingClientRect() { return { left: 20, top: 20, width: 100, height: 24, bottom: 44 }; }
      scrollIntoView() {}
      querySelectorAll(sel) {
        const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
        const out = [];
        const matchOne = (node, part) => {
          if (part.startsWith('.')) return node.classList.contains(part.slice(1));
          if (part.includes('.')) {
            const [tg, cl] = part.split('.');
            return node.localName === tg && node.classList.contains(cl);
          }
          return node.localName === part;
        };
        const visit = node => {
          for (const ch of node.children) {
            if (ch instanceof FakeNode) {
              if (parts.some(p => matchOne(ch, p))) out.push(ch);
              visit(ch);
            }
          }
        };
        visit(this);
        return out;
      }
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    }
    class FakeFragment {
      constructor() { this.children = []; }
      append(...kids) {
        for (const k of kids) {
          if (k === null || k === undefined || k === false) continue;
          if (k instanceof FakeFragment) this.children.push(...k.children);
          else this.children.push(k);
        }
      }
    }

    const docEl = new FakeNode('html');
    const body = new FakeNode('body');
    const mkId = (tag, id, cls = '') => {
      const n = new FakeNode(tag);
      if (cls) n.className = cls;
      n.setAttribute('id', id);
      return n;
    };
    const top = new FakeNode('header'); top.className = 'top';
    const title = mkId('div', 'title', 'top__title');
    const beats = mkId('nav', 'beats', 'beats');
    const tools = new FakeNode('div'); tools.className = 'top__tools';
    const count = mkId('span', 'count', 'num');
    const notesWrap = new FakeNode('div'); notesWrap.className = 'notes';
    const notes = mkId('button', 'notes', 'tool');
    const notesList = mkId('ul', 'notes-list', 'notes__list'); notesList.hidden = true;
    notesWrap.append(notes, notesList);
    const theme = mkId('button', 'theme', 'tool');
    tools.append(count, notesWrap, theme);
    top.append(title, beats, tools);
    const stage = mkId('main', 'stage', 'stage');
    const voice = new FakeNode('footer'); voice.className = 'voice';
    const line = mkId('p', 'line', 'voice__line');
    const key = mkId('p', 'key', 'voice__key');
    const prev = mkId('button', 'prev', 'btn');
    const next = mkId('button', 'next', 'btn');
    voice.append(line, key, prev, next);
    const lessonData = mkId('script', 'lesson-data');
    lessonData._text = JSON.stringify(lessonSpec);
    const bootEl = mkId('script', 'sh-companion-boot');
    bootEl._text = JSON.stringify({ protocol: 'studyhub-companion/1', channelToken: 'tok-slot', theme: 'dark', initialAnchor: initialHash, memory: {} });
    body.append(top, stage, voice, lessonData, bootEl);
    docEl.append(body);

    const document = {
      documentElement: docEl,
      body,
      getElementById: id => idMap.get(id) || null,
      createElement: tag => new FakeNode(tag),
      createElementNS: (_ns, tag) => new FakeNode(tag),
      createDocumentFragment: () => new FakeFragment(),
      createTextNode: txt => { const n = new FakeNode('#text'); n._text = String(txt); return n; },
      importNode: node => node,
      querySelector: sel => {
        if (sel === '.voice') return voice;
        if (sel === '.top__tools') return tools;
        return body.querySelector(sel);
      },
      addEventListener: (name, fn) => {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
      dispatchEvent: () => {},
    };
    const parentWin = { postMessage: msg => posted.push(msg) };
    const windowObj = {
      Lesson: null,
      parent: parentWin,
      innerWidth: 390,
      innerHeight: 844,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      getSelection: () => ({ toString: () => '', rangeCount: 0 }),
      addEventListener: (name, fn) => {
        if (!winListeners.has(name)) winListeners.set(name, []);
        winListeners.get(name).push(fn);
      },
      dispatch: (name, ev = {}) => {
        for (const fn of winListeners.get(name) || []) fn(ev);
      },
    };
    const sandbox = {
      window: windowObj,
      document,
      location: { hash: initialHash },
      localStorage: {
        getItem: k => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, String(v)),
      },
      requestAnimationFrame: fn => fn(),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
      DOMParser: class { parseFromString() { return { documentElement: null }; } },
      Math, Number, String, Boolean, Array, Object, Set, Map, WeakMap, RegExp, JSON, Infinity, NaN,
    };
    vm.runInNewContext(LESSON_TEMPLATE_RUNTIME_JS, sandbox);
    return { stage, prev, next, posted, storage, windowObj };
  }

  const slotLesson = {
    format: 'studyhub-lesson/1',
    id: 'slot-stability',
    language: 'en',
    title: 'Slot Determinism Test',
    beats: [{ id: 'run', label: 'Run' }, { id: 'check', label: 'Check' }],
    slides: [
      {
        beat: 'run',
        title: 'Workshop 1',
        blocks: [{ t: 'try', title: 'First Drill', prompt: 'Sketch invariant 1', criteria: ['Step A', 'Step B'], say: 'Try 1' }],
      },
      {
        beat: 'check',
        title: 'Check Slide 1',
        blocks: [{ t: 'quiz', q: 'First quiz?', answer: 1, say: 'Q1', options: ['Wrong A', 'Right B', 'Wrong C'] }],
      },
      {
        beat: 'check',
        title: 'Check Slide 2',
        blocks: [
          { t: 'quiz', q: 'Second quiz?', answer: 0, say: 'Q2', options: ['Right A', 'Wrong B', 'Wrong C'] },
          { t: 'try', title: 'Second Drill', prompt: 'Sketch invariant 2', criteria: ['Step C'], say: 'Try 2' },
        ],
      },
    ],
  };

  // Start directly on Slide 3 (#3) BEFORE Slide 1 or Slide 2 has ever been built!
  const env = makeDomHarness(slotLesson, '#3');
  // Click option 0 (correct) on Slide 3's quiz -> MUST report `slot: "check:1"`, NOT `"check:0"`!
  const slide3QuizBtns = env.stage.querySelectorAll('.opt');
  assert.equal(slide3QuizBtns.length, 3);
  slide3QuizBtns[0].click();
  const checkEvents = env.posted.filter(m => m.kind === 'self-check');
  assert.equal(checkEvents.length, 1);
  assert.equal(checkEvents[0].slot, 'check:1', 'Out-of-order jump to Slide 3 must still assign check:1 to the second quiz');
  assert.equal(checkEvents[0].correct, true);

  // Advance to reveal Workshop 2 on Slide 3 and write into its scratchpad -> MUST store under `try:w1:...`, NOT `try:w0:...`!
  env.next.click();
  const textarea3 = env.stage.querySelector('textarea');
  assert.ok(textarea3, 'Workshop scratchpad textarea should mount on Slide 3');
  textarea3.value = 'My invariant 2 proof';
  textarea3.dispatch('change');
  const memAfterSlide3 = JSON.parse(env.storage.get('lesson:slot-stability'));
  assert.ok(Object.keys(memAfterSlide3).some(k => k.startsWith('try:w1:') && k.endsWith(':draft')), `Expected try:w1:*:draft key, got ${Object.keys(memAfterSlide3).join(', ')}`);

  // Trigger beforeprint + afterprint (rebuilds ALL slides!) -> must NOT shift any quiz or workshop slot IDs!
  env.windowObj.dispatch('beforeprint');
  env.windowObj.dispatch('afterprint');

  // Navigate back to Slide 2 -> answer Slide 2's quiz -> MUST report `slot: "check:0"`!
  env.windowObj.dispatch('message', { data: { protocol: 'studyhub-companion/1', token: 'tok-slot', kind: 'goto', slide: 2 } });
  const slide2QuizBtns = env.stage.querySelectorAll('.opt');
  slide2QuizBtns[1].click();
  const allChecks = env.posted.filter(m => m.kind === 'self-check');
  assert.equal(allChecks.length, 2);
  assert.equal(allChecks[1].slot, 'check:0', 'Navigating back to Slide 2 after beforeprint must still assign check:0');
  assert.equal(allChecks[1].correct, true);

  // Navigate forward to Slide 3 again -> quiz answer (`is-right`) AND scratchpad draft (`My invariant 2 proof`) remain intact!
  env.windowObj.dispatch('message', { data: { protocol: 'studyhub-companion/1', token: 'tok-slot', kind: 'goto', slide: 3 } });
  env.next.click();
  assert.ok(env.stage.querySelectorAll('.opt')[0].classList.contains('is-right'), 'Quiz state must persist across back/forward navigation');
  assert.equal(env.stage.querySelector('textarea')?.value, 'My invariant 2 proof', 'Workshop scratchpad draft must persist across back/forward navigation');
});

test('Wave 7 Polish: detokenized glossary & slide titles in companion.get, 15 MB message, CompanionViewer ready-state isolation, unmount flush & mobile/dark CSS', async () => {
  // 1. detokenizeLesson + companion.get detokenizes `terms` (zero @@SHM_N@@ leaks) & populates `lesson.slides` titles
  const tmp = await mkdtemp(join(tmpdir(), 'sh-comp-w7-'));
  try {
    const storeDir = join(tmp, 'lib');
    const wsDir = join(tmp, 'ws');
    await mkdir(wsDir, { recursive: true });
    const svc = new StudyService(storeDir, {});
    const spec = buildArchetypeLesson({ archetype: 'sandbox', language: 'en' });
    const compiled = await svc.call('companion.compile', {
      course: 'Vibrations',
      lesson: spec,
      workspace: wsDir,
    });
    const fetched = await svc.call('companion.get', { id: compiled.companion.id, course: 'Vibrations' });
    assert.ok(fetched.lesson?.terms?.['Critical Damping'], 'Glossary term should exist in companion.get');
    assert.ok(fetched.lesson.terms['Critical Damping'].includes('$\\zeta = 1$'), `Expected LaTeX restored in glossary term, got: ${fetched.lesson.terms['Critical Damping']}`);
    assert.ok(!/@@SHM_\d+@@/.test(JSON.stringify(fetched.lesson)), 'companion.get lesson payload must contain zero raw @@SHM_N@@ tokens');
    assert.equal(fetched.lesson.slides?.length, 16);
    assert.equal(fetched.lesson.slides[0].title, 'A Deceptively Simple Question');
    assert.equal(fetched.lesson.slides[0].beat, 'open');

    // Direct detokenizeLesson export check on tokenized math keys & values
    const tokenized = compileMathInLesson(normalizeLessonSpec(spec));
    assert.match(JSON.stringify(tokenized.terms), /@@SHM_\d+@@/);
    const detok = detokenizeLesson(tokenized);
    assert.doesNotMatch(JSON.stringify(detok.terms), /@@SHM_\d+@@/);

    // 15 MB limit runtime enforcement across HTML, JSON attach, and managed companion document reads + localized message
    assert.equal(MAX_COMPANION_BYTES, 15 * 1024 * 1024);
    assert.equal(localizeAppMessage('伴学 HTML 文件超过 15 MB 上限', 'en'), 'The companion HTML file exceeds the 15 MB limit');
    const oversizedHtml = join(wsDir, 'oversized.html');
    await writeFile(oversizedHtml, '<!doctype html>', 'utf8');
    await truncate(oversizedHtml, MAX_COMPANION_BYTES + 1);
    await assert.rejects(
      () => readCheckedHtmlFile(oversizedHtml),
      (err) => /伴学 HTML 文件超过 15 MB 上限/.test(err.message) && !/\b5 MB 上限/.test(err.message),
      'oversized HTML must fail with the 15 MB message',
    );
    const oversizedJson = join(wsDir, 'oversized.json');
    await writeFile(oversizedJson, '{}', 'utf8');
    await truncate(oversizedJson, MAX_COMPANION_BYTES + 1);
    await assert.rejects(
      () => svc.call('companion.attach', { path: oversizedJson, course: 'Vibrations', workspace: wsDir, allowRememberTrusted: true }),
      (err) => /伴学 HTML 文件超过 15 MB 上限/.test(err.message) && !/\b5 MB 上限/.test(err.message),
      'oversized JSON companion must fail with the 15 MB message',
    );
    const managedOversized = join(storeDir, 'companions', 'files', 'comp-oversized.html');
    await mkdir(join(storeDir, 'companions', 'files'), { recursive: true });
    await writeFile(managedOversized, '<!doctype html>', 'utf8');
    await truncate(managedOversized, MAX_COMPANION_BYTES + 1);
    await assert.rejects(
      () => readCompanionDocument({ root: storeDir, record: { id: 'comp-oversized', mode: 'managed' } }),
      (err) => /伴学 HTML 文件超过 15 MB 上限/.test(err.message) && !/\b5 MB 上限/.test(err.message),
      'oversized managed companion document must fail with the 15 MB message',
    );

    svc.dispose();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // 2. CompanionViewer ready-state SSR: ledger isolation, catch-up visibility, aria-label, unified Slide X/Y, zero questions.json jargon & zero Han in English
  const readyState = {
    status: 'ready',
    companion: { id: 'comp-ethics', lessonId: 'ethics-1', title: 'Duty vs Utility', course: 'Moral Philosophy', slideCount: 16, linkedRoot: '/lab' },
    html: '<!doctype html><html><head><title>Duty</title></head><body><main>Slide</main></body></html>',
    file: '/lab/pages/ethics.html',
    changedOnDisk: true,
    lesson: {
      id: 'ethics-1',
      title: 'Duty vs Utility',
      slideCount: 16,
      slides: Array.from({ length: 16 }, (_, i) => ({ title: `Slide Title ${i + 1}`, beat: 'open' })),
      terms: { 'Categorical Imperative': 'Act only according to universalizable maxims.' },
    },
    bootConfig: { channelToken: 'tok-ready', theme: 'dark', initialAnchor: '#1', initialSlide: 1, memory: {} },
    relatedCards: [],
  };

  setUiLanguage('en');
  try {
    const fakeStudy = { busy: false, call: () => new Promise(() => {}), act: async () => ({}), notify: () => {}, openModal: () => {} };
    const fakeApp = { data: { courses: [], sources: [], decks: [] }, core: { refresh: () => {} } };

    // Case A: Feedback ledger has open items ONLY for `other-lesson-99` + tutorReply present with cleared `cardDraft` (post-save state)
    const isolatedViewerHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: fakeApp },
          React.createElement(CompanionViewer, {
            modal: {
              id: 'comp-ethics',
              course: 'Moral Philosophy',
              openDrawer: true,
              initialState: readyState,
              initialFeedbackState: {
                loading: false,
                total: 2,
                open: 2,
                items: [
                  { id: 'q-other-1', lessonId: 'other-lesson-99', slide: 4, slideTitle: 'Other Lesson Slide', tag: 'unclear', note: 'Leaked doubt from another lesson!', status: 'open' },
                ],
                error: '',
              },
              initialTutorReply: 'Here is the crisp tutor explanation.',
              initialCardDraft: { prompt: '', answer: '', misconception: '' },
            },
            onClose: () => {},
          }),
        ),
      ),
    );
    assert.ok(!isolatedViewerHtml.includes('Leaked doubt from another lesson!'), 'openFeedbackItems must never fall back to allOpen from other lessons');
    assert.ok(isolatedViewerHtml.includes('0 open · 0 total'), `Expected isolated "0 open · 0 total", got: ${isolatedViewerHtml}`);
    assert.ok(isolatedViewerHtml.includes('No open doubts recorded for this lesson.'));
    assert.ok(isolatedViewerHtml.includes('aria-label="Ask Tutor About This Slide"'), 'Tutor TextArea must carry aria-label');
    assert.ok(isolatedViewerHtml.includes('Slide 1/16'), 'Slide jump label must use unified "Slide 1/16"');
    assert.ok(!isolatedViewerHtml.includes('Save to Companion Catch-ups'), 'Cleared cardDraft after save must hide catch-up form even while tutorReply stays visible');
    assert.ok(!isolatedViewerHtml.includes('questions.json'), 'Viewer UI must not expose raw questions.json filename');
    assert.ok(!CJK_RE.test(isolatedViewerHtml), `English ready CompanionViewer leaked Han chars: ${isolatedViewerHtml}`);

    // Case B: Seeded cardDraft (even when suggestedCard was null, seeded from question + reply) renders catch-up form cleanly in English
    const seededViewerHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: fakeApp },
          React.createElement(CompanionViewer, {
            modal: {
              id: 'comp-ethics',
              course: 'Moral Philosophy',
              openDrawer: true,
              initialState: { ...readyState, companion: { ...readyState.companion, slideCount: 1 }, lesson: { ...readyState.lesson, slideCount: 1, slides: [{ title: 'Single Slide', beat: 'open' }] } },
              initialTutorReply: 'Direct explanation.',
              initialCardDraft: { prompt: 'My question', answer: 'Direct explanation.', misconception: 'My question' },
            },
            onClose: () => {},
          }),
        ),
      ),
    );
    assert.ok(seededViewerHtml.includes('Save to Companion Catch-ups'), 'Seeded cardDraft must render catch-up card form');
    assert.ok(seededViewerHtml.includes('Slide 1/1'), 'Single-slide badge must also use unified Slide 1/1');
    assert.ok(!seededViewerHtml.includes('questions.json'));
    assert.ok(!CJK_RE.test(seededViewerHtml), `English seeded CompanionViewer leaked Han chars: ${seededViewerHtml}`);
    // Case C: Partial cardDraft (either prompt alone OR answer alone) still opens the catch-up form
    for (const partialDraft of [
      { prompt: 'Only prompt filled', answer: '', misconception: '' },
      { prompt: '', answer: 'Only answer filled', misconception: '' },
    ]) {
      const partialHtml = renderToStaticMarkup(
        React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
          React.createElement(AppContext.Provider, { value: fakeApp },
            React.createElement(CompanionViewer, {
              modal: {
                id: 'comp-ethics',
                course: 'Moral Philosophy',
                openDrawer: true,
                initialState: readyState,
                initialCardDraft: partialDraft,
              },
              onClose: () => {},
            }),
          ),
        ),
      );
      assert.ok(partialHtml.includes('Save to Companion Catch-ups'), 'Partial cardDraft (prompt || answer) must render catch-up form');
    }
  } finally {
    setUiLanguage('zh');
  }

  // 3. Runtime unmount flush: debounced `companion.progress` is flushed immediately when CompanionViewer unmounts
  {
    const messageListeners = [];
    const progressCalls = [];
    await withBrowserGlobals(async () => {
      const viewerUi = await loadInteractiveUi(`
        export { default as CompanionViewer } from './ui/companions/CompanionViewer.jsx';
        export { StudyServicesContext } from './ui/study-context.jsx';
        export { AppContext } from './ui/app/app-context.js';
      `);
      const frameWin = { postMessage() {} };
      const studySvc = {
        busy: false,
        call: async (name, args) => {
          if (name === 'companion.get') return readyState;
          if (name === 'companion.feedback.list') return { total: 0, open: 0, items: [] };
          if (name === 'companion.progress') {
            progressCalls.push(args);
            return { ok: true };
          }
          return {};
        },
        act: async () => ({}),
        notify: () => {},
        openModal: () => {},
      };
      const mounted = viewerUi.mount(() => viewerUi.React.createElement(
        viewerUi.exports.StudyServicesContext.Provider,
        { value: studySvc },
        viewerUi.React.createElement(
          viewerUi.exports.AppContext.Provider,
          { value: { data: { courses: [], sources: [], decks: [] }, core: { refresh: () => {} } } },
          viewerUi.React.createElement(viewerUi.exports.CompanionViewer, {
            modal: { id: 'comp-ethics', course: 'Moral Philosophy' },
            onClose: () => {},
          }),
        ),
      ));
      try {
        await mounted.flush(6);
        const frameEl = mounted.find((n) => typeof n.props?.companion?.channelToken === 'string');
        assert.ok(frameEl?.props?.companion?.channelToken, 'DiagramFrame must receive bootConfig.channelToken');
        const iframeHost = mounted.find((n) => n.type === 'iframe' && n.ref?.current);
        assert.ok(iframeHost, 'DiagramFrame must mount an iframe host ref');
        iframeHost.ref.current.contentWindow = frameWin;

        const token = frameEl.props.companion.channelToken;
        for (const listener of [...messageListeners]) {
          listener({
            source: frameWin,
            data: { protocol: 'studyhub-companion/1', token, kind: 'progress', slide: 4, slideTotal: 16, completed: false },
          });
        }
        assert.equal(progressCalls.length, 0, 'non-completed progress is debounced before unmount');
      } finally {
        mounted.unmount();
      }
      assert.equal(progressCalls.length, 1, 'unmounting CompanionViewer must flush pending debounced companion.progress');
      assert.equal(progressCalls[0].id, 'comp-ethics');
      assert.equal(progressCalls[0].course, 'Moral Philosophy');
      assert.equal(progressCalls[0].slide, 4);
      assert.equal(progressCalls[0].slideTotal, 16);
    }, {
      window: {
        addEventListener: (type, fn) => { if (type === 'message') messageListeners.push(fn); },
        removeEventListener: (type, fn) => {
          const idx = messageListeners.indexOf(fn);
          if (idx >= 0) messageListeners.splice(idx, 1);
        },
      },
    });
  }

  // 4. Mobile 390px popover bounds, dark `--s4` >= 6:1 contrast, selection pill border & container-query split row
  assert.match(LESSON_TEMPLATE_CSS, /@media\s*\(max-width:\s*640px\)\s*\{\s*\.notes__list,\s*\.toc__pop,\s*\.kbd__pop\s*\{\s*position:\s*fixed;\s*left:\s*\.65rem;\s*right:\s*\.65rem;/);
  assert.doesNotMatch(LESSON_TEMPLATE_CSS, /--s4:\s*#7b6a0e/i, 'Low-contrast dark --s4 #7b6a0e must be replaced');
  assert.equal((LESSON_TEMPLATE_CSS.match(/--s4:\s*#d8b24c/gi) || []).length, 2, 'Both prefers-color-scheme and data-theme="dark" must set --s4: #d8b24c');
  assert.match(LESSON_TEMPLATE_CSS, /\.sh-sel-pill\s*\{[^}]*border:\s*1px solid var\(--rule-strong\)/);

  // WCAG 2.1 contrast check of #d8b24c against #161412 dark canvas (>= 6:1)
  const relLum = hex => {
    const n = parseInt(hex.slice(1), 16);
    const chans = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * chans[0] + 0.7152 * chans[1] + 0.0722 * chans[2];
  };
  const l1 = relLum('#d8b24c'), l2 = relLum('#161412');
  const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  assert.ok(contrast >= 6, `Expected dark --s4 contrast >= 6:1 on #161412, got ${contrast.toFixed(2)}:1`);

  const shimBooted = framedDocument('<!doctype html><html><head></head><body></body></html>', { channelToken: 'tok-dark', theme: 'dark' });
  assert.match(shimBooted, /border:1px solid var\(--rule-strong,rgba\(255,241,220,\.42\)\)/);
  assert.doesNotMatch(shimBooted, /border:1px solid #1e1a15/);

  // Static CSS layout contract: Node has no CSS container-query/grid layout engine, so verify companions.css via CSS AST declarations.
  const { declarations: compDecls } = parseCss(await readFile(new URL('../ui/companions/companions.css', import.meta.url), 'utf8'));
  assert.ok(
    compDecls.some(d => d.ctx.at(-1) === '.sh-comp-drawer' && d.prop === 'container-type' && d.value === 'inline-size'),
    '.sh-comp-drawer must declare container-type: inline-size',
  );
  assert.ok(
    compDecls.some(d => d.ctx.at(-1) === '.sh-comp-bar' && d.prop === 'container-type' && d.value === 'inline-size'),
    '.sh-comp-bar must declare container-type: inline-size',
  );
  assert.ok(
    compDecls.some(
      d => d.ctx.some(c => /@container\s*\(max-width:\s*860px\)/.test(c))
        && d.ctx.at(-1) === '.sh-comp-viewer--split'
        && d.prop === 'grid-template-rows'
        && d.value === 'minmax(0, 1fr) minmax(0, 44%)',
    ),
    '@container (max-width: 860px) must stack .sh-comp-viewer--split rows as minmax(0, 1fr) minmax(0, 44%)',
  );
  assert.ok(
    compDecls.some(
      d => d.ctx.some(c => /@media\s*\(max-width:\s*860px\)/.test(c))
        && d.ctx.at(-1) === '.sh-comp-viewer--split'
        && d.prop === 'grid-template-rows'
        && d.value === 'minmax(0, 1fr) minmax(0, 44%)',
    ),
    '@media (max-width: 860px) must stack .sh-comp-viewer--split rows as minmax(0, 1fr) minmax(0, 44%)',
  );
});
