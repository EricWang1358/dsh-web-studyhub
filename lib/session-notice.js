/** V4 session messages attribute notices to their producer, not `kind: plugin`. */
export function createSessionNotifier(agent, createUserMessage, pluginName) {
  if (typeof agent?.inject !== "function") return undefined;
  return ({ text, summary }) => {
    try {
      agent.inject(createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: `plugin:${pluginName}`, form: "notice", summary: String(summary).slice(0, 120) },
      }));
    } catch {
      // A closed session can no longer receive context; the panel keeps its result.
    }
  };
}
