import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILT_IN_PROFILES, FILTERS, JUDGES, REGISTRY, getProfile, listProfiles, run, titleAdjacency,
  unusableLicense,
} from "../dist/index.js";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const ctx = { env: {}, options: {}, log: () => {}, corpusOf: () => "archive" };
const stockCtx = { ...ctx, corpusOf: () => "stock" };

const verdict = (query, title, c = ctx) =>
  titleAdjacency.score({ provider: "fixture", title }, { query }, c);

// ── The field report's own worked examples ──────────────────────────────────
// Every case below is a real pick from the 2026-08-19 sourcing run. All of them
// scored WELL on relevance; the title check is what separates them.
test("title-adjacency reproduces every worked example in the field report", () => {
  const rejects = [
    ["Carl Lewis", "Carl Nielsen, Danish composer", "shared first name, different person"],
    ["Oksana Baiul", "Oksana Zabuzhko, writer", "shared first name, different person"],
    ["Al Oerter", "Plate depicting Harun Al-Rashid", "shared fragment, different subject"],
    ["John Shuster", "John Sloan by Will Shuster", "both words present, two different people"],
    ["Elaine Thompson-Herah", "Thompson's gazelle in Nakuru, Kenya", "surname only, different subject"],
  ];
  for (const [query, title, why] of rejects) {
    assert.equal(verdict(query, title).passes, false, `${query} ← ${title} (${why})`);
  }

  const keeps = [
    ["Herb Brooks", "Herb Brooks 1983"],
    ["Hoover Dam Black Canyon", "Hoover Dam, Nevada"],   // partial place name is still the place
  ];
  for (const [query, title] of keeps) {
    assert.equal(verdict(query, title).passes, true, `${query} ← ${title}`);
  }
});

// Splitting on the hyphen is what lets the maiden-name record match. Without it
// "Thompson-Herah" is one token that never matches a bare "Thompson".
test("hyphenated names split, so a maiden-name record still matches", () => {
  assert.equal(verdict("Elaine Thompson-Herah", "Elaine Thompson Beijing 2015").passes, true);
});

// Rule 8: a stock caption describes a scene, so one shared word is coincidence.
// The same one-word test is safe against an archive, whose records name subjects.
test("a one-word subject is confirmable against an archive but never against stock", () => {
  const stock = verdict("Curling", "a stylist curling blonde hair into glamorous curls", stockCtx);
  assert.equal(stock.passes, false);
  assert.match(stock.reason, /stock caption/);

  // Single-word terms are not proper nouns, so identity is not asserted at all.
  const archive = verdict("Strigil", "Bronze strigil, Metropolitan Museum of Art");
  assert.equal(archive.passes, true);
});

// A floor for EVERY multi-word term, named or not. One shared word is a
// coincidence: "Roman mosaic of theatrical masks" matched "Roman Kostrzewski", a
// Polish metal singer, on the single token `roman` — three separate times.
test("one shared word is a coincidence, not a match", () => {
  const thin = verdict("cliff dwelling in a red rock alcove", "sandstone alcove at golden hour");
  assert.equal(thin.passes, false, "sharing only 'alcove' is not a match");
  assert.match(thin.reason, /coincidence/);

  const real = verdict("cliff dwelling in a red rock alcove", "cliff dwelling in a sandstone alcove");
  assert.equal(real.passes, true);
});

// The name inside a descriptive phrase still has to be matched AS a name — a
// whole-string proper-noun test never fires for these.
test("a name embedded in a descriptive phrase is still guarded", () => {
  assert.equal(verdict("Cicero marble portrait bust", "Roman Kostrzewski live in Katowice").passes, false);
  assert.equal(verdict("Cicero marble portrait bust", "Cicero, marble bust, Musei Capitolini").passes, true);
});

// Structured identity beats string overlap: a file placed in a subject's Commons
// category was judged BY A PERSON to be about that subject, and its filename may
// share no word with the term at all.
test("curated identity outranks a weak title overlap", () => {
  const plain = titleAdjacency.score(
    { provider: "fixture", title: "Hercules Stiernhielm portrait" }, { query: "Hercules Stiernhielm" }, ctx);
  const curated = titleAdjacency.score(
    { provider: "fixture", title: "Hercules Stiernhielm portrait", meta: { identityVerifiedBy: "commons-category" } },
    { query: "Hercules Stiernhielm" }, ctx);
  assert.ok(curated.score >= plain.score);
  assert.ok(curated.score >= 0.72);
  assert.match(curated.reason, /identity verified by commons-category/);
});

