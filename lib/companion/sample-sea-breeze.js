import { compileLessonHtml } from '../companion-template/render-html.js';

export const SEA_BREEZE_SAMPLE_ID = 'sample-geography-sea-breeze';

function seaBreezeLessonZh() {
  return {
    format: 'studyhub-lesson/1',
    id: SEA_BREEZE_SAMPLE_ID,
    title: '地理 · 海陆风热力环流',
    course: '自然地理',
    lead: '为什么白天的海风总从大海吹向沙滩，深夜却反过来从陆地吹向海洋？把比热容、等压面凹凸与闭合环流拆成可动手调参的 7 页舞台。',
    language: 'zh',
    template: 'interactive',
    minutes: 8,
    needs: ['气压与空气热胀冷缩的直觉', '水平气压梯度力由高压指向低压'],
    after: ['用比热容差推导出昼夜海陆温差与近地面气压反转', '画出白天与夜晚海陆上空等压面的「高凸低凹」形态', '独立判断任意时刻海滨近地面与高空的风向闭合链'],
    terms: {
      '比热容': '单位质量物质升高 1 ℃ 所需吸收的热量。海水比热容约 4.2×10³ J/(kg·K)，远大于砂石陆地（约 0.8×10³ J/(kg·K)），所以白天陆地升温快、夜晚降温也快。',
      '热力环流': '因地表冷热不均引起空气垂直升降，进而在同一水平面产生气压差，驱动空气水平流动形成的闭合环流。',
      '等压面': '空间中气压相等的点连成的曲面。气压越高处等压面向上凸起，气压越低处向下凹陷（「高凸低凹」）。',
      '海风': '白天陆地升温更快形成近地面热低压，空气从较冷的海洋高压吹向陆地低压的近地面风。',
      '陆风': '夜晚陆地散热更快形成近地面冷高压，空气从陆地高压吹向较暖海洋低压的近地面风。',
    },
    beats: [
      { id: 'open', label: '核心悬念' },
      { id: 'predict', label: '先猜一猜' },
      { id: 'run', label: '昼夜沙盒' },
      { id: 'why', label: '闭合环流' },
      { id: 'check', label: '边界小测' },
      { id: 'say', label: '开口讲透' },
      { id: 'take', label: '带走卡片' },
    ],
    slides: [
      {
        beat: 'open',
        layout: 'hook',
        title: '同样晒着太阳，为什么白天吹海风、深夜吹陆风？',
        blocks: [
          {
            t: 'text',
            md: '正午站在海滩上，清凉的风迎面从海面吹来；等到凌晨两三点，风向却悄悄掉头，从身后陆地吹向海面。海陆风不是潮汐，也不是地球自转直接推出来的——它的总开关只有一件事：**海和陆地的比热容差了大约 5 倍**。',
          },
          {
            t: 'callout',
            tone: 'info',
            title: '免配置示例预览',
            md: '这是一节内置的只读互动伴学样课：你可以任意拖动滑块、点步进框图和做自测题，所有操作都在内存中完成，**不会写入或改动你的学习库**。',
          },
        ],
      },
      {
        beat: 'predict',
        title: '第一步：先猜白天正午时，哪边近地面气压更低？',
        blocks: [
          {
            t: 'points',
            items: [
              '海水比热容 $c_{\\text{海}} \\approx 4.2 \\times 10^3\\ \\text{J/(kg}\\cdot\\text{K)}$，砂石陆地 $c_{\\text{陆}} \\approx 0.8 \\times 10^3\\ \\text{J/(kg}\\cdot\\text{K)}$。',
              '吸收相同太阳辐射时，由 $\\Delta T = \\frac{Q}{c m}$ 可知，**陆地升温速度远快于海洋**。',
              '受热空气膨胀变轻并向上运动，导致近地面空气柱质量减少。',
            ],
          },
          {
            t: 'predict',
            id: 'daytime-pressure',
            q: '晴朗正午，陆地明显比海洋更热。此时「近地面」和「高空」的气压高低分别是？',
            options: [
              '陆地近地面高压、陆地高空低压，风从陆地吹向海洋',
              '陆地近地面低压、陆地高空高压，近地面风从海洋吹向陆地',
              '陆地近地面与高空都是高压，所以海面空气被推走',
            ],
            answer: 1,
            why: '受热上升抽空了陆地近地面（低压），却把大量空气堆到陆地高空（高压）；于是近地面风从相对冷的海洋高压吹向陆地低压，形成海风。',
          },
        ],
      },
      {
        beat: 'run',
        title: '动手调昼夜时钟：看温度、气压差与风向如何翻转',
        blocks: [
          {
            t: 'sandbox',
            title: '海陆昼夜温差与近地面气压差沙盒',
            caption: '拖动时刻 h（0–24 时）与比热容倍率 k，观察陆地温度 T_land(x)、海洋温度 T_sea(x) 及温差曲线；当陆地温度高于海洋（正午）吹海风，低于海洋（深夜）吹陆风。',
            xLabel: '一天中的时刻（小时）',
            yLabel: '温度 / 温差（℃）',
            xMin: 0,
            xMax: 24,
            yMin: -10,
            yMax: 36,
            knobs: [
              { id: 'amp', label: '日照强度（温差振幅）', min: 2, max: 12, step: 1, value: 8, unit: '℃' },
              { id: 'ratio', label: '海陆比热容倍率', min: 2, max: 6, step: 0.5, value: 4.5, unit: '×' },
            ],
            series: [
              { id: 'land', label: '陆地温度 T_陆(h)', expr: '20 - amp * cos((x - 2) * pi / 12)', color: 'accent' },
              { id: 'sea', label: '海洋温度 T_海(h)', expr: '20 - (amp / ratio) * cos((x - 4) * pi / 12)', color: 'info' },
              { id: 'diff', label: '海陆温差 ΔT = T_陆 - T_海（>0 海风，<0 陆风）', expr: '(20 - amp * cos((x - 2) * pi / 12)) - (20 - (amp / ratio) * cos((x - 4) * pi / 12))', color: 'ok' },
            ],
            threshold: { value: 0, label: '风向翻转线 ΔT = 0（上方海风 · 下方陆风）' },
            presets: [
              { label: '晴朗强日照（海陆风显著）', values: { amp: 10, ratio: 5 } },
              { label: '阴天弱日照（风力减弱）', values: { amp: 3, ratio: 4.5 } },
              { label: '高比热对比（典型海滨）', values: { amp: 8, ratio: 6 } },
            ],
          },
          {
            t: 'reveal',
            of: 'daytime-pressure',
            verdict: '沙盒里的绿色温差曲线在 08:00–19:00 位于零线之上（陆热海冷 → 陆地近地面低压 → 吹海风），在深夜跌破零线（陆冷海热 → 陆地近地面高压 → 吹陆风）。',
          },
        ],
      },
      {
        beat: 'why',
        title: '掀盖看闭合链路：等压面「高凸低凹」与四步环流',
        blocks: [
          {
            t: 'schematic',
            title: '白天海风热力环流四节点框图',
            nodes: [
              { id: 'land-low', label: '陆地近地面（热 · 低压）', detail: '受热膨胀上升，等压面向下凹陷' },
              { id: 'land-high', label: '陆地高空（聚积 · 高压）', detail: '上升气流在约 1–2 km 高空聚集，等压面向上凸起' },
              { id: 'sea-high', label: '海洋高空（辐散 · 低压）', detail: '高空气流自陆地高空流向海洋高空并下沉' },
              { id: 'sea-low', label: '海洋近地面（冷 · 高压）', detail: '下沉气流堆积形成高压，等压面向上凸起' },
            ],
            edges: [
              { from: 'land-low', to: 'land-high', label: '① 受热上升' },
              { from: 'land-high', to: 'sea-high', label: '② 高空陆→海' },
              { from: 'sea-high', to: 'sea-low', label: '③ 冷却下沉' },
              { from: 'sea-low', to: 'land-low', label: '④ 近地面海风' },
            ],
            walk: [
              { focus: ['land-low', 'land-high'], say: '① 白天陆地升温更快，近地面空气膨胀上升，陆地近地面形成热低压（等压面下凹），陆地高空因空气堆积形成高压（等压面上凸）。' },
              { focus: ['land-high', 'sea-high'], say: '② 同一高空水平面上，陆地高空压强大于海洋高空，高空风由陆地上空吹向海洋上空。' },
              { focus: ['sea-high', 'sea-low'], say: '③ 海洋表层相对凉爽且高空不断来流，空气在海面上空冷却下沉，使海洋近地面空气增厚形成冷高压（等压面上凸）。' },
              { focus: ['sea-low', 'land-low'], say: '④ 近地面空气由海洋高压水平流向陆地低压——这就是你在沙滩上感受到的清凉「海风」；到了夜晚冷热对调，整个四步环流精确反转。' },
            ],
          },
        ],
      },
      {
        beat: 'check',
        title: '边界小测：检验高空与近地面气压反转',
        blocks: [
          {
            t: 'quiz',
            q: '晴朗无背景大风的凌晨 3 点，海滨观测到近地面吹陆风。此时关于陆地与海洋上空等压面形态，哪项正确？',
            options: [
              { text: '陆地近地面等压面上凸，陆地高空等压面下凹', ok: true, why: '正确！深夜陆地散热更快成为冷高压（近地面等压面上凸），对应高空成为低压（等压面下凹），高低空气压性质相反。' },
              { text: '陆地近地面与高空等压面同时上凸', ok: false, why: '同一垂直气柱上，近地面与高空的相对气压性质必然相反，否则无法形成闭合环流。' },
              { text: '海洋近地面等压面上凸，近地面风从海洋吹向陆地', ok: false, why: '这是白天海风的状态；凌晨陆地比海洋更冷，高压在陆地一侧。' },
            ],
          },
          {
            t: 'quiz',
            q: '为什么把「风从哪里吹来」当口诀，就能避免把海风和陆风背反？',
            options: [
              { text: '风名按「来向」命名：海风是从海洋吹向陆地的风，说明海洋近地面是高压', ok: true, why: '正确！气象上以风的来向命名，且水平气压梯度力总从高压指向低压，因此「吹海风 = 海高压陆低压 = 白天」。' },
              { text: '风名按「去向」命名：海风是吹向海洋的风', ok: false, why: '刚好相反——气象学中风向永远指「风吹来的方向」。' },
              { text: '海风只发生在高空，与近地面气压无关', ok: false, why: '海陆风指的是近地面风向，高空则是相反方向的补偿回流。' },
            ],
          },
        ],
      },
      {
        beat: 'say',
        title: '开口讲透：用 4 句话讲清夜晚为何切换成陆风',
        blocks: [
          {
            t: 'say',
            prompt: '假设同伴只记得「白天海风、夜晚陆风」但总背反原因，请用 4 步因果链把夜晚切换成陆风的机制讲清楚。',
            points: [
              '指出比热容差异导致夜晚陆地降温更快（陆冷海暖）',
              '说明陆地近地面冷却下沉形成高压，海洋受热上升形成低压',
              '点出水平气压梯度力由高压指向低压，故近地面空气由陆地流向海洋（陆风）',
              '补充高空反向回流完成闭合环流，且等压面遵循「高凸低凹」',
            ],
            model: '夜晚没有日照后，陆地比热容远小于海水，散热更快，很快变得比海洋冷。冷空气在陆地一侧收缩下沉，在近地面堆积成冷高压（等压面上凸）；较暖的海面空气相对上升，近地面形成低压（等压面下凹）。近地面空气按气压梯度从陆地高压吹向海洋低压，就是陆风；同时高空由海洋上空流回陆地上空，闭合整个热力环流。',
          },
        ],
      },
      {
        beat: 'take',
        title: '带走这 3 张因果卡，再也不会背反海陆风',
        blocks: [
          {
            t: 'cards',
            items: [
              { q: '驱动海陆风昼夜反转的根本物理原因是什么？', a: '海陆比热容差异（海水约 4.2×10³ vs 陆地约 0.8×10³ J/(kg·K)）：白天陆热海冷，夜晚陆冷海热。' },
              { q: '如何从「热胀冷缩」一步推出近地面与高空等压面凹凸？', a: '受热区空气上升 → 近地面低压（等压面下凹）、高空高压（等压面上凸）；冷却区相反。记忆口诀：「高凸低凹，上下相反」。' },
              { q: '为什么白天吹海风、夜晚吹陆风？', a: '风以「来向」命名且从高压吹向低压。白天海冷高压→陆热低压（海风）；夜晚陆冷高压→海暖低压（陆风）。' },
            ],
          },
        ],
      },
    ],
  };
}

