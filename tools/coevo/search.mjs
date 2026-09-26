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

// Finds, by trying them in the game, sequences of Tux's moves that get him
// through the hard spots of the level, for Tux's table to learn from.
//
//   node tools/coevo/search.mjs --spots spots.json --out demos.json [--ai off] [--zones 76]
//        [--tabs 6] [--beam 24] [--depth 14] [--turbo 80] [--gameseed 1]
//
// spots.json: [{ "x": 1300, "bottom": 832, "goal": 1990 }, ...]. For each,
// a beam search over the moves of player-facts.js (search.js plays them):
// every sequence kept is tried with each move added, and the best few that
// end alive in different places go on (further right counts, and so does
// higher up, which is how walls are climbed), until some reach the goal.
// demos.json gets, per spot, the shortest sequences that did, with what Tux
// saw before each move (the table index with --zones zones) and the move.
//
// Needs the web build and tools/jev-proxy/server.mjs serving it on 8765.

import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const build = join(repo, "build.wasm");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) =>
  arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
const spots = JSON.parse(await readFile(args.spots, "utf8"));
const out = args.out || join(here, "demos.json");
const ai = args.ai || "off";
const zones = Number(args.zones || 76);
const tabs = Number(args.tabs || 6);
const BEAM = Number(args.beam || 24);
const DEPTH = Number(args.depth || 14);
const turbo = Number(args.turbo || 80);
const gameSeed = Number(args.gameseed || 1);  // play it with bot.js's ?gameseed= the same
const MOVES = 9;
const SOLUTIONS = 3;
const CELL = 24;  // px: two ends closer than this are the same place

const play = await readFile(join(build, "play.html"), "utf8");
const marker = /<script src="laya-prompt\.js[^"]*"><\/script>/;
// Everyone's counts and headstones stay out of automated play: headstones
// are objects in the level, and would change it.
const STATS_SCRIPT = /<script src="stats\.js[^"]*"><\/script>/;
const { copyFile } = await import("node:fs/promises");
await copyFile(join(here, "player-facts.js"), join(build, "coevo-player-facts.js"));
await copyFile(join(here, "search.js"), join(build, "coevo-search.js"));
await writeFile(join(build, "search.html"), play.replace(STATS_SCRIPT, "").replace(marker, (m) =>
  `<script src="coevo-player-facts.js?v=${Date.now()}"></script>\n  <script src="coevo-search.js?v=${Date.now()}"></script>\n  ${m}`));

const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--mute-audio"] });
// However this process ends (an error included), the browser goes with it:
// left behind, its games keep the memory the next run needs.
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const pages = await Promise.all(Array.from({ length: tabs }, async () => {
  const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage()  // own storage: the game keeps its config and saves there;
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.goto(`http://127.0.0.1:8765/search.html?ai=${ai}`);
  await page.waitForFunction(() => document.title.startsWith("SuperTux"), null, { timeout: 300000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__search_ready());
  return page;
}));

/** Tries every sequence, spread over the pages. */
async function tryAll(spot, sequences) {
  const results = new Array(sequences.length);
  let next = 0;
  await Promise.all(pages.map(async (page) => {
    while (next < sequences.length) {
      const i = next++;
      results[i] = await page.evaluate(([s, moves, zones, turbo, gameSeed]) =>
        window.__search_try(s.x, s.bottom, s.goal, moves, zones, turbo, gameSeed), [spot, sequences[i], zones, turbo, gameSeed]);
    }
  }));
  return results;
}

const demos = [];
for (const spot of spots) {
  const started = Date.now();
  let beam = [[]];
  const found = [];
  let tries = 0;
  for (let depth = 1; depth <= DEPTH && found.length < SOLUTIONS && beam.length; depth++) {
    const sequences = beam.flatMap((s) => Array.from({ length: MOVES }, (_, m) => [...s, m]));
    const results = await tryAll(spot, sequences);
    tries += sequences.length;
    const ends = new Map();
    for (let i = 0; i < sequences.length; i++) {
      const r = results[i];
      if (r.reached) {
        if (found.length < SOLUTIONS) found.push({ moves: sequences[i], seconds: r.seconds, pairs: r.pairs });
        continue;
      }
      if (!r.alive)
        continue;
      // Only a sequence whose last move still changed something is worth going on from.
      const key = `${Math.round(r.x / CELL)} ${Math.round(r.y / CELL)} ${r.ground}`;
      const score = r.x + 0.8 * (spot.bottom - r.y);
      if (!ends.has(key) || ends.get(key).score < score || (ends.get(key).score === score && ends.get(key).seq.length > sequences[i].length))
        ends.set(key, { score, seq: sequences[i] });
    }
    beam = [...ends.values()].sort((a, b) => b.score - a.score).slice(0, BEAM).map((e) => e.seq);
    console.log(`spot ${spot.x}: depth ${depth}, ${sequences.length} tried, ${ends.size} places, ` +
                `best ${[...ends.values()].reduce((m, e) => Math.max(m, e.score), 0).toFixed(0)}, found ${found.length}`);
  }
  demos.push({ spot, found, tries, seconds: Math.round((Date.now() - started) / 1000) });
  await writeFile(out, JSON.stringify(demos, null, 1));
  console.log(`spot ${spot.x} -> ${spot.goal}: ${found.length ? found.map((f) => f.moves.join("")).join(" ") : "none"} ` +
              `(${tries} tries, ${Math.round((Date.now() - started) / 1000)} s)`);
}
// Closing the browser has been seen to hang; the work is saved by now.
await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
try { browser.process()?.kill("SIGKILL"); } catch {}
process.exit(0);