test("a named subject with no title at all cannot be confirmed", () => {
  const v = titleAdjacency.score({ provider: "unsplash", title: undefined }, { query: "Sonja Henie" }, stockCtx);
  assert.equal(v.passes, false);
  assert.match(v.reason, /supplied no title/);
});

// ── Executor ────────────────────────────────────────────────────────────────

function fixtureProvider(name, candidates, corpus = "archive") {
  REGISTRY[name] = {
    name, corpus, kind: "search",
    configured: () => true,
    provide: async () => candidates.map((c) => ({ provider: name, bytes: png, mime: "image/png", ...c })),
  };
  return { provider: name };
}

test("a chain of gather/select pairs cascades: the precise source wins outright", async () => {
  const first = fixtureProvider("stage-archive", [{ title: "Herb Brooks 1983" }]);
  const second = fixtureProvider("stage-stock", [{ title: "a hockey coach shouting" }], "stock");

  const result = await run({ query: "Herb Brooks" }, {
    judge: { provider: "none" },
    stages: [
      { gather: [first] }, { score: "title-adjacency" }, { filter: "passing" }, { select: "first" },
      { gather: [second] }, { score: "none" }, { select: "first" },
    ],
  }, {});

  assert.equal(result.ok, true);
  assert.equal(result.candidate.provider, "stage-archive");
});

test("...and falls through to the next gather when nothing survives", async () => {
  const first = fixtureProvider("fall-archive", [{ title: "Carl Nielsen, composer" }]);
  const second = fixtureProvider("fall-stock", [{ title: "anything at all" }], "stock");

  const result = await run({ query: "Carl Lewis" }, {
    judge: { provider: "none" },
    stages: [
      { gather: [first] }, { score: "title-adjacency" }, { filter: "passing" }, { select: "first" },
      { gather: [second] }, { score: "none" }, { select: "first" },
    ],
  }, {});

  assert.equal(result.ok, true);
  assert.equal(result.candidate.provider, "fall-stock", "should have fallen through");
  // The wrong-subject drop stays visible in the trace.
  assert.ok(result.attempts.some((a) => /passing: /.test(a.reason)), "the drop must be recorded");
});

test("a dropped candidate is recorded rather than vanishing silently", async () => {
  const p = fixtureProvider("drop-src", [{ title: "Carl Nielsen" }, { title: "Carl Lewis at the 1984 Games" }]);
  const result = await run({ query: "Carl Lewis" }, {
    judge: { provider: "none" },
    stages: [{ gather: [p] }, { score: "title-adjacency" }, { filter: "passing" }, { select: "best" }],
  }, {});

  assert.equal(result.candidate.title, "Carl Lewis at the 1984 Games");
  const dropped = result.attempts.filter((a) => a.reason.startsWith("passing:"));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /Carl Nielsen/);
});

// The agent-in-the-loop path: the library gathers and checks, the CALLER decides.
test("select defer returns the scored pool instead of choosing", async () => {
  const p = fixtureProvider("defer-src", [{ title: "Sonja Henie 1936" }, { title: "a flock of birds" }]);
  const result = await run({ query: "Sonja Henie" }, {
    judge: { provider: "none" },
    stages: [{ gather: [p] }, { score: "title-adjacency" }, { select: "defer" }],
  }, {});

  assert.equal(result.ok, false, "deferring is not a success — nothing was chosen");
  assert.equal(result.candidate, undefined);
  assert.equal(result.pool.length, 2);
  // The evidence rides along, so the agent reads verdicts rather than guessing from pixels.
  const named = result.pool.find((c) => c.title === "Sonja Henie 1936");
  assert.equal(named.passes, true);
  assert.equal(result.pool.find((c) => c.title === "a flock of birds").passes, false);
});

test("a scorer that needs the judge fails closed when the judge is unconfigured", async () => {
  const p = fixtureProvider("needs-judge", [{ title: "anything" }]);
  await assert.rejects(
    () => run({ query: "x" }, {
      judge: { provider: "openai" },
      stages: [{ gather: [p] }, { score: "judge" }, { select: "first" }],
    }, {}),
    /not configured/,
  );
});

// ── Profiles ────────────────────────────────────────────────────────────────

