import type {
  Config, ImageRequest, RunResult, Candidate, Verdict, Ctx, Attempt,
  PipelineEntry, PipelineStage, Profile, Scored, Judge,
} from "./types.js";
import type { ScorerCtx } from "./stages.js";
import { corpusOf, getFilter, getScorer, isFilter, isGather, isScore, isSelect } from "./stages.js";
import { getProfile } from "./profiles.js";
import { isParallel } from "./types.js";
import { getProvider } from "./providers.js";
import { getJudge } from "./judges.js";
import { download } from "./util.js";

/**
 * Thrown when a scorer errored on EVERY candidate it was given.
 *
 * A judge that throws on all of them is dead, not strict: a 429, an expired
 * key, an exhausted balance. Each such candidate still scores 0 and fails, and
 * a run that merely carried on would then report "no acceptable image" for a
 * subject nobody looked at — a false negative, stored as fact. So the engine
 * stops instead. Opt out with `judge.whenUnavailable: "continue"`.
 *
 * `attempts` is the trace up to the failure, and `errors` the distinct messages
 * the scorer threw, so a caller can tell a rate limit from a revoked key.
 */
export class JudgeUnavailableError extends Error {
  /** The scorer that threw — "judge" in a staged run, the judge's own name in the legacy path. */
  readonly scorer: string;
  /** The configured judge behind it. */
  readonly judge: string;
  /** Distinct messages thrown, in first-seen order. */
  readonly errors: string[];
  /** How many candidates the stage was given. All of them errored. */
  readonly candidates: number;
  /** Scorer errors over the whole run so far, this stage included. */
  readonly scorerErrors: number;
  /** The decision trace up to the failure. */
  readonly attempts: Attempt[];
  readonly profile?: string;
  constructor(info: {
    scorer: string; judge: string; errors: string[]; candidates: number;
    scorerErrors: number; attempts: Attempt[]; profile?: string;
  }) {
    const distinct = [...new Set(info.errors)];
    const who = info.scorer === info.judge
      ? `judge "${info.judge}"`
      : `scorer "${info.scorer}" (judge "${info.judge}")`;
    super(
      `${who} errored on every candidate (${info.candidates} of ${info.candidates}) — ` +
      `the judge is unavailable, not strict: ${distinct.slice(0, 3).join(" | ")}`,
    );
    this.name = "JudgeUnavailableError";
    this.scorer = info.scorer;
    this.judge = info.judge;
    this.errors = distinct;
    this.candidates = info.candidates;
    this.scorerErrors = info.scorerErrors;
    this.attempts = info.attempts;
    this.profile = info.profile;
  }
}

/** The message for a config that asks a deferred judge to score in-process. */
function deferredJudgeRefusal(judge: Judge, where: string): string {
  return `judge "${judge.name}" is deferred, but ${where}. ` +
    `Judging is done out of process by an external agent: use \`select: "defer"\` ` +
    `(or the built-in "agent" profile) and judge the gathered pool yourself.`;
}

/** Expand the configured pipeline into a list of stages, each a list of
 *  provider entries. A `{parallel:[...]}` stage keeps its group; a single
 *  `{provider}` entry becomes a one-element stage. In `pool` mode the whole
 *  pipeline collapses into ONE parallel stage. */
function toStages(config: Config): PipelineEntry[][] {
  const entriesOf = (s: PipelineStage): PipelineEntry[] =>
    isParallel(s) ? s.parallel : [s];
  if (config.mode === "pool") return [config.pipeline.flatMap(entriesOf)];
  return config.pipeline.map(entriesOf);
}

