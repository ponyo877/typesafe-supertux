#!/usr/bin/env node
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

// Serves the WebAssembly build and relays the badguys' questions to Jev, so
// that the API key never reaches the browser, or to Laya running locally
// (tools/laya-server).
//
//   TYPESAFE_API_KEY=sk-... node tools/jev-proxy/server.mjs [build dir]
//
// Without a key or a running Laya server the game still runs; /api/jev or
// /api/laya fails and the badguys behave as usual. No dependencies, Node 18 or
// newer.

import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_BODY as MAX_REPORT, MODES, checkReport, makeToken } from "../web/cloudflare/plays.js";

const HOST = "127.0.0.1"; // local play only; the key pays for every request
const PORT = Number(process.env.PORT || 8765);
const UPSTREAM = "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.JEV_MODEL || "jev-latest";
const LAYA_URL = process.env.LAYA_URL || "http://127.0.0.1:8766/v1/systemone";
const MAX_BODY = 256 * 1024;

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const root = resolve(process.argv[2] || join(repo, "build.wasm"));
const apiKey = process.env.TYPESAFE_API_KEY || "";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function readJson(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY)
      return send(res, 413, "request too large");
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    send(res, 400, "invalid JSON");
  }
}

async function relayJev(req, res) {
  if (!apiKey)
    return send(res, 503, "TYPESAFE_API_KEY is not set");

  const request = await readJson(req, res);
  if (!request)
    return;

  const started = performance.now();
  try {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state: request.state, questions: request.questions }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await upstream.text();
    console.log(`jev ${upstream.status} ${Math.round(performance.now() - started)} ms, ` +
                `${Object.keys(request.questions || {}).length} questions`);
    send(res, upstream.status, body, "application/json");
  } catch (error) {
    console.log("jev failed: " + error.message);
    send(res, 502, "upstream request failed: " + error.message);
  }
}

// Laya answers dozens of times per second, so it is logged as a summary.
const layaStats = { count: 0, failed: 0, totalMs: 0 };
setInterval(() => {
  if (layaStats.count || layaStats.failed)
    console.log(`laya ${layaStats.count} answers in 5 s, avg ${(layaStats.totalMs / Math.max(1, layaStats.count)).toFixed(1)} ms` +
                (layaStats.failed ? `, ${layaStats.failed} failed` : ""));
  Object.assign(layaStats, { count: 0, failed: 0, totalMs: 0 });
}, 5000).unref();

async function relayLaya(req, res) {
  const request = await readJson(req, res);
  if (!request)
    return;

  const started = performance.now();
  try {
    const upstream = await fetch(LAYA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: request.model, state: request.state, questions: request.questions }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await upstream.text();
    layaStats.count++;
    layaStats.totalMs += performance.now() - started;
    send(res, upstream.status, body, "application/json");
  } catch (error) {
    layaStats.failed++;
    send(res, 502, "Laya server not reachable at " + LAYA_URL + " (cd tools/laya-server && uv run server.py): " + error.message);
  }
}

async function serveFile(req, res) {
  let pathname;
  try {
    // Prefixing the origin keeps paths like "//x" from parsing as a host.
    pathname = decodeURIComponent(new URL("http://localhost" + req.url).pathname);
  } catch {
    return send(res, 400, "bad request");
  }
  const file = normalize(join(root, pathname.endsWith("/") ? pathname + "index.html" : pathname));
  if (file !== root && !file.startsWith(root + sep))
    return send(res, 403, "forbidden");

  let info;
  try {
    info = await stat(file);
  } catch {
    return send(res, 404, "not found");
  }
  if (!info.isFile())
    return send(res, 404, "not found");

  // Always revalidate: a rebuild replaces the wasm and the 300 MB data file
  // together, and a stale copy of either one breaks the other.
  const modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000);
  const since = Date.parse(req.headers["if-modified-since"] || "");
  if (!Number.isNaN(since) && modified.getTime() <= since) {
    res.writeHead(304, { "Cache-Control": "no-cache" });
    return res.end();
  }

  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] || "application/octet-stream",
    "Content-Length": info.size,
    "Last-Modified": modified.toUTCString(),
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD")
    return res.end();
  createReadStream(file).pipe(res);
}

// /api/session and /api/stats as tools/web/cloudflare/worker.js answers
// them, with the same checks (plays.js), kept in memory (it starts empty
// every time), for trying mk/emscripten/stats.js locally. Reports that do
// not count are logged with why.
const statsSecret = randomBytes(32).toString("hex");
const statsCounts = new Map();   // "mode kind" -> n
const statsDeaths = new Map();   // "mode tx ty" -> n
const statsUsed = new Set();     // "id kind"
const levelMap = JSON.parse(await readFile(join(repo, "tools", "web", "cloudflare", "level-map.json"), "utf8"));
const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_REPORT) return null;
  }
  return body;
}

async function localSession(req, res) {
  if (req.method !== "POST")
    return send(res, 405, "method not allowed");
  let mode;
  try { mode = JSON.parse(await readBody(req)).mode; } catch { return send(res, 400, "bad JSON"); }
  if (!MODES.has(mode))
    return send(res, 400, "bad mode");
  count(statsCounts, `${mode} attempt`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ token: await makeToken(statsSecret, mode) }));
}

async function localStats(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST") {
    const body = await readBody(req);
    if (body === null)
      return send(res, 413, "too large");
    const report = await checkReport(statsSecret, levelMap, body);
    const answer = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (!report.ok) {
      console.log(`stats: not counted (${report.reason})`);
      return answer(422, { counted: false, reason: report.reason });
    }
    if (statsUsed.has(`${report.id} ${report.kind}`))
      return answer(409, { counted: false, reason: "used" });
    statsUsed.add(`${report.id} ${report.kind}`);
    count(statsCounts, `${report.mode} ${report.kind}`);
    if (report.kind === "death")
      count(statsDeaths, `${report.mode} ${Math.floor(report.x / 32)} ${Math.floor(report.y / 32)}`);
    return answer(200, { counted: true });
  }
  const mode = url.searchParams.get("mode");
  const marks = [...statsDeaths].map(([key, n]) => key.split(" ")).filter(([m]) => m === mode)
    .map(([, tx, ty]) => [Number(tx), Number(ty), statsDeaths.get(`${mode} ${tx} ${ty}`)]);
  const n = (kind) => statsCounts.get(`${mode} ${kind}`) || 0;
  const body = JSON.stringify({ mode, attempts: n("attempt"), deaths: n("death"), clears: n("clear"), tile: 32, marks });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

createServer((req, res) => {
  const handler = req.url.startsWith("/api/stats") ? localStats
                : req.url === "/api/session" ? localSession
                : (req.method === "POST" && req.url === "/api/jev") ? relayJev
                : (req.method === "POST" && req.url === "/api/laya") ? relayLaya
                : (req.method === "GET" || req.method === "HEAD") ? serveFile
                : null;
  if (!handler)
    return send(res, 405, "method not allowed");
  handler(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) send(res, 500, "internal error");
  });
}).listen(PORT, HOST, () => {
  console.log(`Serving ${root}`);
  console.log(`Jev: ${apiKey ? "key set, model " + MODEL : "no TYPESAFE_API_KEY, badguys behave as usual"}`);
  console.log(`Laya (for ?ai=laya-mlx): ${LAYA_URL}`);
  console.log(`http://${HOST}:${PORT}/  (start page; play.html?ai=off|laya|laya-rich|laya-mlx|jev)`);
});
