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

// Checks tools/web/cloudflare/verify.js against real paths and made-up ones.
//
//   node tools/web/verify-test.mjs [--minutes 10] [--tabs 4] [--save paths.json] [--load paths.json]
//   node tools/web/verify-test.mjs --clears [--minutes 10] [--tabs 4]
//
// Real paths: the bot styles of tools/eval and the learned Tux of
// tools/coevo play from the start of the level (with tools/jev-proxy
// serving the build) and every death is kept with its path. Each must pass.
// Made-up paths: built from nothing or from real ones changed; each must
// fail. Prints why things failed.
//
// No one clears the whole level often enough to test clears that way, so
// --clears plays only the last part of it: the paths start where Tux is put
// down, and pass if nothing but their shortness ("too quick") fails.

import { chromium } from "../eval/node_modules/playwright/index.mjs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "./cloudflare/verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const build = join(repo, "build.wasm");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) =>
  arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
const map = JSON.parse(await readFile(join(here, "cloudflare", "level-map.json"), "utf8"));

async function collect() {
  const minutes = Number(args.minutes || 10);
  const tabs = Number(args.tabs || 4);
  const play = await readFile(join(build, "play.html"), "utf8");
  const marker = /<script src="laya-prompt\.js[^"]*"><\/script>/;
  await copyFile(join(repo, "tools", "eval", "bot.js"), join(build, "eval-bot.js"));
  await copyFile(join(repo, "tools", "coevo", "player-facts.js"), join(build, "coevo-player-facts.js"));
  await copyFile(join(repo, "tools", "coevo", "page.js"), join(build, "coevo-page.js"));
  await writeFile(join(build, "verify.html"), play.replace(marker, (m) =>
    `<script src="eval-bot.js"></script>\n  <script src="coevo-player-facts.js"></script>\n  <script src="coevo-page.js"></script>\n  ${m}`));

  const sections = args.clears ? [{ x: 13136, bottom: 768, end: 99999, seconds: 90 }]
                               : [JSON.parse(await readFile(join(repo, "tools", "coevo", "sections.json"), "utf8")).full];
  const parse = (text) => JSON.parse(text.slice(text.indexOf("] = ") + 4, text.lastIndexOf(";")));
  const tux = parse(await readFile(join(repo, "tools", "coevo", "tables", "tux-llm.js"), "utf8"));
  let tuxLearned = null;
  try { tuxLearned = parse(await readFile(join(repo, "tools", "coevo", "tables", "tux-g20.js"), "utf8")); } catch {}
  const enemyDomains = parse(await readFile(join(repo, "mk", "emscripten", "llm-table.js"), "utf8")).domains;
  const coevo = parse(await readFile(join(repo, "mk", "emscripten", "coevo4-table.js"), "utf8"));

  const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--mute-audio"] });
  const styles = ["rusher", "stomper", "cautious", "hopper", "sprinter", "backstepper", "chaotic", "stalker", "jumper",
                  "waiter", "bunny", "zigzag"];
  const results = await Promise.all(Array.from({ length: tabs }, async (_, i) => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    await page.goto(`http://127.0.0.1:8765/verify.html?ai=llm&seed=${900 + i}&lag=1` +
                    `&sections=${encodeURIComponent(JSON.stringify(sections))}`);
    await page.waitForFunction(() => document.title.startsWith("SuperTux"), null, { timeout: 300000 });
    await page.waitForTimeout(1000);
    await page.evaluate(({ styles, tux, tuxLearned, coevo, enemyDomains }) => {
      window.__paths = [];
      const previous = window.jev_on_event;
      window.jev_on_event = (json) => {
        const e = JSON.parse(json);
        if (e.type === "player_death" || (e.type === "level_finished" && e.detail === "win")) {
          const life = window.__eval.lives[window.__eval.lives.length - 1] || {};
          window.__paths.push({ kind: e.type === "player_death" ? "death" : "clear", at: [e.x, e.y],
                                who: life.player || "?", path: JSON.parse(Module.UTF8ToString(Module._jev_take_trajectory())) });
        }
        previous(json);
      };
      const players = styles.map((s) => ({ name: "bot:" + s, weight: 1 }));
      players.push({ name: "tux-llm", weight: 3, packed: tux.packed });
      if (tuxLearned) players.push({ name: "tux-g20", weight: 6, packed: tuxLearned.packed });
      window.__coevo_set({ enemyDomains, seed: 7, players,
                           enemies: [{ name: "classic", weight: 1 }, { name: "coevo4", weight: 1, packed: coevo.packed, shield: !coevo.learned_shield,
                                     extra: coevo.extra, delta: Object.entries(coevo.delta).map(([k, v]) => [Number(k), v]) }] });
    }, { styles, tux, tuxLearned, coevo, enemyDomains });
    await page.evaluate((s) => window.__eval_start(40, s), minutes * 60);
    for (;;) {
      await page.waitForTimeout(2000);
      if (await page.evaluate((s) => window.__eval.gameTime >= s - 0.1, minutes * 60)) break;
    }
    const paths = await page.evaluate(() => window.__paths);
    await page.close();
    return paths;
  }));
  await browser.close();
  return results.flat();
}

