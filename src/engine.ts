import type { Config, ImageRequest, RunResult, Candidate, Verdict, Ctx, Attempt } from "./types.js";
import { getProvider } from "./providers.js";
import { getJudge } from "./judges.js";
import { download } from "./util.js";

/**
 * The whole program. Walk the ranked pipeline; for each configured provider, get
 * candidates and judge them in order; the FIRST candidate that passes wins and we
 * stop. If nothing passes, return the best-scored candidate so far (ok=false).
 */
export async function run(
  req: ImageRequest,
  config: Config,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = () => {},
): Promise<RunResult> {
  const judge = getJudge(config.judge.provider);
  const judgeCtx: Ctx = { env, options: config.judge, log };
  const jok = judge.configured(judgeCtx);
  if (jok !== true) throw new Error(`judge "${judge.name}" not configured: ${jok}`);

  const attempts: Attempt[] = [];
  let best: { c: Candidate; v: Verdict } | null = null;

  for (const entry of config.pipeline) {
    let provider;
    try { provider = getProvider(entry.provider); }
    catch (e) { log(`✗ ${entry.provider}: ${(e as Error).message}`); continue; }

    const ctx: Ctx = { env, options: entry, log };
    const ok = provider.configured(ctx);
    if (ok !== true) { log(`– skip ${provider.name} (${ok})`); continue; }

    let candidates: Candidate[] = [];
    try { candidates = await provider.provide(req, ctx); }
    catch (e) { log(`✗ ${provider.name}: ${(e as Error).message}`); continue; }
    if (!candidates.length) { log(`– ${provider.name}: no candidates`); continue; }

    log(`→ ${provider.name}: ${candidates.length} candidate(s)`);
    for (const c of candidates) {
      let v: Verdict;
      try { v = await judge.evaluate(c, req, judgeCtx); }
      catch (e) { log(`  judge error: ${(e as Error).message}`); continue; }
      attempts.push({ provider: provider.name, score: v.score, passes: v.passes, reason: v.reason });
      log(`  ${v.passes ? "✓ PASS" : "· fail"} (${v.score.toFixed(2)}) ${v.reason}${v.confusedWith ? ` [looks like: ${v.confusedWith}]` : ""}`);
      if (v.passes) {
        const bytes = c.bytes ?? (await download(c.url!)).bytes;
        return { ok: true, candidate: c, verdict: v, bytes, attempts };
      }
      if (!best || v.score > best.v.score) best = { c, v };
    }
  }

  if (best) {
    const bytes = best.c.bytes ?? (await download(best.c.url!).then((d) => d.bytes).catch(() => undefined));
    return { ok: false, candidate: best.c, verdict: best.v, bytes, attempts };
  }
  return { ok: false, attempts };
}
