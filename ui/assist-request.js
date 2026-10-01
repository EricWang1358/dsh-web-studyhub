import { PLAIN_HELP_REQUEST } from "../lib/assist-contract.js";
import { localizeAppMessage } from '../lib/application-messages.js';

export async function submitAssist(call, request) {
  try {
    return await call("assist.start", request);
  } catch (error) {
    // A rebuilt client can connect to a still-loaded pre-plain host. That host
    // rejects the option before dispatch, so only this validation failure is
    // safe to retry. Network/provider failures must never create a second job.
    if (!["帮助方式不正确", localizeAppMessage('帮助方式不正确', 'en')].includes(error.message) || request.mode !== "ask" ||
        !request.helpChoices?.includes("plain")) throw error;
    const text = [PLAIN_HELP_REQUEST, request.text.trim()].filter(Boolean).join("\n\n");
    if (text.length > 1000) throw new Error(localizeAppMessage('请把疑问控制在 1000 字以内', request.uiLanguage || 'zh'));
    return call("assist.start", { ...request, text,
      helpChoices: request.helpChoices.filter((choice) => choice !== "plain") });
  }
}