// --- made-up paths -------------------------------------------------------

function straight(fromX, toX, y, seconds, vx) {
  const n = Math.round(seconds * 10);
  return Array.from({ length: n }, (_, i) => [i * 100, Math.round(fromX + (toX - fromX) * i / (n - 1)), y, vx, 0, 1 | 4]);
}

function forgeries(real) {
  const out = [];
  const [sx, sy] = map.start;
  out.push(["single point", "death", [[0, sx, sy, 0, 0, 1]], [sx, sy]]);
  out.push(["straight to the goal on the ground", "clear", straight(sx, map.goal_x + 10, sy, 60, 230), null]);
  out.push(["straight to the goal, no speed", "clear", straight(sx, map.goal_x + 10, sy, 60, 0), null]);
  out.push(["straight, airborne", "clear", straight(sx, map.goal_x + 10, sy, 60, 230).map((p) => [...p.slice(0, 5), 4]), null]);
  out.push(["too quick", "clear", straight(sx, map.goal_x + 10, sy, 20, 700), null]);
  out.push(["death far from the path", "death", straight(sx, sx + 300, sy, 3, 100), [5000, 700]]);
  const sample = real.filter((r) => r.path.length > 40).slice(0, 20);
  for (const r of sample) {
    const p = r.path;
    out.push(["teleport in the middle", r.kind, p.map((q, i) => i > p.length / 2 ? [q[0], q[1] + 800, ...q.slice(2)] : q), [r.at[0] + 800, r.at[1]]]);
    out.push(["through rock", r.kind, p.map((q, i) => i > p.length / 3 ? [q[0], q[1], q[2] + 200, ...q.slice(3)] : q), [r.at[0], r.at[1] + 200]]);
    out.push(["sped up 3x", r.kind, p.map((q) => [Math.round(q[0] / 3), ...q.slice(1)]), r.at]);
    out.push(["positions only", r.kind, p.map((q) => [q[0], q[1], q[2], 0, 0, q[5]]), r.at]);
    out.push(["extended to the goal", "clear", [...p, ...straight(p[p.length - 1][1], map.goal_x + 10, p[p.length - 1][2], 50, 300)
      .map((q) => [q[0] + p[p.length - 1][0] + 100, ...q.slice(1)])], null]);
    out.push(["started elsewhere", r.kind, p.map((q) => [q[0], q[1] + 3000, ...q.slice(2)]), [r.at[0] + 3000, r.at[1]]]);
  }
  return out;
}

const real = args.load ? JSON.parse(await readFile(args.load, "utf8")) : await collect();
if (args.save) await writeFile(args.save, JSON.stringify(real));

if (args.clears !== undefined) {
  // From the first sample after Tux was put down.
  const trimmed = real.filter((r) => r.kind === "clear").map((r) => {
    const i = r.path.findIndex((p) => p[1] > 13000);
    const t0 = r.path[i][0];
    return { ...r, path: r.path.slice(i).map((p) => [p[0] - t0, ...p.slice(1)]) };
  });
  const results = trimmed.map((r) => verify(r.kind, r.path, r.at, { ...map, start: r.path[0].slice(1, 3) }));
  const tally = results.reduce((acc, v) => ((acc[v.reason] = (acc[v.reason] || 0) + 1), acc), {});
  console.log(`clears: ${trimmed.length}, results: ${JSON.stringify(tally)}`);
  for (const v of results.filter((v) => v.reason !== "too quick").slice(0, 8)) console.log("  ", v.reason, JSON.stringify(v.stats));
  process.exit(0);
}

const tally = (list) => list.reduce((acc, r) => ((acc[r] = (acc[r] || 0) + 1), acc), {});
const realResults = real.map((r) => ({ r, v: verify(r.kind, r.path, r.at, map) }));
const rejected = realResults.filter(({ v }) => !v.ok);
console.log(`real paths: ${real.length} (${real.filter((r) => r.kind === "clear").length} clears), ` +
            `rejected ${rejected.length}: ${JSON.stringify(tally(rejected.map(({ v }) => v.reason)))}`);
for (const { r, v } of rejected.slice(0, 8))
  console.log("  ", r.who, r.kind, r.path.length, v.reason, JSON.stringify(v.stats));

const fakes = forgeries(real);
const passed = fakes.filter(([, kind, path, at]) => verify(kind, path, at, map).ok);
console.log(`made-up paths: ${fakes.length}, passed ${passed.length}: ${JSON.stringify(tally(passed.map(([name]) => name)))}`);
console.log("why made-up paths failed:", JSON.stringify(tally(fakes.map(([name, kind, path, at]) => name + " -> " + verify(kind, path, at, map).reason))));
