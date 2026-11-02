/**
 * A small HTTP server: static UI plus one JSON endpoint.
 *
 * The Otari key lives here, on the server, and never reaches the browser. That
 * is the whole reason a gateway belongs behind an app instead of in front of it
 * from the client: the page calls /api/digest, and the page cannot mint its own
 * key or spend someone else's budget.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { OtariClient, Budget } from "./lib/otari.mjs";
import { runDigest } from "./lib/pipeline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};

const FEEDS = {
  "hacker-news": { name: "Hacker News", url: "https://hnrss.org/frontpage" },
  "lobsters": { name: "Lobsters", url: "https://lobste.rs/rss" }
};

async function readFeed(id, limit = 8) {
  const feed = FEEDS[id];
  if (!feed) throw new Error(`unknown feed: ${id}`);
  const res = await fetch(feed.url, {
    headers: { "user-agent": "newsflow-otari-studio/1.0" },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`${feed.name}: http ${res.status}`);
  const xml = await res.text();
  const items = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const block of blocks.slice(0, limit)) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!m) return "";
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
    };
    const title = pick("title");
    const link = pick("link") || (block.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "";
    if (title && link) items.push({ title, url: link, summary: pick("description").slice(0, 900), source: feed.name });
  }
  return items;
}

function client() {
  const baseUrl = process.env.OTARI_BASE_URL || "http://localhost:8010/api/v1";
  const apiKey = process.env.OTARI_API_KEY || "";
  return new OtariClient({
    baseUrl,
    apiKey,
    models: {
      triage: process.env.OTARI_MODEL_TRIAGE || "localrouter:free-fast",
      write: process.env.OTARI_MODEL_WRITE || "localrouter:free-best",
      fallback: process.env.OTARI_MODEL_FALLBACK || "localrouter:free-coder"
    }
  });
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

async function handleDigest(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) return json(res, 413, { error: "request too large" });
  }
  let input;
  try {
    input = body ? JSON.parse(body) : {};
  } catch {
    return json(res, 400, { error: "body is not JSON" });
  }

  try {
    const feedIds = Array.isArray(input.feeds) && input.feeds.length ? input.feeds : ["hacker-news", "lobsters"];
    const batches = await Promise.all(feedIds.map((id) => readFeed(id, Number(input.limit) || 6)));
    const items = batches.flat().slice(0, 16);

    const budget = new Budget({ maxTokens: Number(input.maxTokens) || 40000, maxUsd: 0.05 });
    const result = await runDigest({ items, client: client(), budget, topN: Number(input.topN) || 5 });
    return json(res, 200, { ok: true, ...result });
  } catch (err) {
    return json(res, 502, { ok: false, error: err.message, attempts: err.attempts || null });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/digest") return handleDigest(req, res);
  if (url.pathname === "/api/health") return json(res, 200, { ok: true, uptime: process.uptime() });

  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });

  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
});

const port = Number(process.env.PORT) || 8787;

// Only listen when this file is the entry point. Importing it (a test that
// wants `readFeed`, for instance) must not bind a port.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, () => {
    console.log(`newsflow-otari-studio on http://localhost:${port}`);
    console.log(`gateway: ${process.env.OTARI_BASE_URL || "http://localhost:8010/api/v1"}`);
  });
}

export { server, readFeed, FEEDS };
