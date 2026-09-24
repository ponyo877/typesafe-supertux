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

// Teaches the badguys by letting them play: reinforcement learning on the
// policy table, starting from the table made by tools/distill (llm).
//
//   node tools/rl/train.mjs [--name rl2] [--iterations 100] [--tabs 6]
//        [--minutes 10] [--epsilon 0.3,0.05] [--turbo 80] [--bots rusher,stomper,cautious]
//
// Needs the web build, tools/jev-proxy/server.mjs serving it on 8765, and the
// uv environment of tools/distill (LightGBM).
//
// Every iteration, each tab plays --minutes of game time against the bot of
// tools/eval (sections, styles and parameters drawn at random) with the
// current policy; with a chance that falls from the first to the second
// --epsilon over the iterations, a badguy tries an order that might still be
// better (learner.js). The returns of every (situation, order) are summed up
// in tools/rl/stats-<name>.json (so training can go on later), and fit_q.py
// decides the policy from them: similar situations share what was learned
// through a LightGBM estimate, and a situation leaves the teacher's order
// only for one that is ahead beyond doubt. The table goes to
// mk/emscripten/<name>-table.js (?ai=<name>) every 10 iterations and at the
// end, and a copy to tools/rl/snapshots/.
//
// ?ai=rl was the first attempt: plain averages, an order taking over after 30
// tries, uniform exploration and rewards only for hits and stomps. Most of
// the situations it changed were chance (see tools/rl/q-v1.json).
//
// The jumper bot style is left out of training on purpose: bench.mjs --bots
// jumper checks the result against a way of playing it never saw.

import { chromium } from "playwright";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) =>
  arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
const name = args.name || "rl2";
const iterations = Number(args.iterations || 100);
const tabs = Number(args.tabs || 6);
const minutes = Number(args.minutes || 10);
const [epsilonStart, epsilonEnd] = (args.epsilon || "0.3,0.05").split(",").map(Number);
const turbo = Number(args.turbo || 80);
const bots = args.bots || "rusher,stomper,cautious";
const TEACHER = "llm";

const build = resolve(repo, "build.wasm");
const base = "http://127.0.0.1:8765";
const statsFile = join(here, `stats-${name}.json`);
const fitFile = join(here, `fit-${name}.json`);

// The teacher's table, read the way the page reads it.
const context = { window: {} };
vm.runInNewContext(await readFile(join(repo, "mk", "emscripten", `${TEACHER}-table.js`), "utf8"), context);
const teacher = context.window.POLICY_TABLES[TEACHER];
const teacherBytes = Buffer.from(teacher.packed, "base64");
const teacherOrder = (index) => (teacherBytes[index >> 1] >> ((index & 1) * 4)) & 15;
const size = teacher.domains.reduce((n, [, values]) => n * values.length, 1);

// "situation:order" -> [sum of returns, sum of their squares, tries]
const stats = existsSync(statsFile) ? new Map(JSON.parse(await readFile(statsFile, "utf8")).entries) : new Map();

/** Runs fit_q.py on the statistics so far; returns its decision. */
async function fit(final) {
  const rows = [...stats].map(([key, [sum, squares, tries]]) => [...key.split(":").map(Number), sum, squares, tries]);
  await writeFile(statsFile, JSON.stringify({ teacher: TEACHER, entries: [...stats] }));
  const input = join(here, `rows-${name}.json`);
  await writeFile(input, JSON.stringify({ teacher: TEACHER, rows }));
  execFileSync("uv", ["run", "--project", join(repo, "tools", "distill"), "python", join(here, "fit_q.py"),
                      input, fitFile, ...(final ? ["--final"] : [])], { stdio: "inherit" });
  return JSON.parse(await readFile(fitFile, "utf8"));
}

async function writeTable(decision, label) {
  const table = new Uint8Array(size);
  for (let index = 0; index < size; index++)
    table[index] = teacherOrder(index);
  for (const [index, order] of decision.greedy)
    table[index] = order;
  const packed = new Uint8Array(size / 2);
  for (let i = 0; i < packed.length; i++)
    packed[i] = table[2 * i] | (table[2 * i + 1] << 4);
  const text =
    "// Generated by tools/rl/train.mjs; do not edit.\n" +
    "// What a badguy does in every combination of the facts of laya-rich-prompt.js.\n" +
    "window.POLICY_TABLES = window.POLICY_TABLES || {};\n" +
    `window.POLICY_TABLES[${JSON.stringify(name)}] = ` + JSON.stringify({
      model: `reinforcement learning from ${teacher.model}`,
      domains: teacher.domains,
      orders: teacher.orders,
      packed: Buffer.from(packed).toString("base64"),
    }) + ";\n";
  await writeFile(join(repo, "mk", "emscripten", `${name}-table.js`), text);
  await mkdir(join(here, "snapshots"), { recursive: true });
  await writeFile(join(here, "snapshots", `${name}-${label}.js`), text);
}