/** Gather candidates from a set of provider entries CONCURRENTLY, pooled. */
export async function gatherPool(
  req: ImageRequest,
  entries: PipelineEntry[],
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = () => {},
  attempts: Attempt[] = [],
): Promise<Candidate[]> {
  const results = await Promise.all(
    entries.map(async (entry) => {
      let provider;
      try { provider = getProvider(entry.provider); }
      catch (e) {
        const reason = `provider unavailable: ${(e as Error).message}`;
        attempts.push({ provider: entry.provider, passes: false, reason });
        log(`✗ ${entry.provider}: ${(e as Error).message}`);
        return [];
      }
      const ctx: Ctx = { env, options: entry, log };
      const ok = provider.configured(ctx);
      if (ok !== true) {
        attempts.push({ provider: provider.name, passes: false, reason: `provider not configured: ${ok}` });
        log(`– skip ${provider.name} (${ok})`);
        return [];
      }
      try {
        const cs = await provider.provide(req, ctx);
        log(`→ ${provider.name}: ${cs.length} candidate(s)`);
        if (!cs.length) attempts.push({ provider: provider.name, passes: false, reason: "provider returned no candidates" });
        return cs;
      } catch (e) {
        const reason = `provider error: ${(e as Error).message}`;
        attempts.push({ provider: provider.name, passes: false, reason });
        log(`✗ ${provider.name}: ${(e as Error).message}`);
        return [];
      }
    }),
  );
  return results.flat();
}

/**
 * Walk the ranked stages. Single-provider stages run the classic sequential
 * loop. In `first-pass` the first candidate to pass an absolute evaluation
 * wins; in `best` every candidate is evaluated absolutely and the global best
 * wins. Explicit `{parallel}` stages and `pool` mode use the judge's
 * COMPARATIVE `select` when available, falling back to absolute evaluations
 * when it is not.
 */
