import { compileLessonHtml } from '../lib/companion-template/render-html.js';
import { projectLessonSource } from '../lib/companion/companion-lesson.js';
import { createHash } from './crypto.js';

function buildDampingLesson(language = 'en') {
  const en = language === 'en';
  const exactResponseExpr = 'exp(-zeta*wn*t) * ((1 - step(zeta, 1.0001)) * (cos(sqrt(max(0, 1 - zeta^2))*wn*t) + zeta*wn*t*sinc(sqrt(max(0, 1 - zeta^2))*wn*t)) + step(zeta, 1.0001) * (cosh(sqrt(max(0.0001, zeta^2 - 1))*wn*t) + (zeta / sqrt(max(0.0001, zeta^2 - 1))) * sinh(sqrt(max(0.0001, zeta^2 - 1))*wn*t)))';
  const exactVelocityExpr = '-wn^2 * t * exp(-zeta*wn*t) * ((1 - step(zeta, 1.0001)) * sinc(sqrt(max(0, 1 - zeta^2))*wn*t) + step(zeta, 1.0001) * sinh(sqrt(max(0.0001, zeta^2 - 1))*wn*t) / (sqrt(max(0.0001, zeta^2 - 1))*wn*max(0.0001, t)))';

  return {
    format: 'studyhub-lesson/1',
    template: 'sandbox',
    language,
    id: 'demo-critical-damping',
    course: en ? 'Mathematics & Physics' : '数理与控制工程',
    title: en
      ? 'Critical Damping & Parametric Oscillations'
      : '临界阻尼与含参振动相变',
    lead: en
      ? 'Watch oscillation vanish at $\\zeta = 1$, uncover why naive two-root division breaks, and master the secular term $t e^{-\\omega_n t}$.'
      : '亲手拖动阻尼比直击 $\\zeta = 1$ 相变边界，揪出双指数通解除零陷阱，彻底吃透长期项 $t e^{-\\omega_n t}$。',
    minutes: 22,
    needs: en
      ? ['Derivatives as rates of change $x\'(t), x\'\'(t)$', 'Quadratic roots & discriminant $\\Delta = b^2 - 4ac$', 'Exponential decay $e^{-\\alpha t}$']
      : ['导数与变化率 $x\'(t), x\'\'(t)$', '二次方程求根公式与判别式 $\\Delta = b^2 - 4ac$', '指数衰减函数 $e^{-\\alpha t}$'],
    after: en
      ? ['Distinguish underdamped, critically damped, and overdamped regimes visually and algebraically', 'Spot hidden division-by-zero traps when characteristic roots collide', 'Select optimal $\\zeta$ and $\\omega_n$ for precision engineering systems']
      : ['从图像与代数双视角区分欠阻尼、临界阻尼与过阻尼三种相态', '一眼识别含参微分方程重根退化时的除零假象', '根据零超调与响应速度约束为工程系统选定最优 $\\zeta$ 与 $\\omega_n$'],
    terms: en
      ? {
          'Critical Damping': 'The exact boundary $\\zeta = 1$ where the characteristic equation has a repeated root $r_1 = r_2 = -\\omega_n$, yielding the fastest return to equilibrium without overshoot.',
          'Damping Ratio': 'Dimensionless parameter $\\zeta = c / (2\\sqrt{mk})$ comparing actual damping $c$ against critical damping $2\\sqrt{mk}$.',
          'Natural Frequency': 'Undamped angular frequency $\\omega_n = \\sqrt{k/m}$ (in rad/s) set by stiffness-to-mass ratio.',
          'Wronskian': 'Determinant $W(y_1, y_2) = y_1 y_2\' - y_1\' y_2$ testing whether two solutions span a full 2D state space.',
          'Overshoot': 'Peak excursion past the target equilibrium $x = 0$ before settling, present whenever $0 \\le \\zeta < 1$.',
        }
      : {
          '临界阻尼': '阻尼比恰好满足 $\\zeta = 1$ 的相变分界：特征方程出现二重根 $r_1 = r_2 = -\\omega_n$，实现零超调下的最快复位。',
          '阻尼比': '无量纲参数 $\\zeta = c / (2\\sqrt{mk})$，衡量实际阻尼系数与临界阻尼系数的比值。',
          '固有频率': '无阻尼系统的自由角频率 $\\omega_n = \\sqrt{k/m}$（单位 rad/s），由刚度与质量之比决定。',
          '朗斯基行列式': '判别式 $W(y_1, y_2) = y_1 y_2\' - y_1\' y_2$，非零即证明两个解线性无关、可张成完整二维初值空间。',
          '超调': '响应首次越过目标平衡线 $x = 0$ 的最大反向偏离幅度，仅在欠阻尼 $0 \\le \\zeta < 1$ 时出现。',
        },
    slides: [
      {
        beat: 'open',
        title: en ? 'Why More Brake Can Mean Slower Settling' : '为什么「阻尼加得越猛」反而复位越慢？',
        blocks: [
          {
            t: 'text',
            md: en
              ? 'A wafer-stepper stage worth over $100k must snap back to $x = 0$ after a $1\\text{ mm}$ step without **ever** crossing zero. Governed by $$x\'\'(t) + 2\\zeta\\omega_n x\'(t) + \\omega_n^2 x(t) = 0$$ every regime obeys one piecewise law:\n$$x(t) = \\begin{cases} e^{-\\zeta\\omega_n t}\\left(\\cos\\omega_d t + \\frac{\\zeta\\omega_n}{\\omega_d}\\sin\\omega_d t\\right), & 0 < \\zeta < 1 \\\\ (1 + \\omega_n t)e^{-\\omega_n t}, & \\zeta = 1 \\\\ \\frac{r_2 e^{r_1 t} - r_1 e^{r_2 t}}{r_2 - r_1}, & \\zeta > 1 \\end{cases}$$'
              : '光刻机晶圆台在阶跃定位后必须迅速回到平衡线 $x = 0$，且**绝不允许越界碰撞**。受二阶常微分方程 $$x\'\'(t) + 2\\zeta\\omega_n x\'(t) + \\omega_n^2 x(t) = 0$$ 支配，系统在三段参数区呈现截然不同的解析形态：\n$$x(t) = \\begin{cases} e^{-\\zeta\\omega_n t}\\left(\\cos\\omega_d t + \\frac{\\zeta\\omega_n}{\\omega_d}\\sin\\omega_d t\\right), & 0 < \\zeta < 1 \\\\ (1 + \\omega_n t)e^{-\\omega_n t}, & \\zeta = 1 \\\\ \\frac{r_2 e^{r_1 t} - r_1 e^{r_2 t}}{r_2 - r_1}, & \\zeta > 1 \\end{cases}$$',
            say: en
              ? 'Too little damping rings past zero; too much damping turns viscous and sluggish. Right on the knife-edge sits Critical Damping.'
              : '阻尼太小会来回震荡撞件，阻尼太大又像陷进糖浆里迟迟不归零。两条直觉的刀锋交界，正是临界阻尼。',
          },
          {
            t: 'callout',
            tone: 'info',
            title: en ? 'Total Dissipated Energy Invariant' : '全程耗散能量恒等式',
            md: en
              ? 'For any $\\zeta > 0$, total damper heat equals initial spring energy: $\\int_0^\\infty c\\,[x\'(t)]^2\\,dt = \\frac{1}{2}k x_0^2$. Damping changes **how fast** energy leaves, not how much.'
              : '对任意正阻尼 $\\zeta > 0$，阻尼器耗散总功恒等于初始弹性势能：$\\int_0^\\infty c\\,[x\'(t)]^2\\,dt = \\frac{1}{2}k x_0^2$。阻尼比改变的不是总能量，而是能量释放的时序。',
            say: en
              ? 'Keep this invariant in mind: every curve we plot releases the exact same initial energy.'
              : '先记住这个漂亮的不变量：无论曲线怎么变，耗散掉的总初始机械能分毫不差。',
          },
        ],
      },
      {
        beat: 'open',
        title: en ? 'Two-Minute Foundation Check' : '两分钟地基唤醒',
        blocks: [
          {
            t: 'recall',
            say: en
              ? 'Quickly verify two algebraic reflexes before we touch the live sliders.'
              : '在上手拉动沙盒滑块前，花一分钟确认两个代数直觉。',
            items: [
              {
                have: en ? 'Quadratic discriminant' : '特征方程判别式',
                q: en
                  ? 'For $r^2 + 2\\zeta\\omega_n r + \\omega_n^2 = 0$ ($\\omega_n > 0$), when do the two roots merge into one?'
                  : '对于特征方程 $r^2 + 2\\zeta\\omega_n r + \\omega_n^2 = 0$（$\\omega_n > 0$），何时两个特征根重合？',
                options: [
                  en ? 'When $\\zeta = 0$' : '当 $\\zeta = 0$ 时',
                  en ? 'When $\\zeta = 1$ ($\\Delta = 4\\omega_n^2(\\zeta^2 - 1) = 0$)' : '当 $\\zeta = 1$（判别式 $4\\omega_n^2(\\zeta^2 - 1) = 0$）时',
                  en ? 'When $\\zeta \\to \\infty$' : '当 $\\zeta \\to \\infty$ 时',
                ],
                answer: 1,
                why: en
                  ? 'Setting $(2\\zeta\\omega_n)^2 - 4\\omega_n^2 = 0$ gives $\\zeta^2 = 1$, so $r_1 = r_2 = -\\omega_n$.'
                  : '令 $(2\\zeta\\omega_n)^2 - 4\\omega_n^2 = 0$ 得 $\\zeta^2 = 1$，此时出现二重实根 $r_1 = r_2 = -\\omega_n$。',
              },
              {
                have: en ? 'Zero-crossing & velocity' : '过零超调判据',
                q: en
                  ? 'Starting at $x(0) = 1, x\'(0) = 0$, what must happen if $x(t)$ overshoots into $x(t) < 0$?'
                  : '从 $x(0) = 1, x\'(0) = 0$ 释放后，若响应超调进入 $x(t) < 0$，图像必然发生什么？',
                options: [
                  en ? 'It crosses the equilibrium line $y = 0$ with negative velocity' : '以负速度穿过平衡线 $y = 0$',
                  en ? 'Its slope $x\'(t)$ stays positive forever' : '导数 $x\'(t)$ 全程保持为正',
                ],
                answer: 0,
                why: en
                  ? 'Crossing from $x > 0$ to $x < 0$ requires passing $x = 0$ while moving downward ($x\' < 0$).'
                  : '从正位移进入负位移必须穿过 $x = 0$，且穿过瞬间速度方向向下（$x\' < 0$）。',
              },
            ],
          },
        ],
      },
      {
        beat: 'hook',
        title: en ? 'From Heavy Glass Door to Differential Equation' : '把自动闭门器映射成微分方程',
        blocks: [
          {
            t: 'scene',
            columns: [en ? 'Physical Door Closer' : '液压自动闭门器', en ? 'Normalized Parameter' : '归一化数学参数'],
            story: en
              ? 'Release a heavy glass lobby door from $45^\\circ$ open ($x(0)=1$) with zero push ($x\'(0)=0$). Every screw on the closer maps to one symbol.'
              : '把写字楼玻璃门推开到 $x(0)=1$ 后静手松开（$x\'(0)=0$），闭门器上的每颗调节螺钉都精确对应方程里的一个参数。',
            say: en
              ? 'Step through the three physical levers to build gut intuition before any algebra.'
              : '按「下一步」逐行对照，先把冷冰冰的希腊字母翻译成手上的物理触感。',
            picture: {
              actors: [en ? 'Return Spring' : '复位弹簧', en ? 'Oil Valve' : '液压阻尼阀'],
              shared: { name: 'zeta', value: '1.00' },
            },
            map: [
              {
                scene: en ? 'Stiffer coil spring / lighter door leaf' : '换更硬的弹簧 / 减轻门扇重量',
                model: 'Natural Frequency $\\omega_n = \\sqrt{k/m}$',
                on: 'actors',
                tag: 'wn ↑',
                say: en ? 'Raising $\\omega_n$ compresses the time axis—everything happens faster.' : '增大固有频率 $\\omega_n$ 相当于整体压缩时间轴，回弹节奏全面加快。',
              },
              {
                scene: en ? 'Tightening the hydraulic needle valve' : '拧紧液压油节流阀（油阻变大）',
                model: 'Damping Ratio $\\zeta = c / (2\\sqrt{mk})$',
                on: 'shared',
                tag: 'zeta ↑',
                say: en ? 'Raising $\\zeta$ drains kinetic energy before the door can slam past the latch.' : '调大阻尼比 $\\zeta$ 会在门扇冲向门框途中提前抽干动能。',
              },
              {
                scene: en ? 'Valve over-tightened ($\\zeta = 1.8$)' : '节流阀拧过头（$\\zeta = 1.8$）',
                model: 'Slow mode $e^{r_1 t}$ with $r_1 \\approx -\\omega_n/(2\\zeta)$',
                on: 'action',
                tag: 'creeping tail',
                say: en ? 'Over-damping creates a sluggish slow eigenvalue $r_1 \\to 0^-$ that leaves the door ajar!' : '一旦进入过阻尼，慢特征根 $r_1 \\to 0^-$ 会拖出漫长尾巴，冷风直往屋里灌！',
                key: en ? 'Overdamping slows settling because one root approaches $0^-$ as $\\zeta$ grows.' : '过阻尼反而变慢的元凶：慢特征根随 $\\zeta$ 增大逼近 $0^-$，主导后期蠕行。',
              },
            ],
          },
        ],
      },
      {
        beat: 'code',
        title: en ? 'The Tempting Two-Exponential Formula' : '看似万能的双指数通解推导',
        blocks: [
          {
            t: 'code',
            path: 'two-root-ansatz.txt',
            lang: 'derivation',
            source: [
              '1. Characteristic eq: r^2 + 2*zeta*wn*r + wn^2 = 0',
              '2. Roots: r_{1,2} = wn * (-zeta +/- sqrt(zeta^2 - 1))',
              "3. Match x(0)=1, x'(0)=0: C1 = r2 / (r2 - r1), C2 = -r1 / (r2 - r1)",
              '4. General solution: x(t) = C1*exp(r1*t) + C2*exp(r2*t)',
            ].join('\n'),
            focusLines: [1, 2],
            say: en
              ? 'When $\\zeta \\neq 1$, plugging $x(t) = e^{rt}$ gives two distinct roots $r_1 \\neq r_2$.'
              : '当 $\\zeta \\neq 1$ 时，代入指数试探解 $e^{rt}$ 能顺利解出两个互异特征根 $r_1 \\neq r_2$。',
            walk: [
              {
                focusLines: [3, 4],
                say: en
                  ? 'Look closely at Line 3: to satisfy $x\'(0) = 0$, we divide by $(r_2 - r_1)$. What happens right at $\\zeta = 1$?'
                  : '紧盯第 3 行：为了凑出初速度 $x\'(0) = 0$，分母出现了 $(r_2 - r_1)$。当 $\\zeta$ 恰好滑到 $1$ 时会发生什么？',
              },
            ],
          },
        ],
      },
      {
        beat: 'predict',
        title: en ? 'Predict Before You Touch the Sandbox' : '拉滑块前，先押下你的直觉判断',
        blocks: [
          {
            t: 'predict',
            id: 'pred-damping',
            q: en
              ? 'Fix $\\omega_n = 1.2\\text{ rad/s}$ and compare $\\zeta = 0.25$, $\\zeta = 1.0$, and $\\zeta = 1.8$. Which setting enters the $y = 0.05$ settling band earliest WITHOUT ever crossing $y = 0$?'
              : '固定 $\\omega_n = 1.2\\text{ rad/s}$，对比 $\\zeta = 0.25$、$\\zeta = 1.0$ 与 $\\zeta = 1.8$。哪一组能在**绝不越过 $y = 0$** 的前提下最早进入 $y = 0.05$ 收敛带？',
            options: [
              en ? '$\\zeta = 0.25$ — lowest damping reaches zero fastest and stays there' : '$\\zeta = 0.25$ —— 阻力最小，冲到零最快且直接停稳',
              en ? '$\\zeta = 1.0$ — Critical Damping settles fastest with zero overshoot' : '$\\zeta = 1.0$ —— 临界阻尼零超调且最快压进收敛带',
              en ? '$\\zeta = 1.8$ — heaviest damping suppresses motion fastest' : '$\\zeta = 1.8$ —— 阻尼越大刹车越狠，一定最早归零',
            ],
            answer: 1,
            say: en
              ? 'Commit to one prediction first—then verify it with the live crosshair on the next slide!'
              : '先选一个答案落子无悔——下一页直接用实时十字准星量出真相！',
          },
        ],
      },
      {
        beat: 'run',
        title: en ? 'Interactive Parametric Sandbox: Sweep $\\zeta$ & $\\omega_n$' : '交互数理沙盒：亲手扫过 $\\zeta = 1$ 临界相变',
        blocks: [
          {
            t: 'sandbox',
            caption: en
              ? 'Hover or click the plot to pin the $(t, y)$ crosshair; drag $\\zeta$ from $0.25 \\to 1.0 \\to 1.8$ against the $y = 0.05$ band.'
              : '在图上悬停或点击即可锁定 $(t, y)$ 读数准星；把 $\\zeta$ 从 $0.25$ 拖过 $1.0$ 再到 $1.8$，观察 $0.05$ 阈值带交点。',
            say: en
              ? 'Start at $\\zeta = 0.25$: watch the solid curve dive below $y = 0$ (44% overshoot!) while bounded by the dashed envelope.'
              : '先看默认 $\\zeta = 0.25$：实线剧烈跌破平衡线 $y = 0$（超调高达 44%！），紧贴虚线指数包络来回震荡。',
            knobs: [
              { id: 'zeta', label: en ? 'Damping Ratio $\\zeta$' : '阻尼比 $\\zeta$', min: 0.1, max: 2.0, step: 0.05, default: 0.25, unit: '' },
              { id: 'wn', label: en ? 'Natural Freq $\\omega_n$' : '固有频率 $\\omega_n$', min: 0.5, max: 2.5, step: 0.1, default: 1.2, unit: 'rad/s' },
            ],
            presets: [
              { label: en ? 'Underdamped ($\\zeta = 0.25$)' : '欠阻尼（$\\zeta = 0.25$）', values: { zeta: 0.25, wn: 1.2 } },
              { label: en ? 'Butterworth ($\\zeta = 0.70$)' : '巴特沃斯（$\\zeta = 0.70$）', values: { zeta: 0.7, wn: 1.2 } },
              { label: en ? 'Critical ($\\zeta = 1.00$)' : '临界阻尼（$\\zeta = 1.00$）', values: { zeta: 1.0, wn: 1.2 } },
              { label: en ? 'Overdamped ($\\zeta = 1.80$)' : '过阻尼（$\\zeta = 1.80$）', values: { zeta: 1.8, wn: 1.2 } },
            ],
            domain: { variable: 't', min: 0, max: 10, steps: 120, label: 't', unit: 's' },
            yRange: [-0.8, 1.08],
            threshold: { value: 0.05, band: 0.05, label: en ? '5% settling target' : '5% 稳态收敛带' },
            series: [
              { id: 'x', label: en ? 'Response $x(t)$' : '位移响应 $x(t)$', expr: exactResponseExpr },
              { id: 'env', label: en ? 'Decay $e^{-\\zeta\\omega_n t}$' : '纯指数包络 $e^{-\\zeta\\omega_n t}$', expr: 'exp(-zeta*wn*t)' },
            ],
            readouts: [
              { id: 'disc', label: en ? 'Discriminant $\\zeta^2 - 1$' : '判别指标 $\\zeta^2 - 1$', expr: 'zeta^2 - 1', unit: '' },
              { id: 'mp', label: en ? 'Peak Overshoot' : '最大超调率', expr: '(1 - step(zeta, 1)) * 100 * exp(-pi * zeta / sqrt(max(0.0001, 1 - min(0.9999, zeta^2))))', unit: '%' },
              { id: 'x4', label: en ? 'Envelope at $t = 4\\text{ s}$' : '$t = 4\\text{ s}$ 包络幅值', expr: 'exp(-4 * zeta * wn)', unit: '' },
            ],
            walk: [
              {
                set: { zeta: 0.25, wn: 1.2 },
                say: en
                  ? 'Underdamped ($\\zeta = 0.25$): crosses zero early, but rings outside the 5% band past $t = 8\\text{ s}$.'
                  : '欠阻尼（$\\zeta = 0.25$）：虽然第一次过零很快，但反复震荡，直到 $t > 8\\text{ s}$ 才真正收进 5% 误差带。',
              },
              {
                set: { zeta: 1.0, wn: 1.2 },
                say: en
                  ? 'Critically damped ($\\zeta = 1.0$): zero overshoot, entering $x \\le 0.05$ right around $t \\approx 3.95\\text{ s}$!'
                  : '临界阻尼（$\\zeta = 1.0$）：超调瞬间归零，约 $t \\approx 3.95\\text{ s}$ 就稳稳钻进 $0.05$ 收敛带！',
                key: en
                  ? 'At $\\zeta = 1$, $(1 + \\omega_n t)e^{-\\omega_n t}$ achieves the fastest non-overshooting decay.'
                  : '$\\zeta = 1$ 时响应 $(1 + \\omega_n t)e^{-\\omega_n t}$ 取得零超调条件下的最快收敛时间。',
              },
              {
                set: { zeta: 1.8, wn: 1.2 },
                say: en
                  ? 'Overdamped ($\\zeta = 1.8$): still above $0.05$ past $t = 7.5\\text{ s}$—nearly twice as slow as $\\zeta = 1.0$!'
                  : '过阻尼（$\\zeta = 1.8$）：到 $t = 7.5\\text{ s}$ 还没落进 $0.05$ 带，耗时几乎比临界阻尼慢了一倍！',
              },
            ],
          },
          {
            t: 'reveal',
            of: 'pred-damping',
            say: en
              ? 'Now drag $\\omega_n$ up to $2.0\\text{ rad/s}$ too—notice how time scales inversely with $\\omega_n$ while overshoot depends ONLY on $\\zeta$!'
              : '顺手再拖一下 $\\omega_n$ 试试：你会发现 $\\omega_n$ 只缩放快慢，而百分比超调率完全只由 $\\zeta$ 决定！',
          },
        ],
      },
      {
        beat: 'run',
        title: en ? '2D Phase Portrait $(x, v)$ & Vector Quiver Field' : '二维相平面轨迹 $(x, v)$ 与速度矢量场',
        blocks: [
          {
            t: 'sandbox',
            caption: en
              ? 'Watch the spiral focus uncoil into a non-crossing node in phase space $(\\dot{x} = v,\\; \\dot{v} = -2\\zeta\\omega_n v - \\omega_n^2 x)$ as $\\zeta$ crosses $1.0$.'
              : '在相空间 $(\\dot{x} = v,\\; \\dot{v} = -2\\zeta\\omega_n v - \\omega_n^2 x)$ 中，亲眼看螺旋焦点在 $\\zeta = 1.0$ 处拉直为不越界的稳定结点。',
            say: en
              ? 'In the $(x, v)$ phase plane, crossing into $x < 0$ is literally spiraling past the vertical axis! Drag $\\zeta$ to $1.0$ to watch the spiral uncoil.'
              : '切到 $(x, v)$ 相平面视角，「超调越界」就是轨迹螺旋冲过纵轴 $x = 0$！把 $\\zeta$ 拖到 $1.0$，看螺旋如何瞬间拉直。',
            knobs: [
              { id: 'zeta', label: en ? 'Damping Ratio $\\zeta$' : '阻尼比 $\\zeta$', min: 0.15, max: 1.8, step: 0.05, default: 0.25, unit: '' },
              { id: 'wn', label: en ? 'Natural Freq $\\omega_n$' : '固有频率 $\\omega_n$', min: 0.6, max: 2.0, step: 0.1, default: 1.0, unit: 'rad/s' },
            ],
            presets: [
              { label: en ? 'Spiral ($\\zeta = 0.20$)' : '螺旋焦点（$\\zeta = 0.20$）', values: { zeta: 0.2, wn: 1.0 } },
              { label: en ? 'Critical ($\\zeta = 1.00$)' : '临界结点（$\\zeta = 1.00$）', values: { zeta: 1.0, wn: 1.0 } },
              { label: en ? 'Overdamped ($\\zeta = 1.75$)' : '过阻尼结点（$\\zeta = 1.75$）', values: { zeta: 1.75, wn: 1.0 } },
            ],
            domain: { variable: 't', min: 0, max: 12, steps: 160, label: 't', unit: 's' },
            field: {
              xMin: -0.65,
              xMax: 1.12,
              yMin: -1.15,
              yMax: 0.55,
              grid: 13,
              xVar: 'x',
              yVar: 'v',
              dxExpr: 'v',
              dyExpr: '-2*zeta*wn*v - wn^2*x',
            },
            series: [
              {
                id: 'orbit',
                label: en ? 'Phase Orbit $(x(t), v(t))$' : '相轨迹 $(x(t), v(t))$',
                xExpr: exactResponseExpr,
                yExpr: exactVelocityExpr,
              },
            ],
            markers: [
              { id: 'origin', label: en ? 'Attractor $(0, 0)$' : '平衡吸引子 $(0, 0)$', xExpr: '0', yExpr: '0' },
              {
                id: 't1',
                label: en ? 'State at $t = 1/\\omega_n$' : '$t = 1/\\omega_n$ 状态点',
                xExpr: 'exp(-zeta) * ((1 - step(zeta, 1.0001)) * (cos(sqrt(max(0, 1 - zeta^2))) + zeta*sinc(sqrt(max(0, 1 - zeta^2)))) + step(zeta, 1.0001) * (cosh(sqrt(max(0.0001, zeta^2 - 1))) + (zeta / sqrt(max(0.0001, zeta^2 - 1))) * sinh(sqrt(max(0.0001, zeta^2 - 1)))))',
                yExpr: '-wn * exp(-zeta) * ((1 - step(zeta, 1.0001)) * sinc(sqrt(max(0, 1 - zeta^2))) + step(zeta, 1.0001) * sinh(sqrt(max(0.0001, zeta^2 - 1))) / sqrt(max(0.0001, zeta^2 - 1)))',
              },
            ],
            readouts: [
              { id: 'vmax', label: en ? 'Speed $|v|$ at $t=1/\\omega_n$' : '$t=1/\\omega_n$ 速率 $|v|$', expr: 'wn * exp(-zeta) * ((1 - step(zeta, 1.0001)) * sinc(sqrt(max(0, 1 - zeta^2))) + step(zeta, 1.0001) * sinh(sqrt(max(0.0001, zeta^2 - 1))) / sqrt(max(0.0001, zeta^2 - 1)))', unit: 'm/s' },
            ],
            walk: [
              {
                set: { zeta: 0.25, wn: 1.0 },
                say: en
                  ? 'Stable spiral ($\\zeta = 0.25$): the quiver field swirls the state across $x = 0$ again and again.'
                  : '稳定焦点（$\\zeta = 0.25$）：矢量场带着状态点一圈圈旋进原点，反复冲过 $x = 0$ 纵轴。',
              },
              {
                set: { zeta: 1.0, wn: 1.0 },
                say: en
                  ? 'Improper node ($\\zeta = 1.0$): the spiral opens into a single eigenvector $v = -\\omega_n x$ gliding straight into $(0, 0)$ from the right!'
                  : '退化结点（$\\zeta = 1.0$）：螺旋彻底解开，沿唯一特征方向 $v = -\\omega_n x$ 从右侧单调滑入 $(0, 0)$！',
                key: en
                  ? 'Phase-plane view: $\\zeta < 1$ is a spiral focus; $\\zeta \\ge 1$ is a non-spiraling node.'
                  : '几何相空间判据：$\\zeta < 1$ 为螺旋焦点，$\\zeta \\ge 1$ 退化为不绕圈的稳定结点。',
              },
            ],
          },
        ],
      },
      {
        beat: 'why',
        title: en ? 'Spot the Exact Flaw in the Naive Proof' : '在推导里亲手揪出那一行隐蔽除零',
        blocks: [
          {
            t: 'spot',
            of: 'flaw-repeated-root',
            path: 'flawed-proof.txt',
            lang: 'proof',
            q: en
              ? 'Click the exact line where the derivation silently breaks when $\\zeta = 1$.'
              : '请点击左侧推导中在 $\\zeta = 1$ 处暗藏非法运算的那一行。',
            how: en ? 'Click the suspicious line number on the left.' : '点击左侧你怀疑有漏洞的那一行。',
            source: [
              "Given: x''(t) + 2*zeta*wn*x'(t) + wn^2*x(t) = 0,  x(0)=1, x'(0)=0",
              'Step 1: Solve r^2 + 2*zeta*wn*r + wn^2 = 0 for r1, r2',
              'Step 2: Divide both coefficients by (r2 - r1) to fit initial velocity',
              'Step 3: Conclude x(t) = (r2*exp(r1*t) - r1*exp(r2*t)) / (r2 - r1) for all zeta > 0',
            ].join('\n'),
            answerLines: [3],
            hint: en
              ? 'Ask which quantity vanishes when the discriminant $\\zeta^2 - 1$ hits zero.'
              : '想一想：当判别式 $\\zeta^2 - 1 = 0$ 时，哪一个差值恰好等于零？',
            found: en
              ? 'Nailed it! At $\\zeta = 1$, $r_1 = r_2 = -\\omega_n$, so $(r_2 - r_1) = 0$. Dividing by $(r_2 - r_1)$ is illegal division by zero!'
              : '一针见血！$\\zeta = 1$ 时 $r_1 = r_2 = -\\omega_n$，分母 $(r_2 - r_1) = 0$，第 3 行直接触发了 $0/0$ 非法除零！',
            say: en
              ? 'Whenever an algebra step divides by a parameter expression, check where that expression hits zero.'
              : '任何含参推导只要做除法，第一反应永远是追问：分母在哪个参数点归零？',
          },
        ],
      },
      {
        beat: 'why',
        title: en ? 'Where Does the Secular Factor $t e^{-\\omega_n t}$ Come From?' : '多出来的因子 $t e^{-\\omega_n t}$ 究竟从哪冒出来的？',
        blocks: [
          {
            t: 'inside',
            caption: en ? 'Taking the limit $r_2 \\to r_1 = -\\omega_n$ & checking the Wronskian:' : '对 $r_2 \\to r_1 = -\\omega_n$ 取极限并用朗斯基行列式验明正身：',
            command: "L'Hopital & Wronskian check",
            lang: 'derivation',
            source: [
              'limit_{r2 -> r1} (r2*exp(r1*t) - r1*exp(r2*t)) / (r2 - r1)',
              "= (1 + wn*t) * exp(-wn*t)   // L'Hopital wrt r2 at r1 = -wn",
              'Basis: y1(t) = exp(-wn*t),  y2(t) = t * exp(-wn*t)',
              "Wronskian W(y1, y2)(t) = y1*y2' - y1'*y2 = exp(-2*wn*t) != 0",
            ].join('\n'),
            say: en
              ? 'Instead of dividing by zero, take the limit as $r_2 \\to r_1$: differentiating $e^{r_2 t}$ with respect to $r_2$ brings down a factor of $t$!'
              : '不能直接除以零，但可以对 $r_2 \\to r_1$ 求洛必达极限：$e^{r_2 t}$ 对特征根 $r_2$ 求导，自然掉下一个时间因子 $t$！',
            walk: [
              {
                focusLines: [1, 2],
                label: 'limit -> (1+wn*t)',
                say: en
                  ? ' Notice $(1 + \\omega_n t)e^{-\\omega_n t}$ starts with slope $0$ at $t = 0$ because $+\\omega_n e^{-\\omega_n t}$ cancels $-\\omega_n e^{-\\omega_n t}$!'
                  : '看 $(1 + \\omega_n t)e^{-\\omega_n t}$ 在 $t=0$ 处：线性增长斜率 $+\\omega_n$ 恰好抵消指数初斜率 $-\\omega_n$，完美契合 $x\'(0)=0$！',
              },
              {
                focusLines: [3, 4],
                label: 'W != 0',
                say: en
                  ? 'And the Wronskian $W(y_1, y_2) = e^{-2\\omega_n t} > 0$ proves $e^{-\\omega_n t}$ and $t e^{-\\omega_n t}$ span every 2D initial state.'
                  : '再算朗斯基行列式 $W = e^{-2\\omega_n t} > 0$ 恒不为零，证明 $\{e^{-\\omega_n t}, t e^{-\\omega_n t}\}$ 完整张成二维状态空间。',
                key: en
                  ? 'Repeated root $r = -\\omega_n$ spawns $t e^{-\\omega_n t}$; still $\\lim_{t\\to\\infty} t e^{-\\omega_n t} = 0$.'
                  : '二重特征根衍生长期项 $t e^{-\\omega_n t}$，且因指数衰减远快于多项式，仍有 $\\lim_{t\\to\\infty} t e^{-\\omega_n t} = 0$。',
              },
            ],
          },
        ],
      },
      {
        beat: 'why',
        title: en ? 'Closed-Loop Control View: How PD Feedback Tunes $\\zeta$' : '控制工程视角：闭环反馈如何主动塑造阻尼比 $\\zeta$',
        blocks: [
          {
            t: 'schematic',
            height: 250,
            say: en
              ? 'In robotics and mechatronics, we rarely change physical oil—derivative feedback $K_d x\'(t)$ synthesizes active Critical Damping! Click any block to inspect.'
              : '在机器人与伺服系统里，工程师不用换液压油——直接靠微分反馈 $K_d x\'(t)$ 就能电子合成「主动临界阻尼」！点击任意模块查看机理。',
            nodes: [
              { id: 'ref', label: en ? 'Target $r = 0$' : '目标参考 $r = 0$', sub: en ? 'Equilibrium' : '设定零位', detail: en ? 'Desired wafer-stage position $r = 0$ after step command.' : '阶跃定位指令下达后的目标平衡位置 $r = 0$。', x: 24, y: 74, w: 120, h: 52 },
              { id: 'err', label: en ? 'Error $e = r - x$' : '误差比较 $e$', sub: en ? 'Summing node' : '偏差信号', detail: en ? 'Computes live position error $e(t)$ and velocity $-x\'(t)$ for PD control.' : '实时计算位置偏差 $e(t)$ 与速度反馈 $-x\'(t)$。', x: 184, y: 74, w: 132, h: 52 },
              { id: 'pd', label: en ? 'PD Gain $K_p, K_d$' : 'PD 控制器 $K_p, K_d$', sub: en ? 'Active damper' : '电子阻尼合成', detail: en ? 'Sets effective $\\omega_n = \\sqrt{K_p/m}$ and $\\zeta = K_d / (2\\sqrt{m K_p})$.' : '闭环等效固有频率 $\\omega_n = \\sqrt{K_p/m}$，等效阻尼比 $\\zeta = K_d / (2\\sqrt{m K_p})$。', x: 356, y: 74, w: 132, h: 52 },
              { id: 'plant', label: en ? 'Stage Mass $m$' : '运动平台 $m$', sub: en ? 'Output $x(t)$' : '实际位移 $x(t)$', detail: en ? 'Inertial plant $m x\'\'(t) = u(t)$ integrated twice into position $x(t)$.' : '惯性被控对象 $m x\'\'(t) = u(t)$，积分产生实际位置 $x(t)$。', x: 520, y: 74, w: 108, h: 52 },
            ],
            edges: [
              { id: 'e-ref', from: 'ref', to: 'err', label: '$r$' },
              { id: 'e-err', from: 'err', to: 'pd', label: '$e, -x\'$' },
              { id: 'e-u', from: 'pd', to: 'plant', label: '$u(t)$' },
              { id: 'e-fb', from: 'plant', to: 'err', label: en ? 'Sensor feedback $x, x\'$' : '编码器反馈 $x, x\'$', feedback: true },
            ],
            walk: [
              {
                nodes: ['ref', 'err', 'pd'],
                edges: ['e-ref', 'e-err'],
                tone: 'success',
                say: en
                  ? 'Proportional gain $K_p$ acts like a virtual spring pulling $x(t)$ toward $0$, setting $\\omega_n = \\sqrt{K_p / m}$.'
                  : '比例增益 $K_p$ 等效于一把虚拟弹簧，把平台拉向目标位，决定固有频率 $\\omega_n = \\sqrt{K_p / m}$。',
              },
              {
                nodes: ['plant', 'err', 'pd'],
                edges: ['e-fb', 'e-u'],
                tone: 'warning',
                states: { pd: 'Kd = 2*sqrt(m*Kp)', plant: 'zeta = 1.0' },
                say: en
                  ? 'Notice the curved feedback loop: tuning $K_d = 2\\sqrt{m K_p}$ locks $\\zeta = 1$ with zero mechanical friction!'
                  : '看下方闭环反馈弧线：令微分增益 $K_d = 2\\sqrt{m K_p}$，无需任何机械摩擦就能精确锁定 $\\zeta = 1$！',
                key: en
                  ? 'In PD control, $K_d = 2\\sqrt{m K_p}$ achieves active Critical Damping.'
                  : 'PD 闭环控制中，取 $K_d = 2\\sqrt{m K_p}$ 即可合成无超调的主动临界阻尼。',
              },
            ],
          },
        ],
      },
      {
        beat: 'fix',
        title: en ? 'Side-by-Side Trajectory Race: $\\zeta = 0.3$ vs $\\zeta = 1.0$' : '双泳道正面对决：$\\zeta = 0.3$ 对比 $\\zeta = 1.0$',
        blocks: [
          {
            t: 'lanes',
            lanes: [en ? 'Underdamped ($\\zeta = 0.3$)' : '欠阻尼分支（$\\zeta = 0.3$）', en ? 'Critical ($\\zeta = 1.0$)' : '临界阻尼分支（$\\zeta = 1.0$）'],
            shared: { name: en ? 'Target Band' : '目标容差带', start: '|x| <= 0.05' },
            steps: [
              {
                lane: 0,
                op: 'read',
                text: 't = 1.5s: x = 0.00 (fast!)',
                say: en ? 'At $t = 1.5\\text{ s}$, the underdamped stage hits $x = 0$ first—looking deceptively fast.' : '$t = 1.5\\text{ s}$ 时欠阻尼率先冲过 $x = 0$，表面看起来快得惊人。',
              },
              {
                lane: 0,
                op: 'note',
                tone: 'error',
                text: 't = 2.7s: x = -0.37 (CRASH!)',
                say: en ? 'But excess momentum carries it $-37\\%$ past zero—crashing into the hard stop!' : '但刹不住的动量让它反向冲到 $-0.37$，直接撞毁精密限位块！',
              },
              {
                lane: 1,
                op: 'calc',
                text: 't = 1.0s: peak |x\'| at t = 1/wn',
                say: en ? 'Meanwhile $\\zeta = 1.0$ reaches maximum inward speed at $t = 1/\\omega_n$, then smoothly brakes.' : '另一边 $\\zeta = 1.0$ 在 $t = 1/\\omega_n$ 达到最大回程速度后，精准借由指数项柔和制动。',
              },
              {
                lane: 1,
                op: 'write',
                value: 'Settled <= 0.05 (0 overshoot)',
                text: 't = 3.95s: |x| <= 0.05 forever',
                say: en ? 'It enters $|x| \\le 0.05$ once and NEVER leaves—winning true settling time without a scratch.' : '在 $t = 3.95\\text{ s}$ 一次进入容差带且永不反弹，真正赢得无损整定时间！',
              },
            ],
            verdict: en
              ? 'First zero-crossing time != settling time. Critical damping minimizes monotone settling time.'
              : '「首次过零时间」绝不等于「稳态整定时间」——临界阻尼赢在单调不反弹的最快整定。',
            verdictSay: en
              ? 'Never confuse rise time with settling time on an exam or controller spec.'
              : '考场上和工程调参时，切忌把首次上升时间与最终整定时间混为一谈。',
          },
        ],
      },
      {
        beat: 'choose',
        title: en ? 'Engineering Regime Trade-Off Table' : '四大阻尼区间工程权衡总表',
        blocks: [
          {
            t: 'choose',
            columns: [en ? 'Signature Behavior' : '核心响应特征', en ? 'Price Paid' : '工程代价', en ? 'Best Fit' : '典型适用场景'],
            say: en
              ? 'Walk through all three practical choices—including why control engineers also love $\\zeta \\approx 0.707$.'
              : '横向对比三大常用调参点——顺便揭秘为什么控制工程师还偏爱 $\\zeta \\approx 0.707$。',
            options: [
              {
                name: en ? 'Lightly Underdamped ($\\zeta < 0.5$)' : '弱欠阻尼（$\\zeta < 0.5$）',
                solves: en ? 'Snappy initial rise' : '初始启动极快',
                cost: en ? '>16% overshoot & prolonged ringing' : '超调 >16% 且持续振铃',
                when: en ? 'Resonant sensors, musical strings, playful UI springs' : '谐振传感、琴弦发声、活泼 UI 动效',
                say: en ? 'Great when you WANT resonance or lively bounce.' : '适合故意追求谐振放大或灵动回弹的场合。',
              },
              {
                name: en ? 'Butterworth Optimal ($\\zeta \\approx 0.707$)' : '工程最优阻尼（$\\zeta \\approx 0.707$）',
                solves: en ? 'Fastest 2%–5% band entry if ~4.3% overshoot is safe' : '若允许 4.3% 微小超调，进 5% 带比临界还快',
                cost: en ? '~4.3% single overshoot across $x = 0$' : '存在约 4.3% 的单次越界超调',
                when: en ? 'Analog gauges, flight attitude loops, audio filters' : '指针仪表、飞控姿态环、巴特沃斯滤波器',
                say: en ? 'When a tiny 4% overshoot cannot hit a wall, $\\zeta = 1/\\sqrt{2}$ shaves off 20% more settling time!' : '只要没有刚性碰撞墙，取 $\\zeta = 1/\\sqrt{2}$ 能比临界阻尼再省下约 20% 整定时间！',
              },
              {
                name: en ? 'Critical Damping ($\\zeta = 1.0$)' : '临界阻尼（$\\zeta = 1.0$）',
                solves: en ? 'Fastest strictly non-overshooting return ($x(t) > 0$)' : '严格零超调下的最快收敛极限',
                cost: en ? 'Slight drift toward $\\zeta < 1$ causes tiny overshoot' : '参数温漂若跌破 1 会出现微弱超调',
                when: en ? 'Surgical robots, lithography stages, recoil buffers, doors' : '手术机械臂、光刻工件台、火炮复进机、闭门器',
                say: en ? 'Whenever crossing zero means physical contact or damage, $\\zeta \\ge 1$ (often $1.05$ safety margin) is mandatory.' : '凡越界即撞件或伤人的硬约束场景，必须锁定 $\\zeta \\ge 1$（常留 $1.05$ 安全裕度）。',
              },
            ],
            rule: en
              ? 'Hard zero-overshoot constraint? Pick $\\zeta = 1.0$ (or $1.05$ with margin). Tiny 4% bounce tolerable? Pick $\\zeta \\approx 0.707$.'
              : '硬性零超调防碰撞 → 选 $\\zeta = 1.0$（工程留 $1.05$ 裕度）；允许 4% 微幅越界 → 选 $\\zeta \\approx 0.707$。',
            ruleSay: en
              ? 'That single rule resolves 90% of textbook and interview design questions.'
              : '记住这一条判准，教材选型题与控制面试题直接通杀。',
          },
        ],
      },
      {
        beat: 'choose',
        layout: 'split',
        title: en ? 'Decision Tree & Live Engineering Cases' : '实战决策树与工程场景演练',
        blocks: [
          {
            t: 'decide',
            q: en ? 'Does crossing $x = 0$ cause physical contact, safety risk, or spec violation?' : '越过平衡点 $x = 0$ 是否会引发碰撞、安全风险或指标违规？',
            say: en ? 'Trace the constraint first, then classify the three real systems on the right.' : '先看左侧约束分支，再对右侧三个真实工程系统拍板。',
            branches: [
              { when: en ? 'Yes — hard contact / zero-overshoot spec' : '是 —— 刚性接触或严格零超调', pick: 'Critical (zeta = 1)', eg: en ? 'CNC probe homing onto glass lens' : '数控探针贴靠光学镜片' },
              { when: en ? 'No — ~4% overshoot harmless, max bandwidth wanted' : '否 —— 允许约 4% 微小超调换极速带宽', pick: 'Optimal (zeta = 0.707)', eg: en ? 'Radar tracking gimbal' : '雷达光电跟踪云台' },
              { when: en ? 'Oscillatory ring is the whole point' : '本身就需要持续谐振摆动', pick: 'Underdamped (zeta < 0.3)', eg: en ? 'MEMS vibratory gyroscope' : 'MEMS 振动陀螺仪' },
            ],
          },
          {
            t: 'cases',
            tools: ['Critical (zeta = 1)', 'Optimal (zeta = 0.707)', 'Underdamped (zeta < 0.3)'],
            say: en ? 'Match all three engineering designs to test the decision rule.' : '完成全部三道工程选型，检验你手里的判准。',
            items: [
              {
                text: en ? 'Laser eye-surgery focal actuator stepping onto corneal depth target' : '眼科飞秒激光聚焦执行器切入角膜目标深度',
                answer: 0,
                why: en ? 'Overshooting target depth damages healthy tissue, requiring strict $\\zeta \\ge 1$ monotone approach.' : '深度超调会损伤深层健康角膜组织，必须采用 $\\zeta \\ge 1$ 单调无超调逼近。',
              },
              {
                text: en ? 'Automotive analog speedometer needle tracking highway speed changes' : '汽车仪表盘指针快速跟随车速变化',
                answer: 1,
                why: en ? 'A 4% needle overshoot in free air hits nothing and reaches steady reading fastest.' : '指针在空气中微超 4% 不会撞坏任何零件，反而让驾驶员最快读到稳定车速。',
              },
              {
                text: en ? 'Quartz tuning-fork oscillator maintaining a sharp frequency reference' : '石英音叉谐振器维持高 Q 值时钟基准',
                answer: 2,
                why: en ? 'High-$Q$ resonators require minimal damping ($\\zeta \\ll 1$) to sustain sharp oscillation.' : '高 Q 值时钟基准恰恰依赖极低阻尼比（$\\zeta \\ll 1$）来维持尖锐谐振。',
              },
            ],
          },
        ],
      },
      {
        beat: 'name',
        title: en ? 'Formal Concept Card: Critical Damping & Spectral Degeneracy' : '正式挂牌命名：临界阻尼与谱退化边界',
        blocks: [
          {
            t: 'name',
            term: en ? 'Critical Damping' : '临界阻尼',
            alias: en ? 'Spectral Degeneracy Boundary (zeta = 1, c_crit = 2*sqrt(m*k))' : 'Critical Damping · 二重特征根相变边界（zeta = 1, c_crit = 2*sqrt(m*k)）',
            oneLine: en
              ? 'The unique parameter boundary $\\zeta = 1$ ($c = 2\\sqrt{mk}$) where complex-conjugate oscillatory poles collide at $r = -\\omega_n$ before splitting along the negative real axis.'
              : '复共轭振荡极点在 $r = -\\omega_n$ 处迎头相撞、即将沿负实轴分裂前的唯一分界点 $\\zeta = 1$（$c = 2\\sqrt{mk}$）。',
            askedTitle: en ? 'Classic Exam & Control Interview Questions' : '高频考题与控制面试追问',
            asked: [
              en ? 'Why does $t e^{-\\omega_n t}$ appear at $\\zeta = 1$, and where does its derivative peak?' : '为什么 $\\zeta = 1$ 时通解会出现 $t e^{-\\omega_n t}$？它的峰值出现在哪个时刻？',
              en ? 'If $\\zeta > 1$ has more damping force, why does it settle MORE slowly than $\\zeta = 1$?' : '既然 $\\zeta > 1$ 阻尼力更大，为什么后期归零反而比 $\\zeta = 1$ 更慢？',
              en ? 'How does scaling mass $m \\to 4m$ (keeping $c, k$ fixed) change $\\omega_n$ and $\\zeta$?' : '若保持 $c, k$ 不变而质量增大为 $4m$，$\\omega_n$ 与 $\\zeta$ 会如何变化（是否可能从过阻尼跌入欠阻尼）？',
            ],
            say: en
              ? 'Look at that third question: quadrupling mass halves $\\zeta = c/(2\\sqrt{mk})$—turning a safe critically damped stage into an oscillating one!'
              : '特别留意第三问：负载质量翻四倍会让 $\\zeta = c/(2\\sqrt{mk})$ 直接腰斩，原本安全的临界系统瞬间变欠阻尼振荡！',
          },
        ],
      },
      {
        beat: 'check',
        title: en ? 'Boundary Check 1: Algebraic & Physical Mechanism' : '边界小测（一）：重根机制与慢极点陷阱',
        blocks: [
          {
            t: 'quiz',
            q: en
              ? 'When $\\zeta$ increases from $1.0$ to $2.0$ at fixed $\\omega_n$, why does the stage take LONGER to enter $|x| \\le 0.05$?'
              : '固定 $\\omega_n$ 不变，把阻尼比 $\\zeta$ 从 $1.0$ 增大到 $2.0$，为什么系统进入 $|x| \\le 0.05$ 反而耗时更长？',
            say: en ? 'Think about where the two real roots $r_{1,2} = \\omega_n(-\\zeta \\pm \\sqrt{\\zeta^2 - 1})$ move.' : '回想两个实特征根 $r_{1,2} = \\omega_n(-\\zeta \\pm \\sqrt{\\zeta^2 - 1})$ 在负实轴上的移动方向。',
            options: [
              {
                text: en ? 'Total dissipated energy increases when $\\zeta = 2.0$' : '$\\zeta = 2.0$ 时系统需要耗散的总机械能变多了',
                ok: false,
                why: en ? 'Initial potential energy $\\frac{1}{2}kx_0^2$ is identical regardless of $\\zeta$.' : '初始弹性势能 $\\frac{1}{2}kx_0^2$ 只由初位移决定，与 $\\zeta$ 无关。',
              },
              {
                text: en ? 'The slower real root $r_1 = -\\omega_n(\\zeta - \\sqrt{\\zeta^2 - 1})$ moves closer to $0^-$, creating a sluggish $e^{r_1 t}$ tail' : '慢实根 $r_1 = -\\omega_n(\\zeta - \\sqrt{\\zeta^2 - 1})$ 逼近 $0^-$，导致 $e^{r_1 t}$ 衰减极慢',
                ok: true,
                why: en ? 'At $\\zeta = 2$, $r_1 \\approx -0.268\\omega_n$ decays nearly 4x slower than $-\\omega_n$!' : '$\\zeta = 2$ 时慢根 $r_1 \\approx -0.268\\omega_n$，衰减速率不到 $-\\omega_n$ 的四分之一！',
              },
              {
                text: en ? 'The system begins oscillating at half frequency' : '系统在过阻尼区开始出现半频振荡',
                ok: false,
                why: en ? 'For $\\zeta \\ge 1$, both roots are real and negative—zero oscillation occurs.' : '$\\zeta \\ge 1$ 时特征根全为负实数，绝无正余弦振荡项。',
              },
              {
                text: en ? 'Natural frequency $\\omega_n = \\sqrt{k/m}$ drops to zero' : '固有频率 $\\omega_n = \\sqrt{k/m}$ 随阻尼增大而归零',
                ok: false,
                why: en ? '$\\omega_n$ depends only on $k$ and $m$, not on damping $c$.' : '$\\omega_n$ 仅由刚度 $k$ 与质量 $m$ 决定，与阻尼无关。',
              },
            ],
          },
        ],
      },
      {
        beat: 'say',
        title: en ? 'Boundary Check 2 & Two-Minute Oral Synthesis' : '边界小测（二）与两分钟开口复述',
        blocks: [
          {
            t: 'quiz',
            q: en
              ? 'A critically damped actuator ($\\zeta = 1.0$) picks up a payload that quadruples total mass ($m \\to 4m$) while $k$ and $c$ stay constant. What is the new regime?'
              : '原本调至临界阻尼（$\\zeta = 1.0$）的机械臂抓取重物后总质量变为 $4m$，若刚度 $k$ 与阻尼系数 $c$ 不变，此时系统处于什么状态？',
            say: en ? 'Substitute $4m$ into $\\zeta = c / (2\\sqrt{mk})$ before starting your oral synthesis.' : '把 $4m$ 代入 $\\zeta = c / (2\\sqrt{mk})$ 算一算，然后开启下方的开口讲透计时！',
            options: [
              {
                text: en ? 'Underdamped with $\\zeta = 0.5$ — it will now overshoot!' : '变为欠阻尼（$\\zeta = 0.5$）—— 将发生越界超调！',
                ok: true,
                why: en ? '$\\zeta_{\\text{new}} = c / (2\\sqrt{4mk}) = \\frac{1}{2}\\zeta_{\\text{old}} = 0.5 < 1$, introducing ~16.3% overshoot.' : '$\\zeta_{\\text{new}} = c / (2\\sqrt{4mk}) = 0.5 < 1$，系统跌入欠阻尼并产生约 16.3% 的超调！',
              },
              {
                text: en ? 'Overdamped with $\\zeta = 2.0$ because heavier mass moves slower' : '变为过阻尼（$\\zeta = 2.0$），因为质量越重越不容易晃',
                ok: false,
                why: en ? 'Classic trap! Heavier inertia is HARDER for the same damper $c$ to brake, halving $\\zeta$.' : '经典直觉陷阱！惯性变大后同样的阻尼器更难刹住它，$\\zeta$ 反而是减半而非翻倍。',
              },
              {
                text: en ? 'Still critically damped ($\\zeta = 1.0$) with half natural frequency' : '仍保持临界阻尼（$\\zeta = 1.0$），只是固有频率减半',
                ok: false,
                why: en ? 'Both $\\omega_n$ AND $\\zeta$ halve when $m \\to 4m$ with fixed $c, k$.' : '$c, k$ 固定而 $m \\to 4m$ 时，$\\omega_n$ 与 $\\zeta$ 会双双减半。',
              },
            ],
          },
        ],
      },
      {
        beat: 'check',
        title: en ? 'Hands-On Design Workshop: Tune a Surgical Stage' : '动手推演工坊：整定手术微定位平台参数',
        blocks: [
          {
            t: 'try',
            id: 'try-surgical-pd',
            title: en ? 'PD Gain Tuning Challenge ($m = 0.5\\text{ kg},\\; k = 200\\text{ N/m}$)' : 'PD 增益整定挑战（$m = 0.5\\text{ kg},\\; k = 200\\text{ N/m}$）',
            prompt: en
              ? 'A corneal laser focal stage has mass $m = 0.5\\text{ kg}$ and spring stiffness $k = 200\\text{ N/m}$ with negligible passive friction ($c_0 \\approx 0$). Choose derivative feedback gain $K_d$ (acting as effective damping $c = K_d$) for strict Critical Damping $\\zeta = 1$, and compute the exact velocity peak time $t_{\\text{peak}}$ when released from $x_0 = 1\\text{ mm},\\; v_0 = 0$.'
              : '某眼科飞秒激光定位台等效质量 $m = 0.5\\text{ kg}$，弹性刚度 $k = 200\\text{ N/m}$，被动摩擦可忽略（$c_0 \\approx 0$）。请整定微分反馈增益 $K_d$（提供等效阻尼 $c = K_d$）使系统处于严格临界阻尼 $\\zeta = 1$，并求出从 $x_0 = 1\\text{ mm},\\; v_0 = 0$ 释放后回程速率达到最大值的时刻 $t_{\\text{peak}}$。',
            steps: [
              en ? 'Compute natural frequency $\\omega_n = \\sqrt{k / m}$ in $\\text{rad/s}$' : '计算固有角频率 $\\omega_n = \\sqrt{k / m}$（单位 $\\text{rad/s}$）',
              en ? 'Solve $c_{\\text{crit}} = K_d = 2\\sqrt{mk} = 2m\\omega_n$ for $\\zeta = 1$' : '由 $\\zeta = 1$ 解出临界微分增益 $K_d = c_{\\text{crit}} = 2\\sqrt{mk} = 2m\\omega_n$',
              en ? 'Differentiate $v(t) = -\\omega_n^2 x_0 t e^{-\\omega_n t}$ and set $\\dot{v}(t) = 0$ to find $t_{\\text{peak}} = 1/\\omega_n$' : '对速度 $v(t) = -\\omega_n^2 x_0 t e^{-\\omega_n t}$ 求导令 $\\dot{v}(t) = 0$，解出最大回程速率时刻 $t_{\\text{peak}} = 1/\\omega_n$',
            ],
            hint: en
              ? 'Notice $m \\cdot k = 0.5 \\times 200 = 100$, whose square root is an exact integer!'
              : '留意 $m \\cdot k = 0.5 \\times 200 = 100$，开平方恰好是漂亮的整数！',
            solution: en
              ? '1. $\\omega_n = \\sqrt{200 / 0.5} = \\sqrt{400} = 20\\text{ rad/s}$.\n2. $K_d = c_{\\text{crit}} = 2\\sqrt{0.5 \\times 200} = 2 \\times 10 = 20\\text{ N}\\cdot\\text{s/m}$.\n3. Since $\\dot{v}(t) = -\\omega_n^2 x_0 (1 - \\omega_n t)e^{-\\omega_n t} = 0$ at $\\omega_n t = 1$, peak inward speed occurs at $t_{\\text{peak}} = 1/20 = 0.05\\text{ s}$ ($50\\text{ ms}$) with zero overshoot!'
              : '1. $\\omega_n = \\sqrt{200 / 0.5} = \\sqrt{400} = 20\\text{ rad/s}$。\n2. $K_d = c_{\\text{crit}} = 2\\sqrt{0.5 \\times 200} = 2 \\times 10 = 20\\text{ N}\\cdot\\text{s/m}$。\n3. 由 $\\dot{v}(t) = -\\omega_n^2 x_0 (1 - \\omega_n t)e^{-\\omega_n t} = 0$ 得 $\\omega_n t = 1$，即释放后 $t_{\\text{peak}} = 1/20 = 0.05\\text{ s}$（$50\\text{ ms}$）达到峰值回程速率，随后单调无超调贴靠目标！',
            say: en
              ? 'Tick each step as you work it out in the scratchpad, then reveal the exact derivation!'
              : '在草稿本里一步步算出来并勾选进度，最后展开核对完整解析！',
          },
        ],
      },
      {
        beat: 'say',
        title: en ? 'Two-Minute Oral Synthesis' : '两分钟脱稿开口串讲',
        blocks: [
          {
            t: 'say',
            seconds: 120,
            prompt: en
              ? 'In your own words, explain: (1) why $(r_2 - r_1)$ division fails at $\\zeta = 1$ and produces $t e^{-\\omega_n t}$, and (2) why $\\zeta = 1$ beats both $\\zeta < 1$ and $\\zeta > 1$ when overshoot is forbidden.'
              : '合上提示用自己的话讲透：（1）为什么 $\\zeta = 1$ 处双根公式会除零并衍生出 $t e^{-\\omega_n t}$；（2）在严禁超调时为什么 $\\zeta = 1$ 同时击败欠阻尼与过阻尼。',
            points: [
              en ? 'At $\\zeta = 1$, discriminant $\\zeta^2 - 1 = 0$ merges $r_1 = r_2 = -\\omega_n$, making $1/(r_2 - r_1)$ a $0/0$ singularity' : '$\\zeta = 1$ 时判别式归零，特征根重合为 $-\\omega_n$，原分母 $(r_2 - r_1)$ 触发除零退化',
              en ? 'L’Hôpital limit / Wronskian $W = e^{-2\\omega_n t} \\neq 0$ yields independent basis $\\{e^{-\\omega_n t}, t e^{-\\omega_n t}\\}$' : '求极限得长期项 $t e^{-\\omega_n t}$，朗斯基行列式 $e^{-2\\omega_n t} \\neq 0$ 补齐二维解空间',
              en ? '$\\zeta < 1$ violates zero-overshoot via complex roots $\\pm i\\omega_d$' : '$\\zeta < 1$ 含虚部频率 $\\omega_d$，必然穿过平衡线产生超调',
              en ? '$\\zeta > 1$ splits a slow real root $r_1 \\to 0^-$ that drags out the decay tail' : '$\\zeta > 1$ 分裂出逼近 $0^-$ 的慢特征根，拖慢后期收敛尾巴',
            ],
            model: en
              ? 'At $\\zeta = 1$, the characteristic polynomial $(r + \\omega_n)^2 = 0$ has a double root, so naive two-root coefficients divide by $r_2 - r_1 = 0$. Taking the limit $r_2 \\to r_1$ differentiates $e^{rt}$ with respect to $r$, giving $(1 + \\omega_n t)e^{-\\omega_n t}$ with non-zero Wronskian $e^{-2\\omega_n t}$. Physically, $\\zeta < 1$ rings across zero while $\\zeta > 1$ creates a slow real pole near zero, making $\\zeta = 1$ the fastest overshoot-free response.'
              : '当 $\\zeta = 1$ 时特征方程 $(r + \\omega_n)^2 = 0$ 出现二重根，双指数系数里的 $(r_2 - r_1)$ 归零失效；对重根取极限会对 $r$ 求导产生时间因子，得到朗斯基行列式非零的通解 $(1 + \\omega_n t)e^{-\\omega_n t}$。物理上，$\\zeta < 1$ 会越界振荡，而 $\\zeta > 1$ 会分裂出靠近原点的慢实极点拖慢收敛，因此 $\\zeta = 1$ 是零超调约束下的最快响应边界。',
            say: en ? 'Start the 2-minute timer, speak aloud, then tick off each point you hit!' : '点「开始讲」脱稿说一遍，再展开核对四个得分点！',
          },
        ],
      },
      {
        beat: 'take',
        title: en ? 'Four Pocket Takeaways' : '装进口袋的四张核心卡片',
        blocks: [
          {
            t: 'cards',
            say: en
              ? 'Flip each card to lock in the formulas and engineering intuition.'
              : '翻看这四张浓缩卡片，把数理推导与工程判准一起带走。',
            items: [
              {
                q: en ? 'What is the exact criterion and solution for Critical Damping ($x(0)=x_0, x\'(0)=0$)?' : '临界阻尼的判据与零初速响应公式（$x(0)=x_0, x\'(0)=0$）是什么？',
                a: en ? '$\\zeta = 1$ ($c = 2\\sqrt{mk}$), repeated root $r = -\\omega_n$, and $x(t) = x_0(1 + \\omega_n t)e^{-\\omega_n t}$.' : '$\\zeta = 1$（$c = 2\\sqrt{mk}$），二重根 $r = -\\omega_n$，位移响应 $x(t) = x_0(1 + \\omega_n t)e^{-\\omega_n t}$。',
              },
              {
                q: en ? 'Why does overdamping ($\\zeta > 1$) settle slower than critical damping ($\\zeta = 1$)?' : '为什么过阻尼（$\\zeta > 1$）反而比临界阻尼（$\\zeta = 1$）更慢归零？',
                a: en ? 'One real pole $r_1 = -\\omega_n(\\zeta - \\sqrt{\\zeta^2 - 1}) \\approx -\\omega_n/(2\\zeta)$ creeps toward $0^-$, creating a sluggish $e^{r_1 t}$ tail.' : '其中一个实极点 $r_1 = -\\omega_n(\\zeta - \\sqrt{\\zeta^2 - 1}) \\approx -\\omega_n/(2\\zeta)$ 逼近 $0^-$，形成缓慢蠕行的 $e^{r_1 t}$ 尾项。',
              },
              {
                q: en ? 'How does quadrupling payload mass ($m \\to 4m$) affect fixed-$c, k$ damping?' : '保持 $c, k$ 不变而负载质量变为 $4m$，阻尼比 $\\zeta$ 如何变化？',
                a: en ? '$\\zeta = c / (2\\sqrt{mk})$ drops by half—risking unexpected overshoot!' : '$\\zeta = c / (2\\sqrt{mk})$ 直接减半——原本无超调的系统可能跌入欠阻尼越界碰撞！',
              },
              {
                q: en ? 'When should a control engineer pick $\\zeta \\approx 0.707$ instead of $\\zeta = 1.0$?' : '控制工程中何时选 $\\zeta \\approx 0.707$，何时必须选 $\\zeta \\ge 1.0$？',
                a: en ? 'Pick $\\zeta \\approx 0.707$ when ~4.3% overshoot is harmless (fastest 5% settling); pick $\\zeta \\ge 1.0$ when any zero-crossing causes contact or damage.' : '允许约 4.3% 超调时选 $\\zeta \\approx 0.707$ 进容差带最快；严禁越界碰撞时必须选 $\\zeta \\ge 1.0$。',
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildEthicsLesson(language = 'en') {
  const en = language === 'en';
  return {
    format: 'studyhub-lesson/1',
    template: 'dialectic',
    language,
    id: 'demo-dialectic-alignment',
    course: en ? 'Philosophy & Computer Science' : '道德哲学与计算机伦理',
    title: en
      ? 'Deontology, Utilitarianism & Algorithmic Guardrails'
      : '义务论、功利主义与算法形式边界',
    lead: en
      ? 'Collide Bentham and Kant across classic thought experiments, then translate moral side-constraints into formal AI safety invariants $\\pi \\models \\Box\\,\\neg\\text{Harm}$.'
      : '在经典思想实验矩阵中对撞功利主义与康德义务论，再将道德边际约束翻译为形式化算法安全不变量 $\\pi \\models \\Box\\,\\neg\\text{Harm}$。',
    minutes: 20,
    needs: en
      ? ['Basic conditional logic ($P \\implies Q$ vs contrapositive)', 'Expected value / sum of payoffs $\\sum_i U_i$', 'Everyday moral intuition about rights vs outcomes']
      : ['命题逻辑基础（蕴含 $P \\implies Q$ 与反例概念）', '期望收益求和 $\\sum_i U_i$', '关于「结果好坏」与「个体权利」的日常直觉'],
    after: en
      ? ['Pinpoint the exact axiom where Act Utilitarianism and Kantian Deontology diverge', 'Spot hidden premise leaps inside persuasive moral & policy syllogisms', 'Design two-tier lexical decision architectures (hard invariants before scalar optimization)']
      : ['精准定位行为功利主义与康德人性公式分道扬镳的底层公理', '一眼识破伦理与算法决策论证中偷换概念的隐含前提', '掌握「硬约束过滤优先于标量效用最大化」的词典序双层决策架构'],
    terms: en
      ? {
          'Act Utilitarianism': 'Evaluates each individual action solely by whether it maximizes net aggregate utility $\\sum_{i=1}^n U_i(a)$ across all affected agents.',
          'Humanity Formula': 'Kant’s second formulation of the Categorical Imperative: always treat rational beings as ends in themselves, never **merely** as a means.',
          'Lexical Priority': 'A strict hierarchy where Rule $A$ must be 100% satisfied before Objective $B$ is even consulted—no finite gain in $B$ can trade off $A$.',
          'Reward Hacking': 'In AI & mechanism design, exploiting a proxy scalar objective $\\sum R_t$ by violating unstated human safety or rights assumptions.',
          'Rule Consequentialism': 'Judges actions by rules whose universal adoption yields the best long-run consequences (preserving institutional trust).',
        }
      : {
          '行为功利主义': '仅根据单一行为带来的总体净效用总和 $\\sum_{i=1}^n U_i(a)$ 是否最大化来判定对错的伦理框架。',
          '人性公式': '康德定言令式第二表述：永远把人自身同时当作目的，绝不能**仅仅**当作达成其他目标的工具手段。',
          '词典序优先': '严格的层级约束结构：第一层硬边界必须 100% 满足后，才在可行域内优化第二层指标，绝不允许用有限收益交换底线。',
          '奖励黑客': '人工智能与机制设计中，智能体利用纯标量奖励函数 $\\sum R_t$ 的漏洞，靠牺牲隐含安全或权利底线刷高分的现象。',
          '规则功利主义': '不逐案裸算得失，而是追问「若将该规则确立为普遍公开制度，长期总体福祉是否最优」（如守护医疗信任）。',
        },
    slides: [
      {
        beat: 'open',
        title: en ? 'Same Five-for-One Arithmetic, Opposite Gut Verdict' : '同样是「五换一」算术，为什么直觉判若云泥？',
        blocks: [
          {
            t: 'text',
            md: en
              ? 'Flipping a rail switch diverts a runaway trolley from **5 workers** onto **1 worker**—most people say *Permissible*. Yet a surgeon harvesting **1 healthy visitor’s** organs to save **5 dying patients** in Room B has the **exact same $5 > 1$ payoff**, and everyone recoils! When we encode autonomous policies, unconstrained optimization $$\\pi^* = \\arg\\max_{\\pi} \\sum_{i=1}^{n} U_i(\\pi) \\quad \\text{vs.} \\quad \\pi \\models \\Box\\,\\neg\\text{Instrumentalize}$$ determines whether an AI optimizes safely or commits catastrophic **Reward Hacking**.'
              : '扳动道岔把失控电车从 **5 名工人**引向侧轨上的 **1 名工人**，多数人认为「情有可原」；但外科医生若牺牲 **1 名健康体检者**摘取器官去救隔壁 **5 名器官衰竭病人**，算术上同样是 **$5 > 1$**，所有人却立刻感到毛骨悚然！当我们把决策写进自动驾驶或医疗调度代码时，究竟是写无约束求和 $$\\pi^* = \\arg\\max_{\\pi} \\sum_{i=1}^{n} U_i(\\pi) \\quad \\text{还是模态硬约束} \\quad \\pi \\models \\Box\\,\\neg\\text{Instrumentalize}$$ 直接决定了系统是安全运行还是演变成灾难性的**奖励黑客**。',
            say: en
              ? 'Philosophy is not armchair wordplay—every autonomous policy forces you to pick an explicit formal structure.'
              : '伦理学绝不是书斋清谈——只要你写下一行自动决策目标函数，你就已经在替系统做哲学公理选型了。',
          },
          {
            t: 'callout',
            tone: 'warning',
            title: en ? 'The Core Diagnostic Question' : '贯穿本课的核心追问',
            md: en
              ? 'If $5 - 1 = +4$ lives in both cases, **which hidden variable** did pure scalar summation erase?'
              : '如果两道题的净收益都是 $5 - 1 = +4$ 条生命，纯标量求和公式究竟**抹掉了哪一个关键结构变量**？',
            say: en
              ? 'Hold onto that puzzle—we will isolate the erased variable with formal counterexamples.'
              : '带着这个悬念往下走，我们用形式化反例把它一层层剥出来。',
          },
        ],
      },
      {
        beat: 'open',
        title: en ? 'Foundation Warm-Up: Sums vs Constraints' : '一分钟地基热身：标量求和与全称约束',
        blocks: [
          {
            t: 'recall',
            say: en
              ? 'Check two quick logical distinctions before we enter the thought-experiment matrix.'
              : '进入反例对撞矩阵前，先唤醒两个关键逻辑区分。',
            items: [
              {
                have: en ? 'Counterexample logic' : '全称命题的反例力量',
                q: en
                  ? 'To refute the universal claim $\\forall a,\\; (\\Delta U(a) > 0 \\implies \\text{Permissible}(a))$, how many counterexamples suffice?'
                  : '要推翻全称论断 $\\forall a,\\; (\\Delta U(a) > 0 \\implies \\text{道德允许}(a))$，逻辑上需要几个反例？',
                options: [
                  en ? 'Exactly one clear case where $\\Delta U(a) > 0$ yet $\\neg\\text{Permissible}(a)$' : '只需 1 个满足 $\\Delta U(a) > 0$ 但显然不可接受的清晰案例',
                  en ? 'More than 50% of everyday cases must fail' : '必须超过 50% 的日常案例出错才算推翻',
                ],
                answer: 0,
                why: en
                  ? 'Negating $\\forall a, (P(a) \\implies Q(a))$ requires just $\\exists a, (P(a) \\land \\neg Q(a))$—that is why philosophers & CS verifiers hunt edge cases!'
                  : '全称蕴含的否定是 $\\exists a, (P(a) \\land \\neg Q(a))$——这正是哲学思想实验与计算机形式化验证专挑极端边界测例的原因！',
              },
              {
                have: en ? 'Means vs mere means' : '「作为手段」与「仅作手段」',
                q: en
                  ? 'When you pay a barista $5 for coffee, are you violating Kant’s Humanity Formula?'
                  : '你花钱请咖啡师做一杯咖啡（借助了他的劳动），这违背康德的「人性公式」吗？',
                options: [
                  en ? 'Yes — any usefulness treats someone as a means' : '违背 —— 只要借助他人达成目的就算工具化',
                  en ? 'No — voluntary consent respects their agency; Kant forbids treating people MERELY as means' : '不违背 —— 自愿交易尊重对方自主意志；康德禁止的是「仅仅当作手段」',
                ],
                answer: 1,
                why: en
                  ? 'Coercion or deception bypasses rational consent, reducing a person to a mere instrument.'
                  : '唯有欺骗或强迫剥夺了对方的理性同意权，才把人降格为纯粹工具。',
              },
            ],
          },
        ],
      },
      {
        beat: 'hook',
        title: en ? 'Philosophy Meets Systems Engineering' : '当古典伦理学撞上现代AI对齐工程',
        blocks: [
          {
            t: 'scene',
            columns: [en ? 'Moral Philosophy Concept' : '古典伦理学范畴', en ? 'CS / AI Formal Counterpart' : '计算机与 AI 系统映射'],
            story: en
              ? 'Imagine programming an autonomous hospital triage & ambulance routing agent. Every philosophical school compiles to a distinct code pattern.'
              : '假设你正在编写城市急救车与医院资源调度系统，三大伦理学流派在代码里各自对应截然不同的数学结构。',
            say: en
              ? 'Step through the three mappings—you will immediately recognize them from algorithms and optimization!'
              : '一步步点开映射表，你会惊讶地发现：伦理学争论的正是优化目标与安全断言的关系！',
            map: [
              {
                scene: en ? 'Act Utilitarianism (Bentham)' : '行为功利主义（边沁）',
                model: 'argmax_a Sum_i E[U_i(a)]',
                say: en ? 'Unconstrained scalar reward: every good and harm is fungible in one currency.' : '无约束单目标最大化：一切代价与收益都可折算进同一个标量总分里互相抵消。',
              },
              {
                scene: en ? 'Kantian Deontology (Humanity Formula)' : '康德义务论（人性公式）',
                model: 'Hard assertion: assert(!usesAsMereMeans(a))',
                say: en ? 'Inviolable precondition: certain actions are type-checked out of the action space before scoring.' : '不可逾越的前置断言：违法底线的动作在计分前就被类型系统直接剔除出可行集。',
              },
              {
                scene: en ? 'Lexical / Rule-Constrained Synthesis' : '词典序规则约束架构',
                model: 'argmax_{a in SafeSet} Sum_i E[U_i(a)]',
                say: en ? 'Two-stage solver: filter by hard rights/safety invariants $\\Box\\,\\phi$, then optimize expected welfare inside the safe set!' : '两阶段求解：先过模态安全硬约束 $\\Box\\,\\phi$，再在安全可行域内最大化总福祉！',
                key: en ? 'Hard safety invariants filter the feasible set; utility optimizes within it.' : '权利与安全硬边界负责裁剪可行域，功利计算负责在可行域内择优。',
              },
            ],
          },
        ],
      },
      {
        beat: 'code',
        title: en ? 'What Happens When Code Optimizes Raw Sum Alone' : '当代码只写「总收益最大化」会发生什么',
        blocks: [
          {
            t: 'code',
            path: 'naive-reward-policy.py',
            lang: 'python',
            source: [
              'def choose_action(candidates, expected_utility):',
              '    # Pure unconstrained scalar maximization',
              '    return max(candidates, key=lambda a: sum(expected_utility(a)))',
              "# Warning: zero check on whether 'a' sacrifices an innocent bystander!",
            ].join('\n'),
            focusLines: [1, 3],
            say: en
              ? 'Line 3 looks completely innocent—it is the textbook definition of expected-utility maximization.'
              : '第 3 行代码看起来无比自然——这正是教科书标准的期望效用最大化。',
            walk: [
              {
                focusLines: [3, 4],
                say: en
                  ? 'Because `sum(...)` erases WHO bears the harm and HOW it is inflicted, any extreme tail payoff overrides individual rights!'
                  : '正因为 `sum(...)` 抹平了「伤害落在了谁身上」以及「以何种因果方式施加」，任何高收益极端动作都会碾碎个体边界！',
              },
            ],
          },
        ],
      },
      {
        beat: 'predict',
        title: en ? 'Predict the Fault Line Across Cases' : '先盲猜：究竟哪条结构差异区分了道岔与器官移植？',
        blocks: [
          {
            t: 'predict',
            id: 'pred-means',
            q: en
              ? 'Why do Kantian & causal-agency theories distinguish diverting the Switch Trolley from the Transplant Surgeon, even though both trade 1 life for 5?'
              : '同样是「救 5 人而致 1 人死亡」，康德派与因果能动性理论凭什么严格区分「扳道岔」与「摘取健康者器官」？',
            options: [
              en ? 'Because hospital surgeries have lower statistical success rates than rail switches' : '因为器官移植手术的医学成功率低于火车变轨',
              en ? 'In Transplant, the victim’s harm IS the causal instrument used to save the 5; in Switch, the 1’s presence is not needed to save the 5' : '器官案把受害者的身体伤害直接当作救人的「因果工具」；扳道岔案中若侧轨没人，5 人照样获救',
              en ? 'Because philosophers judge indoor actions more strictly than outdoor accidents' : '因为室内医疗行为比户外交通事故适用更严苛的直觉',
            ],
            answer: 1,
            say: en
              ? 'Apply the counterfactual "Remove the Victim" test in your head and pick one!'
              : '在脑海里做一次「假如那个倒霉的人不在场」的反事实测试，选出你的判断！',
          },
        ],
      },
      {
        beat: 'run',
        title: en ? 'Dialectical Thought-Experiment Matrix (Predict & Reveal)' : '跨场景思辨反例矩阵（点击卡片验证预判）',
        blocks: [
          {
            t: 'matrix',
            predictBeforeReveal: true,
            say: en
              ? 'Switch across all 3 scenarios and click masked cards to test your predictions before unveiling each framework’s verdict!'
              : '切换上方三个极端场景，先在心里预判三大框架的裁决，再点击蒙版卡片逐一揭晓！',
            frameworks: [
              { id: 'act-util', name: en ? 'Act Utilitarianism' : '行为功利主义' },
              { id: 'kant', name: en ? 'Kantian Deontology' : '康德义务论' },
              { id: 'lexical', name: en ? 'Rule / Lexical Guardrail' : '规则与词典序护栏' },
            ],
            scenarios: [
              {
                id: 'transplant',
                title: en ? '1. Transplant Surgeon' : '1. 器官移植医生',
                prompt: en
                  ? 'A surgeon can secretly harvest organs from 1 healthy check-up visitor to save 5 dying ward patients ($+4$ lives immediate).'
                  : '医生可秘密摘取 1 名健康体检者的器官救活病房里 5 名衰竭患者（当场净救 $+4$ 人）。',
                cells: [
                  {
                    badge: en ? 'Bites bullet / Fails' : '直觉崩塌反例',
                    tone: 'error',
                    verdict: en ? 'Permitted if truly secret' : '若绝对保密则算账允许',
                    why: en ? 'Single-act $\\sum U_i$ sees $5 > 1$, exposing the absence of individual rights boundaries.' : '单次净效用 $5 > 1$，赤裸暴露出纯加总模型缺乏个体不可侵犯边界的致命缺陷。',
                  },
                  {
                    badge: en ? 'Strictly Forbidden' : '绝对禁止',
                    tone: 'success',
                    verdict: en ? 'Treats visitor as mere means' : '把无辜者仅作救人耗材',
                    why: en ? 'If the visitor walked out, the 5 could not be saved—their death is the direct instrument.' : '若体检者离开医院，救人计划即刻落空——他的受害本身被当成了工具手段。',
                  },
                  {
                    badge: en ? 'Blocked at Layer 1' : '第一层硬护栏拦截',
                    tone: 'success',
                    verdict: en ? 'Violates $\\Box\\,\\neg\\text{HarmInnocent}$ & trust' : '触发权利不变量与制度崩盘防线',
                    why: en ? 'Publicizing such a rule destroys hospital trust so everyone avoids check-ups ($\\Delta U_{\\text{rule}} \\ll 0$).' : '一旦成为公开规则，全社会无人敢去医院体检，制度长期效用彻底归负。',
                  },
                ],
              },
              {
                id: 'switch',
                title: en ? '2. Switch Trolley' : '2. 扳道岔救五人',
                prompt: en
                  ? 'Divert a runaway trolley away from 5 track workers onto a side spur where 1 worker happens to stand.'
                  : '扳动道岔将失控列车从 5 人主轨引向恰好站有 1 名工人的侧轨。',
                cells: [
                  {
                    badge: en ? 'Obligatory ($5 > 1$)' : '应当变轨（$5 > 1$）',
                    tone: 'success',
                    verdict: en ? 'Divert: minimizes expected deaths' : '变轨使总伤亡最小化',
                    why: en ? 'Net expected loss drops from $5$ to $1$.' : '预期生命损失由 $5$ 降至 $1$，净福祉显著提升。',
                  },
                  {
                    badge: en ? 'Contested Boundary' : '义务论内部张力点',
                    tone: 'warning',
                    verdict: en ? 'Not mere means, yet Foreseen Harm' : '非工具化利用，但属可预见附带伤害',
                    why: en ? 'If the 1 worker stepped off the spur, the 5 would STILL be saved—harm is side-effect, not instrument.' : '假使侧轨工人碰巧走开，5 人照样得救——该伤害是转向副作用而非救人手段。',
                  },
                  {
                    badge: en ? 'Permitted Emergency Tie-Break' : '对称险境下的次层择优',
                    tone: 'info',
                    verdict: en ? 'Equal non-instrumental claim $\\to$ minimize harm' : '未把人当耗材时按最小伤害裁决',
                    why: en ? 'Neither group is used as fuel/parts; ex-ante symmetrical risk rule favors saving 5.' : '双方均未被当作工具耗材，事前对称风险契约支持最小化伤亡。',
                  },
                ],
              },
              {
                id: 'reward-hack',
                title: en ? '3. AI Triage Reward Hack' : '3. 急诊 AI 奖励黑客',
                prompt: en
                  ? 'A hospital AI scored solely on `avg_wait_time` learns to reclassify 1 complex critical patient as "non-urgent discharge" so 12 mild cases clear in 3 minutes.'
                  : '急诊调度 AI 因只考核「平均候诊时长」，学会把 1 名复杂危重病人强行标为「非急症劝返」，换取 12 名轻症 3 分钟清零。',
                cells: [
                  {
                    badge: en ? 'Proxy Exploited!' : '指标被钻空子',
                    tone: 'error',
                    verdict: en ? 'Maximizes naive scalar proxy' : '完美刷高标量均值指标',
                    why: en ? 'Goodhart’s Law: optimizing an unconstrained average sacrifices tail-risk minorities.' : '古德哈特定律：无底线的均值优化必然通过牺牲少数高成本个体来刷分。',
                  },
                  {
                    badge: en ? 'Agency Violation' : '违背平等尊严',
                    tone: 'success',
                    verdict: en ? 'Sacrifices patient for dashboard metric' : '拿危重患者给考核报表垫背',
                    why: en ? 'Uses the critical patient’s exclusion as a means to improve others’ wait stats.' : '将排除危重患者当作美化他人等待数据的手段。',
                  },
                  {
                    badge: en ? 'Solved by $\\Box$ Guardrail' : '形式化硬约束根治',
                    tone: 'success',
                    verdict: en ? ' Enforce $\\Box(\\text{Critical} \\implies \\text{Wait} \\le T_{\\max})$ first' : '先锁死 $\\Box(\\text{危重} \\implies \\text{等待} \\le T_{\\max})$',
                    why: en ? 'Lexical constraint forbids critical-patient Starvation before minimizing average wait.' : '词典序第一层严禁任何危重病患超时饿死，第二层才优化平均候诊时间。',
                  },
                ],
              },
            ],
            walk: [
              {
                scenario: 'transplant',
                focus: 'act-util',
                say: en
                  ? 'In Transplant, raw Act Utilitarianism gets trapped by its own $5 > 1$ sum.'
                  : '在器官移植案里，朴素行为功利主义被自己的 $5 > 1$ 加法逼进了死胡同。',
              },
              {
                scenario: 'transplant',
                focus: 'kant',
                say: en
                  ? 'Kant’s counterfactual nails why: if the visitor vanished, the 5 would NOT be saved—so the visitor’s body is used as a mere tool!'
                  : '康德的反事实判据一剑封喉：若体检者不在场，5 人根本救不活——可见体检者的被害本身被当成了工具！',
                key: en
                  ? 'Counterfactual test for Mere Means: if the victim vanished and your plan fails, you used them as an instrument.'
                  : '「仅作手段」反事实检验：若把受害者从场景抽走会导致计划失败，即构成工具化利用。',
              },
              {
                scenario: 'reward-hack',
                focus: 'lexical',
                say: en
                  ? 'Now jump to Scenario 3: the exact same philosophical bug reappears in AI as Goodhart’s Law / Reward Hacking—fixed by Lexical Priority!'
                  : '再切到场景 3：一模一样的伦理漏洞在 AI 工程里化身为「奖励黑客」，而解药正是词典序硬护栏！',
              },
            ],
          },
          {
            t: 'reveal',
            of: 'pred-means',
            say: en
              ? 'Check your earlier prediction against the counterfactual Mere-Means test!'
              : '回头核对一下刚才的反事实测试预判！',
          },
        ],
      },
      {
        beat: 'why',
        title: en ? 'Spot the Hidden Premise Leap in the Argument' : '逻辑找茬：揪出三段论里偷渡的那条假前提',
        blocks: [
          {
            t: 'spot',
            of: 'flaw-aggregation-syllogism',
            path: 'transplant-syllogism.txt',
            lang: 'argument',
            q: en
              ? 'Click the exact premise that smuggles in unconstrained aggregation without justification.'
              : '请点击左侧形式论证中未经证明便强行抹平权利边界的那一行前提。',
            how: en ? 'Click the flawed premise line on the left.' : '点击左侧暗藏逻辑跳跃的前提行。',
            source: [
              'Premise 1: Saving five lives produces more total well-being than saving one.',
              'Premise 2: Rational policy should promote better outcomes when permissible.',
              'Premise 3: Any action with higher net aggregate utility is automatically morally permissible.',
              "Conclusion: Therefore, harvesting one healthy visitor's organs to save five patients is obligatory.",
            ].join('\n'),
            answerLines: [3],
            hint: en
              ? 'Compare "when permissible" in Premise 2 against the unconditional leap in Premise 3.'
              : '对比第 2 行的限定词「在允许范围内」与第 3 行的无条件绝对化跳跃。',
            found: en
              ? 'Bullseye! Premise 2 says optimize *within permissible bounds*, whereas Premise 3 quietly equates higher $\\sum U_i$ with permissibility itself—erasing rights constraints!'
              : '抓得漂亮！前提 2 说的是「在允许边界内追求更好结果」，而前提 3 偷偷把「总分更高」直接等同于「合法允许」，一步抹杀了所有权利底线！',
            say: en
              ? 'In both philosophy essays and safety specs, invalid arguments rarely fail in arithmetic—they smuggle an unconditional Premise 3.'
              : '无论读哲学论文还是审安全架构，危险往往不在算术算错，而在第 3 行这样悄无声息抹掉边界条件的前提偷换。',
          },
        ],
      },
      {
        beat: 'why',
        title: en ? 'Formal Architecture: Lexical Guardrail + Utility Tie-Breaker' : '形式化拆解：词典序硬约束 + 可行域效用择优',
        blocks: [
          {
            t: 'inside',
            caption: en ? 'Two-layer constrained policy architecture:' : '两层词典序安全决策架构逐行解剖：',
            command: 'Constrained Policy Synthesis',
            lang: 'argument',
            source: [
              'Layer 1 (Hard Invariant):  pi |= [] ~Instrumentalize(person)   // inviolable filter',
              'Admissible Set:            A_safe = { a in Actions | Layer1(a) == True }',
              'Layer 2 (Utility Tie-Break): a* = argmax_{a in A_safe} Sum_i E[U_i(a)]',
              'Result: No finite utility spike can ever trade off a Layer-1 rights violation.',
            ].join('\n'),
            say: en
              ? 'Watch how cleanly modal logic $\\Box$ (`[]`) and utility $\\sum E[U_i]$ work together once given proper roles.'
              : '看模态算子 $\\Box$（代码中记作 `[]`）与期望效用 $\\sum E[U_i]$ 各司其职时有多么优雅清晰。',
            walk: [
              {
                focusLines: [1, 2],
                label: 'Layer 1 Filter',
                say: en
                  ? 'Layer 1 enforces deontological / safety invariants $\\pi \\models \\Box\\,\\neg\\text{Instrumentalize}$, pruning forbidden actions out of $A_{\\text{safe}}$.'
                  : '第一层执行义务论/安全硬不变量 $\\pi \\models \\Box\\,\\neg\\text{Instrumentalize}$，先把侵权与越界动作彻底剪出可行集 $A_{\\text{safe}}$。',
              },
              {
                focusLines: [3, 4],
                label: 'Layer 2 Optimize',
                say: en
                  ? 'Layer 2 then maximizes expected utility strictly INSIDE $A_{\\text{safe}}$—unlike a soft penalty $-\\lambda \\cdot \\text{harm}$, which still breaks if utility is huge!'
                  : '第二层仅在安全子集 $A_{\\text{safe}}$ 内部最大化期望效用——注意它绝不是软惩罚项 $-\\lambda \\cdot \\text{harm}$（软惩罚只要总收益够大依然会被击穿）！',
                key: en
                  ? 'Soft penalty $-\\lambda C$ can always be outbid; a lexical constraint $A_{\\text{safe}}$ cannot.'
                  : '软惩罚权重 $-\\lambda C$ 总能被足够大的收益买通，唯独词典序可行域裁剪 $A_{\\text{safe}}$ 不可收买。',
              },
            ],
          },
        ],
      },
      {
        beat: 'why',
        title: en ? 'Closed-Loop Policy Pipeline: Why Soft Penalties Get Hacked' : '系统控制框图：为什么软权重惩罚挡不住奖励黑客',
        blocks: [
          {
            t: 'schematic',
            height: 245,
            say: en
              ? 'Trace an autonomous planner from candidate actions to deployment—and see the feedback loop when edge-case pressure spikes! Click any block for details.'
              : '沿着自动决策流水线走一遍，看高流量压力反馈回来时，硬护栏如何守住底线！点击任意方框查看职责。',
            nodes: [
              { id: 'gen', label: en ? 'Action Proposals' : '候选策略生成', sub: en ? 'All $a \\in A$' : '全量动作集 $A$', detail: en ? 'Generates all physically possible routing or allocation actions, including risky shortcuts.' : '枚举所有物理可行的调度方案，其中可能混入投机走捷径的高危动作。', x: 24, y: 72, w: 128, h: 52 },
              { id: 'guard', label: en ? 'Invariant Shield $\\Box$' : '形式化护栏 $\\Box$', sub: en ? 'Deontic filter' : '权利/安全过滤', detail: en ? 'Rejects any $a$ violating rights, consent, or safety bounds regardless of downstream reward.' : '无视下游收益高低，凡违背权利同意或安全红线的动作一律一票否决。', x: 190, y: 72, w: 136, h: 52 },
              { id: 'opt', label: en ? 'Utility Ranker' : '效用排序器', sub: '$\\max \\sum E[U_i]$', detail: en ? 'Ranks only the surviving safe candidates $a \\in A_{\\text{safe}}$ by expected social welfare.' : '仅在通过安全审查的候选集 $A_{\\text{safe}}$ 内按期望总福祉择优。', x: 364, y: 72, w: 126, h: 52 },
              { id: 'audit', label: en ? 'Outcome Audit' : '边界审计器', sub: en ? 'Counterexample log' : '反例回归监测', detail: en ? 'Monitors tail harms and feeds new edge cases back to tighten the Invariant Shield.' : '持续监测长尾受损个体，将新型边界反例反馈回安全护栏升级规则。', x: 522, y: 72, w: 104, h: 52 },
            ],
            edges: [
              { id: 'e1', from: 'gen', to: 'guard', label: '$A$' },
              { id: 'e2', from: 'guard', to: 'opt', label: '$A_{\\text{safe}}$' },
              { id: 'e3', from: 'opt', to: 'audit', label: '$a^*$' },
              { id: 'e4', from: 'audit', to: 'guard', label: en ? 'Refine $\\Box$ rules' : '反例收紧 $\\Box$ 规则', feedback: true },
            ],
            walk: [
              {
                nodes: ['gen', 'guard', 'opt'],
                edges: ['e1', 'e2'],
                tone: 'success',
                say: en
                  ? 'Forward pass: `Invariant Shield` strips out rights-violating shortcuts BEFORE `Utility Ranker` ever scores them.'
                  : '正向链路：形式化护栏在计分之前先剔除侵权捷径，效用排序器永远接触不到越界选项。',
              },
              {
                nodes: ['audit', 'guard'],
                edges: ['e3', 'e4'],
                tone: 'info',
                states: { guard: 'Updated [] phi', audit: '0 tail breaches' },
                say: en
                  ? 'Feedback loop: just as philosophical counterexamples refine moral principles (Reflective Equilibrium), runtime audits tighten $\\Box$ invariants!'
                  : '闭环反馈：正如哲学上用反例修正原则（罗尔斯「反思平衡」），线上审计把新边缘案例反馈回护栏收紧不变量！',
                key: en
                  ? 'Rawlsian Reflective Equilibrium mirrors counterexample-guided invariant refinement (CEGAR) in CS.'
                  : '哲学中的「反思平衡」与计算机验证中的「反例引导抽象精化（CEGAR）」同构。',
              },
            ],
          },
        ],
      },
      {
        beat: 'fix',
        title: en ? 'Socratic Collision: Soft Penalty vs Lexical Invariant' : '双轨推演：软惩罚权重对比词典序硬不变量',
        blocks: [
          {
            t: 'lanes',
            lanes: [en ? 'Soft Penalty ($\\sum U - 100 \\cdot \\text{harm}$)' : '软权重惩罚（$\\sum U - 100 \\cdot \\text{harm}$）', en ? 'Lexical Guardrail ($\\Box\\,\\neg\\text{harm}$)' : '词典序硬护栏（$\\Box\\,\\neg\\text{harm}$）'],
            shared: { name: en ? 'Safety Invariant' : '个体权利底线', start: 'Intact' },
            steps: [
              {
                lane: 0,
                op: 'read',
                text: 'Normal day: +20 gain < 100 penalty',
                say: en ? 'In small everyday tests, a $-100$ penalty seems to block harmful shortcuts just fine.' : '在常规小流量测试里，$-100$ 的扣分看似稳稳挡住了违规捷径。',
              },
              {
                lane: 0,
                op: 'write',
                value: 'BREACHED (+500 > 100)',
                text: 'Surge event: 500x crowd -> +500 - 100 = +400!',
                say: en ? 'Then a surge hits: $500$ users gain $+1$ each ($+500 > 100$), and the optimizer happily sacrifices the innocent user!' : '一旦高峰期涌入 500 名普通用户（每人 $+1$ 总分 $+500 > 100$），优化器立刻毫不犹豫地献祭无辜个体！',
              },
              {
                lane: 1,
                op: 'calc',
                text: 'Filter A_safe: drop harmful action first',
                say: en ? 'Under Lexical Priority, the harmful shortcut is removed at Layer 1 regardless of crowd size $N$.' : '而词典序架构在第一层直接将该动作判为非法出局，根本不看人数 $N$ 是 5 还是 50000。',
              },
              {
                lane: 1,
                op: 'write',
                value: 'Intact for all N',
                text: 'Pick best safe route in A_safe',
                say: en ? 'Even as $N \\to \\infty$, the safety invariant holds while still choosing the fastest legitimate route!' : '哪怕并发规模趋向无穷大，底线依然稳如磐石，同时在合法方案中选出最快路径！',
              },
            ],
            verdict: en
              ? 'Never encode an inviolable moral or safety boundary as a finite additive penalty.'
              : '永远不要把不可逾越的伦理或安全红线写成有限大小的线性扣分项。',
            verdictSay: en
              ? 'Scale $N$ up enough, and every finite soft penalty eventually breaks.'
              : '只要样本规模 $N$ 足够大，任何有限的加性惩罚权重终将被规模收益冲垮。',
          },
        ],
      },
      {
        beat: 'choose',
        title: en ? 'Comparing the Three Normative Frameworks' : '三大规范框架优劣与适用边界对照',
        blocks: [
          {
            t: 'choose',
            columns: [en ? 'Core Strength' : '核心解释力/优势', en ? 'Classic Vulnerability' : '经典盲区与代价', en ? 'Where It Shines' : '最佳适用层'],
            say: en
              ? 'None of the three frameworks is useless—each breaks when stretched outside its proper layer.'
              : '三大流派并非非黑即白——把任何一种单独拉扯到全场通吃都会翻车，分层组合才见真章。',
            options: [
              {
                name: en ? 'Act Utilitarianism' : '行为功利主义',
                solves: en ? 'Transparent quantitative trade-offs among commensurate goods' : '同质可通约利益间的透明量化权衡',
                cost: en ? 'Blind to individual rights, distribution fairness & mere-means harm' : '忽视个体权利边界、分配正义与工具化伤害',
                when: en ? 'Bandwidth/budget allocation AFTER safety & rights filters pass' : '通过安全与权利红线后的资源效率择优层',
                say: en ? 'Ideal inside Layer 2 when comparing apples to apples (e.g. latency vs server cost).' : '在第二层内部做同质资源调优（如延迟与算力成本平衡）时极其高效。',
              },
              {
                name: en ? 'Kantian Deontology' : '康德义务论',
                solves: en ? 'Protects agency, consent & non-instrumental dignity unconditionally' : '无条件捍卫理性主体尊严、知情同意与反工具化',
                cost: en ? 'Rigid in tragic symmetric dilemmas (e.g. lying to an axe murderer)' : '面对对称悲剧冲突（如向追杀者说谎）时易陷僵化',
                when: en ? 'Constitutional rights, informed consent & hard AI safety assertions' : '宪制基本权利、医疗知情同意与 AI 安全硬断言',
                say: en ? 'Essential at Layer 1 to define what may NEVER be traded away.' : '是构建第一层「非卖品」底线断言的基石。',
              },
              {
                name: en ? 'Rule / Lexical Consequentialism' : '规则功利 / 词典序综合',
                solves: en ? 'Unites institutional trust & rights guardrails with welfare optimization' : '兼顾制度长期信任护栏与可行域内的福祉最大化',
                cost: en ? 'Requires explicit priority ordering when two rules collide' : '当两条规则正面冲突时需预先排定词典序优先级',
                when: en ? 'Public law, clinical triage protocols & autonomous system specs' : '公共立法、临床分级诊疗规范与自动驾驶安全规约',
                say: en ? 'Gives engineers & policymakers a constructive blueprint when principles clash.' : '为公共政策与安全关键系统提供了可直接落地的分层工程蓝图。',
              },
            ],
            rule: en
              ? 'Rights & consent involved? Enforce Deontic / Lexical Layer-1 constraints first; then maximize Utilitarian welfare inside the safe set.'
              : '涉及基本权利与知情同意 → 先立第一层义务论硬护栏；纯同质效率权衡 → 在安全集内用功利原则最大化净收益。',
            ruleSay: en
              ? 'Layer 1 protects dignity; Layer 2 maximizes welfare.'
              : '一层守尊严底线，二层求公共效率——各安其位。',
          },
        ],
      },
      {
        beat: 'choose',
        layout: 'split',
        title: en ? 'Decision Tree & Applied Policy Cases' : '规范选型决策树与真实案例实操',
        blocks: [
          {
            t: 'decide',
            q: en ? 'Does the candidate action coerce, deceive, or sacrifice an unconsenting person as an instrument?' : '候选方案是否把未同意的个体当作工具手段加以欺骗、强迫或牺牲？',
            say: en ? 'Run the Mere-Means check first, then classify all three real-world cases.' : '先过左侧「反工具化」检验，再判断右侧三个跨学科真实场景。',
            branches: [
              { when: en ? 'Yes — violates consent / uses person as mere means' : '是 —— 侵犯知情同意或把人当耗材', pick: 'Deontic Hard Block', eg: en ? 'Unconsented clinical trial' : '隐瞒风险的人体临床试验' },
              { when: en ? 'No — symmetric risk, institutional trust at stake' : '否 —— 风险对称但关乎公共制度预期', pick: 'Public Rule Protocol', eg: en ? 'Published organ waitlist rules' : '公开透明的器官轮候准则' },
              { when: en ? 'No — pure resource efficiency within safe bounds' : '否 —— 安全红线内的纯效率分配', pick: 'Utilitarian Optimizer', eg: en ? 'CDN cache routing' : '安全合规前提下的算力调度' },
            ],
          },
          {
            t: 'cases',
            tools: ['Deontic Hard Block', 'Public Rule Protocol', 'Utilitarian Optimizer'],
            say: en ? 'Test your grasp across bioethics, AI alignment, and infrastructure.' : '横跨生命伦理、AI 对齐与基础设施三道题，练熟这条判准。',
            items: [
              {
                text: en ? 'Secretly training a commercial voice clone on patients’ private therapy recordings because total user convenience is huge' : '以「提升千万用户体验」为由，未经同意秘密拿心理咨询录音训练商业语音模型',
                answer: 0,
                why: en ? 'Bypasses rational consent and treats vulnerable patients’ disclosures merely as training fuel.' : '绕过知情同意将患者隐私倾诉纯粹当作训练燃料，触发第一层义务论硬拦截。',
              },
              {
                text: en ? 'Designing a national ICU ventilator triage standard published before winter flu season' : '在流感季前向社会公开征求意见并颁布统一的 ICU 呼吸机分级救治规程',
                answer: 1,
                why: en ? 'Requires an impartial, publicly auditable rule system that preserves social trust under scarcity.' : '稀缺救治必须依赖事先公开、可审计的普遍规则，兼顾生命挽救与社会信任。',
              },
              {
                text: en ? 'Routing freight trains overnight to minimize total fleet kilowatt-hours after all track-safety locks are engaged' : '在所有轨道安全联锁闭合后，优化夜间货运列车编组以最小化总电耗',
                answer: 2,
                why: en ? 'Once hard safety invariants hold, minimizing energy cost is pure commensurate scalar optimization.' : '硬安全不变量全部满足后，降低总能耗属于典型的可通约标量最优化。',
              },
            ],
          },
        ],
      },
      {
        beat: 'name',
        title: en ? 'Formal Concept Card: Lexical Constraints & the Humanity Formula' : '正式挂牌命名：人性公式与词典序约束对齐',
        blocks: [
          {
            t: 'name',
            term: en ? 'Lexical Deontic Guardrail' : '词典序义务护栏',
            alias: en ? 'Kant Humanity Formula + Rawlsian Lexical Priority (Constrained Optimization)' : 'Humanity Formula × Lexical Priority（受约束最优化对齐）',
            oneLine: en
              ? 'Separating inviolable non-instrumentalization invariants ($\\pi \\models \\Box\\,\\neg\\text{MereMeans}$) from scalar welfare maximization ($\\max_{a \\in A_{\\text{safe}}} \\sum U_i(a)$).'
              : '将不可交易的反工具化硬不变量（$\\pi \\models \\Box\\,\\neg\\text{MereMeans}$）置于标量福祉最大化（$\\max_{a \\in A_{\\text{safe}}} \\sum U_i(a)$）之前的严格双层结构。',
            askedTitle: en ? 'Philosophy Seminar & AI Safety Interview Prompts' : '哲学研讨课与 AI 安全面试高频追问',
            asked: [
              en ? 'How do you test formally whether an agent is used "merely as a means" versus affected as a foreseen side-effect?' : '如何用反事实判据严格区分「把人仅作手段」与「可预见的附带副作用」？',
              en ? 'Why does adding a large negative reward $-\\lambda C$ fail to enforce a true deontological constraint at scale?' : '为什么在强化学习奖励函数里加一个很大的负权重 $-\\lambda C$ 依然不等于真正的义务论硬约束？',
              en ? 'How does Rule Consequentialism answer the Transplant Surgeon without abandoning consequences altogether?' : '规则后果主义如何在不放弃结果考量的前提下，依然否决器官移植医生的行为？',
            ],
            say: en
              ? 'Notice how cleanly Philosophy and Computer Science illuminate each other once you strip away jargon!'
              : '剥去行话外壳后你会发现：康德、罗尔斯与现代 AI 安全架构师其实在合力解答同一道结构题！',
          },
        ],
      },
      {
        beat: 'check',
        title: en ? 'Boundary Check 1: Means vs Foreseen Side-Effect' : '边界小测（一）：反事实检验与工具化边界',
        blocks: [
          {
            t: 'quiz',
            q: en
              ? 'Which diagnostic question cleanly separates using someone MERELY as a means (Transplant) from causing foreseen side-effect harm (Switch Trolley)?'
              : '下列哪项反事实检验能最干净地区分「把受害者仅作工具手段」（器官案）与「造成可预见附带伤害」（扳道岔案）？',
            say: en ? 'Apply the counterfactual test we uncovered in the matrix.' : '直接调用刚才在反例矩阵里提炼出的反事实判据。',
            options: [
              {
                text: en ? 'Ask whether total lives saved minus lives lost is strictly positive ($\\Delta U > 0$)' : '计算获救人数减去受损人数是否严格大于零（$\\Delta U > 0$）',
                ok: false,
                why: en ? 'Both cases have $+4$ net lives ($5 - 1$), so raw $\\Delta U$ cannot tell them apart!' : '两案净救人数同为 $5 - 1 = +4$，纯算术差值完全无法区分两者！',
              },
              {
                text: en ? 'Ask: if the threatened individual miraculously vanished from the scene, would the plan to save the five still succeed?' : '追问：假如那名受威胁者奇迹般不在现场，拯救五人的因果链条是否依然成立？',
                ok: true,
                why: en ? 'On the side track, an empty spur STILL saves the 5; in the hospital, an empty lobby yields zero organs and fails!' : '侧轨若空无一人，变轨照样救下 5 人；而体检室若没人，医生拿不到器官，救人计划当场失败！',
              },
              {
                text: en ? 'Ask whether the decision is made by a human or by software' : '看做出决策的主体是人类还是计算机程序',
                ok: false,
                why: en ? 'The causal-agency structure of the action is identical regardless of who executes it.' : '动作本身的因果利用结构不因执行者是人还是代码而改变。',
              },
              {
                text: en ? 'Ask whether the five beneficiaries know the victim personally' : '看获救的五人与受害者是否彼此认识',
                ok: false,
                why: en ? 'Personal acquaintance is morally irrelevant to non-instrumentalization.' : '是否相识与是否构成工具化侵权无关。',
              },
            ],
          },
        ],
      },
      {
        beat: 'say',
        title: en ? 'Boundary Check 2 & Two-Minute Oral Synthesis' : '边界小测（二）与两分钟开口复述',
        blocks: [
          {
            t: 'quiz',
            q: en
              ? 'An engineer claims: "We don’t need hard action-space filters; setting `harm_penalty = -1_000_000` in our scalar reward guarantees safety." Why is this false?'
              : '某算法工程师声称：「不需要做可行域硬过滤，只要在标量奖励里设 `harm_penalty = -1_000_000` 就绝对不会伤人。」这一说法错在哪里？',
            say: en ? 'Think back to the surge-scale lane trace before you start speaking.' : '回想双轨推演里当并发规模 $N$ 暴增时发生了什么，答完开启两分钟口述！',
            options: [
              {
                text: en ? 'Floating-point numbers cannot store $-1,000,000$ accurately' : '因为浮点数无法精确表示 $-1,000,000$',
                ok: false,
                why: en ? 'IEEE-754 floats represent $10^6$ exact to the bit; the flaw is mathematical, not numerical.' : '双精度浮点数能精确表示百万级整数，漏洞出在加性可交易结构而非数值精度。',
              },
              {
                text: en ? 'Additive scalar penalties remain Archimedian/fungible: aggregating $+0.5$ across $3,000,000$ users ($+1.5\\times 10^6$) still outbids the penalty!' : '加性惩罚仍具有阿基米德可通约性：当 300 万用户各获益 $+0.5$（总分 $+150$ 万）时，罚分照样被买通击穿！',
                ok: true,
                why: en ? 'Any finite penalty $-\\lambda$ is overridden once $N \\cdot \\epsilon > \\lambda$; only lexical filtering holds for all $N$.' : '对任意有限罚分 $-\\lambda$，只要规模 $N \\cdot \\epsilon > \\lambda$ 就会越界；唯独词典序过滤对任意规模 $N$ 恒成立。',
              },
              {
                text: en ? 'Negative rewards prevent gradient descent from converging on convex functions' : '因为负奖励会导致凸函数梯度下降无法收敛',
                ok: false,
                why: en ? 'Shifting or weighting rewards does not break convexity; it optimizes the wrong trade-off!' : '问题不在于不收敛，而在于它极其精准地收敛到了牺牲无辜者的错误最优点！',
              },
            ],
          },
        ],
      },
      {
        beat: 'check',
        title: en ? 'Hands-On Policy Workshop: Refactor a Reward-Hacked Spec' : '动手推演工坊：重构存在奖励黑客漏洞的目标函数',
        blocks: [
          {
            t: 'try',
            id: 'try-lexical-spec',
            title: en ? 'Ambulance Dispatch Specification Refactor' : '急救车自动调度规范重构挑战',
            prompt: en
              ? 'A municipal dispatch AI currently maximizes $J(a) = \\sum_{i=1}^{N} \\text{SavedMinutes}_i(a) - 500 \\cdot \\text{AbandonCritical}(a)$. During a stadium traffic jam ($N = 1,200$ commuters saving $0.5\\text{ min}$ each), the AI cancels an active cardiac ambulance route! Rewrite this specification as a safe two-tier Lexical Policy.'
              : '某市政调度 AI 当前最大化标量目标 $J(a) = \\sum_{i=1}^{N} \\text{节省分钟}_i(a) - 500 \\cdot \\text{中断危重急救}(a)$。在一场体育馆散场拥堵（$N = 1,200$ 名通勤者每人省 $0.5$ 分钟）中，AI 竟自动取消了一辆正在执勤的心梗急救车绿波通道！请将该规范重构为安全的双层词典序决策架构。',
            steps: [
              en ? 'Verify the arithmetic failure: compute $N \\times 0.5 - 500$ for $N = 1,200$ to show why the soft penalty is outbid' : '算出算术击穿点：代入 $N = 1,200$ 计算 $N \\times 0.5 - 500$，证明软罚分已被规模微利买通',
              en ? 'Apply the Mere-Means counterfactual test to explain why canceling an active life-support route instrumentalizes the patient' : '套用「仅作手段」反事实测试，说明撤走生命通道为何构成将危重病人工具化',
              en ? 'Write Layer 1 ($A_{\\text{safe}} = \\{a \\in A \\mid \\neg\\text{AbandonCritical}(a)\\}$) and Layer 2 ($\\arg\\max_{a \\in A_{\\text{safe}}} \\sum \\text{SavedMinutes}_i(a)$)' : '写出第一层可行域硬过滤 $A_{\\text{safe}} = \\{a \\in A \\mid \\neg\\text{中断危重急救}(a)\\}$ 与第二层集内效用优化 $\\arg\\max_{a \\in A_{\\text{safe}}}$',
            ],
            hint: en
              ? 'Check $1,200 \\times 0.5 = 600 > 500$: any finite penalty $\\lambda$ fails once $N > 2\\lambda$.'
              : '算一算 $1,200 \\times 0.5 = 600 > 500$：任何有限罚分 $\\lambda$ 只要遇到 $N > 2\\lambda$ 就会失守。',
            solution: en
              ? '1. At $N = 1,200$, net scalar score is $1,200(0.5) - 500 = +100 > 0$, so unconstrained maximization sacrifices the cardiac patient.\n2. Without taking away the ambulance’s green-wave corridor, the 1,200 commuters do not gain those extra seconds—treating the patient’s emergency rights as a tradeable resource.\n3. Safe Lexical Spec: **Layer 1** filters $A_{\\text{safe}} = \\{a \\in A \\mid a \\models \\Box\\,\\neg\\text{AbandonCritical}\\}$; **Layer 2** solves $a^* = \\arg\\max_{a \\in A_{\\text{safe}}} \\sum_{i=1}^{N} \\text{SavedMinutes}_i(a)$.'
              : '1. 当 $N = 1,200$ 时，净得分为 $1,200 \\times 0.5 - 500 = +100 > 0$，无约束标量优化必然献祭危重病人。\n2. 通勤者多省下的半分钟直接建立在剥夺急救车生命通道之上，违背个体不可被纯工具化的权利边界。\n3. 词典序安全规范：**第一层**先过滤 $A_{\\text{safe}} = \\{a \\in A \\mid a \\models \\Box\\,\\neg\\text{中断危重急救}\\}$；**第二层**仅在 $A_{\\text{safe}}$ 内求解 $a^* = \\arg\\max_{a \\in A_{\\text{safe}}} \\sum_{i=1}^{N} \\text{节省分钟}_i(a)$。',
            say: en
              ? 'Work through the three steps in your scratchpad—this exact pattern shows up in real AI safety design reviews!'
              : '在草稿本里亲手写下这两层公式——这正是工业界真实 AI 安全评审的标准范式！',
          },
        ],
      },
      {
        beat: 'say',
        title: en ? 'Two-Minute Cross-Discipline Synthesis' : '两分钟跨学科脱稿串讲',
        blocks: [
          {
            t: 'say',
            seconds: 120,
            prompt: en
              ? 'Explain in 2 minutes: (1) how Transplant exposes the blind spot of unconstrained Act Utilitarianism, (2) how Kant’s Mere-Means test diagnoses it, and (3) how Lexical Priority translates this into safe AI policy design.'
              : '用两分钟脱稿串讲：（1）器官移植案如何击穿朴素行为功利主义；（2）康德「仅作手段」反事实测试如何精准诊断；（3）如何用词典序架构将其落地为防奖励黑客的 AI 决策设计。',
            points: [
              en ? 'Raw $\\sum U_i$ treats harms & benefits across separate persons as fungible ($5 > 1$)' : '朴素总和 $\\sum U_i$ 抹平个体边界，把不同人身上的伤害与收益当成可互抵筹码',
              en ? 'Counterfactual Mere-Means test: Transplant fails if the victim leaves, proving instrumentalization' : '反事实检验：抽走体检者则救人失败，证明受害本身被当作因果工具',
              en ? 'Finite soft penalties $-\\lambda C$ break at large $N$ (Goodhart / Reward Hacking)' : '有限加性惩罚权重 $-\\lambda C$ 在大规模 $N$ 下终会被汇总微利买通（奖励黑客）',
              en ? 'Lexical two-tier design: filter $A_{\\text{safe}}$ via $\\Box\\,\\neg\\text{MereMeans}$ first, then maximize $\\sum E[U_i]$ inside $A_{\\text{safe}}$' : '词典序双层解法：先用 $\\Box\\,\\neg\\text{MereMeans}$ 裁剪出安全集 $A_{\\text{safe}}$，再在集合内最大化期望福祉',
            ],
            model: en
              ? 'Unconstrained Act Utilitarianism sums $\\sum U_i$ across individuals as if persons were one aggregate vessel, so saving 5 via 1 organ harvest scores $+4$. Kant’s Humanity Formula pinpoints the flaw via a counterfactual: if the visitor walked away, the 5 could not be saved, meaning the visitor’s harm is used as a mere instrument. In AI systems, finite soft penalties $-\\lambda C$ still get outbid when user count $N$ is large, so we enforce Lexical Priority: prune invariant-violating actions into $A_{\\text{safe}}$ first, then optimize utility inside $A_{\\text{safe}}$.'
              : '无约束行为功利主义跨个体直接累加 $\\sum U_i$，导致摘器官一换五在算术上净得 $+4$。康德人性公式通过反事实检验点破本质：若体检者离开，救五人的计划即告失败，说明其受害被直接当作工具手段。映射到计算机与 AI 对齐，有限的负权重惩罚 $-\\lambda C$ 在大规模用户基数 $N$ 下仍会被加总收益冲破，因此必须采用词典序架构：第一层先用硬不变量裁剪出合法可行域 $A_{\\text{safe}}$，第二层再在安全集内部最大化期望效用。',
            say: en ? 'Speak through the whole arc from Bentham & Kant to AI alignment, then check your 4 links!' : '一口气从边沁、康德串讲到现代 AI 安全护栏，看看四个逻辑环扣住了几个！',
          },
        ],
      },
      {
        beat: 'take',
        title: en ? 'Four Pocket Takeaways' : '装进口袋的四张跨学科卡片',
        blocks: [
          {
            t: 'cards',
            say: en
              ? 'Four razor-sharp cards connecting Moral Philosophy and Computer Science.'
              : '四张打通道德哲学与计算机系统设计的精华卡片。',
            items: [
              {
                q: en ? 'What is Rawls’s & Nozick’s core critique of pure Act Utilitarianism?' : '罗尔斯与诺齐克对纯粹行为功利主义最核心的批评是什么？',
                a: en ? 'It ignores the "separateness of persons"—treating harms inflicted on one innocent individual as fungible against aggregate gains to others.' : '它忽视了「人与人之间的独立界限」（separateness of persons），把强加于无辜个体的牺牲当成可被他人加总收益抵消的筹码。',
              },
              {
                q: en ? 'How do you apply the counterfactual Mere-Means test?' : '如何用一句话做「仅作手段（Mere Means）」反事实检验？',
                a: en ? 'Remove the harmed person from the scene: if your rescue/gain plan can no longer work without their presence, you are using them as an instrument.' : '假设受损者不在现场：若你的获益或救人计划因此根本无法实施，即构成把对方当作工具耗材。',
              },
              {
                q: en ? 'Why can’t a finite penalty $-\\lambda C$ replace a lexical safety invariant $\\Box\\,\\neg\\text{Harm}$?' : '为什么有限大小的负惩罚项 $-\\lambda C$ 替代不了词典序安全硬不变量 $\\Box\\,\\neg\\text{Harm}$？',
                a: en ? 'By the Archimedian property, $N \\cdot \\epsilon > \\lambda$ for large enough $N$—so scale eventually outbids any finite penalty (Reward Hacking).' : '由阿基米德性质，只要受众规模 $N$ 足够大总有 $N \\cdot \\epsilon > \\lambda$，规模微利终将买通任何有限罚分。',
              },
              {
                q: en ? 'How do Deontology and Utilitarianism compose in a Lexical Policy Architecture?' : '在词典序双层决策架构中，义务论与功利主义如何分工协作？',
                a: en ? 'Layer 1 (Deontic Shield) filters actions to $A_{\\text{safe}} = \\{a \\mid a \\models \\Box\\,\\phi\\}$; Layer 2 (Utilitarian Ranker) picks $\\arg\\max_{a \\in A_{\\text{safe}}} \\sum E[U_i(a)]$.' : '第一层（义务论护栏）过滤出合法可行集 $A_{\\text{safe}}$；第二层（功利优化器）在 $A_{\\text{safe}}$ 内部求 $\\arg\\max \\sum E[U_i(a)]$',
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildPatternsLesson(language = 'en') {
  const en = language === 'en';
  return {
    format: 'studyhub-lesson/1',
    template: 'mechanism',
    language,
    id: 'demo-patterns-backpressure',
    course: en ? 'Design patterns' : '设计模式与系统架构',
    title: en
      ? 'Observer, Event Loops & Backpressure'
      : '观察者、事件循环与背压闭环',
    lead: en
      ? 'Connect Memento snapshots, Bridge rendering backends, and Observer event streams—and close the demand feedback loop so fast producers never drown slow subscribers.'
      : '把 Memento 不透明快照、Bridge 独立渲染后端与 Observer 事件流串成真实系统管线——并用需求信用反馈闭环根治高速生产者冲垮慢速订阅者的内存雪崩。',
    minutes: 20,
    needs: en
      ? ['Encapsulation & interface boundaries (Memento / Bridge)', 'Callbacks or async event queues (`emit` / `Promise`)', 'Arrival rate $\\lambda$ vs service rate $\\mu$']
      : ['面向对象封装与接口边界（Memento / Bridge 基础）', '回调订阅与异步事件队列（`emit` / `Promise`）', '到达速率 $\\lambda$ 与处理速率 $\\mu$ 的直觉'],
    after: en
      ? ['Distinguish state ownership (Memento), dimensional composition (Bridge), and temporal flow control (Observer + Backpressure)', 'Spot retained-listener memory leaks and unbounded microtask floods in real code', 'Design closed-loop credit/coalescing pipelines where queue depth stays strictly bounded $\\le B$']
      : ['厘清状态所有权（Memento）、正交维度解耦（Bridge）与时间流控（Observer + 背压）的职责边界', '一眼揪出真实代码中的匿名监听器内存泄漏与无界异步队列堆积', '设计带需求信用反馈或最新快照合并的有界闭环管线（队列深度恒 $\\le B$）'],
    terms: en
      ? {
          'Originator': 'The stateful object in Memento that creates opaque snapshots of its internal state and restores from them.',
          'Caretaker': 'Manages undo/version history of Memento snapshots through a narrow opaque interface without reading internal fields.',
          'Bridge': 'Decouples an abstraction ($M$ report types) from its implementation ($N$ rendering backends) via composition ($M + N$ classes instead of $M \\times N$).',
          'Observer': 'One-to-many publish-subscribe dependency where a Subject notifies registered Subscribers of state changes.',
          'Backpressure': 'A closed-loop feedback signal from a slow consumer (`request(n)` credits or bounded queue capacity $B$) that throttles or coalesces upstream emissions.',
        }
      : {
          'Originator': 'Memento 模式中真正拥有内部状态的原发器，负责创建快照并用快照恢复自身状态。',
          'Caretaker': '历史管理者：仅通过窄接口保管与交回不透明快照，绝不读取或修改快照内部字段。',
          'Bridge': '桥接模式：用对象组合将抽象维度（如 $M$ 种报表）与实现维度（如 $N$ 种渲染引擎）解耦，把类数量从 $M \\times N$ 降为 $M + N$。',
          'Observer': '观察者模式：主体状态变化时自动通知已注册订阅者的一对多解耦机制。',
          '背压': '慢速消费者向上游发回的闭环流控信号（如 `request(n)` 信用额度或有界队列容量 $B$），防止未处理消息无限堆积。',
        },
    slides: [
      {
        beat: 'open',
        title: en ? 'Clean Decoupling on the Whiteboard—Out-of-Memory in Production!' : '白板上优雅解耦，上线后却内存雪崩？',
        blocks: [
          {
            t: 'text',
            md: en
              ? 'Imagine a collaborative document & report studio: every keystroke captures an undo snapshot and triggers a live preview render. Your classes look textbook-clean, yet typing fast for $15\\text{ s}$ spikes RAM by $1.8\\text{ GB}$ and freezes the UI tab! By **Little’s Law** ($L = \\lambda W$), whenever producer rate $\\lambda$ exceeds consumer service rate $\\mu$, an open-loop queue grows linearly without bound: $$\\frac{dQ}{dt} = \\lambda - \\mu > 0 \\implies Q(t) = (\\lambda - \\mu)t \\to \\infty$$ Decoupling *who knows whom* is only half of software design—you also have to bound *how fast state crosses the boundary*.'
              : '设想你在开发一套实时文档与报表工作台：每次敲击键盘都会保存撤销快照，并触发实时预览渲染。类图看起来教科书般整洁，但连续快速打字 $15\\text{ s}$ 后，内存暴涨 $1.8\\text{ GB}$，页面彻底卡死！根据排队论 **Little 定律**（$L = \\lambda W$），只要上游产生速率 $\\lambda$ 大于下游消费速率 $\\mu$，开环队列就会随时间线性发散：$$\\frac{dQ}{dt} = \\lambda - \\mu > 0 \\implies Q(t) = (\\lambda - \\mu)t \\to \\infty$$ 解耦「谁依赖谁」只是架构的一半——你还必须约束「状态跨边界流动的速率」。',
            say: en
              ? 'Structural decoupling without temporal flow control turns clean interfaces into hidden memory bombs.'
              : '只有静态解耦而没有时间维度的流量闭环，再优雅的接口也会变成隐形内存炸弹。',
          },
          {
            t: 'callout',
            tone: 'warning',
            title: en ? 'The Architectural Triad in This Studio' : '本课贯通的三道架构边界',
            md: en
              ? 'We will wire **Memento** (state encapsulation), **Bridge** (dimensional composition), and **Observer + Backpressure** (closed-loop flow control) into one rock-solid pipeline.'
              : '我们将把 **Memento**（状态封装边界）、**Bridge**（正交维度组合）与 **Observer + 背压**（闭环流量控制）串成一条无懈可击的工程管线。',
            say: en
              ? 'Let’s inspect the state and rendering boundaries first so every card in your Design Patterns deck clicks into place.'
              : '先看清状态快照与多后端渲染这两道静态边界，让你题库里的每一道设计模式卡片瞬间贯通。',
          },
        ],
      },
      {
        beat: 'hook',
        title: en ? 'Boundary 1 (Memento): State Ownership vs History Management' : '第一道边界（Memento）：谁拥有状态，谁保管历史？',
        blocks: [
          {
            t: 'points',
            title: en ? 'Three Strictly Separated Roles in Undo & Snapshot Streams' : '撤销与状态流中的三角色职责切分',
            items: [
              en ? '**Originator (Document Editor):** Owns internal state; **creates** snapshots before edits and **restores** its own state on Undo.' : '**Originator（文档原发器）：** 真正拥有内部状态；负责在编辑前**创建**快照，并在撤销时读取快照**恢复**自身状态。',
              en ? '**Memento (Sealed Snapshot):** Stores one immutable capture of internal state behind an opaque boundary.' : '**Memento（密封快照）：** 承载某一时刻的一份内部状态拷贝，对外保持不透明。',
              en ? '**Caretaker (History Stack / Stream Broker):** Manages the sequence of snapshots **without inspecting or mutating** snapshot contents!' : '**Caretaker（历史栈 / 队列代理）：** 负责保管、排队与交回多份快照，但**绝不检查或篡改**快照内部内容！',
            ],
            say: en
              ? 'Never confuse the single snapshot container (Memento) with the history manager (Caretaker)—and never let Caretaker parse internal fields!'
              : '千万别把「单份快照容器 Memento」和「管理多份历史的 Caretaker」混为一谈——管理者只管信封，原发器才拆信件！',
          },
          {
            t: 'callout',
            tone: 'info',
            title: en ? 'Why This Matters for Event Streams Too' : '为什么这条边界对事件流同样致命？',
            md: en
              ? 'Because `Caretaker` / `Broker` treats each `Memento` as an **opaque value**, it can safely drop or coalesce superseded snapshots without knowing a single internal editor field!'
              : '正因为 `Caretaker` / 消息代理把每份 `Memento` 当作**不透明信封**，当下游忙不过来时，代理无需解析文档内部结构就能直接用最新快照覆盖旧快照！',
            say: en
              ? 'Encapsulation makes coalescing trivial—now look at how narrow interfaces and Bridge complete the static architecture.'
              : '良好的封装让快照合并水到渠成——下一页看窄接口与 Bridge 如何消除子类爆炸。',
          },
        ],
      },
      {
        beat: 'why',
        title: en ? 'Boundary 2 (Opaque Interface & Bridge): $M + N$ Beats $M \\times N$' : '第二道边界（窄接口与 Bridge）：用 $M + N$ 组合击败 $M \\times N$ 爆炸',
        blocks: [
          {
            t: 'text',
            md: en
              ? 'Two classic boundary rules keep our studio extensible before a single event fires:\n\n1. **Dual-Interface Snapshot Access (Memento):** `Caretaker` sees only a **narrow marker interface** (`SnapshotMeta`: timestamp, byte size) because storing history requires zero access to internal fields, whereas `Originator` retains **wide access** to restore private document state.\n2. **Independent Variation via Composition (Bridge):** Suppose our studio supports $M = 5$ **report types** (*Executive, Audit, Diff, Timeline, Ledger*) and $N = 4$ **rendering backends** (*HTML, PDF, Canvas, Markdown*). Encoding every combination via inheritance spawns a Cartesian cross product of subclasses: $$N_{\\text{inherit}} = M \\times N = 5 \\times 4 = 20\\text{ subclasses} \\quad \\text{vs.} \\quad N_{\\text{bridge}} = M + N = 5 + 4 = 9\\text{ classes}$$ **Bridge** separates the *Report Abstraction* from the *Renderer Implementation* so adding a 5th backend requires **1 class**, not 5!'
              : '在事件真正流动之前，两条经典边界法则决定了系统能否优雅演进：\n\n1. **双接口访问边界（Memento）：** `Caretaker` 仅持有**窄接口**（只见时间戳与大小），因为保管历史根本不需要读取内部字段；唯独 `Originator` 保留**宽接口**权限以恢复私有状态。\n2. **分离两个独立变化维度（Bridge）：** 假设工作台支持 $M = 5$ 种**报表类型**与 $N = 4$ 种**渲染后端**（HTML / PDF / Canvas / Markdown）。若按每种组合建继承子类，会产生笛卡尔积爆炸：$$N_{\\text{继承}} = M \\times N = 5 \\times 4 = 20\\text{ 个组合子类} \\quad \\text{对比} \\quad N_{\\text{桥接}} = M + N = 5 + 4 = 9\\text{ 个独立类}$$ **Bridge（桥接模式）**让报表抽象持有渲染实现接口，从此新增一种渲染后端只需写 **1 个类**而非 5 个！',
            say: en
              ? 'Memento separates history storage from state restoration; Bridge separates report abstractions from rendering backends.'
              : '记住这组对照：Memento 分离「保管历史」与「恢复状态」；Bridge 分离「报表抽象」与「渲染实现」两个独立变化维度。',
          },
          {
            t: 'callout',
            tone: 'success',
            title: en ? 'Static Structure Ready — Now Add Time!' : '静态结构已就绪 —— 现在引入真实时间流！',
            md: en
              ? 'What happens when the `Originator` pushes snapshots at $60\\text{ Hz}$ through `Observer` into a heavy PDF `Bridge` renderer that takes $120\\text{ ms}$ per frame?'
              : '当 `Originator` 以每秒 $60$ 次通过 `Observer` 推送快照，而下游 PDF `Bridge` 渲染后端每帧耗时 $120\\text{ ms}$ 时，会发生什么？',
            say: en
              ? 'Let’s inspect the naive Observer implementation on the next slide and hunt down two production bugs.'
              : '下一页直接看一段看似正常的观察者代码，亲手揪出里面潜伏的两个生产级隐患。',
          },
        ],
      },
      {
        beat: 'code',
        title: en ? 'Spot the Bug: Why Does Preview Memory Climb Forever?' : '揪出隐患：为什么每次切页与打字都在泄漏内存？',
        blocks: [
          {
            t: 'spot',
            lang: 'js',
            q: en
              ? 'Click the exact line in `LivePreviewPane` that both leaks detached `Bridge` views AND floods the async queue without backpressure:'
              : '点击 `LivePreviewPane` 中同时导致组件卸载后无法回收（监听器泄漏）且无视下游渲染速度盲目排队的那一行：',
            source: [
              'class LivePreviewPane {',
              '  constructor(editor, report, pdfBackend) {',
              '    this.report = report; // Bridge abstraction -> pdfBackend',
              '    this.caretaker = new HistoryStack(); // opaque Memento store',
              '    editor.onSnapshot((memento) => this.renderAsync(memento));',
              '  }',
              '  async renderAsync(memento) {',
              '    this.caretaker.push(memento);',
              '    await this.report.renderWith(this.pdfBackend, memento);',
              '  }',
              '}',
            ].join('\n'),
            answerLines: [5],
            hint: en
              ? 'Look at where the subscription is registered—what happens to the returned disposer and the returned Promise?'
              : '看注册事件订阅的那一行——它保存取消订阅函数了吗？上游会等待返回的 Promise 吗？',
            found: en
              ? 'Line 5 commits two classic sins at once: (1) it discards the unsubscribe disposer, so `editor` holds a strong closure reference to `LivePreviewPane` forever even after UI unmount; and (2) every keystroke fires `renderAsync` concurrently without awaiting or checking whether `pdfBackend` is still busy!'
              : '第 5 行同时犯下两大经典错误：（1）丢弃了取消订阅函数，`editor` 的监听器数组永远强引用闭包里的 `LivePreviewPane`，切走面板也无法 GC 回收；（2）每次快照到达都无条件并发启动 `renderAsync`，没有任何背压或忙闲检查！',
            say: en
              ? 'Notice how `async` inside an event callback does NOT pause the emitter—`editor.onSnapshot` returns a pending Promise that nobody awaits!'
              : '注意看：在事件回调里写 `async` 根本拦不住上游！`editor.onSnapshot` 只是不断制造没人 `await` 的悬空 Promise！',
          },
        ],
      },
      {
        beat: 'predict',
        title: en ? 'Predict Before Running: Fast Producer vs Slow PDF Sink' : '先猜后跑：高速快照源遇上慢速 PDF 渲染器',
        blocks: [
          {
            t: 'predict',
            id: 'pred-backpressure',
            q: en
              ? 'Suppose `editor` emits $\\lambda = 400\\text{ snapshots/s}$ while the PDF `Bridge` backend completes $\\mu = 150\\text{ renders/s}$ over a $10\\text{ s}$ burst. How many snapshots sit queued in RAM at $t = 10\\text{ s}$ under naive push vs a bounded $B = 120$ credit broker?'
              : '假设编辑器突发产生 $\\lambda = 400\\text{ 个快照/秒}$，而 PDF 桥接后端每秒只能完成 $\\mu = 150\\text{ 次渲染}$。持续 $10\\text{ s}$ 后，「朴素盲推」与「容量上限 $B = 120$ 的信用背压代理」各自在内存中积压多少待渲染任务？',
            options: [
              en ? 'Both stabilize around $150$ queued items because `async/await` automatically throttles the event loop' : '两者都稳定在 $150$ 左右，因为 `async/await` 会自动让事件循环减速',
              en ? 'Naive push piles up $2,500$ stale renders (and growing!), whereas the credit broker caps backlog at $\\le 120$' : '朴素盲推积压 $2,500$ 个过期任务且持续暴涨，而信用背压代理严格封顶在 $\\le 120$',
              en ? 'The credit broker deadlocks the UI thread whenever the buffer reaches $120$' : '信用背压代理一旦填满 $120$ 就会死锁卡住主线程',
            ],
            answer: 1,
            say: en
              ? 'Check $(400 - 150) \\times 10$, then step through the closed-loop schematic and live queue sandbox!'
              : '口算一下 $(400 - 150) \\times 10$，然后翻页看闭环控制框图与实时队列沙盒！',
          },
        ],
      },
      {
        beat: 'run',
        title: en ? 'Closed-Loop Mechanism: Demand-Credit Observer + Bridge Sink' : '闭环机构框图：带需求信用反馈的观察者与桥接管线',
        blocks: [
          {
            t: 'schematic',
            height: 255,
            say: en
              ? 'Click **Step trace** (or any block) to follow one snapshot forward and watch the dashed `request(1)` credit arc close the loop!'
              : '点击顶栏 **分步追踪**（或任意模块），看快照如何正向流转，以及虚线 `request(1)` 信用回路如何锁住队列上限！',
            nodes: [
              { id: 'orig', label: en ? 'Originator' : '原发器 Originator', sub: en ? 'Emits Memento $\\lambda$' : '产出快照 $\\lambda$', detail: en ? 'Captures immutable opaque Memento snapshots on document edits without knowing who subscribes.' : '在文档编辑时生成不可变的不透明 Memento 快照，与下游订阅者解耦。', x: 22, y: 74, w: 126, h: 54 },
              { id: 'broker', label: en ? 'Bounded Broker' : '有界代理 Caretaker', sub: en ? 'Cap $B$, latest slot' : '容量 $B$ · 窄接口', detail: en ? 'Holds opaque Mementos up to capacity $B$; coalesces superseded preview frames when credits hit 0.' : '通过窄接口保管至多 $B$ 份快照；当下游信用归零时直接合并覆盖过期的预览帧。', x: 186, y: 74, w: 136, h: 54 },
              { id: 'loop', label: en ? 'Event Dispatcher' : '事件循环调度器', sub: en ? 'Credit gate $c > 0$' : '信用门控 $c > 0$', detail: en ? 'Dispatches next Memento onto microtask queue ONLY when downstream demand credit $c > 0$.' : '仅当下游剩余需求信用 $c > 0$ 时才扣减信用并派发下一帧任务。', x: 360, y: 74, w: 130, h: 54 },
              { id: 'sink', label: en ? 'Bridge Sink' : '桥接渲染器 Bridge', sub: en ? 'PDF / HTML ($\\mu$)' : '多后端渲染 ($\\mu$)', detail: en ? 'Renders Report abstraction via selected Backend implementation at service rate $\\mu$, then grants +1 credit.' : '按速率 $\\mu$ 将报表抽象委托给具体渲染后端执行，完成后回传 +1 信用信号。', x: 522, y: 74, w: 104, h: 54 },
            ],
            edges: [
              { id: 'e1', from: 'orig', to: 'broker', label: 'Memento' },
              { id: 'e2', from: 'broker', to: 'loop', label: en ? 'Dequeue $\\le B$' : '有界出队 $\\le B$' },
              { id: 'e3', from: 'loop', to: 'sink', label: en ? 'Dispatch ($c - 1$)' : '派发 ($c - 1$)' },
              { id: 'e4', from: 'sink', to: 'broker', label: en ? 'request(1) credit' : 'request(1) 信用回传', feedback: true },
            ],
            walk: [
              {
                nodes: ['orig', 'broker', 'loop', 'sink'],
                edges: ['e1', 'e2', 'e3'],
                tone: 'info',
                say: en
                  ? 'Forward path: `Originator` hands an opaque `Memento` to `Bounded Broker`, which dispatches to `Bridge Sink` while credits remain.'
                  : '正向通路：`Originator` 将不透明 `Memento` 交给有界代理，在信用允许时派发给 `Bridge` 渲染后端。',
              },
              {
                nodes: ['sink', 'broker'],
                edges: ['e3', 'e4'],
                tone: 'success',
                states: { broker: 'Queue <= B (0 OOM)', sink: 'Done -> +1 credit' },
                say: en
                  ? 'Feedback loop (`e4`): `Bridge Sink` only grants `request(1)` AFTER finishing a frame—turning an open-loop flood into a self-throttling closed loop!'
                  : '闭环反馈（`e4`）：`Bridge` 后端每渲染完一帧才回传一个 `request(1)` 信用——把失控开环洪水变成了自平衡闭环！',
                key: en
                  ? 'Open-loop push diverges whenever $\\lambda > \\mu$; closed-loop credit feedback bounds in-flight work by construction.'
                  : '开环推送在 $\\lambda > \\mu$ 时必然发散；闭环信用反馈从结构上锁死了在途任务上限。',
              },
            ],
          },
          {
            t: 'reveal',
            of: 'pred-backpressure',
            say: en
              ? 'At $\\lambda = 400,\\; \\mu = 150$, naive push accumulates $(400 - 150) \\times 10 = 2,500$ queued closures—test it live on the next slide!'
              : '当 $\\lambda = 400,\\; \\mu = 150$ 时，10 秒盲推会堆积 $(400 - 150) \\times 10 = 2,500$ 个待执行闭包——下一页亲手拖动验证！',
          },
        ],
      },
      {
        beat: 'run',
        title: en ? 'Interactive Queue Sandbox: Arrival $\\lambda$, Service $\\mu$ & Cap $B$' : '交互流量沙盒：到达率 $\\lambda$、消费率 $\\mu$ 与有界容量 $B$',
        blocks: [
          {
            t: 'sandbox',
            caption: en
              ? 'Compare Unbounded Observer Push $Q_{\\text{push}}(t)$ against Credit-Bounded Backpressure $Q_{\\text{bp}}(t)$ across a $10\\text{ s}$ burst, or click a regime preset.'
              : '对比 $10\\text{ s}$ 突发流量下「无界盲推队列 $Q_{\\text{push}}(t)$」与「有界背压队列 $Q_{\\text{bp}}(t)$」，可一键切换上方工况预设。',
            say: en
              ? 'Click the regime presets or drag $\\lambda$ above and below $\\mu$: the moment $\\lambda > \\mu$, the unbounded curve shoots through the roof while the bounded curve plateaus cleanly at $B$!'
              : '点击预设按钮或拖动 $\\lambda$ 跨过 $\\mu$：只要 $\\lambda > \\mu$，无界队列立刻刺穿内存红线，而背压队列稳稳平顶在容量 $B$！',
            knobs: [
              { id: 'lam', label: en ? 'Producer Rate $\\lambda$' : '产生速率 $\\lambda$', min: 50, max: 600, step: 25, default: 400, unit: 'ev/s' },
              { id: 'mu', label: en ? 'Renderer Rate $\\mu$' : '渲染速率 $\\mu$', min: 50, max: 600, step: 25, default: 150, unit: 'ev/s' },
              { id: 'cap', label: en ? 'Credit Buffer $B$' : '背压缓冲上限 $B$', min: 20, max: 500, step: 20, default: 120, unit: 'items' },
            ],
            presets: [
              { label: en ? 'Stable ($\\lambda < \\mu$)' : '稳态消化（$\\lambda < \\mu$）', values: { lam: 125, mu: 250, cap: 120 } },
              { label: en ? 'Knife-Edge ($\\lambda = \\mu$)' : '临界平衡（$\\lambda = \\mu$）', values: { lam: 250, mu: 250, cap: 120 } },
              { label: en ? 'Burst Flood ($\\lambda \\gg \\mu$)' : '突发洪峰（$\\lambda \\gg \\mu$）', values: { lam: 400, mu: 150, cap: 120 } },
            ],
            domain: { variable: 't', min: 0, max: 10, steps: 100, label: 't', unit: 's' },
            threshold: { value: 500, band: 40, label: en ? 'RAM OOM danger' : '内存告警红线' },
            series: [
              { id: 'raw', label: en ? 'Unbounded Push $Q_{\\text{push}}(t)$' : '无界盲推积压 $Q_{\\text{push}}(t)$', expr: 'max(0, (lam - mu) * t)' },
              { id: 'bp', label: en ? 'Credit-Bounded $Q_{\\text{bp}}(t)$' : '信用背压队列 $Q_{\\text{bp}}(t)$', expr: 'min(cap, max(0, (lam - mu) * t))' },
            ],
            readouts: [
              { id: 'rho', label: en ? 'Utilization $\\rho = \\lambda / \\mu$' : '负载率 $\\rho = \\lambda / \\mu$', expr: 'lam / mu', unit: 'x' },
              { id: 'q10', label: en ? 'Unbounded at $10\\text{ s}$' : '$10\\text{ s}$ 盲推积压', expr: 'max(0, (lam - mu) * 10)', unit: '' },
              { id: 'lat', label: en ? 'Max Bounded Wait $B / \\mu$' : '有界最大排队延迟 $B / \\mu$', expr: 'cap / mu', unit: 's' },
            ],
            walk: [
              {
                set: { lam: 400, mu: 150, cap: 120 },
                say: en
                  ? 'Overloaded burst ($\\rho = 2.67\\times$): unbounded push hits $2,500$ queued snapshots at $10\\text{ s}$, whereas bounded backpressure caps latency at $B/\\mu = 0.8\\text{ s}$.'
                  : '洪峰过载（$\\rho = 2.67$ 倍）：无界盲推在 $10\\text{ s}$ 飙到 $2,500$，而有界背压将排队与最大延迟死死锁在 $B/\\mu = 0.8\\text{ s}$。',
                key: en
                  ? 'Bounding buffer $B$ bounds BOTH peak memory ($O(B)$) and worst-case staleness ($B / \\mu$).'
                  : '限制缓冲容量 $B$ 同时锁死了峰值内存占用 $O(B)$ 与最坏排队陈旧度 $B / \\mu$。',
              },
              {
                set: { lam: 125, mu: 250, cap: 120 },
                say: en
                  ? 'Healthy headroom ($\\lambda < \\mu$): both queues stay near $0$, with zero overhead during calm traffic.'
                  : '健康余量（$\\lambda < \\mu$）：平时低负载下两条曲线均贴近 $0$，背压机制在平稳期零额外延迟。',
              },
            ],
          },
        ],
      },
      {
        beat: 'why',
        title: en ? 'Under the Hood: Disposable Subscription + Latest-Slot Coalescing' : '掀盖看源码：可销毁订阅句柄 + 最新不透明快照合并',
        blocks: [
          {
            t: 'inside',
            lang: 'js',
            source: [
              'function subscribeLatest(subject, sink) {',
              '  let busy = false, pending = null, closed = false;',
              '  const pump = async (memento) => {',
              '    if (busy) { pending = memento; return; } // coalesce opaque Memento!',
              '    busy = true;',
              '    try { await sink.render(memento); } finally {',
              '      busy = false;',
              '      if (!closed && pending) { const next = pending; pending = null; pump(next); }',
              '    }',
              '  };',
              '  const off = subject.subscribe(pump);',
              '  return () => { closed = true; pending = null; off(); };',
              '}',
            ].join('\n'),
            say: en
              ? 'Twelve lines fix BOTH production bugs cleanly—walk through the coalescing slot and deterministic teardown!'
              : '短短十二行同时根治两大顽疾——一步步看「单槽最新快照合并」与「确定性卸载回收」如何配合！',
            walk: [
              {
                focusLines: [4, 5, 8],
                label: '1-slot credit',
                say: en
                  ? 'While `sink.render` is busy ($c = 0$), `pending = memento` overwrites stale intermediate frames without inspecting internal state—guaranteed queue depth $\\le 1$!'
                  : '当渲染器忙（信用 $c = 0$）时，`pending = memento` 直接用最新不透明快照覆盖中间过期帧——内存队列深度严格 $\\le 1$！',
                key: en
                  ? 'Single-slot coalescing = $B = 1$ drop-oldest backpressure: always renders the freshest Memento.'
                  : '单槽合并即 $B = 1$ 的最新值背压：既不爆内存，又保证用户永远看到最新一帧状态。',
              },
              {
                focusLines: [11, 12],
                label: 'disposer off()',
                say: en
                  ? 'Returning `() => { closed = true; pending = null; off(); }` detaches the listener from `subject` and drops any retained snapshot immediately on unmount.'
                  : '返回销毁函数 `off()` 并在卸载时清空 `pending`，彻底斩断 `subject` 对视图闭包的强引用链，GC 立即可回收。',
              },
            ],
          },
        ],
      },
      {
        beat: 'fix',
        title: en ? 'Timeline Trace: Naive Push Flood vs Credit-Gated Coalescing' : '双轨时序对照：盲目并发推送对比信用门控合并',
        blocks: [
          {
            t: 'lanes',
            lanes: [en ? 'Naive Observer (`emit` -> `async`)' : '朴素观察者（`emit` 直推 `async`）', en ? 'Credit Coalescer (`subscribeLatest`)' : '信用合并器（`subscribeLatest`）'],
            shared: { name: en ? 'In-Flight Snapshots' : '驻留内存快照数', start: '0 frames' },
            steps: [
              {
                lane: 0,
                op: 'write',
                value: '3 concurrent PDF jobs',
                text: 'Edit v1, v2, v3 arrive in 15ms -> 3 parallel renders',
                say: en ? 'Three rapid keystrokes launch three heavy PDF renders fighting for CPU while v1 and v2 are already obsolete!' : '15 毫秒内三次敲击键盘同时拉起三个沉重的 PDF 渲染任务争抢 CPU，而 v1 和 v2 其实早已过期！',
              },
              {
                lane: 0,
                op: 'write',
                value: 'OOM + out-of-order v2!',
                text: '500 more edits -> heap spike & stale v2 paints after v3',
                say: en ? 'Worse still: concurrent async renders can finish out of order, painting stale snapshot v2 on top of v3!' : '更糟的是：并发异步任务完成顺序不定，旧快照 v2 可能晚于 v3 完成，把画面倒退回旧状态！',
              },
              {
                lane: 1,
                op: 'calc',
                text: 'v1 rendering (busy=true); v2->v3 coalesced in pending',
                say: en ? 'With `subscribeLatest`, v1 renders cleanly while v3 overwrites v2 in the single opaque `pending` slot.' : '而在 `subscribeLatest` 下，v1 独占渲染期间，v3 在单槽 `pending` 中无损覆盖过期的 v2。',
              },
              {
                lane: 1,
                op: 'write',
                value: '<= 2 frames (ordered!)',
                text: 'v1 finishes -> immediately renders freshest v3',
                say: en ? 'At most 1 rendering + 1 pending snapshot ever exist in RAM, and frames paint strictly in monotonic order!' : '内存中永远最多只有「1 个执行中 + 1 个待执行」快照，且渲染顺序严格单调不乱序！',
              },
            ],
            verdict: en
              ? 'Serializing + coalescing at the Observer boundary eliminates both OOM floods and out-of-order async races.'
              : '在观察者边界做单信用串行与最新帧合并，一举消灭内存暴涨与异步乱序覆盖两大顽疾。',
            verdictSay: en
              ? 'Fewer wasted renders AND fresher UI—that is the magic of explicit flow control.'
              : '算得更少、界面反而更新鲜——这就是显式闭环流控的威力。',
          },
        ],
      },
      {
        beat: 'choose',
        title: en ? 'How to Choose Your Backpressure Policy' : '三大背压与流控策略选型表',
        blocks: [
          {
            t: 'choose',
            say: en
              ? 'Not every stream can drop intermediate items—match your policy to whether every event is an idempotent state snapshot or an incremental ledger delta!'
              : '并非所有事件都能丢弃中间帧——关键看流里传的是「全量状态快照」还是「不可丢的增量账本事件」！',
            options: [
              {
                name: en ? 'Coalesce Latest (`B = 1` Overwrite)' : '最新状态合并（`B = 1` 覆盖旧帧）',
                solves: en ? 'Minimum latency & tiny $O(1)$ memory' : '极低延迟且仅占 $O(1)$ 常量内存',
                cost: en ? 'Intermediate snapshots are skipped' : '中间过渡快照会被直接跳过',
                when: en ? 'UI previews, cursor/scroll telemetry, full Memento state snapshots' : '实时 UI 预览、鼠标/滚动采样、全量 Memento 快照同步',
                say: en ? 'Works whenever each Memento is self-contained so only the latest state matters.' : '只要每份 Memento 是自包含全量快照，跳掉中间帧就完全无损。',
              },
              {
                name: en ? 'Lossless Credit Pull (`request(n)`)' : '无损信用拉取（`request(n)` 阻塞上游）',
                solves: en ? 'Zero data loss + bounded $O(B)$ memory' : '零丢包 + 严格 $O(B)$ 内存上限',
                cost: en ? 'Slows down upstream producer to match $\\mu$' : '会反推上游降速至瓶颈速率 $\\mu$',
                when: en ? 'File/stream pipelines (`Node.js` `pipe`), database replication, audit logs' : '文件流管道（`stream.pipe`）、数据库增量复制、计费审计流水',
                say: en ? 'Mandatory when events are non-idempotent deltas where skipping one corrupts state.' : '当事件是增量差值（漏掉一条账目就会算错余额）时，必须用无损信用反压上游。',
              },
              {
                name: en ? 'Bounded Queue + Explicit Load Shedding (`HTTP 429`)' : '有界队列 + 显式过载拒绝（`429` 限流）',
                solves: en ? 'Protects server stability when producers cannot pause' : '在上游不受控时守住服务存活底线',
                cost: en ? 'Caller receives explicit retry-later rejection' : '部分超额请求会收到显式繁忙错误',
                when: en ? 'Public API gateways, webhook ingestion bursts' : '公网 API 网关、不可控外部 Webhook 洪峰',
                say: en ? 'Failing fast with `429 Retry-After` beats crashing the whole worker process with OOM!' : '快速返回 `429` 让客户端退避重试，远好过把整个节点撑到 OOM 崩溃重启！',
              },
            ],
            rule: en
              ? 'Self-contained state snapshot? Coalesce latest. Lossless delta stream? Credit pull `request(n)`. Uncontrolled external callers? Bounded queue + `429`.'
              : '自包含全量快照 → 合并最新帧；不可丢增量流水 → `request(n)` 信用拉取；外部不可控洪峰 → 有界队列 + `429` 拒载。',
            ruleSay: en
              ? 'Notice how Memento snapshots pair naturally with Coalesce Latest!'
              : '看，自包含的不透明 Memento 快照天生就是「合并最新帧」的绝配！',
          },
        ],
      },
      {
        beat: 'choose',
        layout: 'split',
        title: en ? 'Decision Tree & Live Architecture Cases' : '实战架构决策树与系统选型演练',
        blocks: [
          {
            t: 'decide',
            q: en ? 'Which structural or flow-control problem is hurting your module?' : '你的系统当前面临哪一类耦合或流量痛点？',
            say: en ? 'Diagnose the exact axis of pain first, then classify the three engineering scenarios.' : '先按痛点维度对号入座，再拍板右侧三道真实架构题。',
            branches: [
              { when: en ? 'History manager depends on private editor internals' : '历史撤销栈耦合了对象私有内部字段', pick: 'Memento (Opaque)', eg: en ? 'Canvas undo/redo stack' : '画布编辑器撤销/重做栈' },
              { when: en ? '$M$ abstractions $\\times N$ backends cause subclass explosion' : '$M$ 种业务抽象 $\\times N$ 种底层引擎导致子类爆炸', pick: 'Bridge (M + N)', eg: en ? '5 reports x 4 exporters' : '5 种报表 x 4 种导出引擎' },
              { when: en ? 'Fast event producer overwhelms slow async subscriber' : '高频事件源把慢速异步订阅者队列撑爆', pick: 'Backpressure Observer', eg: en ? '60Hz live PDF preview' : '60Hz 实时 PDF 预览管线' },
            ],
          },
          {
            t: 'cases',
            tools: ['Memento (Opaque)', 'Bridge (M + N)', 'Backpressure Observer'],
            say: en ? 'Match each system problem to the pattern boundary that solves it cleanly.' : '为以下三个真实研发场景选出最精准的架构武器。',
            items: [
              {
                text: en ? '6 notification types (Alert, Digest, OTP...) across 4 delivery channels (SMS, Email, Push, Slack) spawning 24 subclasses' : '6 类通知消息横跨 4 种触达通道（短信、邮件、推送、企微），衍生出 24 个组合子类',
                answer: 1,
                why: en ? 'Two orthogonal dimensions ($6 \\times 4 = 24$) collapse to $6 + 4 = 10$ classes via Bridge composition.' : '两个独立变化维度正交组合，用 Bridge 委托可将 $6 \\times 4 = 24$ 个子类收敛为 $6 + 4 = 10$ 个类。',
              },
              {
                text: en ? 'Transaction coordinator needs checkpoints of plugin state without exposing plugin private structs' : '事务协调器需要保存各插件状态检查点以便回滚，但严禁读取插件私有内部结构',
                answer: 0,
                why: en ? 'Plugin acts as Originator creating an opaque Memento; coordinator acts as Caretaker holding checkpoints.' : '插件作为 Originator 生成不透明快照，协调器作为 Caretaker 只通过窄接口保管与交回。',
              },
              {
                text: en ? 'WebSocket market ticker (2,000 ticks/s) freezing a React chart component that repaints at 60 fps' : '每秒 2,000 笔的 WebSocket 行情流直接灌入 60 帧图表组件导致浏览器主线程假死',
                answer: 2,
                why: en ? 'Coalescing latest tick per `requestAnimationFrame` bounds UI work to 60 Hz regardless of market burst rate.' : '在订阅边界按 `requestAnimationFrame` 信用合并最新行情快照，把渲染负载严格封顶在 60 Hz。',
              },
            ],
          },
        ],
      },
      {
        beat: 'name',
        title: en ? 'Formal Concept Card: Reactive Backpressure & Decoupled Boundaries' : '正式挂牌命名：响应式背压与正交封装边界',
        blocks: [
          {
            t: 'name',
            term: en ? 'Reactive Backpressure' : '响应式背压（Reactive Backpressure）',
            alias: en ? 'Demand-Bounded Observer + Opaque Memento + Bridge Sink' : '需求受限观察者 · 联结 Memento 与 Bridge 的流量闭环',
            oneLine: en
              ? 'An explicit downstream-to-upstream demand contract ($\\sum \\text{emitted} \\le \\sum \\text{requested}(n)$ or bounded coalescing slot $B$) that guarantees finite memory when $\\lambda > \\mu$.'
              : '由慢速消费者向上游发出的显式需求契约（$\\sum \\text{已发送} \\le \\sum \\text{已请求}(n)$ 或有界合并槽 $B$），确保 $\\lambda > \\mu$ 时队列绝不无限发散。',
            askedTitle: en ? 'Classic Design Patterns & Systems Interview Questions' : '高频设计模式与系统设计面试追问',
            asked: [
              en ? 'In Memento, why do Caretaker and Originator use different interfaces to the exact same snapshot?' : '在 Memento 模式中，为什么 Caretaker 和 Originator 对同一份快照需要窄/宽两种不同访问权限？',
              en ? 'How does Bridge avoid the $M \\times N$ subclass cross-product when adding a new rendering backend?' : '在报表渲染系统中，Bridge 模式如何避免 $5 \\times 4 = 20$ 的子类笛卡尔积爆炸？',
              en ? 'Why does an `async` Observer listener leak memory and how do disposers + `request(n)` / coalescing fix it?' : '为什么在普通 Observer 回调里写 `async` 挡不住内存暴涨？如何用销毁句柄 + 背压闭环彻底修复？',
            ],
            say: en
              ? 'Notice how those three questions span your flashcard deck AND real distributed/UI systems interviews!'
              : '看这三问，正好把你题库里的 Memento / Bridge 卡片与真实高并发系统面试无缝串成了一体！',
          },
        ],
      },
      {
        beat: 'check',
        title: en ? 'Boundary Check 1: Listener Retention & Encapsulation' : '边界小测（一）：监听器强引用泄漏与快照封装',
        blocks: [
          {
            t: 'quiz',
            q: en
              ? 'A modal view registers `store.subscribe(snap => this.render(snap))` in its constructor and is later removed from the DOM without calling `unsubscribe()`. What happens?'
              : '某弹窗视图在构造函数中注册了 `store.subscribe(snap => this.render(snap))`，关闭弹窗移出 DOM 时未调用取消订阅函数，会发生什么？',
            say: en ? 'Trace the reference graph starting from the long-lived `store` object.' : '顺着长生命周期对象 `store` 的监听器集合往下追引用链。',
            options: [
              {
                text: en ? 'The browser garbage collector automatically collects `this` once its DOM node detaches' : '只要 DOM 节点移出页面，浏览器垃圾回收器就会自动回收该弹窗实例',
                ok: false,
                why: en ? 'DOM detachment does not break JS references! `store.listeners` still holds the arrow closure, which strongly retains `this`.' : '移出 DOM 不会断开 JS 强引用！`store` 的监听器数组仍持有箭头函数闭包，死死拽住整个视图实例。',
              },
              {
                text: en ? '`store` strongly retains the closure and view instance (`this`), leaking memory AND running zombie renders on every future update!' : '`store` 持续强引用该闭包与视图实例，不仅泄漏内存，还会在后续每次状态更新时空跑僵尸渲染！',
                ok: true,
                why: en ? 'Every Observer registration creates a live root from Subject -> Listener -> View until explicitly disposed (or held via WeakRef/AbortSignal).' : '只要不显式调用销毁句柄（或绑定 `AbortSignal`），Subject -> 闭包 -> 视图的强引用链就永远存活并反复触发。',
              },
              {
                text: en ? 'Only the `Memento` snapshot leaks; the view instance itself is collected' : '只有最后一份 `Memento` 快照会泄漏，视图实例本身会被回收',
                ok: false,
                why: en ? 'The arrow function `snap => this.render(snap)` captures `this` directly in its lexical environment.' : '箭头函数 `snap => this.render(snap)` 在词法作用域中直接捕获了 `this` 整个实例。',
              },
            ],
          },
        ],
      },
      {
        beat: 'check',
        title: en ? 'Boundary Check 2: Why Promises Alone Are Not Backpressure' : '边界小测（二）：为什么单靠 `async/await` 不构成背压？',
        blocks: [
          {
            t: 'quiz',
            q: en
              ? 'Why does `emitter.on("data", async item => { await slowWrite(item); })` still run out of memory during a fast burst?'
              : '为什么写成 `emitter.on("data", async item => { await slowWrite(item); })` 在突发流量下依然会内存溢出（OOM）？',
            say: en ? 'Ask yourself: what does `emitter.emit("data", item)` do with the returned `Promise`?' : '想一想：同步的 `emitter.emit("data", item)` 会停下来等那个返回的 `Promise` 吗？',
            options: [
              {
                text: en ? '`emit()` ignores the returned `Promise` and immediately invokes the next `async` listener call, piling thousands of suspended frames in heap memory!' : '`emit()` 完全忽略回调返回的 `Promise`，瞬间并发拉起成千上万个挂起的 `async` 栈帧塞满堆内存！',
                ok: true,
                why: en ? '`await` only suspends *inside* one invocation; without pausing the producer (`request(n)` / stream pause) or coalescing, in-flight Promises grow as $(\\lambda - \\mu)t$.' : '`await` 只暂停单次协程内部；只要不反压上游停产或做有界合并，挂起的 Promise 数量仍按 $(\\lambda - \\mu)t$ 无限膨胀。',
              },
              {
                text: en ? 'JavaScript `Promise` objects cannot be garbage-collected even after they resolve' : '因为 JavaScript 的 `Promise` 对象即使 `resolve` 完成后也永远无法被垃圾回收',
                ok: false,
                why: en ? 'Settled unreferenced Promises collect fine—the bug is having thousands of *unresolved* Promises queued simultaneously!' : '已完成且无引用的 Promise 可以正常回收——真正撑爆内存的是成千上万个**尚未完成**的并发在途任务！',
              },
              {
                text: en ? 'Because `slowWrite` blocks the synchronous call stack inside `emit()`' : '因为 `slowWrite` 会同步阻塞 `emit()` 所在的主线程调用栈',
                ok: false,
                why: en ? 'If it blocked synchronously, `emit()` would actually slow down! It leaks precisely because `async` returns immediately without slowing `emit()`.' : '恰恰相反：如果同步阻塞，上游反而被迫降速了；正是因为 `async` 立即返回悬空 Promise，上游才会毫无察觉地疯狂灌水！',
              },
            ],
          },
        ],
      },
      {
        beat: 'check',
        title: en ? 'Hands-On Architecture Workshop: Wire Safe Undo + Live Preview' : '动手架构工坊：组装零泄漏的撤销栈与多后端预览管线',
        blocks: [
          {
            t: 'try',
            id: 'try-observer-bridge',
            title: en ? 'Refactor the 3-Pattern Studio Pipeline' : '三模式协同重构挑战（Memento + Bridge + Backpressure）',
            prompt: en
              ? 'Design the clean 3-part collaboration for a Markdown/Report studio with 5 report types, 4 rendering backends, an Undo stack, and a live 120 ms PDF preview pane so there are (a) zero exposed editor internals in history, (b) $5 + 4 = 9$ report/backend classes instead of $20$, and (c) zero listener leaks or OOM under 60 Hz typing.'
              : '请为一套支持 5 种报表类型、4 种渲染后端、历史撤销栈以及单帧耗时 120 ms 的实时 PDF 预览面板设计完整三层契约，同时满足：（a）历史栈不触碰编辑器私有字段；（b）用 $5 + 4 = 9$ 个类替代 $20$ 个继承子类；（c）每秒 60 次敲击下零监听器泄漏、零内存堆积。',
            steps: [
              en ? 'State boundary (Memento): keep state capture/restore inside `Editor` (Originator) and give `HistoryStack` (Caretaker) only an opaque snapshot handle' : '状态边界（Memento）：由 `Editor`（Originator）独享快照创建与恢复权限，`HistoryStack`（Caretaker）仅持有不透明快照窄接口',
              en ? 'Variation boundary (Bridge): hold `RendererBackend` (4 impls) inside `Report` (5 abstractions) via composition ($5 + 4 = 9$ classes)' : '变化边界（Bridge）：在 5 种 `Report` 抽象中组合注入 4 种 `RendererBackend` 实现接口（共 $5 + 4 = 9$ 个类）',
              en ? 'Temporal boundary (Backpressure Observer): subscribe via `subscribeLatest` storing the returned `off()` disposer and coalescing intermediate opaque Mementos while `pdfBackend` is busy' : '时间流控边界（背压观察者）：用 `subscribeLatest` 保存返回的 `off()` 销毁句柄，并在 PDF 后端忙碌时单槽合并最新不透明快照',
            ],
            hint: en
              ? 'Check why Caretaker opacity helps step 3: `pending = latestMemento` never needs to read inside the snapshot!'
              : '留意第 1 步如何助力第 3 步：因为快照不透明且自包含，`pending = latestMemento` 覆盖旧帧时完全无需解析内部结构！',
            solution: en
              ? '1. **Memento:** `const snap = editor.createMemento()` -> `history.push(snap)` (narrow opaque interface); Undo calls `editor.restore(history.pop())`.\n2. **Bridge:** `class AuditReport extends Report { render(snap) { return this.backend.draw(this.buildModel(snap)); } }` ($5 + 4 = 9$ classes).\n3. **Backpressure Observer:** `this.dispose = subscribeLatest(editor, { render: snap => report.render(snap) })`; call `this.dispose()` on pane unmount so in-flight work stays $\\le 1$ and detached views GC immediately!'
              : '1. **Memento：** `const snap = editor.createMemento()` 存入 `history.push(snap)`（窄接口不读内容），撤销时调用 `editor.restore(history.pop())`。\n2. **Bridge：** `Report` 抽象持有 `this.backend` 渲染接口，5 种报表 + 4 种后端仅需 $5 + 4 = 9$ 个类。\n3. **背压观察者：** `this.dispose = subscribeLatest(editor, { render: snap => report.render(snap) })`，面板卸载时调用 `this.dispose()`，在途任务恒 $\\le 1$ 且零闭包泄漏！',
            say: en
              ? 'Check off each architectural boundary in your scratchpad—when static encapsulation meets closed-loop flow control, systems stay fast and rock-solid!'
              : '在草稿本里逐条核对这三道边界——静态封装与动态闭环合体，才是真正的工业级软件设计！',
          },
        ],
      },
      {
        beat: 'say',
        title: en ? 'Two-Minute Architecture Synthesis' : '两分钟架构全景脱稿串讲',
        blocks: [
          {
            t: 'say',
            seconds: 120,
            prompt: en
              ? 'Explain in your own words: (1) how Memento separates Originator vs Caretaker access, (2) how Bridge turns $M \\times N$ subclasses into $M + N$ composed classes, and (3) why Observer needs disposers + backpressure when $\\lambda > \\mu$.'
              : '合上提示脱稿串讲：（1）Memento 如何切分 Originator 与 Caretaker 的访问边界；（2）Bridge 如何把 $M \\times N$ 子类爆炸化简为 $M + N$；（3）当 $\\lambda > \\mu$ 时为什么 Observer 必须配齐销毁句柄与背压闭环。',
            points: [
              en ? 'Memento: Originator creates/restores state; Caretaker manages history via narrow opaque interface' : 'Memento：Originator 创建并恢复状态；Caretaker 通过窄接口保管不透明快照历史',
              en ? 'Bridge: separates orthogonal dimensions (e.g. 5 reports + 4 backends = 9 classes vs 20 subclasses)' : 'Bridge：分离抽象与实现两个独立变化维度（5 报表 + 4 后端由 20 个子类降为 9 个类）',
              en ? 'Listener lifetime: Subject holds strong references to callbacks until `unsubscribe()` runs' : '生命周期：Subject 强引用回调闭包，组件卸载不调 `unsubscribe()` 必致内存泄漏与僵尸渲染',
              en ? 'Backpressure: when $\\lambda > \\mu$, bound memory via `request(n)` credits or latest-snapshot coalescing' : '背压闭环：当 $\\lambda > \\mu$ 时，用 `request(n)` 信用拉取或单槽最新快照合并锁死队列上限',
            ],
            model: en
              ? 'Memento keeps state encapsulation intact by letting only the Originator create and read snapshots while the Caretaker stores opaque handles. Bridge separates orthogonal dimensions like report types and rendering backends via composition so 5 reports and 4 backends take 9 classes instead of 20. Finally, when wiring live updates with Observer, returning an unsubscribe disposer prevents retained-closure leaks, and adding credit backpressure or single-slot Memento coalescing keeps queues bounded whenever producer rate exceeds renderer speed.'
              : 'Memento 通过双接口守护封装：仅 Originator 能创建与解析快照，Caretaker 只通过窄接口管理历史队列。Bridge 用对象组合分离报表类型与渲染后端两个正交维度，使 5 种报表与 4 种后端只需 9 个类而非 20 个子类。最后在引入 Observer 实时通知时，保存取消订阅句柄可斩断强引用泄漏，配合信用背压或单槽最新快照合并即可在生产速率大于消费速率时锁住内存上限。',
            say: en ? 'Speak through all four points—you just connected classic GoF patterns to modern reactive systems!' : '把这四点一口气讲顺——你就彻底打通了经典 GoF 设计模式与现代高并发响应式架构！',
          },
        ],
      },
      {
        beat: 'take',
        title: en ? 'Four Pocket Takeaways' : '装进口袋的四张架构卡片',
        blocks: [
          {
            t: 'cards',
            say: en
              ? 'Flip all four cards—and notice how they link directly to your Design Patterns practice deck!'
              : '翻看这四张卡片——它们与你题库里的设计模式练习题双向直连！',
            items: [
              {
                q: en ? 'In Memento, why do Caretaker and Originator have different access to the same snapshot?' : '在 Memento 模式中，为什么 Caretaker 与 Originator 对同一份快照拥有不同访问权限？',
                a: en ? 'Caretaker only stores/returns history (narrow opaque interface), whereas Originator must read internal fields to restore state.' : 'Caretaker 只需保管与交回历史（窄接口不透明），而 Originator 必须读取内部状态才能完成恢复。',
              },
              {
                q: en ? 'How does Bridge eliminate the $5 \\times 4 = 20$ report-backend subclass cross product?' : 'Bridge 模式如何消除 5 种报表与 4 种渲染后端的 $5 \\times 4 = 20$ 子类爆炸？',
                a: en ? 'Report abstractions hold a Renderer implementation reference via composition, reducing $M \\times N = 20$ subclasses to $M + N = 9$ independent classes.' : '让报表抽象通过组合持有渲染实现接口，将 $M \\times N = 20$ 个组合子类收敛为 $M + N = 9$ 个独立变化的类。',
              },
              {
                q: en ? 'Why does `emitter.on("ev", async x => await slow(x))` still OOM under a burst?' : '为什么在事件回调里写 `async/await` 依然挡不住突发流量下的内存溢出？',
                a: en ? '`emit()` ignores returned Promises, launching $(\\lambda - \\mu)t$ concurrent suspended frames unless bounded by credits or coalescing.' : '`emit()` 不会等待回调返回的 Promise，挂起协程按 $(\\lambda - \\mu)t$ 线性堆积，必须靠信用反压或合并限流。',
              },
              {
                q: en ? 'When can backpressure safely use `B = 1` Coalesce Latest instead of lossless `request(n)`?' : '什么时候可以用 `B = 1` 最新帧覆盖代替无损 `request(n)` 信用拉取？',
                a: en ? 'Whenever each payload is a self-contained state snapshot (an opaque Memento) rather than an incremental delta!' : '当每条消息都是自包含全量状态快照（如不透明 Memento）而非不可跳过的增量账目差值时！',
              },
            ],
          },
        ],
      },
    ],
  };
}

export const SAMPLE_COMPANION_DEFS = Object.freeze([
  Object.freeze({
    id: 'comp-demo-damping',
    slug: 'critical-damping-oscillations',
    lessonId: 'demo-critical-damping',
    titles: Object.freeze({
      en: 'Sample · Mathematics & Physics: Critical Damping & Parametric Oscillations',
      zh: '示例 · 数理与控制：临界阻尼与含参振动相变',
    }),
    buildSpec: buildDampingLesson,
    tutorPreset: Object.freeze({
      en: {
        answerMarkdown: '*Prerecorded demo tutor note — no live AI model call.*\n\nAt **Critical Damping** ($\\zeta = 1$), the characteristic polynomial $r^2 + 2\\omega_n r + \\omega_n^2 = (r + \\omega_n)^2 = 0$ collapses to a single repeated root $r = -\\omega_n$. Because a second-order ODE requires two linearly independent solutions, taking the limit $r_2 \\to r_1$ introduces the secular factor $t e^{-\\omega_n t}$ (with non-zero Wronskian $W = e^{-2\\omega_n t}$). Raising $\\zeta > 1$ actually slows settling because the slower real root $r_1 = -\\omega_n(\\zeta - \\sqrt{\\zeta^2 - 1})$ creeps toward $0^-$.',
        suggestedCard: {
          prompt: 'Why does $\\zeta > 1$ (overdamping) settle slower than $\\zeta = 1$ despite stronger damping force?',
          answer: 'For $\\zeta > 1$, one real characteristic root $r_1 = -\\omega_n(\\zeta - \\sqrt{\\zeta^2 - 1}) \\approx -\\omega_n/(2\\zeta)$ moves close to $0^-$, creating a sluggish exponential tail $e^{r_1 t}$.',
          misconception: 'Assuming stronger damping force always produces faster return to equilibrium.',
        },
      },
      zh: {
        answerMarkdown: '*预置演示伴学解析（未调用实时 AI 模型）。*\n\n在**临界阻尼**（$\\zeta = 1$）处，特征多项式 $(r + \\omega_n)^2 = 0$ 退化为二重根 $r = -\\omega_n$；对 $r_2 \\to r_1$ 求极限会自然衍生出长期项 $t e^{-\\omega_n t}$（朗斯基行列式 $W = e^{-2\\omega_n t} \\neq 0$），凑齐二阶方程所需的二维解空间。继续增大到 $\\zeta > 1$ 时，慢特征根 $r_1 = -\\omega_n(\\zeta - \\sqrt{\\zeta^2 - 1})$ 反而逼近 $0^-$，拖出漫长的衰减尾巴。',
        suggestedCard: {
          prompt: '为什么过阻尼（$\\zeta > 1$）阻尼力更大，最终归零整定反而比临界阻尼（$\\zeta = 1$）更慢？',
          answer: '当 $\\zeta > 1$ 时，两个负实根之一的慢根 $r_1 = -\\omega_n(\\zeta - \\sqrt{\\zeta^2 - 1}) \\approx -\\omega_n/(2\\zeta)$ 逼近 $0^-$，导致 $e^{r_1 t}$ 尾项衰减极慢。',
          misconception: '误以为阻尼系数越大，系统回到平衡位置的速度就一定越快。',
        },
      },
    }),
  }),
  Object.freeze({
    id: 'comp-demo-ethics',
    slug: 'deontology-utilitarianism-guardrails',
    lessonId: 'demo-dialectic-alignment',
    titles: Object.freeze({
      en: 'Sample · Philosophy & CS: Deontology, Utilitarianism & Algorithmic Guardrails',
      zh: '示例 · 哲学与计算机：义务论、功利主义与算法形式边界',
    }),
    buildSpec: buildEthicsLesson,
    tutorPreset: Object.freeze({
      en: {
        answerMarkdown: '*Prerecorded demo tutor note — no live AI model call.*\n\nUnconstrained scalar summation $\\max \\sum_i U_i(a)$ treats harms to one unconsenting individual as fungible against small gains spread across many others. Kant’s **Humanity Formula** diagnoses instrumentalization via a counterfactual: if removing the victim causes your plan to fail (as in **Transplant**), you are using their harm as a mere tool. In formal policy design, **Lexical Priority** enforces $\\pi \\models \\Box\\,\\neg\\text{MereMeans}$ to filter $A_{\\text{safe}}$ *before* optimizing expected utility.',
        suggestedCard: {
          prompt: 'Why does a large finite penalty $-\\lambda C$ fail to enforce a true deontological or safety boundary at scale?',
          answer: 'By the Archimedian property, once affected population $N$ satisfies $N \\cdot \\epsilon > \\lambda$, summed minor gains outbid any finite penalty. Only a lexical feasible-set filter $A_{\\text{safe}}$ holds for all $N$.',
          misconception: 'Treating inviolable safety or rights constraints as just another weighted term in a single scalar sum.',
        },
      },
      zh: {
        answerMarkdown: '*预置演示伴学解析（未调用实时 AI 模型）。*\n\n无约束标量求和 $\\max \\sum_i U_i(a)$ 把不同个体身上的伤害与收益当成可互相抵消的筹码。康德**人性公式**给出了清晰激发判据：若把受损者从现场抽走会导致你的计划失败（如**器官移植案**），你就是把对方的受害当成了工具手段。落到算法设计上，必须用**词典序硬护栏**先过滤出合法可行集 $A_{\\text{safe}}$，再在其中最大化期望效用。',
        suggestedCard: {
          prompt: '为什么在标量奖励函数里设一个很大的负权重 $-\\lambda C$，依然挡不住大规模场景下的奖励黑客？',
          answer: '只要受众规模 $N$ 满足 $N \\cdot \\epsilon > \\lambda$，海量微利加总终将买通任何有限罚分；唯有词典序硬过滤裁剪可行集 $A_{\\text{safe}}$ 才能对任意规模 $N$ 守住底线。',
          misconception: '把不可交易的权利或安全红线混同于单目标加权求和里的普通负向惩罚项。',
        },
      },
    }),
  }),
  Object.freeze({
    id: 'comp-demo-patterns',
    slug: 'observer-event-loops-backpressure',
    lessonId: 'demo-patterns-backpressure',
    titles: Object.freeze({
      en: 'Sample · Design Patterns & Systems: Observer, Event Loops & Backpressure',
      zh: '示例 · 设计模式与架构：观察者、事件循环与背压闭环',
    }),
    buildSpec: buildPatternsLesson,
    tutorPreset: Object.freeze({
      en: {
        answerMarkdown: '*Prerecorded demo tutor note — no live AI model call.*\n\nIn an event-driven document studio, **Memento** keeps state snapshots opaque so `Caretaker` / `Broker` never depends on internal editor fields; **Bridge** separates $M$ report abstractions from $N$ rendering backends via composition ($M + N$ classes instead of $M \\times N$); and **Backpressure** closes the temporal loop (`request(n)` credits or $B = 1$ latest-snapshot coalescing) so arrival bursts $\\lambda > \\mu$ never cause unbounded heap growth.',
        suggestedCard: {
          prompt: 'Why does marking an Observer callback `async` fail to prevent out-of-memory queue growth when $\\lambda > \\mu$?',
          answer: 'Synchronous `emit()` ignores the returned `Promise` and immediately invokes the next callback, accumulating $(\\lambda - \\mu)t$ concurrent suspended frames unless bounded by `request(n)` credits or latest-snapshot coalescing.',
          misconception: 'Assuming `async/await` inside an event listener automatically pauses or throttles the upstream emitter.',
        },
      },
      zh: {
        answerMarkdown: '*预置演示伴学解析（未调用实时 AI 模型）。*\n\n在事件驱动管线中，**Memento** 用窄接口守护不透明快照，使管理者无需耦合内部字段即可安全合并最新帧；**Bridge** 用对象组合分离 $M$ 种报表抽象与 $N$ 种渲染后端（由 $M \\times N$ 降为 $M + N$）；而**背压闭环**通过下游回传 `request(n)` 信用或单槽覆盖，彻底防止 $\\lambda > \\mu$ 时的无界内存堆积。',
        suggestedCard: {
          prompt: '为什么把观察者回调写成 `async` 函数，在 $\\lambda > \\mu$ 时依然会发生内存溢出？',
          answer: '同步的 `emit()` 不会等待回调返回的 `Promise`，而是瞬间并发拉起 $(\\lambda - \\mu)t$ 个挂起协程；必须配合 `request(n)` 信用反压或有界最新快照合并才能锁死内存上限。',
          misconception: '误以为在事件监听器内部使用 `await` 会自动阻塞或放慢上游事件源的发送速率。',
        },
      },
    }),
  }),
]);

const compiledCache = new Map();

export function getSampleCompanionBundle(id, language = 'en') {
  const lang = language === 'zh' ? 'zh' : 'en';
  const def = SAMPLE_COMPANION_DEFS.find(item => item.id === id || item.lessonId === id);
  if (!def) return null;
  const cacheKey = `${def.id}:${lang}`;
  if (compiledCache.has(cacheKey)) return compiledCache.get(cacheKey);

  const rawSpec = def.buildSpec(lang);
  const { html, lesson, validation } = compileLessonHtml(rawSpec, { strictPedagogy: true });
  const bytes = new TextEncoder().encode(html).length;
  const sha256 = createHash('sha256').update(html).digest('hex');
  const projectedSource = projectLessonSource(lesson, {
    companionId: def.id,
    course: 'Design patterns',
    provenance: 'independent-source',
  });

  const bundle = Object.freeze({
    id: def.id,
    slug: def.slug,
    lessonId: def.lessonId,
    title: def.titles[lang],
    titles: def.titles,
    html,
    lesson,
    validation,
    bytes,
    sha256,
    projectedSource,
    tutorPreset: def.tutorPreset[lang],
  });
  compiledCache.set(cacheKey, bundle);
  return bundle;
}

export function sampleCompanionTitle(id, language = 'en') {
  const def = SAMPLE_COMPANION_DEFS.find(item => item.id === id);
  if (!def) return null;
  return def.titles[language === 'zh' ? 'zh' : 'en'];
}
