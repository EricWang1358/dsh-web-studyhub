import assert from 'node:assert/strict';

/** Wait for a user action to commit through the preview API before checking persisted state. */
export async function commitPreviewAction(page, action, activate) {
  const response = page.waitForResponse(reply => {
    const request = reply.request();
    return new URL(reply.url()).pathname === '/api/call' && request.method() === 'POST' && request.postDataJSON()?.action === action;
  });
  const [reply] = await Promise.all([response, activate()]);
  const payload = await reply.json();
  assert.equal(payload.ok, true, `${action} failed: ${JSON.stringify(payload.error)}`);
  return payload.value;
}
