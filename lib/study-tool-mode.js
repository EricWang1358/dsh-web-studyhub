/** PTC's run_code is a reserved transport outside toolFilter. Override tool
 * presentation on the exact Study child, before its initial prompt is sent. */
export function studyToolMode(ctx, childId) {
  let configured = false, failure;
  if (!ctx.get?.("tools")?.presentAs) return { dispose() {}, configured: () => false, error: () => null };
  const dispose = ctx.on("agent/created", ({ agent }) => {
    if (agent.id !== childId) return;
    try {
      agent.ctx.get("tools").presentAs("native");
      configured = true;
    } catch (error) { failure = error; }
  });
  return { dispose, configured: () => configured, error: () => failure };
}