test("built-in profiles are well formed", () => {
  for (const [name, profile] of Object.entries(BUILT_IN_PROFILES)) {
    assert.equal(profile.name, name, `${name} must name itself`);
    assert.ok(profile.description, `${name} needs a description`);
    assert.ok(profile.stages.some((s) => Array.isArray(s.gather)), `${name} must gather`);
    assert.ok(profile.stages.some((s) => s.select !== undefined), `${name} must select`);
  }
});

// A candidate that can never be used must never cost a judge call — or any
// score at all. The gate sits between the first gather and the first scorer.
test("every built-in profile drops NC/ND before anything scores", () => {
  const usesLicenseGate = (s) => {
    if (s.filter === undefined) return false;
    const specs = Array.isArray(s.filter) ? s.filter : [s.filter];
    return specs.some((f) => (typeof f === "string" ? f : f.filter) === "usable-license");
  };
  for (const [name, profile] of Object.entries(BUILT_IN_PROFILES)) {
    const gate = profile.stages.findIndex(usesLicenseGate);
    const firstScore = profile.stages.findIndex((s) => s.score !== undefined || s.select === "compare");
    assert.ok(gate >= 0, `${name} must run usable-license`);
    assert.ok(firstScore < 0 || gate < firstScore, `${name} must gate licences before it scores`);
  }
});

test("archive-first checks identity before it spends a judge call", () => {
  const stages = BUILT_IN_PROFILES["archive-first"].stages;
  const deterministic = stages.findIndex((s) => s.score === "title-adjacency");
  const judged = stages.findIndex((s) => s.score === "judge");
  assert.ok(deterministic >= 0 && judged >= 0);
  assert.ok(deterministic < judged, "a relevance score must not get the chance to rescue a wrong subject");
});

test("a config-defined profile overrides a built-in of the same name", () => {
  const overrides = { verified: { description: "mine", stages: [{ gather: [{ provider: "wikipedia" }] }, { select: "first" }] } };
  assert.equal(getProfile("verified", overrides).description, "mine");
  assert.equal(getProfile("verified").description, BUILT_IN_PROFILES.verified.description);
  assert.ok(listProfiles(overrides).some((p) => p.name === "verified" && p.description === "mine"));
});

test("an unknown profile names the ones that exist", () => {
  assert.throws(() => getProfile("nope"), /unknown profile "nope".*archive-first/s);
});

test("a profile runs end to end via run()", async () => {
  const p = fixtureProvider("profile-src", [{ title: "Herb Brooks 1983" }]);
  const result = await run({ query: "Herb Brooks" }, {
    judge: { provider: "none" },
    profile: "custom",
    profiles: {
      custom: { stages: [{ gather: [p] }, { score: "title-adjacency" }, { filter: "passing" }, { select: "best" }] },
    },
  }, {});
  assert.equal(result.ok, true);
  assert.equal(result.profile, "custom");
});

// ── no-other-name ───────────────────────────────────────────────────────────
// The three-way split. "No name match" is two different things: a title that
// names NOTHING (generic — imprecise but honest, and often the best answer
// available) and a title that names something ELSE (a different subject,
// captioned as such, presented as ours — the falsehood).
const rejectName = (query, title) =>
  FILTERS["no-other-name"].reject({ provider: "fixture", title }, { query }, ctx, {});

test("no-other-name rejects a different named subject but allows a generic one", () => {
  // The real miss: a card about the Stoa Poikile was given the Stoa of Attalos.
  assert.match(
    rejectName("Stoa Poikile Athenian Agora", "Stoa of Attalos, Athens") ?? "",
    /names a different subject/,
  );
  assert.match(
    rejectName("Empire State Building", "the Chrysler Building at dusk") ?? "",
    /names a different subject/,
  );

  // Loosely related is acceptable — a generic example names nothing, so nothing
  // is being asserted falsely. This is what a strict name check wrongly killed.
  assert.equal(rejectName("Stoa Poikile Athenian Agora", "a ruined colonnade at sunset"), null);
  assert.equal(rejectName("Empire State Building", "a Manhattan skyscraper at sunset"), null);

  // And the subject itself obviously passes.
  assert.equal(rejectName("Empire State Building", "Empire State Building from Rockefeller Center"), null);
});

test("no-other-name cannot convict a candidate that has no title", () => {
  assert.equal(rejectName("Empire State Building", undefined), null);
  assert.equal(rejectName("Empire State Building", ""), null);
});