function seaBreezeLessonEn() {
  return {
    format: 'studyhub-lesson/1',
    id: SEA_BREEZE_SAMPLE_ID,
    title: 'Geography · Sea & Land Breeze Thermal Circulation',
    course: 'Physical Geography',
    lead: 'Why does a coastal breeze blow onshore from the sea at noon and reverse offshore from the land at night? Explore specific heat capacity, isobaric tilt, and closed thermal circulation in 7 interactive slides.',
    language: 'en',
    template: 'interactive',
    minutes: 8,
    needs: ['Warm air expands and rises; cool air contracts and sinks', 'Pressure gradient force pushes air from high pressure to low pressure'],
    after: ['Derive day/night coastal temperature contrast from specific heat capacity', 'Sketch convex-high / concave-low isobaric surfaces aloft and near the surface', 'Predict both surface wind and upper-level return flow at any hour'],
    terms: {
      'Specific heat capacity': 'Heat required to raise 1 kg of a substance by 1 K. Seawater (~4.2×10³ J/(kg·K)) is ~5× higher than dry soil/rock (~0.8×10³ J/(kg·K)), so land heats faster by day and cools faster at night.',
      'Thermal circulation': 'A closed loop of rising warm air, upper-level horizontal flow, sinking cool air, and surface return flow driven by uneven surface heating.',
      'Isobaric surface': 'A surface of equal atmospheric pressure. It bulges upward over high pressure and dips downward over low pressure.',
      'Sea breeze': 'Daytime onshore surface wind blowing from cooler, higher-pressure sea toward warmer, lower-pressure land.',
      'Land breeze': 'Nighttime offshore surface wind blowing from cooler, higher-pressure land toward warmer, lower-pressure sea.',
    },
    beats: [
      { id: 'open', label: 'Core Puzzle' },
      { id: 'predict', label: 'Predict' },
      { id: 'run', label: 'Day/Night Sandbox' },
      { id: 'why', label: 'Closed Loop' },
      { id: 'check', label: 'Quick Check' },
      { id: 'say', label: 'Say It Aloud' },
      { id: 'take', label: 'Takeaways' },
    ],
    slides: [
      {
        beat: 'open',
        layout: 'hook',
        title: 'Under the same sky, why does wind blow onshore at noon and offshore at 3 AM?',
        blocks: [
          {
            t: 'text',
            md: 'At midday on the beach, cool air blows in from the ocean; late at night, the breeze reverses and blows out from the shore. The switch is not tides or Coriolis alone — it is a **~5× difference in specific heat capacity** between water and land.',
          },
          {
            t: 'callout',
            tone: 'info',
            title: 'Zero-config sample preview',
            md: 'This is a built-in read-only interactive companion preview. Drag sliders, step through the circulation diagram, and test yourself freely — **nothing is written to your study library**.',
          },
        ],
      },
      {
        beat: 'predict',
        title: 'Step 1: At sunny noon, where is surface pressure lower?',
        blocks: [
          {
            t: 'points',
            items: [
              'Seawater specific heat $c_{\\text{sea}} \\approx 4.2 \\times 10^3\\ \\text{J/(kg}\\cdot\\text{K)}$ vs. land $c_{\\text{land}} \\approx 0.8 \\times 10^3\\ \\text{J/(kg}\\cdot\\text{K)}$.',
              'Under equal solar input, $\\Delta T = \\frac{Q}{c m}$ means **land warms much faster than the sea**.',
              'Warm air expands and rises, removing mass from the surface column and piling it up aloft.',
            ],
          },
          {
            t: 'predict',
            id: 'daytime-pressure-en',
            q: 'At sunny noon when land is much warmer than the sea, what is the pressure pattern over land?',
            options: [
              'High pressure at the land surface and low pressure aloft, pushing air out to sea',
              'Low pressure at the land surface and high pressure aloft, pulling a sea breeze onshore',
              'High pressure at both surface and upper air over land',
            ],
            answer: 1,
            why: 'Rising warm air lowers surface pressure over land while building high pressure aloft, so cooler surface air flows onshore from sea to land.',
          },
        ],
      },
      {
        beat: 'run',
        title: 'Tune the diurnal cycle: watch temperature contrast flip the breeze',
        blocks: [
          {
            t: 'sandbox',
            title: 'Coastal Day/Night Temperature & Wind-Flip Sandbox',
            caption: 'Adjust solar heating amplitude and heat-capacity ratio to inspect T_land(h), T_sea(h), and ΔT = T_land - T_sea (positive = sea breeze, negative = land breeze).',
            xLabel: 'Hour of day (h)',
            yLabel: 'Temperature / ΔT (°C)',
            xMin: 0,
            xMax: 24,
            yMin: -10,
            yMax: 36,
            knobs: [
              { id: 'amp', label: 'Solar heating amplitude', min: 2, max: 12, step: 1, value: 8, unit: '°C' },
              { id: 'ratio', label: 'Sea/land heat-capacity ratio', min: 2, max: 6, step: 0.5, value: 4.5, unit: '×' },
            ],
            series: [
              { id: 'land', label: 'Land temp T_land(h)', expr: '20 - amp * cos((x - 2) * pi / 12)', color: 'accent' },
              { id: 'sea', label: 'Sea temp T_sea(h)', expr: '20 - (amp / ratio) * cos((x - 4) * pi / 12)', color: 'info' },
              { id: 'diff', label: 'Contrast ΔT = T_land - T_sea (>0 sea breeze, <0 land breeze)', expr: '(20 - amp * cos((x - 2) * pi / 12)) - (20 - (amp / ratio) * cos((x - 4) * pi / 12))', color: 'ok' },
            ],
            threshold: { value: 0, label: 'Reversal line ΔT = 0 (above: sea breeze · below: land breeze)' },
            presets: [
              { label: 'Clear sunny day (strong breeze)', values: { amp: 10, ratio: 5 } },
              { label: 'Overcast day (weak breeze)', values: { amp: 3, ratio: 4.5 } },
              { label: 'High heat-capacity contrast', values: { amp: 8, ratio: 6 } },
            ],
          },
          {
            t: 'reveal',
            of: 'daytime-pressure-en',
            verdict: 'The green ΔT curve stays above zero from ~08:00 to ~19:00 (warm land → surface low → sea breeze) and drops below zero overnight (cool land → surface high → land breeze).',
          },
        ],
      },
      {
        beat: 'why',
        title: 'Under the hood: 4-step closed thermal circulation',
        blocks: [
          {
            t: 'schematic',
            title: 'Daytime Sea Breeze Circulation Loop',
            nodes: [
              { id: 'land-low', label: 'Land Surface (Warm · Low P)', detail: 'Air warms and rises; isobaric surface dips downward' },
              { id: 'land-high', label: 'Land Aloft (Piled · High P)', detail: 'Rising air accumulates aloft; isobaric surface bulges upward' },
              { id: 'sea-high', label: 'Sea Aloft (Diverging · Low P)', detail: 'Upper air flows from land aloft to sea aloft and subsides' },
              { id: 'sea-low', label: 'Sea Surface (Cool · High P)', detail: 'Sinking air builds surface high; isobaric surface bulges upward' },
            ],
            edges: [
              { from: 'land-low', to: 'land-high', label: '1. Warm air rises' },
              { from: 'land-high', to: 'sea-high', label: '2. Upper return flow' },
              { from: 'sea-high', to: 'sea-low', label: '3. Cool air sinks' },
              { from: 'sea-low', to: 'land-low', label: '4. Surface sea breeze' },
            ],
            walk: [
              { focus: ['land-low', 'land-high'], say: '1. Daytime land heats faster, so air rises, leaving a surface thermal low (concave isobar) and creating an upper-level high (convex isobar).' },
              { focus: ['land-high', 'sea-high'], say: '2. Aloft, air flows horizontally from the higher pressure over land toward lower pressure over the sea.' },
              { focus: ['sea-high', 'sea-low'], say: '3. Over the cooler sea, converging upper air sinks and builds a surface high pressure (convex isobar).' },
              { focus: ['sea-low', 'land-low'], say: '4. Near the ground, air moves from sea high to land low — the onshore sea breeze. At night the entire loop reverses.' },
            ],
          },
        ],
      },
      {
        beat: 'check',
        title: 'Quick check: pressure & isobaric surface reversal',
        blocks: [
          {
            t: 'quiz',
            q: 'At 3 AM on a calm, clear night with an offshore land breeze, how do the isobaric surfaces bend over land?',
            options: [
              { text: 'Convex upward near the land surface and concave downward aloft', ok: true, why: 'Correct! Rapid nighttime cooling creates a surface high over land (upward bulge) and a corresponding upper-level low (downward dip).' },
              { text: 'Convex upward at both surface and upper air over land', ok: false, why: 'Surface and upper-air pressure anomalies in a thermal column have opposite signs.' },
              { text: 'Convex upward near the sea surface, driving an onshore breeze', ok: false, why: 'That describes the daytime sea breeze rather than a 3 AM land breeze.' },
            ],
          },
          {
            t: 'quiz',
            q: 'Why does remembering wind naming convention prevent mixing up sea and land breezes?',
            options: [
              { text: 'Winds are named by origin: a sea breeze comes FROM the sea (high P) toward land (low P)', ok: true, why: 'Correct! Because wind always flows from high to low pressure, origin naming immediately tells you which side is cooler and higher pressure.' },
              { text: 'Winds are named by destination: a sea breeze blows toward the sea', ok: false, why: 'Meteorological wind names always denote where the wind blows FROM.' },
              { text: 'Sea breezes occur only aloft and never near the surface', ok: false, why: 'Sea and land breezes refer to the near-surface branch of the circulation.' },
            ],
          },
        ],
      },
      {
        beat: 'say',
        title: 'Say it aloud: explain the nighttime flip in 4 causal steps',
        blocks: [
          {
            t: 'say',
            prompt: 'Explain to a classmate in 4 causal steps why a daytime sea breeze flips into a nighttime land breeze.',
            points: [
              'Land has much lower specific heat capacity than seawater, so it cools faster after sunset',
              'Cool air sinks over land (surface high) while warmer sea air rises (surface low)',
              'Pressure gradient force drives near-surface air from land high to sea low (land breeze)',
              'Upper-level return flow from sea aloft to land aloft closes the loop with opposite isobaric tilt',
            ],
            model: 'After sunset, land cools far faster than the ocean because of its much smaller specific heat capacity. Cooling air contracts and sinks over land to build a surface high (convex isobar), while warmer air over the sea rises to form a surface low (concave isobar). Surface air therefore flows offshore from land to sea as a land breeze, while an upper-level return flow completes the closed thermal circulation.',
          },
        ],
      },
      {
        beat: 'take',
        title: '3 takeaway cards to lock in thermal circulation',
        blocks: [
          {
            t: 'cards',
            items: [
              { q: 'What physical property drives the day/night sea-land breeze reversal?', a: 'Specific heat capacity contrast: seawater (~4.2×10³) is ~5× higher than land (~0.8×10³ J/(kg·K)), making land warmer by day and cooler by night.' },
              { q: 'How do isobaric surfaces bend in a thermal circulation?', a: 'Upward (convex) over high pressure and downward (concave) over low pressure, with opposite anomalies at the surface vs. aloft.' },
              { q: 'How can you reconstruct daytime vs. nighttime wind direction without rote memorization?', a: 'Wind is named by origin and blows from high (cool) to low (warm): daytime cool sea → warm land (sea breeze); nighttime cool land → warm sea (land breeze).' },
            ],
          },
        ],
      },
    ],
  };
}

