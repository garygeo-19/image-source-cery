import { writeFileSync, mkdirSync } from "node:fs";
import * as readline from "node:readline";
import type { Judge } from "./types.js";
import { toDataUrl, download } from "./util.js";

// ── none — accept the first candidate (pure ranked fallback, no judging) ──────
export const none: Judge = {
  name: "none",
  configured: () => true,
  async evaluate() {
    return { score: 1, passes: true, reason: "no judge (accept first candidate)" };
  },
};

// ── openai — vision judge (key: OPENAI_API_KEY) ───────────────────────────────
export const openai: Judge = {
  name: "openai",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "OPENAI_API_KEY";
    return ctx.env[k] ? true : `set ${k}`;
  },
  async evaluate(candidate, req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "OPENAI_API_KEY"]!;
    const dataUrl = await toDataUrl(candidate);
    const minScore = req.minScore ?? ctx.options.minScore ?? 0.7;
    const instruction =
      `Requested subject: "${req.query}".` +
      (req.mustShow ? ` It must show: ${req.mustShow}.` : "") +
      (req.mustNotConfuse ? ` It must NOT be confused with: ${req.mustNotConfuse}.` : "") +
      ` Judge how well the image depicts the requested subject. Be strict about species/identity.` +
      ` Respond with JSON: {"score":0..1,"isCorrect":boolean,"reason":"short","confusedWith":"if mismatched, what it actually shows"}.`;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ctx.options.model ?? "gpt-4o-mini",
        response_format: { type: "json_object" },
        max_tokens: 300,
        messages: [
          { role: "system", content: "You verify whether an image correctly depicts a requested subject. Reply ONLY with JSON." },
          { role: "user", content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: dataUrl } },
          ] },
        ],
      }),
    });
    if (!res.ok) throw new Error(`judge OpenAI ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = (await res.json()) as any;
    const j = JSON.parse(data.choices[0].message.content);
    const score = typeof j.score === "number" ? j.score : 0;
    return {
      score,
      passes: (j.isCorrect ?? score >= minScore) && score >= minScore,
      reason: j.reason ?? "",
      confusedWith: j.confusedWith,
    };
  },
};

// ── human — download, show the path, ask y/N on stdin ─────────────────────────
// Also the natural hook for "agent-in-the-loop": an MCP/agent host can swap this
// for a judge that returns the image to the calling model to view.
export const human: Judge = {
  name: "human",
  configured: () => true,
  async evaluate(candidate, req) {
    const bytes = candidate.bytes ?? (await download(candidate.url!)).bytes;
    mkdirSync("/tmp/imgsrcy", { recursive: true });
    const p = `/tmp/imgsrcy/review.${candidate.mime?.includes("png") ? "png" : "jpg"}`;
    writeFileSync(p, bytes);
    console.error(`\n  [${candidate.provider}] saved for review → ${p}`);
    console.error(`  subject: "${req.query}"  ·  license: ${candidate.license ?? "?"}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const ans: string = await new Promise((r) => rl.question("  accept? [y/N] ", (a) => { rl.close(); r(a); }));
    const ok = /^y/i.test(ans.trim());
    return { score: ok ? 1 : 0, passes: ok, reason: ok ? "accepted by human" : "rejected by human" };
  },
};

export const JUDGES: Record<string, Judge> = { none, openai, human };

export function getJudge(name: string): Judge {
  const j = JUDGES[name];
  if (!j) throw new Error(`unknown judge "${name}" (have: ${Object.keys(JUDGES).join(", ")})`);
  return j;
}
