import assert from "node:assert/strict";
import test from "node:test";

import { BUILT_IN_PROFILES, JUDGES, REGISTRY, getJudge, run } from "../dist/index.js";

const ctx = (options = {}) => ({ env: { OPENAI_API_KEY: "sk-test" }, options, log: () => {} });
const png = Buffer.from("89504e470d0a1a0a", "hex");
const candidate = (provider, title, extra = {}) => ({
  provider, title, bytes: png, mime: "image/png", ...extra,
});

/** Stub the OpenAI endpoint and hand back whatever body the judge sent. */
async function captureJudgeRequest(reply, body) {
  const real = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_input, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try { await body(); } finally { globalThis.fetch = real; }
  return sent;
}

/** Every text fragment the judge sent, flattened. */
const promptText = (sent) =>
  sent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .filter((p) => p.type === "text").map((p) => p.text).join("\n");

// An archive record names its subject; a stock caption only describes a scene.
// That distinction is the whole basis of the filename test, and it is invisible
// to a judge that only ever receives pixels.
test("evaluate sends the candidate's record title to the judge", async () => {
  const sent = await captureJudgeRequest(
    { score: 0.9, isCorrect: true, reason: "ok" },
    () => JUDGES.openai.evaluate(
      candidate("wikipedia", "Herb Brooks", { meta: { description: "American ice hockey coach" } }),
      { query: "Herb Brooks" },
      ctx(),
    ),
  );
  const text = promptText(sent);
  assert.match(text, /Herb Brooks/);
  assert.match(text, /record title/);
  assert.match(text, /American ice hockey coach/);
  assert.match(text, /wikipedia/);
});

test("evaluate says so explicitly when a provider supplied no title", async () => {
  const sent = await captureJudgeRequest(
    { score: 0.5, isCorrect: false, reason: "unclear" },
    () => JUDGES.openai.evaluate(candidate("unsplash", undefined), { query: "Sonja Henie" }, ctx()),
  );
  // Silence would read as "no objection". Absence has to be stated.
  assert.match(promptText(sent), /record title: \(none supplied\)/);
});

test("select labels every image with its own provider and title", async () => {
  const sent = await captureJudgeRequest(
    { index: 0, score: 0.9, reason: "ok" },
    () => JUDGES.openai.select(
      [candidate("wikipedia", "Carl Lewis"), candidate("pexels", "a man running on a track at sunset")],
      { query: "Carl Lewis" },
      ctx(),
    ),
  );
  const text = promptText(sent);
  assert.match(text, /Image 0 — source: wikipedia; title: "Carl Lewis"/);
  assert.match(text, /Image 1 — source: pexels; title: "a man running on a track at sunset"/);
});

// gatherPool preserves provider order, so slicing the pool truncated by provider:
// with three providers at count 5 and poolMax 8, the third was never judged.
test("select's pool cap keeps every provider represented", async () => {
  const many = [
    ...Array.from({ length: 5 }, (_, i) => candidate("openverse", `openverse ${i}`)),
    ...Array.from({ length: 5 }, (_, i) => candidate("unsplash", `unsplash ${i}`)),
    ...Array.from({ length: 5 }, (_, i) => candidate("pexels", `pexels ${i}`)),
  ];
  const sent = await captureJudgeRequest(
    { index: 0, score: 0.9, reason: "ok" },
    () => JUDGES.openai.select(many, { query: "anything" }, ctx({ poolMax: 8 })),
  );
  const text = promptText(sent);
  for (const provider of ["openverse", "unsplash", "pexels"]) {
    assert.match(text, new RegExp(`source: ${provider};`), `${provider} was starved by the pool cap`);
  }
  assert.equal((text.match(/^Image \d+ — source:/gm) ?? []).length, 8, "cap must still be respected");
});

test("select still returns the index the judge chose", async () => {
  let verdict;
  await captureJudgeRequest(
    { index: 1, score: 0.82, reason: "second one is the right person" },
    async () => {
      verdict = await JUDGES.openai.select(
        [candidate("pexels", "a skater"), candidate("wikipedia", "Sonja Henie")],
        { query: "Sonja Henie" },
        ctx(),
      );
    },
  );
  assert.equal(verdict.index, 1);
  assert.equal(verdict.verdict.passes, true);
});

// ── uniqueness ──────────────────────────────────────────────────────────────
// Relevance is the question that failed — every wrong-subject pick scored well
// on it. "Is there exactly one of these in the world?" is a factual question
// about the subject rather than an aesthetic one about the image.
test("the judge is asked whether the subject is unique, and reports it", async () => {
  let verdict;
  const sent = await captureJudgeRequest(
    { score: 0.4, isCorrect: false, subjectIsUnique: true, reason: "a different skyscraper" },
    async () => {
      verdict = await JUDGES.openai.evaluate(
        candidate("pexels", "a Manhattan skyscraper at sunset"),
        { query: "Empire State Building" },
        ctx(),
      );
    },
  );
  const text = promptText(sent);
  assert.match(text, /UNIQUE/);
  assert.match(text, /Chrysler Building is not the Empire State Building/);
  assert.match(text, /subjectIsUnique/);
  // Reported, not acted on — the pipeline's floor decides what is good enough.
  assert.equal(verdict.subjectIsUnique, true);
  assert.equal(verdict.passes, false);
});