// ── whenUnique ──────────────────────────────────────────────────────────────
// The judge reports uniqueness; the caller decides what to do about it. For a
// KIND of thing any good example is correct. For one particular thing, a
// merely-similar image is a near-miss rather than an answer.
const reject = (scored, options) =>
  FILTERS["min-score"].reject({ provider: "fixture", ...scored }, {}, ctx, options);

test("whenUnique applies a stricter floor only to unique subjects", () => {
  const near = { score: 0.6, passes: true, reason: "" };

  // No whenUnique set: the ordinary floor governs, unique or not.
  assert.equal(reject({ ...near, subjectIsUnique: true }, { min: 0.5 }), null);

  // A KIND clears the ordinary floor.
  assert.equal(reject({ ...near, subjectIsUnique: false }, { min: 0.5, whenUnique: 0.8 }), null);

  // The same score on a UNIQUE subject does not.
  const why = reject({ ...near, subjectIsUnique: true }, { min: 0.5, whenUnique: 0.8 });
  assert.match(why ?? "", /0\.8/);
  assert.match(why ?? "", /subject is unique/);

  // And a genuinely good image of the unique thing still passes.
  assert.equal(reject({ score: 0.95, passes: true, reason: "", subjectIsUnique: true },
    { min: 0.5, whenUnique: 0.8 }), null);
});

test("an unjudged candidate is unaffected by whenUnique", () => {
  // subjectIsUnique is undefined when no judge ran; the ordinary floor applies.
  assert.equal(reject({ score: 0.6, passes: true, reason: "" }, { min: 0.5, whenUnique: 0.8 }), null);
});

// ── scorer errors are not verdicts ──────────────────────────────────────────
// A scorer that threw left score 0 behind. "scored 0.00 < 0.7" is a sentence
// about the picture, and nothing looked at the picture: a 429 or an expired key
// must survive into the stored trace as what it was.
test("min-score and passing pass a scorer error through instead of composing a verdict over it", () => {
  const errored = { score: 0, passes: false, reason: "scorer error: judge OpenAI 429: rate limited", scorerError: "judge OpenAI 429: rate limited" };
  assert.equal(reject(errored, { min: 0.7 }), "scorer error: judge OpenAI 429: rate limited");
  assert.equal(reject({ ...errored, subjectIsUnique: true }, { min: 0.5, whenUnique: 0.8 }),
    "scorer error: judge OpenAI 429: rate limited");
  assert.equal(FILTERS.passing.reject({ provider: "fixture", ...errored }, {}, ctx, {}),
    "scorer error: judge OpenAI 429: rate limited");

  // A genuine 0 from a scorer that ran is still judged as a score.
  assert.match(reject({ score: 0, passes: false, reason: "wrong subject" }, { min: 0.7 }) ?? "", /scored 0\.00 < 0\.7/);
});

test("a throwing scorer leaves 'scorer error' in the stored reason after min-score", async () => {
  const judgeName = "stages-partial-outage";
  JUDGES[judgeName] = {
    name: judgeName,
    configured: () => true,
    evaluate: async (c) => {
      if (c.title === "second") throw new Error("judge OpenAI 429: insufficient_quota");
      return { score: 0.9, passes: true, reason: "fine" };
    },
  };
  const p = fixtureProvider("outage-src", [{ title: "first" }, { title: "second" }]);
  try {
    const result = await run({ query: "x" }, {
      judge: { provider: judgeName },
      stages: [{ gather: [p] }, { score: "judge" }, { filter: "min-score" }, { select: "best" }],
    }, {});

    // Only one candidate errored, so the judge is not dead and the run completes.
    assert.equal(result.ok, true);
    assert.equal(result.candidate.title, "first");
    assert.equal(result.scorerErrors, 1);

    // The error is recorded as an error, with the dedicated field…
    const flagged = result.attempts.filter((a) => a.scorerError);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].scorerError, "judge OpenAI 429: insufficient_quota");
    assert.match(flagged[0].reason, /^scorer error: /);

    // …and the filter's drop entry keeps that text instead of "scored 0.00 < 0.7".
    const dropped = result.attempts.find((a) => a.reason.startsWith("min-score:"));
    assert.equal(dropped.reason, "min-score: scorer error: judge OpenAI 429: insufficient_quota");
    assert.ok(!result.attempts.some((a) => /scored 0\.00/.test(a.reason)), "the outage must not be stored as a verdict");
  } finally {
    delete JUDGES[judgeName];
  }
});