// The game page with the bot and the learner.
const sections = JSON.parse(await readFile(join(repo, "tools", "eval", "sections.json"), "utf8"));
const play = await readFile(join(build, "play.html"), "utf8");
const marker = /<script src="laya-prompt\.js[^"]*"><\/script>/;
await copyFile(join(repo, "tools", "eval", "bot.js"), join(build, "eval-bot.js"));
await copyFile(join(here, "learner.js"), join(build, "rl-learner.js"));
await writeFile(join(build, "rl.html"), play.replace(marker, (m) =>
  `<script src="eval-bot.js?v=${Date.now()}"></script>\n  <script src="rl-learner.js?v=${Date.now()}"></script>\n  ${m}`));

const browser = await chromium.launch({ headless: true, channel: "chromium",
                                        args: ["--enable-gpu", "--ignore-gpu-blocklist", "--mute-audio"] });
const pages = await Promise.all(Array.from({ length: tabs }, async (_, i) => {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on("pageerror", (e) => console.error(`[tab ${i}] pageerror`, e.message));
  await page.goto(`${base}/rl.html?ai=${TEACHER}&seed=${100 + i}&bots=${bots}` +
                  `&sections=${encodeURIComponent(JSON.stringify(sections))}`);
  await page.waitForFunction(() => document.title.startsWith("SuperTux"), null, { timeout: 300000 });
  await page.waitForTimeout(1000);
  return page;
}));

let started = false;
let decision = stats.size ? await fit(false) : { greedy: [], explore: [], significant: 0 };
for (let iteration = 1; iteration <= iterations; iteration++) {
  const epsilon = epsilonStart + (epsilonEnd - epsilonStart) * (iteration - 1) / Math.max(iterations - 1, 1);
  const results = await Promise.all(pages.map(async (page, i) => {
    await page.evaluate((p) => window.__rl_set(p), { teacher: TEACHER, greedy: decision.greedy,
                                                     explore: decision.explore, epsilon,
                                                     seed: iteration * 1000 + i });
    const livesBefore = await page.evaluate(() => (window.__eval ? window.__eval.lives.length : 0));
    const target = await page.evaluate(([t, s, first]) => {
      if (first) window.__eval_start(t, s);
      else window.__eval_continue(t, s);
      return window.__eval.gameTime + s;
    }, [turbo, minutes * 60, !started]);
    for (;;) {
      await page.waitForTimeout(1500);
      if (await page.evaluate((end) => window.__eval.gameTime >= end - 0.1, target))
        break;
    }
    return page.evaluate((from) => ({ ...window.__rl_collect(), lives: window.__eval.lives.slice(from) }), livesBefore);
  }));
  started = true;

  let samples = 0;
  let hits = 0, stomped = 0, cleared = 0, deaths = 0;
  for (const result of results) {
    hits += result.hits;
    stomped += result.stomped;
    cleared += result.lives.filter((l) => l.end === "cleared").length;
    deaths += result.lives.filter((l) => l.end === "death").length;
    for (const [index, order, value] of result.samples) {
      samples++;
      const key = `${index}:${order}`;
      const entry = stats.get(key) || [0, 0, 0];
      entry[0] += value;
      entry[1] += value * value;
      entry[2] += 1;
      stats.set(key, entry);
    }
  }
  decision = await fit(false);
  console.log(`iteration ${iteration}: epsilon ${epsilon.toFixed(2)}, ${samples} decisions, ${hits} hits, ` +
              `${stomped} stomped, cleared ${(cleared / Math.max(cleared + deaths, 1)).toFixed(3)}, ` +
              `${decision.significant} of ${decision.states} situations changed beyond doubt`);
  if (iteration % 10 === 0)
    await writeTable(decision, `it${iteration}`);
}
await browser.close();

const final = await fit(true);
await writeTable(final, "final");
console.log(`wrote mk/emscripten/${name}-table.js: ${final.significant} situations met and ` +
            `${final.unmet} never met differ from ${TEACHER}`);

