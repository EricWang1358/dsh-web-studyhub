/** A call the provider (or the model in front of it) turned away for rate limits: a reason to slow down and ask again, not to give up. */
export const isRateLimit = (error) => error?.status === 429 || error?.code === 429 || /\b429\b|rate.?limit|too many requests|限流/i.test(String(error?.message ?? error));
