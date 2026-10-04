/** V4 session messages attribute notices to their producer, not `kind: plugin`. */
export function createSessionNotifier(agent, createUserMessage, pluginName) {
  if (typeof agent?.inject !== "function") return undefined;
  return ({ text, summary, wakeup = false }) => {
    try {
      // Terminal receipts need a reporting turn even after the parent became idle.
      // Passive panel observations still wait for its next step.
      const deliver = wakeup && typeof agent.followup === 'function' ? agent.followup : agent.inject;
      const result = deliver.call(agent, createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: `plugin:${pluginName}`, form: "notice", summary: String(summary).slice(0, 120) },
      }));
      Promise.resolve(result).catch(() => {});
    } catch {
      // A closed session can no longer receive context; the panel keeps its result.
    }
  };
}
