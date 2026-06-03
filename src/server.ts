import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { loadEnv } from "./util.js";
import { REGISTRY, getProvider } from "./providers.js";
import { JUDGES } from "./judges.js";
import { run } from "./engine.js";
import type { Candidate, Ctx, Config, Provider, Judge } from "./types.js";

const baseEnv = loadEnv();
const PORT = Number(process.env.PORT ?? 5190);
const PUBLIC = path.join(process.cwd(), "public");

// ── Session key overlay ───────────────────────────────────────────────────────
// Keys the user sets via the demo UI live ONLY here, in memory, for this process.
// They are never written to disk, never logged, and never echoed back in any
// response. The effective env is the process env with these overlaid on top.
const overrides: Record<string, string> = {};
const env = (): Record<string, string | undefined> => ({ ...baseEnv, ...overrides });
const ctx = (): Ctx => ({ env: env(), options: {}, log: () => {} });

// Discover which env var a provider/judge needs by reading its own configured()
// message against an empty env (e.g. "set UNSPLASH_ACCESS_KEY" → UNSPLASH_ACCESS_KEY).
function keyEnvOf(thing: Provider | Judge): string | null {
  try {
    const r = thing.configured({ env: {}, options: {}, log: () => {} });
    if (r === true) return null;
    const m = /set ([A-Z][A-Z0-9_]*)/.exec(r);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

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
    // ── List providers + judges, each with required key + configured status ────
    if (req.method === "GET" && url.pathname === "/api/providers") {
      const e = env();
      const providers = Object.entries(REGISTRY).map(([name, p]) => ({
        name, kind: p.kind, configured: p.configured(ctx()), keyEnv: keyEnvOf(p),
      }));
      const judges = Object.entries(JUDGES).map(([name, j]) => ({
        name, configured: j.configured(ctx()), keyEnv: keyEnvOf(j),
      }));
      // Unique set of credentials any provider/judge wants, with set-status + users.
      const cred: Record<string, { env: string; set: boolean; usedBy: string[] }> = {};
      const note = (envName: string | null, who: string) => {
        if (!envName) return;
        (cred[envName] ??= { env: envName, set: !!e[envName], usedBy: [] }).usedBy.push(who);
      };
      providers.forEach((p) => note(p.keyEnv, p.name));
      judges.forEach((j) => note(j.keyEnv, `${j.name} (judge)`));
      return json({ providers, judges, credentials: Object.values(cred) });
    }

    // ── Set / clear a credential for this session (env var by NAME) ─────────────
    // Body: { name: "OPENAI_API_KEY", value: "sk-..." }. Empty value clears it.
    // Response NEVER contains the secret — only whether that name is now set.
    if (req.method === "POST" && url.pathname === "/api/keys") {
      const { name, value } = await body(req);
      if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
        return json({ error: "name must be an ENV_VAR style identifier" }, 400);
      }
      if (typeof value === "string" && value.trim()) overrides[name] = value.trim();
      else delete overrides[name];
      return json({ ok: true, name, set: !!env()[name] });
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
        let provider;
        try { provider = getProvider(name); } catch { results.push({ provider: name, error: "unknown provider" }); continue; }
        const ok = provider.configured(ctx());
        if (ok !== true) { results.push({ provider: name, kind: provider.kind, skipped: ok, candidates: [] }); continue; }
        const t0 = Date.now();
        try {
          const cands = await provider.provide({ query, count: count ?? 3 }, ctx());
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
        config, env(), (m) => log.push(m),
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
