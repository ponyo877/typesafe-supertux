//  SuperTux
//  Copyright (C) 2026 ponyo877
//
//  This program is free software: you can redistribute it and/or modify
//  it under the terms of the GNU General Public License as published by
//  the Free Software Foundation, either version 3 of the License, or
//  (at your option) any later version.
//
//  This program is distributed in the hope that it will be useful,
//  but WITHOUT ANY WARRANTY; without even the implied warranty of
//  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//  GNU General Public License for more details.
//
//  You should have received a copy of the GNU General Public License
//  along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Serves the web build on Cloudflare (see tools/web/deploy.sh). Every file is
// a static asset except the data package: at ~330 MB it is over the limits
// of Workers assets (25 MiB per file) and of Wrangler's R2 uploads (300 MiB
// per object), so it sits in R2 in parts, data/<DATA_VERSION>/0, 1, ..., and
// is streamed back here as one file. Only requests that match no asset reach
// this code.
//
// It also keeps everyone's attempts, deaths and clears per mode, and how
// often players died on each tile, in D1 (schema.sql): /api/stats, used by
// mk/emscripten/stats.js. Only these counts are kept: no single play, no
// address, nothing about who played.

const MODES = new Set(["off", "coevo4", "coevo3", "coevo2", "coevo", "rl2", "rl", "llm", "laya-rich", "laya"]);
const KINDS = new Set(["attempt", "death", "clear"]);
const TILE = 32;
const MARKS = 2000;  // the tiles with the most deaths that are sent back

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) },
});

async function stats(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "POST") {
    const text = await request.text();
    if (text.length > 200)
      return new Response("Too large", { status: 413 });
    let event;
    try { event = JSON.parse(text); } catch { return new Response("Bad JSON", { status: 400 }); }
    const { mode, kind, x, y } = event || {};
    if (!MODES.has(mode) || !KINDS.has(kind))
      return new Response("Bad event", { status: 400 });
    const statements = [
      env.STATS.prepare("INSERT INTO counts (mode, kind, n) VALUES (?1, ?2, 1) " +
                        "ON CONFLICT (mode, kind) DO UPDATE SET n = n + 1").bind(mode, kind),
    ];
    if (kind === "death") {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 20000 || y < -200 || y > 2000)
        return new Response("Bad position", { status: 400 });
      statements.push(env.STATS.prepare(
        "INSERT INTO deaths (mode, tx, ty, n) VALUES (?1, ?2, ?3, 1) " +
        "ON CONFLICT (mode, tx, ty) DO UPDATE SET n = n + 1").bind(mode, Math.floor(x / TILE), Math.floor(y / TILE)));
    }
    await env.STATS.batch(statements);
    return new Response(null, { status: 204 });
  }
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

  const mode = url.searchParams.get("mode");
  if (!MODES.has(mode))
    return new Response("Bad mode", { status: 400 });
  // Everyone asks for the same few answers; keep each for half a minute.
  const cache = caches.default;
  const key = new Request(`${url.origin}/api/stats?mode=${mode}`);
  const cached = await cache.match(key);
  if (cached)
    return cached;
  const [counts, deaths] = await env.STATS.batch([
    env.STATS.prepare("SELECT kind, n FROM counts WHERE mode = ?1").bind(mode),
    env.STATS.prepare("SELECT tx, ty, n FROM deaths WHERE mode = ?1 ORDER BY n DESC LIMIT ?2").bind(mode, MARKS),
  ]);
  const n = Object.fromEntries(counts.results.map((r) => [r.kind, r.n]));
  const response = json({
    mode, attempts: n.attempt || 0, deaths: n.death || 0, clears: n.clear || 0,
    tile: TILE, marks: deaths.results.map((r) => [r.tx, r.ty, r.n]),
  }, { headers: { "Cache-Control": "public, max-age=30" } });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/stats")
      return stats(request, env, ctx);
    if (url.pathname !== "/supertux2.data")
      return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

    const etag = `"${env.DATA_VERSION}"`;
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      ETag: etag,
      // The page keeps the package in IndexedDB; a new build comes with a
      // new package, so never serve a stale one from an HTTP cache.
      "Cache-Control": "no-cache",
    });
    if (request.headers.get("If-None-Match") === etag)
      return new Response(null, { status: 304, headers });

    const keys = Array.from({ length: Number(env.DATA_PARTS) }, (_, i) => `data/${env.DATA_VERSION}/${i}`);
    const parts = await Promise.all(keys.map((key) => env.DATA.head(key)));
    if (keys.length === 0 || parts.some((part) => !part))
      return new Response("The data package is not uploaded", { status: 503 });
    const size = parts.reduce((total, part) => total + part.size, 0);
    headers.set("Content-Length", String(size));
    if (request.method === "HEAD")
      return new Response(null, { headers });

    const { readable, writable } = new FixedLengthStream(size);
    ctx.waitUntil((async () => {
      for (const key of keys) {
        const part = await env.DATA.get(key);
        await part.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    })());
    return new Response(readable, { headers });
  },
};
