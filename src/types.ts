// ── Core contracts ──────────────────────────────────────────────────────────
// Everything is a Provider — searching a source and generating an image both
// implement the same interface. A user-ranked list of providers is walked top
// to bottom; the Judge decides whether each candidate is good enough, and the
// first one that passes wins (the pipeline stops). Fork the tool by writing a
// new Provider; that's the whole extension surface.

export type ProviderKind = "search" | "generate" | "diagram";

export interface ImageRequest {
  /** What the image should depict, e.g. "Yarrow's spiny lizard". */
  query: string;
  /** Optional positive constraint the judge must confirm, e.g. "blue-green scaly body". */
  mustShow?: string;
  /** Optional negative constraint, e.g. "must not be a desert spiny lizard". */
  mustNotConfuse?: string;
  /** Minimum judge score (0..1) to accept. Overrides config/judge default. */
  minScore?: number;
  /** How many candidates to consider per provider. */
  count?: number;
}

export interface Candidate {
  /** Remote URL OR inline bytes (generators return bytes). One is required. */
  url?: string;
  bytes?: Buffer;
  mime?: string;
  provider: string;
  title?: string;
  license?: string;
  attribution?: string;
  /** Link back to the source record/page, for provenance. */
  sourceUrl?: string;
  meta?: Record<string, unknown>;
}

/** Per-call context: the user's env (for credentials) + this entry's options. */
export interface Ctx {
  env: NodeJS.ProcessEnv;
  options: Record<string, any>;
  log: (msg: string) => void;
}

export interface Provider {
  name: string;
  kind: ProviderKind;
  /** Is this provider usable for THIS user right now? Returns true, or a
   *  human-readable reason it's skipped (e.g. "set UNSPLASH_ACCESS_KEY"). */
  configured(ctx: Ctx): true | string;
  provide(req: ImageRequest, ctx: Ctx): Promise<Candidate[]>;
}

export interface Verdict {
  score: number; // 0..1
  passes: boolean;
  reason: string;
  confusedWith?: string;
}

export interface Judge {
  name: string;
  configured(ctx: Ctx): true | string;
  evaluate(candidate: Candidate, req: ImageRequest, ctx: Ctx): Promise<Verdict>;
}

export interface PipelineEntry {
  provider: string;
  [option: string]: any;
}
export interface JudgeConfig {
  provider: string;
  [option: string]: any;
}
export interface Config {
  judge: JudgeConfig;
  /** Ranked list — tried in order. */
  pipeline: PipelineEntry[];
}

export interface Attempt {
  provider: string;
  score?: number;
  passes?: boolean;
  reason: string;
}
export interface RunResult {
  ok: boolean;
  candidate?: Candidate;
  verdict?: Verdict;
  bytes?: Buffer;
  attempts: Attempt[];
}
