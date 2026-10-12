/* The text of the review-book fixtures (tests/helpers/book-fixtures.mjs): sixteen knowledge points of a solution-architecture course ("ArchSS"), four
   chapters of two sections of two points. Chinese notes in the shape the program writes them (考情, 知识梳理, 讲解 with 角标, 例子, 补充（资料以外）, 出处).
   Only words; nothing here touches a library. */

/** [chapter title, [section title, [point...]]]; a point: { id, title, term, defines, why, how, mistake, check, example, link, extra, quote } */
export const CHAPTERS = [
  ['课程导入与架构基础', [
    ['架构师的工作', [
      { id: 'what', title: 'What architects do', term: '架构师的工作', defines: '把业务目标翻译成一组可以落地、可以检验的结构性决定', why: '团队里每个人都在做局部决定，只有架构师要保证这些决定合在一起仍然成立', how: '先写下目标和约束，再逐条记录决定、备选方案和理由，放进所有人都能查到的决策日志', mistake: '把架构师当成画图的人，图画完就算交付', check: '这个决定的理由写下来了吗？半年后别人读得懂吗？', example: '一个团队在第二周决定用消息队列解耦订单和库存，决策日志里写明了延迟换可用性的取舍，后来换供应商时只改了一条记录。', link: '它是后面所有知识点的前提：之后每一节讲的都是一类具体的决定。', extra: '行业里常把这个角色细分成企业、解决方案和技术三种架构师，课程只讲解决方案架构师。', quote: '架构师记录每个决定及其理由' },
      { id: 'asset', title: 'Architect the Solution (Asset)', term: '架构资产', defines: '团队可以反复使用的设计成果，比如参考架构、模式库和决策模板', why: '每个项目从零开始会重复犯同一批错误，资产把上一次的代价变成这一次的起点', how: '把一次成功的设计抽成参考架构，写清适用范围和不适用的情况，再放进可检索的库', mistake: '只存最终的图，不存当时的约束和被否决的方案', check: '拿到这份资产的人能不能判断自己的项目该不该用它？', example: '一家银行把「对外开放接口」的网关设计抽成参考架构，新项目只需要回答三个适配问题就能复用。', link: '它依赖决策日志（上一节）；用得好，后面的模式选择会快很多。', extra: '资产会过期，需要有人定期复核，否则会变成负担。', quote: '参考架构是可复用的设计资产' },
    ]],
    ['干系人与视图', [
      { id: 'who', title: 'Stakeholders and concerns', term: '干系人和关注点', defines: '所有受系统影响或能影响系统的人，以及他们各自在意的事', why: '漏掉一个关键干系人，常常要到上线后才发现某个质量要求从来没被问过', how: '先列干系人，再对每一类问「你最怕什么」，把答案整理成关注点清单并排序', mistake: '只问出资人和用户，忽略运维、安全和合规', check: '每个关注点都能对应到至少一个设计决定吗？', example: '运维团队的关注点是「凌晨三点能不能一眼看出哪个服务挂了」，这直接带来了统一日志和健康检查的要求。', link: '关注点是下一节视图的输入：每个视图服务于一组关注点。', extra: '关注点之间常常互相冲突，冲突本身要记录下来。', quote: '干系人各有不同的关注点' },
      { id: 'views', title: 'Views and viewpoints', term: '视图和视角', defines: '视角规定怎么看、看什么，视图是按这个规定画出来的具体结果', why: '一张图装不下所有关注点，硬塞只会让谁都看不懂', how: '为每组关注点选一个视角，写明它的元素和符号，再按它画出视图，并标明哪些关注点已被覆盖', mistake: '把「视图」和「视角」当成同一个词，导致没人知道图该怎么读', check: '这张图服务的是哪一组关注点？图例写了吗？', example: '部署视图回答「服务跑在哪」，逻辑视图回答「职责怎么分」，两张图的符号不同，也不该混在一张里。', link: '它承接干系人的关注点，并为后面的质量属性场景提供讨论的共同语言。', extra: '有些团队用 C4 模型代替传统视角，思路相同，只是层次更少。', quote: '视角规定如何构造和使用视图' },
    ]],
  ]],
  ['质量属性与权衡', [
    ['质量属性', [
      { id: 'qas', title: 'Quality attribute scenarios', term: '质量属性场景', defines: '用「刺激、环境、响应、响应度量」四个部分把一个质量要求写成可检验的句子', why: '「系统要快」「要稳定」没法检验，场景把它变成可以测的目标', how: '先选质量属性，再写出谁在什么情况下做了什么，系统应怎样响应，并用数字写明度量', mistake: '只写形容词，不写度量', check: '这个场景里的数字能被测试出来吗？', example: '「高峰时段用户提交订单，系统在两秒内确认，成功率不低于 99.5%」就是一个合格的性能场景。', link: '每个场景都会引出一到几个战术（下一节），并在权衡时互相争夺资源。', extra: '场景最好和业务指标挂钩，否则很难争取到资源。', quote: '场景包括刺激、响应和度量' },
      { id: 'avail', title: 'Availability tactics', term: '可用性战术', defines: '让系统在部分失效时仍然对外服务的一组具体设计手段', why: '可用性目标一旦写成几个九，对应的代价是数量级的差别', how: '先按故障发现、故障恢复、故障预防三类找手段，再逐个评估它们的成本和副作用', mistake: '只做冗余，不做故障发现，结果备份节点坏了也没人知道', check: '这个战术覆盖的是发现、恢复还是预防？', example: '主备数据库加心跳检测，主库失联后三十秒内自动切换，同时告警，值班同学第二天复盘。', link: '它是质量属性场景里「响应度量」的落实，也会和性能战术争夺预算。', extra: '混沌演练是验证可用性战术最直接的办法。', quote: '冗余、心跳与自动切换是常见战术' },
    ]],
    ['性能与权衡', [
      { id: 'perf', title: 'Performance and scalability', term: '性能与可扩展性', defines: '性能是单位时间内能完成多少工作，可扩展性是负载增长时性能能否保持', why: '用户感知的慢往往出在少数几个瓶颈，找不到瓶颈的优化大多是浪费', how: '先做容量估算和压测，找到最先饱和的资源，再决定是纵向扩容、横向扩展还是缓存', mistake: '没有测量就开始优化', check: '这个优化针对的瓶颈有数据证明吗？', example: '商品详情页加了一层读缓存，数据库查询量降了八成，但缓存失效时的雪崩风险要用限流兜住。', link: '它和可用性一起消耗预算，下一节的权衡分析就是处理这类冲突的方法。', extra: '横向扩展要求服务尽量无状态，状态的处理要提前设计。', quote: '性能瓶颈决定扩展的方式' },
      { id: 'atam', title: 'Trade-off analysis (ATAM)', term: '权衡分析', defines: '把质量属性场景、架构决定和风险放在一起评审，看哪些决定在互相拉扯', why: '每个决定都在一个维度上得分，在另一个维度上失分，不摆出来就没人负责', how: '收集场景并排序，把每个重要决定对应到场景上，标出敏感点、权衡点和风险，再决定接受还是调整', mistake: '评审变成讨论技术偏好，没有回到场景', check: '这个权衡点牺牲了哪个场景？谁同意了？', example: '为了满足两秒响应，团队同意订单查询允许五秒的数据延迟，并把这一条写进了验收标准。', link: '它汇总前面所有质量属性的讨论，是模式选择（下一章）的判断依据。', extra: '轻量版本的评审一小时就能做，适合每个迭代一次。', quote: '权衡点是影响多个质量属性的决定' },
    ]],
  ]],
  ['解决方案模式', [
    ['结构模式', [
      { id: 'layers', title: 'Layered architecture', term: '分层架构', defines: '按职责把系统分成上下相邻的几层，上层只依赖下层', why: '分层让每一层可以单独理解、替换和测试，是最容易讲清楚的一种结构', how: '先定每层的职责和允许的依赖方向，再用包或模块边界把它固定下来，并加上自动检查', mistake: '为了方便跨层调用，慢慢出现了循环依赖', check: '有没有哪一层在调用它上面的层？', example: '展示层只调用业务层，业务层只调用数据层；某次有人从展示层直接查数据库，被依赖检查拦住了。', link: '它是微服务拆分之前最常见的起点，很多系统是先分层、再按层拆开。', extra: '层数不是越多越好，三到四层通常足够。', quote: '上层只依赖相邻的下层' },
      { id: 'micro', title: 'Microservices', term: '微服务', defines: '把系统拆成可以独立部署、独立演进的小服务，每个服务围绕一个业务能力', why: '团队可以并行交付，局部故障不会拖垮整体，但换来的是分布式系统的全部麻烦', how: '先按业务边界拆，再为每个服务配上自己的数据、部署流水线和监控，服务之间只通过接口通信', mistake: '按技术层拆，结果每次改一个功能都要动好几个服务', check: '这个服务能不能独立发布，不通知别的团队？', example: '订单、库存、支付拆成三个服务后，支付团队可以每天发布，库存团队每周发布，互不等待。', link: '它建立在分层的职责划分之上，并依赖下一节的事件和接口把服务连起来。', extra: '团队规模小于十人时，单体往往更划算。', quote: '服务围绕业务能力划分' },
    ]],
    ['集成与事件', [
      { id: 'event', title: 'Event-driven design', term: '事件驱动设计', defines: '服务之间通过发布和订阅事件来协作，而不是直接调用对方', why: '发布者不需要知道谁在听，新增一个订阅者不用改发布者', how: '先定义事件的含义和格式，再选消息中间件，明确投递语义，并给消费者设计幂等处理', mistake: '把事件当成远程调用的替代品，期待立刻拿到结果', check: '消费者收到重复事件时会出错吗？', example: '订单创建后发布「订单已创建」事件，库存、通知、积分三个服务各自订阅，其中通知服务因故停了两小时，恢复后补上了消息。', link: '它是微服务之间松耦合的主要手段，也是下一节接口网关要面对的另一种集成方式。', extra: '事件溯源是更激进的做法，需要额外的存储与回放设计。', quote: '发布者不知道订阅者' },
      { id: 'gateway', title: 'API gateways and integration', term: '接口网关与集成', defines: '在外部调用方和内部服务之间放一个统一入口，处理认证、限流、路由和协议转换', why: '没有统一入口，每个服务都要自己重复实现这些横切功能', how: '先列出横切关注点，把它们放进网关，再规定网关不做业务逻辑，并为它做好高可用', mistake: '把业务编排也塞进网关，网关变成新的单体', check: '这段逻辑去掉网关还能工作吗？', example: '移动端和合作伙伴走同一个网关，但各自有不同的限流配额，认证统一由网关校验后再把用户身份传给内部服务。', link: '它与事件驱动互补：网关管同步入口，事件管异步协作。', extra: '服务网格把部分网关功能下沉到每个服务旁边，适合服务数量很多的场景。', quote: '网关处理认证、限流和路由' },
    ]],
  ]],
  ['交付与治理', [
    ['部署与安全', [
      { id: 'deploy', title: 'Deployment models', term: '部署模型', defines: '系统在哪些环境里运行：本地机房、公有云、私有云，或者几者混合', why: '部署位置决定了成本结构、合规边界和可用性上限', how: '先列合规和延迟的硬约束，再比较各种部署方式的成本与迁移难度，选定后写进架构决策', mistake: '先选定云厂商，再倒推架构', check: '这个选择有哪些约束是硬的、哪些只是偏好？', example: '一家医院的病历数据必须留在本地机房，而预约系统可以放公有云，二者通过受控的专线对接。', link: '它直接影响安全架构（下一节）的边界划分。', extra: '多云常被当成目标，其实往往只是成本更高的备选。', quote: '部署位置影响成本和合规' },
      { id: 'sec', title: 'Security architecture', term: '安全架构', defines: '把威胁建模、身份与访问控制、数据保护和审计组织成一个整体的设计', why: '安全问题大多出在决定之间的缝隙，而不是单个组件', how: '先做威胁建模找到入口和资产，再按最小权限设计身份与访问，对数据分级加密，最后设计审计与告警', mistake: '把安全当成上线前才加的一层', check: '如果这个组件被攻破，最大的损失是什么？', example: '零信任的做法是每次服务调用都校验身份与权限，即使请求来自内网，所以内网的一台机器被入侵不会自动打开所有门。', link: '它依赖部署模型划定的边界，也要被治理流程持续检查。', extra: '合规要求常常比技术最佳实践更严格，要分开处理。', quote: '威胁建模从资产和入口开始' },
    ]],
    ['决策与治理', [
      { id: 'adr', title: 'Architecture decision records', term: '架构决策记录', defines: '用一页纸记下一个重要决定的背景、选项、结论和后果', why: '人会离开，记忆会变，只有记录能让后来的人理解为什么是这样', how: '每个重要决定一个文件，包含背景、考虑过的选项、最终选择和后果，并随代码一起版本管理', mistake: '记录写成了会议纪要，没有写被否决的选项', check: '读这条记录的人能不能不问作者就明白理由？', example: '一条记录写明「选择 PostgreSQL 而不是文档数据库，因为事务一致性比扩展灵活性更重要」，两年后新同事一读就懂。', link: '它就是第一节决策日志的正式形式，也是治理评审（下一节）的材料。', extra: '记录的状态可以是提议、通过、被取代，不要直接删旧记录。', quote: '记录背景、选项、结论与后果' },
      { id: 'gov', title: 'Governance and reviews', term: '架构治理与评审', defines: '通过规则、流程和检查点，让团队的决定与整体架构保持一致', why: '没有治理，各团队的局部最优会合成整体的混乱', how: '先定哪些决定必须评审、哪些团队自己做主，再安排轻量的评审节奏，并用自动检查代替人工盯防', mistake: '评审成了审批关卡，拖慢所有团队', check: '这条规则能不能自动检查，而不是靠人记得？', example: '团队在流水线里加了依赖方向检查和接口兼容性检查，评审会只讨论机器查不出来的权衡。', link: '它回收前面所有知识点：决策记录是输入，质量场景和模式是评审的标尺。', extra: '治理的目标是让对的事更容易做，而不是让错的事更难做。', quote: '治理保持局部决定与整体一致' },
    ]],
  ]],
];