test("stock-safe screens competing names before it spends a judge call", () => {
  const stages = BUILT_IN_PROFILES["stock-safe"].stages;
  const screened = stages.findIndex((s) => s.filter === "no-other-name");
  const judged = stages.findIndex((s) => s.score === "judge");
  assert.ok(screened >= 0 && judged >= 0);
  assert.ok(screened < judged, "a different named subject must not reach the judge at all");
  // And it must NOT use the strict adjacency check: stock captions do not name
  // ancient philosophers, so requiring a match kills the honest generics too.
  assert.ok(!stages.some((s) => s.score === "title-adjacency"));
});

// ── usable-license ──────────────────────────────────────────────────────────
// NoDerivatives is breached by any consumer that resizes or re-encodes; NonCommercial
// the moment anything is monetised. 143 NC and 82 ND images reached a production
// catalogue before this gate existed, most of them from the archives — the corpus a
// named subject is sent to first — because the consumer's first version read only
// the first token of the licence string. Every case asserts BOTH directions: a
// reject-predicate only ever seen returning null is indistinguishable from one
// that always does.
const lic = (license, options = {}) =>
  FILTERS["usable-license"].reject({ provider: "fixture", license }, {}, ctx, options);

test("unusableLicense reads every token, not the first", () => {
  // The strings actually found in a consumer's image manifest.
  assert.equal(unusableLicense("wallyg (Openverse) · by-nc-nd 2.0"), "nd", "Openverse lowercase by-nc-nd");
  assert.equal(unusableLicense("APK · CC BY-NC-ND 2.0"), "nd", 'Wikimedia "CC BY-NC-ND 2.0" — the clause is the SECOND token');
  assert.equal(unusableLicense("someone · CC BY-NC 4.0"), "nc", "NonCommercial alone is refused");
  assert.equal(unusableLicense("someone · by-nd"), "nd", "NoDerivatives alone is refused");
  assert.equal(unusableLicense("CC BY-NC-SA 3.0"), "nc", "NC survives an SA clause");

  // Everything a catalogue legitimately serves.
  assert.equal(unusableLicense("APK · CC BY 4.0"), null, "plain CC BY must serve");
  assert.equal(unusableLicense("someone · CC BY-SA 3.0"), null, "ShareAlike is usable");
  assert.equal(unusableLicense("CC0"), null, "public domain is usable");
  assert.equal(unusableLicense("Pexels · Jane Doe"), null, "a Pexels credit must never be read as a licence code");
  assert.equal(unusableLicense("AI-generated (gpt-image-1.5)"), null, "generated images must serve");
  assert.equal(unusableLicense("Unsplash · Someone"), null, "Unsplash must serve");
  assert.equal(unusableLicense(""), null, "no claim is not a refusal");
  assert.equal(unusableLicense(undefined), null, "no claim is not a refusal");
});

test("a bare code is a clause only when it is the whole field or CC is named", () => {
  // The trap the first version fell into: prose words are not clause codes.
  assert.equal(unusableLicense("Photo by ND Smith, National Archives"), null,
    '"ND" as somebody\'s initials inside prose is not a NoDerivatives clause');
  assert.equal(unusableLicense("Nic Coury for the NC Museum"), null,
    '"NC" inside a proper noun is not a NonCommercial clause');
  // A bare code that IS the whole field is a clause; the same code inside prose is not.
  assert.equal(unusableLicense("ND"), "nd", 'a license field that is literally "ND" is a clause');
  assert.equal(unusableLicense("NC"), "nc", 'so is a bare "NC"');
  assert.equal(unusableLicense("nc"), "nc");
});

test("usable-license fires on the two clauses that cannot be honoured", () => {
  assert.ok(lic("by-nd 2.0"), "rejects by-nd");
  assert.ok(lic("by-nc 2.0"), "rejects by-nc");
  assert.ok(lic("by-nc-sa 2.0"), "rejects by-nc-sa");
  assert.ok(lic("by-nc-nd 2.0"), "rejects by-nc-nd");
  assert.match(lic("by-nc-nd 2.0"), /NoDerivatives/, "names ND first — it is the clause already being broken");
  assert.match(lic("by-nc-sa 4.0"), /NonCommercial/, "names NC when ND is absent");

  // The format the ARCHIVES use, and the reason the consumer's filter was half-blind.
  assert.ok(lic("CC BY-NC-SA 3.0"), "rejects the CC-prefixed Wikimedia format (was silently allowed)");
  assert.ok(lic("CC BY-NC-ND 2.0"), "rejects CC BY-NC-ND (was silently allowed)");
  assert.ok(lic("CC-BY-NC"), "rejects the hyphenated Wellcome id");
  assert.ok(lic("Attribution-NonCommercial-NoDerivatives 4.0 International"), "rejects the spelled-out Creative Commons name");
  assert.ok(lic("Attribution-NonCommercial 4.0"), "rejects the spelled-out NonCommercial");
  assert.ok(lic("ND"), "a bare clause code is still a clause");
  assert.ok(lic("nc"), "so is a bare lowercase one");
});