export async function run(
  req: ImageRequest,
  config: Config,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = () => {},
): Promise<RunResult> {
  // A staged pipeline — inline, or a named profile — takes precedence. The
  // `pipeline`/`mode` form below is the original shorthand and stays supported;
  // it is a shim over the same idea and can retire once callers have moved.
  if (config.stages) {
    return runStages(req, { name: "inline", stages: config.stages }, config, env, log);
  }
  if (config.profile) {
    return runStages(req, getProfile(config.profile, config.profiles), config, env, log);
  }

  const judge = getJudge(config.judge.provider);
  const judgeCtx: Ctx = { env, options: config.judge, log };
  // The legacy pipeline always judges in-process. A deferred judge cannot, so
  // refuse here — before a single provider is called.
  if (judge.deferred) throw new Error(deferredJudgeRefusal(judge, "the pipeline/mode form judges every candidate in-process"));
  const jok = judge.configured(judgeCtx);
  if (jok !== true) throw new Error(`judge "${judge.name}" not configured: ${jok}`);

  const mode = config.mode ?? "first-pass";
  const stages = toStages(config);
  const attempts: Attempt[] = [];
  let scorerErrors = 0;
  let best: { c: Candidate; v: Verdict } | null = null;
  const stopOnDeadJudge = config.judge.whenUnavailable !== "continue";

  const finish = async () => {
    if (!best) return { ok: false, attempts, scorerErrors } as RunResult;
    const bytes = best.c.bytes ?? (await download(best.c.url!).then((d) => d.bytes).catch(() => undefined));
    return { ok: best.v.passes, candidate: best.c, verdict: best.v, bytes, attempts, scorerErrors };
  };

  /** The judge threw on this candidate. Recorded as an error, never as a verdict. */
  const errored = (c: Candidate, e: unknown): string => {
    const message = (e as Error).message;
    scorerErrors++;
    attempts.push({ provider: c.provider, score: 0, passes: false, reason: `scorer error: ${message}`, scorerError: message });
    log(`  ✗ [${c.provider}] scorer error: ${message}`);
    return message;
  };

  for (const entries of stages) {
    const gathered = await gatherPool(req, entries, env, log, attempts);
    // Freeze the exact bytes before judging. Judges consume Candidate.bytes and
    // the returned RunResult reuses those same bytes, so a mutable remote URL
    // cannot yield different judged and saved images.
    const pool: Candidate[] = [];
    for (const candidate of gathered) {
      try {
        if (!candidate.bytes) {
          if (!candidate.url) throw new Error("candidate has neither bytes nor URL");
          candidate.bytes = (await download(candidate.url)).bytes;
        }
        pool.push(candidate);
      } catch (e) {
        const reason = `candidate download failed: ${(e as Error).message}`;
        attempts.push({ provider: candidate.provider, passes: false, reason });
        log(`✗ ${candidate.provider}: ${reason}`);
      }
    }
    if (!pool.length) continue;

    // Only explicitly parallel work is comparative. `best` must retain the
    // absolute acceptance floor by evaluating every candidate individually.
    const comparative = entries.length > 1 || mode === "pool";

    if (comparative && judge.select) {
      // One look at the whole pool — relative evaluation.
      let pick;
      try { pick = await judge.select(pool, req, judgeCtx); }
      catch (e) {
        // One comparative call covers the whole pool, so its failure leaves
        // every candidate in it unjudged.
        const errors = pool.map((c) => errored(c, e));
        if (stopOnDeadJudge) {
          throw new JudgeUnavailableError({
            scorer: judge.name, judge: judge.name, errors, candidates: pool.length, scorerErrors, attempts,
          });
        }
        continue;
      }
      if (pick && pick.index >= 0 && pick.index < pool.length) {
        const c = pool[pick.index];
        attempts.push({
          provider: c.provider,
          score: pick.verdict.score,
          passes: pick.verdict.passes,
          reason: pick.verdict.reason,
          confusedWith: pick.verdict.confusedWith,
        });
        log(`  ◇ picked [${c.provider}] (${pick.verdict.score.toFixed(2)}) ${pick.verdict.reason}`);
        if (!best || pick.verdict.score > best.v.score) best = { c, v: pick.verdict };
        if (pick.verdict.passes && mode === "first-pass") {
          const bytes = c.bytes ?? (await download(c.url!)).bytes;
          return { ok: true, candidate: c, verdict: pick.verdict, bytes, attempts, scorerErrors };
        }
      }
      continue;
    }

    // Fallback: evaluate each candidate; comparative = take the max of this pool,
    // first-pass single-provider = stop at the first that passes.
    const errors: string[] = [];
    for (const c of pool) {
      let v: Verdict;
      try { v = await judge.evaluate(c, req, judgeCtx); }
      catch (e) { errors.push(errored(c, e)); continue; }
      attempts.push({
        provider: c.provider,
        score: v.score,
        passes: v.passes,
        reason: v.reason,
        confusedWith: v.confusedWith,
      });
      log(`  ${v.passes ? "✓ PASS" : "· fail"} (${v.score.toFixed(2)}) ${v.reason}${v.confusedWith ? ` [looks like: ${v.confusedWith}]` : ""}`);
      if (!best || v.score > best.v.score) best = { c, v };
      if (v.passes && mode === "first-pass" && !comparative) {
        const bytes = c.bytes ?? (await download(c.url!)).bytes;
        return { ok: true, candidate: c, verdict: v, bytes, attempts, scorerErrors };
      }
    }
    // Every candidate in this stage errored: the judge is down, and nothing
    // after this point would be a judgement.
    if (errors.length === pool.length && stopOnDeadJudge) {
      throw new JudgeUnavailableError({
        scorer: judge.name, judge: judge.name, errors, candidates: pool.length, scorerErrors, attempts,
      });
    }
    // A comparative stage that produced a passing best in first-pass mode: stop.
    if (comparative && mode === "first-pass" && best?.v.passes) return finish();
  }

  return finish();
}

// ── Staged execution ────────────────────────────────────────────────────────
// The working set flows through the chain. `gather` ADDS to it, `score` and
// `filter` transform it, and `select` may end the run. A chain with several
// gather/select pairs is therefore a cascade — try the precise source, and only
// fall through to the broad one if nothing was chosen — expressed as data.