/** All sixteen points in book order, with their chapter and section index. */
export const POINTS = CHAPTERS.flatMap(([, sections], chapter) => sections.flatMap(([, points], section) => points.map((point, index) => ({ ...point, chapter, section, index }))));

/** A point's generated notes in the shape the book stores them (lib/course-book.js normalizeBody): points, explain (the takeaway is its first sentence), example, extra, cites. */
export function bodyOf(point, at, pages) {
  const gist = `${at === 0 || at === 5 ? '一句话：' : ''}${point.term}是${point.defines}。`;
  const paragraphs = [`${gist}${point.why}[^1]。`, `落到做法上：${point.how}[^2]。`, `最常见的误区是${point.mistake}。所以评审时先问：${point.check}`];
  if (at % 2 === 0) paragraphs.push(`和相邻知识点的关系：${point.link}[^1]`);
  return { fingerprint: 'f'.repeat(16),
    points: [`${point.term}：${point.defines}`, `为什么重要：${point.why}`, `怎么做：${point.how}`, `易错：${point.mistake}`, `自查：${point.check}`],
    explain: paragraphs.join('\n\n'), example: point.example, extra: [point.extra],
    cites: pages.map((page, number) => ({ n: number + 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 })) };
}

/** The 考情 line of a point (only some are on a sample paper). */
export const examOf = (point, at) => (at % 2 === 0 ? { fingerprint: 'e'.repeat(16), tested: true, note: `${point.term}在近两年的样卷里各出现一次。` } : null);
