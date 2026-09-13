import assert from "node:assert/strict";
import test from "node:test";

import { JUDGES, JudgeUnavailableError, REGISTRY, run } from "../dist/index.js";

test("best mode evaluates every candidate absolutely and preserves confusedWith", async () => {
  const providerA = "test-best-a";
  const providerB = "test-best-b";
  const judgeName = "test-best-judge";
  let evaluateCalls = 0;
  let selectCalls = 0;

  REGISTRY[providerA] = {
    name: providerA,
    kind: "search",
    configured: () => true,
    provide: async () => [
      { provider: providerA, bytes: Buffer.from("a1"), mime: "image/png", meta: { id: "a1" } },
      { provider: providerA, bytes: Buffer.from("a2"), mime: "image/png", meta: { id: "a2" } },
    ],
  };
  REGISTRY[providerB] = {
    name: providerB,
    kind: "search",
    configured: () => true,
    provide: async () => [
      { provider: providerB, bytes: Buffer.from("b1"), mime: "image/png", meta: { id: "b1" } },
    ],
  };
  const verdicts = {
    a1: { score: 0.3, passes: false, reason: "wrong subject", confusedWith: "lookalike a" },
    a2: { score: 0.8, passes: true, reason: "correct but weaker" },
    b1: { score: 0.9, passes: true, reason: "best correct image" },
  };
  JUDGES[judgeName] = {
    name: judgeName,
    configured: () => true,
    evaluate: async (candidate) => {
      evaluateCalls += 1;
      return verdicts[candidate.meta.id];
    },
    select: async () => {
      selectCalls += 1;
      return { index: 0, verdict: { score: 1, passes: true, reason: "must not run" } };
    },
  };

  try {
    const result = await run(
      { query: "specific subject" },
      {
        judge: { provider: judgeName },
        mode: "best",
        pipeline: [{ provider: providerA }, { provider: providerB }],
      },
      {},
    );

    assert.equal(evaluateCalls, 3);
    assert.equal(selectCalls, 0);
    assert.equal(result.ok, true);
    assert.equal(result.candidate.provider, providerB);
    assert.equal(result.attempts.length, 3);
    assert.equal(result.attempts[0].confusedWith, "lookalike a");
  } finally {
    delete REGISTRY[providerA];
    delete REGISTRY[providerB];
    delete JUDGES[judgeName];
  }
});

test("explicit parallel stages remain comparative", async () => {
  const providerA = "test-parallel-a";
  const providerB = "test-parallel-b";
  const judgeName = "test-parallel-judge";
  let evaluateCalls = 0;
  let selectCalls = 0;

  for (const name of [providerA, providerB]) {
    REGISTRY[name] = {
      name,
      kind: "search",
      configured: () => true,
      provide: async () => [{ provider: name, bytes: Buffer.from(name), mime: "image/png" }],
    };
  }
  JUDGES[judgeName] = {
    name: judgeName,
    configured: () => true,
    evaluate: async () => {
      evaluateCalls += 1;
      return { score: 0, passes: false, reason: "must not run" };
    },
    select: async () => {
      selectCalls += 1;
      return { index: 1, verdict: { score: 0.9, passes: true, reason: "comparative winner" } };
    },
  };

  try {
    const result = await run(
      { query: "parallel subject" },
      {
        judge: { provider: judgeName },
        pipeline: [{ parallel: [{ provider: providerA }, { provider: providerB }] }],
      },
      {},
    );

    assert.equal(evaluateCalls, 0);
    assert.equal(selectCalls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.candidate.provider, providerB);
  } finally {
    delete REGISTRY[providerA];
    delete REGISTRY[providerB];
    delete JUDGES[judgeName];
  }
});

