/** Match DSH's Fetch RPC carrier, with only 404/405 allowing legacy fallback. */
export function createStudyCall(connection, sessionId) {
  let legacy = false;
  return async (action, args = {}) => {
    const signal = AbortSignal.timeout(200000),
      payload = { sessionId, action, args };
    let result;
    try {
      result = await connection.rpc.call(
        legacy ? "/study-workspace" : "/api",
        legacy ? "call" : "study-workspace/call",
        payload,
        signal,
      );
    } catch (e) {
      if (legacy || !/HTTP (404|405)\b/.test(e.message || "")) throw e;
      legacy = true;
      result = await connection.rpc.call(
        "/study-workspace",
        "call",
        payload,
        signal,
      );
    }
    if (!result?.ok)
      throw new Error(result?.error?.message || "Study request failed");
    return result.value;
  };
}
