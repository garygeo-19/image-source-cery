# Image Source-cery 🪄

**Ranked image sourcing, with a judge.**

Most image tools hand you *an* image. Image Source-cery hands you a *correct* one — it
walks a **ranked list of providers**, and a pluggable **judge** decides whether each
candidate actually depicts what you asked for. The first one that passes wins; if it
doesn't, the pipeline falls through to the next provider. Searching a source and
generating an image are the **same kind of thing** — both are just providers.

```
your ranked pipeline:   wikimedia → iNaturalist → diagram → generate → unsplash
                              │           │                    │
                          judge?       judge?               judge?      ← first PASS wins, stop
```

The judge is the magic: it's what caught "beets" returning a *strawberry plant* and
"Geronimo" returning the *wrong chief* — the failures every blind image search ships.

## Why

- **Unified providers** — search sources, generators, and diagram-makers all implement
  one tiny interface. Generation is just a provider that draws instead of finds.
- **You rank them** — per use case, set the order. Prefer free/verified sources first,
  fall back to paid search or generation only when needed.
- **A judge gates progression** — an LLM vision judge (default), a human, or none.
- **Bring your own credentials** — the tool ships **zero keys**. Config references your
  credentials by env-var *name*; secrets stay in your environment.
- **License-aware** — every candidate carries its license + attribution for provenance.
- **Fork-friendly** — add a source by writing one `Provider`. That's the whole surface.

## Install

```bash
npm install        # dev deps only (no runtime deps)
npm run build      # → dist/ ; then `npm link` to get the `imgsrcy` command
# or run straight from source:
npx tsx src/cli.ts find "saguaro cactus" --judge none --out ./saguaro.jpg
```

## Quick start

```bash
# keyless, no judge — fastest source wins
imgsrcy find "Sonoran Desert saguaro" --providers wikimedia,inaturalist --judge none --out out.jpg

# verified species, with an LLM judge and a negative constraint
imgsrcy find "Yarrow's spiny lizard" \
  --providers inaturalist,wikimedia,generate \
  --judge openai --min 0.75 \
  --must-not "desert spiny lizard" --out lizard.png

# see what you're configured for (no secrets printed)
imgsrcy doctor
```

## Demo UI

A zero-dependency web demo lets you watch the providers race for a term — see what
each one returns side by side, reorder/toggle them, then run the judged pipeline and
inspect the winner + decision trace.

```bash
npm run serve          # → http://localhost:5190  (or: npm run build && npm start)
```

- **Search term** → **Run gallery** sources from every enabled provider *in order* and
  shows their candidates with license + attribution.
- Drag the order with ▲ ▼ and toggle providers on/off; unconfigured ones (missing key)
  are greyed out — your **own** credentials, read from env, decide what's available.
- Pick a **judge** + **mode**, then **Run pipeline** to run the real ranked loop and see
  which candidate won and why (the full decision trace).

It calls the same engine the CLI does, over a tiny HTTP API (`GET /api/providers`,
`POST /api/search`, `POST /api/pipeline`). No keys are bundled; nothing leaves your machine.

## Configuration

Copy `image-sourcery.config.example.json` → `image-sourcery.config.json` and set your
ranked `pipeline` + `judge`. Credentials are referenced by env-var **name** only:

```jsonc
{
  "judge":   { "provider": "openai", "model": "gpt-4o-mini", "minScore": 0.7, "apiKeyEnv": "OPENAI_API_KEY" },
  "pipeline": [
    { "provider": "wikimedia" },
    { "provider": "inaturalist", "license": ["cc0", "cc-by"] },
    { "provider": "loc" },
    { "provider": "unsplash", "apiKeyEnv": "UNSPLASH_ACCESS_KEY" },
    { "provider": "generate", "model": "gpt-image-1", "apiKeyEnv": "OPENAI_API_KEY" }
  ]
}
```

Put keys in your shell env or a local `.env` (gitignored). Nothing is bundled.

## Built-in providers

| Provider | Key needed | Best for |
|---|---|---|
| `wikimedia` | none | niche subjects, species, science, historical |
| `inaturalist` | none | **community-verified species photos** (license-filterable) |
| `loc` | none | US historical people, places, events (public domain) |
| `openverse` | none | 800M+ CC-licensed images across many sources |
| `nasa` | none | space & earth science (public domain) |
| `met` | none | public-domain art & artifacts (The Met) |
| `smithsonian` | `SMITHSONIAN_API_KEY` | art, history, natural science (free key) |
| `unsplash` | `UNSPLASH_ACCESS_KEY` | modern stock photography, mood |
| `generate` | `OPENAI_API_KEY` | anything nothing else has (gpt-image-1) |

Judges: `openai` (vision), `human` (interactive), `none` (accept first).

### Modes

- **first-pass** (default) — stop at the first candidate that passes. Cheapest.
- **best** (`--best` or `"mode": "best"`) — judge *every* candidate from every
  provider and keep the highest scorer. More thorough (and more API calls); fixes
  "the first result was bad."

Every `--out` also writes a **provenance sidecar** (`<out>.json`): the source, license,
attribution, query, judge score + reason, and the full decision trace.

## Add a provider (the whole extension surface)

```ts
import type { Provider } from "image-sourcery";

export const flickr: Provider = {
  name: "flickr",
  kind: "search",
  configured: (ctx) => ctx.env[ctx.options.apiKeyEnv ?? "FLICKR_API_KEY"] ? true : "set FLICKR_API_KEY",
  async provide(req, ctx) {
    // ...return Candidate[] with { url, license, attribution, sourceUrl }
  },
};
```

Register it, drop it into your ranked `pipeline`, done.

## Roadmap

- ✅ Providers: Wikimedia, iNaturalist, LoC, Openverse, NASA, The Met, Smithsonian, Unsplash, generate
- ✅ Multi-candidate `--best` mode; provenance sidecar manifests
- ✅ Demo web UI (`npm run serve`) — gallery + judged pipeline over a tiny HTTP API
- More providers: Europeana, Flickr Commons, GBIF, Pexels, Pixabay
- More judges/generators: Anthropic & Gemini vision; Imagen, Flux, local Stable Diffusion
- **MCP server** so any agent (Claude Code, Cursor) can call it as tools
- Cost ledger + budgets, response/image caching
- Diagram lane: author SVGs as code (with no-answer-giveaway rules)

## License

MIT