// A declared person is the one hard line: a photograph of someone else, however
// apt, is a lie the viewer has no way to catch.
test("a declared person is called out to the judge explicitly", async () => {
  const sent = await captureJudgeRequest(
    { score: 0.1, isCorrect: false, subjectIsUnique: true, reason: "not her" },
    () => JUDGES.openai.evaluate(
      candidate("pexels", "a female figure skater practising indoors"),
      { query: "Sonja Henie", subjectType: "person" },
      ctx(),
    ),
  );
  assert.match(promptText(sent), /DECLARED this subject a specific real person/);
});

test("a subject with no declared type gets no person-specific instruction", async () => {
  const sent = await captureJudgeRequest(
    { score: 0.9, isCorrect: true, subjectIsUnique: false, reason: "fine" },
    () => JUDGES.openai.evaluate(candidate("pexels", "a rowing boat"), { query: "a rowing boat" }, ctx()),
  );
  assert.doesNotMatch(promptText(sent), /DECLARED this subject/);
});

test("the comparative path carries the same rubric", async () => {
  const sent = await captureJudgeRequest(
    { index: 0, score: 0.9, subjectIsUnique: true, reason: "ok" },
    () => JUDGES.openai.select(
      [candidate("wikipedia", "Empire State Building, 1932")],
      { query: "Empire State Building" },
      ctx(),
    ),
  );
  assert.match(promptText(sent), /UNIQUE/);
});

// ── agent — deferred, never synchronous ─────────────────────────────────────
// A consumer that judges with an external agent used to point `judge.provider`
// at a NONEXISTENT name, just so any in-process scoring path would fail loudly
// instead of billing OpenAI. The arrangement now has a name.
test("agent is a valid judge that refuses to score synchronously", async () => {
  const judge = getJudge("agent");
  assert.equal(judge.name, "agent");
  assert.equal(judge.deferred, true);
  assert.equal(judge.configured(ctx()), true, "naming it is valid config, not a misconfiguration");
  await assert.rejects(
    () => judge.evaluate(candidate("wikipedia", "Herb Brooks"), { query: "Herb Brooks" }, ctx()),
    /deferred to an external agent.*select: "defer"/s,
  );
  await assert.rejects(
    () => judge.select([candidate("wikipedia", "Herb Brooks")], { query: "Herb Brooks" }, ctx()),
    /deferred to an external agent/,
  );
});

function countingProvider(name) {
  let calls = 0;
  REGISTRY[name] = {
    name, kind: "search", corpus: "archive",
    configured: () => true,
    provide: async () => { calls += 1; return [{ provider: name, title: "anything", bytes: png, mime: "image/png" }]; },
  };
  return { entry: { provider: name }, calls: () => calls };
}

test("a scoring stage with the agent judge fails before any provider is called", async () => {
  const p = countingProvider("agent-refuse-staged");
  const legacy = countingProvider("agent-refuse-legacy");
  try {
    await assert.rejects(
      () => run({ query: "x" }, {
        judge: { provider: "agent" },
        stages: [{ gather: [p.entry] }, { score: "judge" }, { select: "best" }],
      }, {}),
      /judge "agent" is deferred.*select: "defer"/s,
    );
    await assert.rejects(
      () => run({ query: "x" }, {
        judge: { provider: "agent" },
        stages: [{ gather: [p.entry] }, { select: "compare" }],
      }, {}),
      /judge "agent" is deferred/,
    );
    // The legacy pipeline form always judges in-process.
    await assert.rejects(
      () => run({ query: "x" }, { judge: { provider: "agent" }, pipeline: [legacy.entry] }, {}),
      /judge "agent" is deferred/,
    );
    assert.equal(p.calls(), 0, "no provider may be billed on the way to refusing");
    assert.equal(legacy.calls(), 0);
  } finally {
    delete REGISTRY["agent-refuse-staged"];
    delete REGISTRY["agent-refuse-legacy"];
  }
});

test("the agent judge runs a deferred pipeline without ever being asked to score", async () => {
  const p = countingProvider("agent-defer-src");
  try {
    const result = await run({ query: "x" }, {
      judge: { provider: "agent" },
      stages: [{ gather: [p.entry] }, { filter: "usable-license" }, { score: "title-adjacency" }, { select: "defer" }],
    }, {});
    assert.equal(result.ok, false, "deferring is not a success — nothing was chosen");
    assert.equal(result.pool.length, 1);
    assert.equal(p.calls(), 1);
  } finally {
    delete REGISTRY["agent-defer-src"];
  }
});

test("the built-in agent profile names the agent judge and defers", () => {
  assert.equal(BUILT_IN_PROFILES.agent.judge.provider, "agent");
  assert.ok(BUILT_IN_PROFILES.agent.stages.some((s) => s.select === "defer"));
  assert.ok(!BUILT_IN_PROFILES.agent.stages.some((s) => s.score === "judge" || s.select === "compare"));
});