const previewCache = new Map();

/**
 * Compile and cache the built-in zero-config, zero-token Geography Sea & Land Breeze sample preview.
 * Pure read-only in-memory payload: never writes files or mutates library state.
 */
export function buildSeaBreezePreview({ language = 'zh' } = {}) {
  const lang = language === 'en' ? 'en' : 'zh';
  if (previewCache.has(lang)) return previewCache.get(lang);
  const rawLesson = lang === 'en' ? seaBreezeLessonEn() : seaBreezeLessonZh();
  const compiled = compileLessonHtml(rawLesson, { strictPedagogy: false });
  const lesson = compiled.lesson;
  const payload = Object.freeze({
    preview: true,
    companion: Object.freeze({
      id: SEA_BREEZE_SAMPLE_ID,
      lessonId: SEA_BREEZE_SAMPLE_ID,
      title: lesson.title,
      course: lesson.course,
      mode: 'preview',
      slideCount: lesson.slides.length,
      grounded: true,
      sample: true,
    }),
    html: compiled.html,
    file: null,
    changedOnDisk: false,
    lesson: Object.freeze({
      id: lesson.id,
      title: lesson.title,
      lead: lesson.lead,
      language: lesson.language,
      template: lesson.template || 'interactive',
      slideCount: lesson.slides.length,
      slides: lesson.slides.map(sl => ({
        title: String(sl?.title || '').slice(0, 200),
        beat: String(sl?.beat || '').slice(0, 60),
      })),
      needs: lesson.needs || [],
      after: lesson.after || [],
      terms: lesson.terms || {},
    }),
    savedState: { memory: {}, checkResults: {} },
    relatedCards: [],
  });
  previewCache.set(lang, payload);
  return payload;
}
