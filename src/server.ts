import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { loadEnv } from "./util.js";
import { REGISTRY, getProvider } from "./providers.js";
import { JUDGES } from "./judges.js";
import { run } from "./engine.js";
import type { Candidate, Ctx, Config } from "./types.js";

const env = loadEnv();
const PORT = Number(process.env.PORT ?? 5190);
const PUBLIC = path.join(process.cwd(), "public");

function src(c: Candidate): string | null {
  if (c.url) return c.url;
  if (c.bytes) return `data:${c.mime ?? "image/png"};base64,${c.bytes.toString("base64")}`;
  return null;
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://localhost");
  const json = (obj: unknown, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  try {
    // ── List providers + judges + which are configured for this user ──────────
    if (req.method === "GET" && url.pathname === "/api/providers") {
      const ctx: Ctx = { env, options: {}, log: () => {} };
      return json({
        providers: Object.entries(REGISTRY).map(([name, p]) => ({
          name, kind: p.kind, configured: p.configured(ctx),
        })),
        judges: Object.keys(JUDGES),
      });
    }

    // ── Gallery: run EVERY requested provider, return all candidates ──────────
    if (req.method === "POST" && url.pathname === "/api/search") {
      const { query, providers, count } = await body(req);
      if (!query) return json({ error: "query required" }, 400);
      const order: string[] = providers?.length
        ? providers
        : Object.keys(REGISTRY).filter((n) => n !== "generate");
      const results: any[] = [];
      for (const name of order) {
        const ctx: Ctx = { env, options: {}, log: () => {} };
        let provider;
        try { provider = getProvider(name); } catch { results.push({ provider: name, error: "unknown provider" }); continue; }
        const ok = provider.configured(ctx);
        if (ok !== true) { results.push({ provider: name, kind: provider.kind, skipped: ok, candidates: [] }); continue; }
        const t0 = Date.now();
        try {
          const cands = await provider.provide({ query, count: count ?? 3 }, ctx);
          results.push({
            provider: name, kind: provider.kind, ms: Date.now() - t0,
            candidates: cands.map((c) => ({ src: src(c), title: c.title, license: c.license, attribution: c.attribution, sourceUrl: c.sourceUrl })).filter((c) => c.src),
          });
        } catch (e) {
          results.push({ provider: name, kind: provider.kind, error: (e as Error).message, candidates: [] });
        }
      }
      return json({ query, results });
    }

    // ── Pipeline: the real ranked run with the judge (returns winner + trace) ─
    if (req.method === "POST" && url.pathname === "/api/pipeline") {
      const b = await body(req);
      if (!b.query) return json({ error: "query required" }, 400);
      const config: Config = {
        judge: { provider: b.judge ?? "none", model: b.model, minScore: b.minScore, apiKeyEnv: "OPENAI_API_KEY" },
        pipeline: (b.providers ?? Object.keys(REGISTRY)).map((n: string) => ({ provider: n })),
        mode: b.mode,
      };
      const log: string[] = [];
      const result = await run(
        { query: b.query, mustShow: b.mustShow, mustNotConfuse: b.mustNot, minScore: b.minScore, count: b.count ?? 3 },
        config, env, (m) => log.push(m),
      );
      return json({
        ok: result.ok,
        winner: result.candidate ? { src: src(result.candidate), provider: result.candidate.provider, license: result.candidate.license, attribution: result.candidate.attribution, sourceUrl: result.candidate.sourceUrl, score: result.verdict?.score, reason: result.verdict?.reason } : null,
        attempts: result.attempts, log,
      });
    }

    // ── Static files (the demo UI) ────────────────────────────────────────────
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("forbidden"); }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

server.listen(PORT, () => console.log(`Image Source-cery demo → http://localhost:${PORT}`));
