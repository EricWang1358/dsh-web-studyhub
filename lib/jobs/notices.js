/** The settlement sinks of a definition whose `persistence.open` may return null are declared twice: `notifications` on the definition (used when the job is not durable) and the
 * `notifications` of the port `open` returns (used when it is). They must be the same sinks as far as the kernel can tell: the same channels with the same idempotence, so that
 * a notice exists on both paths or on neither. A sink's `deliver` for a durable job takes its notifier from the closure of `persistence.open`, never from bindings. */
const describe = sinks => `[${[...(sinks ?? [])].map(item => `${item.channel}:${item.idempotent ? 'idempotent' : 'at-most-once'}`).sort().join(', ')}]`;

export function checkNoticePairing(declared, ported) {
  const inProcess = describe(declared), durable = describe(ported);
  if (inProcess !== durable) {
    const message = `Notification sinks of the durable port ${durable} differ from those the definition declares for a job that is not durable ${inProcess}: `
      + 'declare the same channels with the same idempotence on both';
    throw Object.assign(new Error(message), { code: 'invalid-notification-adapter' });
  }
}
