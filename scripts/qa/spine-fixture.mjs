/* The knowledge skeleton of the owner's screenshot (微服务边界与通信): 5 stations, 8 points, station 4 holds five of them. */
const card = (id) => ({ deckId: "d1", cardId: id });

export function spineFixture(lang = "zh") {
  const en = lang === "en";
  const node = (id, term, meaning, extra = {}) => ({ id, term, meaning, cards: [], ...extra });
  const nodes = en ? [
    node("s1", "Domain-driven initial service boundaries", "Cut services along bounded contexts so each one owns a single business capability instead of a technical layer.", { cards: [card("1")] }),
    node("s1a", "Bounded context", "A boundary inside which one model and one vocabulary apply; teams agree on its words once.", { parent: "s1", cards: [card("2")] }),
    node("s2", "How services talk to each other", "Pick synchronous calls when the caller needs the answer now, and messages when it can continue without it.", { cards: [card("3")] }),
    node("s2a", "Synchronous calls versus asynchronous messages", "A synchronous call couples availability: if the callee is down the caller fails too. A message broker trades that for eventual consistency and extra operations.", { parent: "s2", cards: [card("4")] }),
    node("s3", "Service discovery and load balancing", "Instances come and go, so callers look the address up at run time and spread requests over healthy instances.", { cards: [card("5")] }),
    node("s3a", "Client-side and server-side discovery", "Either the caller asks a registry and picks an instance, or a proxy in front of the service does it.", { parent: "s3", cards: [card("6")] }),
    node("s4", "Data access and read/write splitting in microservices", "Each service owns its data; reads that need other services' data use replicas or projections.", { cards: [card("7")] }),
    node("s4a", "Database per service", "No service reads another service's tables; sharing a schema silently couples release cycles.", { parent: "s4", cards: [card("8")] }),
    node("s4b", "gRPC and binary protocols", "A typed contract and compact encoding for internal calls; a poor fit for browsers without a gateway.", { parent: "s4", cards: [card("9")] }),
    node("s4c", "CQRS read models", "Split the model that changes state from the model that answers queries so each scales on its own.", { parent: "s4", cards: [card("10")] }),
    node("s4d", "Replication lag", "A replica can be behind the primary; read-your-own-writes needs routing the next read to the primary.", { parent: "s4", cards: [card("11")] }),
    node("s4e", "Event-carried state transfer", "Publish the changed data in the event so consumers keep a local copy and never call back.", { parent: "s4", cards: [card("12")] }),
    node("s5", "Fault isolation and observability", "Timeouts, bulkheads and circuit breakers keep one slow dependency from taking the rest down; traces show where."),
  ] : [
    node("s1", "领域驱动的初始服务边界", "用限界上下文划分服务，让每个服务围绕一项业务能力，而不是围绕技术分层。", { cards: [card("1")] }),
    node("s1a", "限界上下文", "在同一个边界内使用同一套模型和术语，团队只需要在边界上达成一次共识。", { parent: "s1", cards: [card("2")] }),
    node("s2", "服务之间怎样通信", "调用方立刻需要结果时用同步调用，可以先往下走时用消息。", { cards: [card("3")] }),
    node("s2a", "同步调用与异步消息的取舍", "同步调用把可用性耦合在一起：被调用方宕机，调用方也失败；消息队列换来最终一致，但要多维护一套运维。", { parent: "s2", cards: [card("4")] }),
    node("s3", "服务发现与负载均衡", "实例会不断上线下线，调用方要在运行时查询地址，并把请求分摊给健康的实例。", { cards: [card("5")] }),
    node("s3a", "客户端发现与服务端发现", "要么调用方自己查注册中心再挑实例，要么由前面的代理来做这件事。", { parent: "s3", cards: [card("6")] }),
    node("s4", "微服务的数据访问与读写分离", "每个服务拥有自己的数据；需要别的服务数据的读请求，用副本或投影来满足。", { cards: [card("7")] }),
    node("s4a", "每个服务一个数据库", "任何服务都不直接读别的服务的表，共用库表会悄悄把发布节奏绑在一起。", { parent: "s4", cards: [card("8")] }),
    node("s4b", "gRPC 与二进制协议", "内部调用用带类型的契约和紧凑编码；浏览器直连不方便，需要网关转换。", { parent: "s4", cards: [card("9")] }),
    node("s4c", "CQRS 读模型", "把修改状态的模型和回答查询的模型分开，两边可以各自扩容。", { parent: "s4", cards: [card("10")] }),
    node("s4d", "复制延迟", "副本可能落后于主库；要读到自己刚写入的数据，就要把下一次读路由到主库。", { parent: "s4", cards: [card("11")] }),
    node("s4e", "事件携带状态传递", "把变更后的数据放进事件里发布，消费方保存本地副本，不必再回头调用。", { parent: "s4", cards: [card("12")] }),
    node("s5", "故障隔离与可观测性", "超时、舱壁和熔断让一个变慢的依赖拖不垮其他服务，链路追踪告诉你慢在哪里。"),
  ];
  return {
    id: "sk-ms",
    title: en ? "Microservice boundaries and communication spine" : "微服务边界与通信学习脊柱",
    overview: en ? "From where to cut services to how they talk and fail." : "从怎样切分服务，到它们怎样通信、怎样出故障。",
    nodes,
    relations: [],
  };
}
