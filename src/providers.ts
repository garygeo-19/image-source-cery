import type { Provider, Candidate } from "./types.js";
import { getJSON } from "./util.js";

// ── Wikimedia Commons (no key) ────────────────────────────────────────────────
export const wikimedia: Provider = {
  name: "wikimedia",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const n = req.count ?? 5;
    const search = await getJSON(
      "https://commons.wikimedia.org/w/api.php?" +
        new URLSearchParams({
          action: "query", format: "json", list: "search",
          srsearch: req.query + " filetype:bitmap", srnamespace: "6",
          srlimit: String(n), origin: "*",
        }),
    );
    const out: Candidate[] = [];
    for (const r of (search.query?.search ?? []).slice(0, n)) {
      const info = await getJSON(
        "https://commons.wikimedia.org/w/api.php?" +
          new URLSearchParams({
            action: "query", format: "json", titles: r.title, prop: "imageinfo",
            iiprop: "url|mime|extmetadata", iiurlwidth: "1080", origin: "*",
          }),
      );
      const page: any = Object.values(info.query?.pages ?? {})[0];
      const ii = page?.imageinfo?.[0];
      if (!ii || !/^image\/(jpeg|png|webp|gif)$/.test(ii.mime ?? "")) continue;
      out.push({
        url: ii.thumburl || ii.url, mime: ii.mime, provider: "wikimedia", title: r.title,
        attribution: (ii.extmetadata?.Artist?.value ?? "").replace(/<[^>]+>/g, "").slice(0, 80) || "Wikimedia Commons",
        license: ii.extmetadata?.LicenseShortName?.value ?? "", sourceUrl: ii.descriptionurl,
      });
    }
    return out;
  },
};

// ── iNaturalist (no key) — research-grade, community-verified species photos ──
export const inaturalist: Provider = {
  name: "inaturalist",
  kind: "search",
  configured: () => true,
  async provide(req, ctx) {
    const allowed: string[] | undefined = ctx.options.license;
    const data = await getJSON(
      "https://api.inaturalist.org/v1/taxa?" +
        new URLSearchParams({ q: req.query, per_page: String(req.count ?? 5) }),
    );
    const out: Candidate[] = [];
    for (const t of data.results ?? []) {
      const p = t.default_photo;
      if (!p?.medium_url) continue;
      if (allowed && (!p.license_code || !allowed.includes(p.license_code))) continue;
      out.push({
        url: p.medium_url, provider: "inaturalist",
        title: t.preferred_common_name || t.name,
        attribution: p.attribution || "iNaturalist", license: p.license_code || "all-rights-reserved",
        sourceUrl: `https://www.inaturalist.org/taxa/${t.id}`,
        meta: { taxon: t.name, rank: t.rank },
      });
    }
    return out;
  },
};

// ── Library of Congress (no key) — US historical photos/prints/drawings ───────
export const loc: Provider = {
  name: "loc",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const data = await getJSON(
      "https://www.loc.gov/search/?" +
        new URLSearchParams({ q: req.query, fo: "json", fa: "online-format:image", c: "12" }),
    );
    const sizeOf = (u: string) => {
      const h = /#h=(\d+)/.exec(u); if (h) return +h[1];
      const px = /_(\d+)px\./.exec(u); if (px) return +px[1];
      return /v\.jpe?g/i.test(u) ? 9000 : 100;
    };
    const out: Candidate[] = [];
    for (const r of data.results ?? []) {
      if (!/photo|print|drawing/i.test((r.original_format ?? []).join(" "))) continue;
      const imgs: string[] = r.image_url ?? [];
      if (!imgs.length) continue;
      const best = imgs.reduce((a, b) => (sizeOf(b) > sizeOf(a) ? b : a)).split("#")[0];
      if (!/\.(jpe?g|png|gif)$/i.test(best)) continue;
      out.push({
        url: best, provider: "loc", title: r.title,
        attribution: `Library of Congress · ${(r.title ?? "").slice(0, 60)}`,
        license: "No known restrictions (verify at source)", sourceUrl: r.id,
      });
      if (out.length >= (req.count ?? 5)) break;
    }
    return out;
  },
};

// ── Unsplash (key: UNSPLASH_ACCESS_KEY) ───────────────────────────────────────
export const unsplash: Provider = {
  name: "unsplash",
  kind: "search",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "UNSPLASH_ACCESS_KEY";
    return ctx.env[k] ? true : `set ${k}`;
  },
  async provide(req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "UNSPLASH_ACCESS_KEY"]!;
    const data = await getJSON(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(req.query)}` +
        `&per_page=${req.count ?? 5}&orientation=landscape&client_id=${key}`,
    );
    return (data.results ?? []).map((r: any) => ({
      url: r.urls.regular, provider: "unsplash",
      attribution: `Unsplash · ${r.user?.name ?? ""}`, license: "Unsplash License",
      sourceUrl: r.links?.html,
    }));
  },
};

// ── Pexels (key: PEXELS_API_KEY) ──────────────────────────────────────────────
export const pexels: Provider = {
  name: "pexels",
  kind: "search",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "PEXELS_API_KEY";
    return ctx.env[k] ? true : `set ${k}`;
  },
  async provide(req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "PEXELS_API_KEY"]!;
    const data = await getJSON(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(req.query)}` +
        `&per_page=${req.count ?? 5}&orientation=landscape`,
      { Authorization: key },
    );
    return (data.photos ?? []).map((p: any) => ({
      url: p.src?.large ?? p.src?.original, provider: "pexels", title: p.alt || undefined,
      attribution: `Pexels · ${p.photographer ?? ""}`.trim(), license: "Pexels License",
      sourceUrl: p.url,
    }));
  },
};

