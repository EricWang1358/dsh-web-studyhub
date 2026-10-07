/* A local OpenAI-compatible chat-completions server for DSH end-to-end runs
   (node scripts/qa/fake-openai.mjs --port 4194). Study prompts get the same
   answers as scripts/fake-model.mjs, so plugin work inside DSH (generation,
   assist, coach) completes; any other chat turn gets a short canned reply.
   Streams Server-Sent Events when the request asks for `stream`. No keys. */
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeModel } from "../fake-model.mjs";

export const FAKE_OPENAI_MODEL = "fake-tutor";

const text = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text || "").join("") : "";

/** Start the server. Returns { url (…/v1), log, close() }. */
export async function createFakeOpenAI({ port = 0, host = "127.0.0.1", model, beforeReply } = {}) {
  const log = [];
  const studyLog = [];
  const study = model || createFakeModel({ log: studyLog });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        if (req.method === "GET" && /\/models\/?$/.test(req.url)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: FAKE_OPENAI_MODEL, object: "model", owned_by: "studyhub-qa" }] }));
          return;
        }
        if (req.method !== "POST" || !/\/chat\/completions\/?$/.test(req.url)) { res.writeHead(404).end(); return; }
        const request = JSON.parse(body || "{}");
        const messages = Array.isArray(request.messages) ? request.messages : [];
        const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).join("\n");
        // DSH ends the conversation of a delegated call with a runtime-context snapshot of its own: what was asked is the last user turn before it.
        const turns = messages.filter((m) => m.role === "user").map((m) => text(m.content));
        const prompt = turns.findLast((turn) => !/^\s*Current runtime context\./.test(turn)) ?? turns.at(-1) ?? "";
        await beforeReply?.(system, prompt); // a run may hold the model (scripts/qa/dsh-runtime-smoke.mjs shows a job while it runs)
        const before = studyLog.length;
        // DSH prepends <system-reminder> blocks to the user turn of every request, and a delegated call carries the plugin's instruction inside that turn: the study model is
        // asked what the plugin asked, and its handlers (which match on the system text) are shown the instruction as well.
        const asked = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        let content = await study(asked, asked);
        let handled = studyLog.slice(before).some((entry) => entry.handler);
        if (!handled) { content = await study(system, asked); handled = studyLog.slice(before).some((entry) => entry.handler); }
        // DSH prepends <system-reminder> blocks to the user turn; echo only what the learner wrote.
        if (!handled) content = `【StudyHub QA fake model】收到：${prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim().slice(0, 60)}`;
        log.push({ at: new Date().toISOString(), model: request.model, stream: !!request.stream, handled,
          tools: (request.tools || []).map((tool) => tool.function?.name || tool.name).filter(Boolean), systemHead: system.slice(0, 200) });
        const base = { id: `chatcmpl-qa-${log.length}`, created: Math.floor(Date.now() / 1000), model: request.model || FAKE_OPENAI_MODEL };
        const usage = { prompt_tokens: Math.ceil((system.length + prompt.length) / 4), completion_tokens: Math.ceil(content.length / 4) };
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        if (!request.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...base, object: "chat.completion", usage,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const send = (value) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...value })}\n\n`);
        send({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        for (const piece of content.match(/[\s\S]{1,80}/g) || [""]) send({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
        res.end("data: [DONE]\n\n");
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: String(error?.message || error) } }));
      }
    });
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(port, host, done); });
  return { url: `http://${host}:${server.address().port}/v1`, log,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--port");
  const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? (at > 0 ? process.argv[at + 1] : 4194));
  const server = await createFakeOpenAI({ port: Number.isInteger(port) ? port : 4194 });
  console.log(`fake OpenAI-compatible model on ${server.url} (model ${FAKE_OPENAI_MODEL})`);
}