test("usable-license stays silent on everything a catalogue legitimately runs on", () => {
  for (const ok of [
    "by-sa 2.0", "by 2.0", "CC BY-SA 4.0", "CC BY 2.0", "cc0 1.0", "CC0", "CC0 (verify)",
    "pdm 1.0", "Public Domain", "Public Domain (NASA — verify usage)",
    "Pexels License", "Unsplash License",
    "No known restrictions (verify at source)", "See Wikimedia Commons (per-file)",
  ]) assert.equal(lic(ok), null, `allows ${JSON.stringify(ok)}`);

  // Unknown is ALLOWED on purpose: this rejects the two clauses we know cannot be
  // honoured, it does not adjudicate every licence in the world.
  assert.equal(lic(""), null, "a candidate claiming no licence is not rejected here");
  assert.equal(lic(undefined), null, "a missing licence field does not throw");
  assert.equal(lic("Some Museum Terms of Use"), null, "an unrecognised licence is allowed, not guessed at");
});

test("usable-license matches licence codes, never attribution names", () => {
  // The clause vocabulary enforces it: "ndlovu" is not a clause word, so the
  // token is never read as a licence code at all.
  assert.equal(lic("CC BY 2.0 — photo by Sipho Ndlovu"), null, "a photographer named Ndlovu does not trip the ND clause");
  assert.equal(lic("Ndlovu · CC BY 4.0"), null);
  assert.equal(lic("Photo by ND Smith"), null);
  assert.equal(lic("CC BY-SA 4.0, Ndiaye/Ncube"), null, "nor do surnames beginning nc/nd");
  assert.equal(
    FILTERS["usable-license"].reject(
      { provider: "fixture", license: "CC BY 2.0", attribution: "Ndlovu, NoDerivatives Studio" }, {}, ctx, {}),
    null, "the attribution string is not consulted at all");
});

test("usable-license options let a consumer keep a clause it can honour", () => {
  assert.equal(lic("CC BY-NC 4.0", { allowNonCommercial: true }), null);
  assert.equal(lic("CC BY-ND 4.0", { allowNoDerivatives: true }), null);
  // Allowing one clause does not allow the other.
  assert.match(lic("CC BY-NC-ND 4.0", { allowNoDerivatives: true }), /NonCommercial/);
  assert.match(lic("CC BY-NC-ND 4.0", { allowNonCommercial: true }), /NoDerivatives/);
  assert.equal(lic("CC BY-NC-ND 4.0", { allowNonCommercial: true, allowNoDerivatives: true }), null);
});

test("an NC/ND candidate is dropped before the judge sees it, and the drop is recorded", async () => {
  const judgeName = "licence-gate-judge";
  const judged = [];
  JUDGES[judgeName] = {
    name: judgeName, configured: () => true,
    evaluate: async (c) => { judged.push(c.title); return { score: 0.9, passes: true, reason: "fine" }; },
  };
  const p = fixtureProvider("licence-src", [
    { title: "restricted", license: "CC BY-NC-ND 2.0" },
    { title: "free", license: "CC BY 4.0" },
  ]);
  try {
    const result = await run({ query: "x" }, {
      judge: { provider: judgeName },
      profile: "stock",
      profiles: { stock: { ...BUILT_IN_PROFILES.stock, stages: BUILT_IN_PROFILES.stock.stages.map((s) => (s.gather ? { gather: [p] } : s)) } },
    }, {});
    assert.deepEqual(judged, ["free"], "the NC/ND candidate must never cost a judge call");
    assert.equal(result.candidate.title, "free");
    const dropped = result.attempts.find((a) => a.reason.startsWith("usable-license:"));
    assert.match(dropped.reason, /NoDerivatives licence \(CC BY-NC-ND 2\.0\)/);
  } finally {
    delete JUDGES[judgeName];
  }
});