// ── Generate via OpenAI gpt-image-1 (key: OPENAI_API_KEY) ─────────────────────
// Generation is just another provider. It always "succeeds" at returning bytes;
// the judge still decides whether what it drew is correct.
export const generate: Provider = {
  name: "generate",
  kind: "generate",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "OPENAI_API_KEY";
    return ctx.env[k] ? true : `set ${k}`;
  },
  async provide(req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "OPENAI_API_KEY"]!;
    const prompt = ctx.options.promptPrefix
      ? `${ctx.options.promptPrefix} ${req.query}`
      : `Photograph of ${req.query}, photorealistic, natural lighting`;
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ctx.options.model ?? "gpt-image-1",
        prompt, size: ctx.options.size ?? "1024x1024",
        quality: ctx.options.quality ?? "medium", n: 1,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as any;
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error("no image returned");
    return [{
      bytes: Buffer.from(b64, "base64"), mime: "image/png", provider: "generate",
      attribution: `Generated (${ctx.options.model ?? "gpt-image-1"})`, license: "Generated",
      meta: { prompt },
    }];
  },
};

// ── Openverse (no key) — 800M+ CC-licensed images across many sources ─────────
export const openverse: Provider = {
  name: "openverse",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const data = await getJSON(
      "https://api.openverse.org/v1/images/?" +
        new URLSearchParams({ q: req.query, page_size: String(req.count ?? 5) }),
    );
    return (data.results ?? []).map((r: any) => ({
      url: r.url, provider: "openverse", title: r.title,
      attribution: r.creator ? `${r.creator} (Openverse)` : "Openverse",
      license: `${r.license ?? ""} ${r.license_version ?? ""}`.trim(),
      sourceUrl: r.foreign_landing_url,
    }));
  },
};

// ── NASA Images (no key) — space & earth science, public domain ───────────────
export const nasa: Provider = {
  name: "nasa",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const data = await getJSON(
      "https://images-api.nasa.gov/search?" +
        new URLSearchParams({ q: req.query, media_type: "image" }),
    );
    const items = data.collection?.items ?? [];
    return items.slice(0, req.count ?? 5).map((x: any) => {
      const meta = x.data?.[0] ?? {};
      const href = (x.links?.[0]?.href ?? "").replace(/~thumb\.jpg$/i, "~medium.jpg");
      return {
        url: href, provider: "nasa", title: meta.title,
        attribution: meta.center ? `NASA / ${meta.center}` : "NASA",
        license: "Public Domain (NASA — verify usage)",
        sourceUrl: meta.nasa_id ? `https://images.nasa.gov/details/${meta.nasa_id}` : undefined,
      };
    }).filter((c: Candidate) => !!c.url);
  },
};

// ── The Met (no key) — public-domain art & artifacts (two-step search) ────────
export const met: Provider = {
  name: "met",
  kind: "search",
  configured: () => true,
  async provide(req) {
    const s = await getJSON(
      "https://collectionapi.metmuseum.org/public/collection/v1/search?" +
        new URLSearchParams({ q: req.query, hasImages: "true" }),
    );
    const ids: number[] = (s.objectIDs ?? []).slice(0, req.count ?? 5);
    const out: Candidate[] = [];
    for (const id of ids) {
      try {
        const o = await getJSON(
          `https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`,
        );
        const img = o.primaryImage || o.primaryImageSmall;
        if (!img) continue;
        out.push({
          url: img, provider: "met", title: o.title,
          attribution: o.artistDisplayName || "The Metropolitan Museum of Art",
          license: o.isPublicDomain ? "Public Domain (CC0)" : "The Met (verify)",
          sourceUrl: o.objectURL,
        });
      } catch { /* skip unfetchable object */ }
    }
    return out;
  },
};

// ── Smithsonian Open Access (key: SMITHSONIAN_API_KEY, free at api.data.gov) ───
export const smithsonian: Provider = {
  name: "smithsonian",
  kind: "search",
  configured: (ctx) => {
    const k = ctx.options.apiKeyEnv ?? "SMITHSONIAN_API_KEY";
    return ctx.env[k] ? true : `set ${k} (free key at api.data.gov)`;
  },
  async provide(req, ctx) {
    const key = ctx.env[ctx.options.apiKeyEnv ?? "SMITHSONIAN_API_KEY"]!;
    const data = await getJSON(
      "https://api.si.edu/openaccess/api/v1.0/search?" +
        new URLSearchParams({ q: req.query, rows: String(req.count ?? 5), api_key: key }),
    );
    const out: Candidate[] = [];
    for (const r of data.response?.rows ?? []) {
      const media = r.content?.descriptiveNonRepeating?.online_media?.media ?? [];
      const m = media.find((x: any) => x.type === "Images") || media[0];
      const img = m?.content || m?.thumbnail;
      if (!img) continue;
      out.push({
        url: img, provider: "smithsonian", title: r.title,
        attribution: "Smithsonian Open Access", license: "CC0 (verify)",
        sourceUrl: r.content?.descriptiveNonRepeating?.record_link,
      });
    }
    return out;
  },
};

export const REGISTRY: Record<string, Provider> = {
  wikimedia, inaturalist, loc, unsplash, pexels, openverse, nasa, met, smithsonian, generate,
};

export function getProvider(name: string): Provider {
  const p = REGISTRY[name];
  if (!p) throw new Error(`unknown provider "${name}" (have: ${Object.keys(REGISTRY).join(", ")})`);
  return p;
}