test("judged remote bytes are frozen once and provider failures remain attempts", async () => {
  const changingProvider = "test-changing-bytes";
  const brokenProvider = "test-broken-provider";
  const judgeName = "test-frozen-bytes-judge";
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  REGISTRY[brokenProvider] = {
    name: brokenProvider,
    kind: "search",
    configured: () => true,
    provide: async () => { throw new Error("offline fixture failure"); },
  };
  REGISTRY[changingProvider] = {
    name: changingProvider,
    kind: "search",
    configured: () => true,
    provide: async () => [{ provider: changingProvider, url: "https://fixture.invalid/image", mime: "image/png" }],
  };
  JUDGES[judgeName] = {
    name: judgeName,
    configured: () => true,
    evaluate: async (candidate) => {
      assert.deepEqual(candidate.bytes, Buffer.from("judged-bytes"));
      return { score: 0.9, passes: true, reason: "exact frozen bytes" };
    },
  };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(fetchCalls === 1 ? Buffer.from("judged-bytes") : Buffer.from("different-bytes"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };

  try {
    const result = await run(
      { query: "frozen subject" },
      {
        judge: { provider: judgeName },
        mode: "best",
        pipeline: [{ provider: brokenProvider }, { provider: changingProvider }],
      },
      {},
    );
    assert.equal(fetchCalls, 1);
    assert.deepEqual(result.bytes, Buffer.from("judged-bytes"));
    assert.match(result.attempts[0].reason, /provider error: offline fixture failure/);
    assert.equal(result.attempts.at(-1).passes, true);
  } finally {
    globalThis.fetch = originalFetch;
    delete REGISTRY[brokenProvider];
    delete REGISTRY[changingProvider];
    delete JUDGES[judgeName];
  }
});

// ── A dead judge is not a strict one ────────────────────────────────────────
// A 429, an expired key, an exhausted balance: the scorer throws on every
// candidate, each scores 0, and a run that carried on would report "no
// acceptable image" for a subject nobody looked at. The engine stops instead.

const png = Buffer.from("89504e470d0a1a0a", "hex");
function fixtureProvider(name, titles, onProvide = () => {}) {
  REGISTRY[name] = {
    name, kind: "search", corpus: "archive",
    configured: () => true,
    provide: async () => { onProvide(); return titles.map((title) => ({ provider: name, title, bytes: png, mime: "image/png" })); },
  };
  return { provider: name };
}
function throwingJudge(name, shouldThrow = () => true) {
  JUDGES[name] = {
    name,
    configured: () => true,
    evaluate: async (c) => {
      if (shouldThrow(c)) throw new Error("judge OpenAI 429: insufficient_quota");
      return { score: 0.9, passes: true, reason: "fine" };
    },
  };
}

test("a score stage on which every candidate errors throws JudgeUnavailableError before the next gather", async () => {
  const judgeName = "dead-judge-staged";
  throwingJudge(judgeName);
  let secondGathers = 0;
  const first = fixtureProvider("dead-first", ["a", "b", "c"]);
  const second = fixtureProvider("dead-second", ["d"], () => { secondGathers += 1; });

  try {
    await assert.rejects(
      () => run({ query: "x" }, {
        judge: { provider: judgeName },
        stages: [
          { gather: [first] }, { score: "judge" }, { filter: "min-score" }, { select: "best" },
          { gather: [second] }, { score: "judge" }, { select: "best" },
        ],
      }, {}),
      (e) => {
        assert.ok(e instanceof JudgeUnavailableError, `expected JudgeUnavailableError, got ${e?.name}: ${e?.message}`);
        assert.equal(e.name, "JudgeUnavailableError");
        assert.equal(e.scorer, "judge");
        assert.equal(e.judge, judgeName);
        assert.equal(e.candidates, 3);
        assert.equal(e.scorerErrors, 3);
        assert.deepEqual(e.errors, ["judge OpenAI 429: insufficient_quota"]);
        assert.equal(e.profile, "inline");
        assert.match(e.message, /unavailable, not strict/);
        assert.match(e.message, /insufficient_quota/);
        // The trace up to the failure rides along, one flagged entry per error.
        assert.equal(e.attempts.filter((a) => a.scorerError).length, 3);
        return true;
      },
    );
    assert.equal(secondGathers, 0, "a dead judge must not bill the next gather");
  } finally {
    delete JUDGES[judgeName];
    delete REGISTRY["dead-first"];
    delete REGISTRY["dead-second"];
  }
});

test("it does not fire when only some candidates error", async () => {
  const judgeName = "half-dead-judge";
  throwingJudge(judgeName, (c) => c.title === "b");
  const p = fixtureProvider("half-dead", ["a", "b"]);
  try {
    const result = await run({ query: "x" }, {
      judge: { provider: judgeName },
      stages: [{ gather: [p] }, { score: "judge" }, { filter: "min-score" }, { select: "best" }],
    }, {});
    assert.equal(result.ok, true);
    assert.equal(result.candidate.title, "a");
    assert.equal(result.scorerErrors, 1);
    assert.equal(result.attempts.filter((a) => a.scorerError).length, result.scorerErrors);
  } finally {
    delete JUDGES[judgeName];
    delete REGISTRY["half-dead"];
  }
});

test("whenUnavailable: continue records the outage and carries on", async () => {
  const judgeName = "dead-judge-continue";
  throwingJudge(judgeName);
  const p = fixtureProvider("dead-continue", ["a", "b"]);
  try {
    const result = await run({ query: "x" }, {
      judge: { provider: judgeName, whenUnavailable: "continue" },
      stages: [{ gather: [p] }, { score: "judge" }, { filter: "min-score" }, { select: "best" }],
    }, {});
    assert.equal(result.ok, false);
    assert.equal(result.scorerErrors, 2);
    assert.equal(result.attempts.filter((a) => a.scorerError).length, 2);
    // Every stored reason says what happened; none says "scored 0.00".
    assert.ok(result.attempts.filter((a) => /scorer error/.test(a.reason)).length >= 2);
    assert.ok(!result.attempts.some((a) => /scored 0\.00/.test(a.reason)));
  } finally {
    delete JUDGES[judgeName];
    delete REGISTRY["dead-continue"];
  }
});

test("a deferred pool still reports scorer errors, once each", async () => {
  const judgeName = "dead-judge-defer";
  throwingJudge(judgeName, (c) => c.title === "b");
  const p = fixtureProvider("dead-defer", ["a", "b"]);
  try {
    const result = await run({ query: "x" }, {
      judge: { provider: judgeName },
      stages: [{ gather: [p] }, { score: "judge" }, { select: "defer" }],
    }, {});
    assert.equal(result.scorerErrors, 1);
    assert.equal(result.attempts.filter((a) => a.scorerError).length, 1);
    assert.equal(result.pool.find((c) => c.title === "b").scorerError, "judge OpenAI 429: insufficient_quota");
    assert.equal(result.pool.find((c) => c.title === "a").scorerError, undefined);
  } finally {
    delete JUDGES[judgeName];
    delete REGISTRY["dead-defer"];
  }
});

test("a comparative select that throws is the same outage for the whole pool", async () => {
  const judgeName = "dead-judge-compare";
  JUDGES[judgeName] = {
    name: judgeName,
    configured: () => true,
    evaluate: async () => { throw new Error("must not run"); },
    select: async () => { throw new Error("judge OpenAI 401: invalid_api_key"); },
  };
  const p = fixtureProvider("dead-compare", ["a", "b"]);
  try {
    await assert.rejects(
      () => run({ query: "x" }, {
        judge: { provider: judgeName },
        stages: [{ gather: [p] }, { select: "compare" }],
      }, {}),
      (e) => e instanceof JudgeUnavailableError && e.candidates === 2 && /invalid_api_key/.test(e.message),
    );
  } finally {
    delete JUDGES[judgeName];
    delete REGISTRY["dead-compare"];
  }
});

test("the legacy pipeline path stops on a dead judge too, and survives a partial one", async () => {
  const dead = "legacy-dead-judge";
  const partial = "legacy-partial-judge";
  throwingJudge(dead);
  throwingJudge(partial, (c) => c.title === "b");
  const p = fixtureProvider("legacy-outage", ["a", "b"]);
  try {
    await assert.rejects(
      () => run({ query: "x" }, { judge: { provider: dead }, mode: "best", pipeline: [p] }, {}),
      (e) => e instanceof JudgeUnavailableError && e.judge === dead && e.candidates === 2,
    );
    const result = await run({ query: "x" }, { judge: { provider: partial }, mode: "best", pipeline: [p] }, {});
    assert.equal(result.ok, true);
    assert.equal(result.scorerErrors, 1);
    const flagged = result.attempts.filter((a) => a.scorerError);
    assert.equal(flagged.length, 1);
    assert.match(flagged[0].reason, /^scorer error: judge OpenAI 429/);
  } finally {
    delete JUDGES[dead];
    delete JUDGES[partial];
    delete REGISTRY["legacy-outage"];
  }
});
