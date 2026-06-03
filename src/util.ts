import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";

const UA = "image-sourcery/0.1 (+https://github.com/; educational)";

/**
 * Load credentials WITHOUT bundling any. Reads process.env first, then a local
 * `.env` in the working directory (gitignored), then any extra files passed.
 * Config references creds by env-var NAME — secrets never live in this repo.
 */
export function loadEnv(extraFiles: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const files = [path.resolve(process.cwd(), ".env"), ...extraFiles];
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

export async function getJSON(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (res.status === 429) throw new Error("rate limited (429)");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function download(url: string): Promise<{ bytes: Buffer; mime: string }> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const mime = res.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!/^image\//.test(mime) && !bytes.slice(0, 3).toString("hex").match(/^(ffd8ff|89504e|474946)/)) {
    throw new Error(`not an image (${mime})`);
  }
  return { bytes, mime };
}

/** Resolve a candidate to base64 data-URL form for vision models. */
export async function toDataUrl(c: { url?: string; bytes?: Buffer; mime?: string }): Promise<string> {
  if (c.bytes) return `data:${c.mime ?? "image/png"};base64,${c.bytes.toString("base64")}`;
  const d = await download(c.url!);
  return `data:${d.mime};base64,${d.bytes.toString("base64")}`;
}