/** Download once, so the bytes that were judged are the bytes that get saved. */
async function freeze(
  gathered: Candidate[],
  attempts: Attempt[],
  log: (m: string) => void,
): Promise<Candidate[]> {
  const pool: Candidate[] = [];
  for (const candidate of gathered) {
    try {
      if (!candidate.bytes) {
        if (!candidate.url) throw new Error("candidate has neither bytes nor URL");
        candidate.bytes = (await download(candidate.url)).bytes;
      }
      pool.push(candidate);
    } catch (e) {
      const reason = `candidate download failed: ${(e as Error).message}`;
      attempts.push({ provider: candidate.provider, passes: false, reason });
      log(`✗ ${candidate.provider}: ${reason}`);
    }
  }
  return pool;
}

export async function runStages(
  req: ImageRequest,
  profile: Profile,
  config: Config,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = () => {},
): Promise<RunResult> {
  const judgeConfig = profile.judge ?? config.judge;
  const judge = getJudge(judgeConfig.provider);
  const judgeCtx: Ctx = { env, options: judgeConfig, log };

  const needsJudge = profile.stages.some(
    (s) => isScore(s) && getScorer(typeof s.score === "string" ? s.score : s.score.scorer).usesJudge,
  ) || profile.stages.some((s) => isSelect(s) && s.select === "compare");
  if (needsJudge) {
    // A deferred judge never scores in-process. Refuse before any gather, so a
    // profile that names one cannot bill a provider on the way to failing.
    if (judge.deferred) {
      throw new Error(deferredJudgeRefusal(judge, `profile "${profile.name}" has a stage that judges in-process`));
    }
    const ok = judge.configured(judgeCtx);
    if (ok !== true) throw new Error(`judge "${judge.name}" not configured: ${ok}`);
  }

  const scorerCtx: ScorerCtx = { env, options: {}, log, judge, judgeCtx, corpusOf };
  const attempts: Attempt[] = [];
  let working: (Candidate & Partial<Scored>)[] = [];
  let best: (Candidate & Scored) | null = null;
  let scorerErrors = 0;
  const stopOnDeadJudge = judgeConfig.whenUnavailable !== "continue";

  const record = (c: Candidate & Partial<Scored>) =>
    attempts.push({
      provider: c.provider, score: c.score, passes: c.passes,
      reason: c.reason ?? "", confusedWith: c.confusedWith,
    });

  /**
   * The scorer THREW on this candidate. That is recorded as an error, never as
   * a verdict: one attempt per error carries `scorerError`, so a caller counts
   * outages by that field (or by `RunResult.scorerErrors`) rather than by
   * grepping reasons. The candidate itself is marked only by a score stage —
   * see `errored` below — because a failed comparative `select` leaves the
   * verdicts an earlier scorer reached intact.
   */
  const noteError = (c: Candidate, e: unknown): string => {
    const message = (e as Error).message;
    scorerErrors++;
    attempts.push({
      provider: c.provider, score: 0, passes: false,
      reason: `scorer error: ${message}`, scorerError: message,
    });
    log(`  ✗ [${c.provider}] scorer error: ${message}`);
    return message;
  };
  const errored = (c: Candidate & Partial<Scored>, e: unknown): string => {
    const message = noteError(c, e);
    // Score 0 and passes false so it can never be chosen; scorerError so no
    // filter downstream can dress the outage up as a judgement.
    Object.assign(c, { score: 0, passes: false, reason: `scorer error: ${message}`, scorerError: message });
    return message;
  };

  const answer = async (c: Candidate & Scored, ok: boolean): Promise<RunResult> => ({
    ok,
    candidate: c,
    verdict: { score: c.score, passes: c.passes, reason: c.reason, confusedWith: c.confusedWith },
    bytes: c.bytes ?? (await download(c.url!)).bytes,
    attempts,
    scorerErrors,
    profile: profile.name,
  });

  for (const stage of profile.stages) {
    if (isGather(stage)) {
      // Metadata only. Bytes are fetched lazily, once something actually needs
      // to look at the picture.
      working.push(...(await gatherPool(req, stage.gather, env, log, attempts)));
      log(`  ↳ ${working.length} candidate(s) in play`);
      continue;
    }

    if (isScore(stage)) {
      const spec = typeof stage.score === "string" ? { scorer: stage.score } : stage.score;
      const scorer = getScorer(spec.scorer);
      if (scorer.usesBytes) working = await freeze(working, attempts, log);
      const errors: string[] = [];
      for (const c of working) {
        try {
          const verdict = await scorer.score(c, req, { ...scorerCtx, options: spec });
          // A fresh verdict supersedes an earlier scorer's error on this candidate.
          delete c.scorerError;
          Object.assign(c, verdict);
        } catch (e) {
          errors.push(errored(c, e));
          continue;
        }
        log(`  ${c.passes ? "✓" : "·"} [${c.provider}] ${(c.score ?? 0).toFixed(2)} ${c.reason}`);
        if (c.passes && (!best || (c.score ?? 0) > best.score)) best = c as Candidate & Scored;
      }
      // Every candidate errored: the judge is down, not strict. Nothing after
      // this point would be a judgement, and carrying on would bill the next
      // gather for the same outage.
      if (working.length && errors.length === working.length && stopOnDeadJudge) {
        throw new JudgeUnavailableError({
          scorer: scorer.name, judge: judge.name, errors, candidates: working.length,
          scorerErrors, attempts, profile: profile.name,
        });
      }
      continue;
    }

    if (isFilter(stage)) {
      const specs = (Array.isArray(stage.filter) ? stage.filter : [stage.filter])
        .map((f) => (typeof f === "string" ? { filter: f } : f));
      for (const spec of specs) {
        const filter = getFilter(spec.filter);
        const kept: typeof working = [];
        for (const c of working) {
          const rejected = filter.reject(c, req, scorerCtx, spec);
          if (rejected) {
            // A dropped candidate stays in the trace. Silence here is how a
            // decision trace comes to say nothing about why candidates vanished.
            attempts.push({ provider: c.provider, passes: false, reason: `${filter.name}: ${rejected}` });
            log(`  – dropped [${c.provider}] ${filter.name}: ${rejected}`);
          } else kept.push(c);
        }
        working = kept;
      }
      continue;
    }

    if (isSelect(stage)) {
      if (stage.select === "defer") {
        // Errored candidates are already in the trace, from the moment they
        // errored; recording them again would double-count scorerError.
        working.filter((c) => !c.scorerError).forEach(record);
        return {
          ok: false, attempts, scorerErrors, profile: profile.name,
          pool: working.filter((c) => c.score !== undefined) as (Candidate & Scored)[],
        };
      }
      if (!working.length) continue;   // nothing to choose from — fall through

      if (stage.select === "compare" && judge.select) {
        working = await freeze(working, attempts, log);   // the judge must see the images
        let pick;
        try { pick = await judge.select(working, req, judgeCtx); }
        catch (e) {
          // One comparative call covers the whole pool, so its failure leaves
          // every candidate in it unjudged.
          const errors = working.map((c) => noteError(c, e));
          if (stopOnDeadJudge) {
            throw new JudgeUnavailableError({
              scorer: judge.name, judge: judge.name, errors, candidates: working.length,
              scorerErrors, attempts, profile: profile.name,
            });
          }
        }
        if (pick && pick.index >= 0 && pick.index < working.length) {
          const chosen = Object.assign(working[pick.index], pick.verdict) as Candidate & Scored;
          record(chosen);
          if (!best || chosen.score > best.score) best = chosen;
          if (chosen.passes) return answer(chosen, true);
        }
        continue;
      }

      const ranked = [...working].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const chosen = stage.select === "best"
        ? ranked[0]
        : working.find((c) => c.passes);
      if (chosen?.passes) {
        record(chosen);
        return answer(chosen as Candidate & Scored, true);
      }
      continue;
    }
  }

  if (best) return answer(best, best.passes);
  return { ok: false, attempts, scorerErrors, profile: profile.name };
}
