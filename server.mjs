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
import { createHash } from "node:crypto";
import { OtariClient, Budget } from "./lib/otari.mjs";
import { GatewayTools } from "./lib/gatewayTools.mjs";
import { UserBudgetStore, UserBudgetError } from "./lib/userBudget.mjs";
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

/* The hackathon asks for the hosted platform at otari.ai, so that is the
 * default. A self-hosted gateway is the same API: point OTARI_BASE_URL at
 * http://localhost:8010/api/v1 and nothing else changes. */
const DEFAULT_BASE_URL = "https://otari.ai/api/v1";

function client() {
  const baseUrl = process.env.OTARI_BASE_URL || DEFAULT_BASE_URL;
  const apiKey = process.env.OTARI_API_KEY || "";
  return new OtariClient({
    baseUrl,
    apiKey,
    endUserBudgetId: process.env.OTARI_END_USER_BUDGET || null,
    models: {
      triage: process.env.OTARI_MODEL_TRIAGE || "localrouter:free-fast",
      write: process.env.OTARI_MODEL_WRITE || "localrouter:free-best",
      fallback: process.env.OTARI_MODEL_FALLBACK || "localrouter:free-coder"
    }
  });
}

/**
 * One budget per person, not per request. The page sends `X-User-Id` when it
 * has one; otherwise a signed-out visitor gets a session cookie, and a client
 * that keeps no cookie is keyed by a hash of its address and user agent.
 */
const userBudgets = new UserBudgetStore({
  maxTokens: Number(process.env.USER_MAX_TOKENS) || 60000,
  maxRuns: Number(process.env.USER_MAX_RUNS) || 6,
  windowMs: (Number(process.env.USER_WINDOW_MINUTES) || 60) * 60 * 1000
});

const cleanUserId = (raw) => {
  const id = String(raw || "")
    .replace(/[^A-Za-z0-9._@:-]/g, "")
    .slice(0, 128);
  return id.length >= 3 ? id : null;
};

function identifyUser(req, res) {
  const fromHeader = cleanUserId(req.headers["x-user-id"]);
  if (fromHeader) return fromHeader;

  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  const fromCookie = cleanUserId(cookies.nf_user);
  if (fromCookie) return fromCookie;

  // No identity offered: mint one from the caller's address, and remember it
  // in the browser so a visitor keeps one budget across page loads. A client
  // that drops cookies still shares one bucket per address.
  const fresh = fallbackUserKey(req);
  res.setHeader("set-cookie", `nf_user=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  return fresh;
}

/** The same bucket for the same caller when no identity is offered. */
function fallbackUserKey(req) {
  const address = req.socket.remoteAddress || "unknown";
  return `anon-${createHash("sha256").update(`${address}|${req.headers["user-agent"] || ""}`).digest("hex").slice(0, 16)}`;
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
  const userId = identifyUser(req, res);

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

  let reservation = null;
  try {
    const feedIds = Array.isArray(input.feeds) && input.feeds.length ? input.feeds : ["hacker-news", "lobsters"];
    const batches = await Promise.all(feedIds.map((id) => readFeed(id, Number(input.limit) || 6)));
    const items = batches.flat().slice(0, 16);

    // The per-user budget is checked before the first model call, with an
    // estimate of the whole run, so two tabs cannot both spend the last of it.
    const estimate = items.length * 600 + 2500;
    try {
      reservation = userBudgets.reserve(userId, { tokens: estimate, runs: 1 });
    } catch (err) {
      if (err instanceof UserBudgetError) {
        res.setHeader("retry-after", String(err.retryAfterSeconds));
        return json(res, 429, {
          ok: false,
          error: "user_budget_exceeded",
          message: err.message,
          retryAfterSeconds: err.retryAfterSeconds,
          user: { id: userId, ...err.snapshot }
        });
      }
      throw err;
    }

    const budget = new Budget({ maxTokens: Number(input.maxTokens) || 40000, maxUsd: 0.05 });
    // The gateway bills the end user, not the application, and its own end-user
    // budget (when the key is a service key) applies beside ours.
    const runClient = client().forUser(userId);
    const tools = process.env.OTARI_WEB_FETCH === "off" ? null : new GatewayTools({ client: runClient });
    const result = await runDigest({ items, client: runClient, budget, tools, topN: Number(input.topN) || 5 });

    // One line per run, with the gateway host in it: a screen recording has
    // something to show on the hosted path, where there are no container logs.
    const gateway = process.env.OTARI_BASE_URL || DEFAULT_BASE_URL;
    console.log(
      `[digest] gateway=${gateway} items=${result.stats.items} tokens=${result.stats.budget.tokens} ` +
      `calls=${result.stats.budget.calls} ms=${result.stats.ms} ` +
      `roles=${result.stats.roles.distinct ? "distinct" : "collapsed"}`
    );

    const after = reservation.commit(result.stats.budget.tokens);
    return json(res, 200, { ok: true, user: { id: userId, ...after }, ...result });
  } catch (err) {
    reservation?.release();
    return json(res, 502, { ok: false, error: err.message, attempts: err.attempts || null });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/digest") return handleDigest(req, res);
  if (req.method === "GET" && url.pathname === "/api/me") {
    const userId = identifyUser(req, res);
    return json(res, 200, { ok: true, user: userBudgets.snapshot(userId) });
  }
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
    console.log(`gateway: ${process.env.OTARI_BASE_URL || DEFAULT_BASE_URL}`);

    // On the hosted platform there are no container logs, and a workspace can
    // switch the gateway's web tools off, in which case every run fetches pages
    // itself and the audit says `via=direct`. Saying it once at startup is
    // cheaper than discovering it after a paid run.
    Promise.resolve()
      .then(() => client().tools())
      .then((t) => {
        if (!t.known) return console.log("[tools] gateway does not report tool availability");
        const on = t.tools.filter((x) => x.available).map((x) => x.id);
        const off = t.tools.filter((x) => !x.available).map((x) => `${x.id} (${x.reason})`);
        console.log(
          `[tools] available: ${on.join(", ") || "none"}` + (off.length ? ` | off: ${off.join(", ")}` : "")
        );
      })
      .catch(() => {});
  });
}

export { server, readFeed, FEEDS };
