import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { StudyService } from "../lib/service.js";

const port = Number(process.env.PORT || 4178),
  token = randomBytes(24).toString("hex");
const initialRoot = process.argv
  .find((a) => a.startsWith("--library="))
  ?.slice(10);
let previewBinding = {
  root: initialRoot ? resolve(initialRoot) : "",
  provider: "",
  model: "",
};
const complete = process.env.STUDY_API_KEY
  ? async (system, prompt) => {
      const res = await fetch(
        (process.env.STUDY_BASE_URL || "https://api.deepseek.com").replace(
          /\/$/,
          "",
        ) + "/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + process.env.STUDY_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.STUDY_MODEL || "deepseek-chat",
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
          }),
          signal: AbortSignal.timeout(180000),
        },
      );
      if (!res.ok)
        throw new Error("Model request failed (HTTP " + res.status + ")");
      return (await res.json()).choices?.[0]?.message?.content || "";
    }
  : undefined;
const server = createServer(async (req, res) => {
  try {
    if (
      req.headers.host !== `127.0.0.1:${port}` &&
      req.headers.host !== `localhost:${port}`
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "POST" && req.url === "/api/call") {
      if (req.headers["x-study-token"] !== token) {
        res.writeHead(403).end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) throw new Error("Request too large");
      }
      const { action, args = {} } = JSON.parse(body);
      let value;
      if (action === "binding.get") value = previewBinding;
      else if (action === "binding.set") {
        if (typeof args.root !== "string" || !isAbsolute(args.root))
          throw new Error("Choose an absolute library directory");
        previewBinding = {
          root: args.root,
          provider: String(args.provider || ""),
          model: String(args.model || ""),
        };
        value = previewBinding;
      } else
        value = await new StudyService(previewBinding.root, { complete }).call(
          action,
          args,
        );
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify({ ok: true, value }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        })
        .end(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Study · DSH</title><link rel="stylesheet" href="/app.css"><body style="margin:0;background:#22272b"><div id="root"></div><script>window.STUDY_TOKEN=${JSON.stringify(token)}</script><script src="/app.js"></script></body></html>`,
        );
      return;
    }
    if (!["/app.js", "/app.css"].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": req.url.endsWith(".js")
          ? "text/javascript"
          : "text/css",
      })
      .end(await readFile(resolve("dist", req.url.slice(1))));
  } catch (e) {
    res
      .writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ok: false, error: e.message }));
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Study preview: http://127.0.0.1:${port} (explicit library required; no sample data loaded automatically)`,
  ),
);
