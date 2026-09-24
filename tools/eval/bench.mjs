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

// Measures how hard each enemy AI mode makes the level, with bot.js playing.
//
//   node tools/eval/bench.mjs [--modes off,laya,laya-rich] [--seeds 1,2,3]
//        [--minutes 5] [--turbo 40] [--parallel 3] [--bots rusher,stomper,cautious] [--lag 1]
//        [--out results.json] [--build build.wasm]
//
// Needs the web build and tools/jev-proxy/server.mjs serving it on 8765.
// The sections (sections.json) are the parts of Shallow Green the bot can get
// through when the badguys behave as usual; others were left out because the
// bot got stuck or died to the terrain there even in Classic, so they would
// measure the bot, not the badguys. --sections 0,2 picks some of them.
// Each (mode, seed) runs in its own headless page for --minutes of game time
// at --turbo logic steps per frame; the same seed gives every mode the same
// sequence of bot styles and parameters. The page is play.html with the bot
// added, written to <build>/eval.html (not part of the site).

import { chromium } from "playwright";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) =>
  arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
const modes = (args.modes || "off,laya,laya-rich").split(",");
const seeds = (args.seeds || "1,2,3").split(",").map(Number);
const minutes = Number(args.minutes || 5);
const turbo = Number(args.turbo || 40);
const parallel = Number(args.parallel || 3);
const bots = args.bots || "rusher,stomper,cautious";
const build = resolve(repo, args.build || "build.wasm");
const out = args.out || join(here, "results.json");
const base = "http://127.0.0.1:8765";
const allSections = JSON.parse(await readFile(join(here, "sections.json"), "utf8"));
const sections = args.sections ? args.sections.split(",").map(Number).map((i) => allSections[i]) : allSections;

// The game page with the bot in front of the controller.
const play = await readFile(join(build, "play.html"), "utf8");
const marker = /<script src="laya-prompt\.js[^"]*"><\/script>/;
if (!marker.test(play))
  throw new Error("play.html has changed; update the marker in bench.mjs");
await copyFile(join(here, "bot.js"), join(build, "eval-bot.js"));
await writeFile(join(build, "eval.html"),
                play.replace(marker, (m) => `<script src="eval-bot.js?v=${Date.now()}"></script>\n  ${m}`));

async function runOne(browser, mode, seed) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on("pageerror", (e) => console.error(`[${mode}/${seed}] pageerror`, e.message));
  await page.goto(`${base}/eval.html?ai=${mode}&seed=${seed}&bots=${bots}${args.lag ? "&lag=1" : ""}` +
                  `&sections=${encodeURIComponent(JSON.stringify(sections))}`);
  await page.waitForFunction(() => document.title.startsWith("SuperTux"), null, { timeout: 300000 });
  await page.waitForTimeout(1000);
  const started = Date.now();
  await page.evaluate(([t, s, c]) => window.__eval_start(t, s, c), [turbo, minutes * 60, !!args.collect]);

  const target = minutes * 60;
  for (;;) {
    await page.waitForTimeout(2000);
    const time = await page.evaluate(() => window.__eval.gameTime);
    if (time >= target)
      break;
    if (Date.now() - started > 30 * 60 * 1000)
      throw new Error(`${mode}/${seed}: only ${time.toFixed(0)} s of game time after 30 minutes`);
  }
  const result = await page.evaluate(() => window.__eval_finish());
  const wall = (Date.now() - started) / 1000;
  console.log(`${mode.padEnd(10)} seed ${seed}: ${result.lives.length} lives, ` +
              `${(result.gameTime / wall).toFixed(0)}x real time`);
  if (args.screenshot)
    await page.screenshot({ path: `${args.screenshot}-${mode}-${seed}.png` });
  await page.close();
  return { mode, seed, gameTime: result.gameTime, lives: result.lives, trace: result.trace, facts: result.facts };
}

const median = (values) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function summarize(runs, filter = () => true) {
  const lives = runs.flatMap((r) => r.lives).filter(filter);
  const minutesPlayed = runs.reduce((sum, r) => sum + r.gameTime, 0) / 60;
  const count = (end) => lives.filter((l) => l.end === end).length;
  const judged = lives.filter((l) => l.end === "cleared" || l.end === "death");
  return {
    runs: lives.length,
    // Of the runs that ended in either, how many reached the section's end.
    cleared: +(count("cleared") / Math.max(judged.length, 1)).toFixed(3),
    deaths: count("death"),
    stuck: count("stuck") + count("slow"),
    deathsPerMinute: +(count("death") / minutesPlayed).toFixed(2),
    medianGained: Math.round(median(lives.map((l) => l.gained))),
    hurtsPerRun: +(lives.reduce((s, l) => s + l.hurts, 0) / Math.max(lives.length, 1)).toFixed(2),
    squishedPerRun: +(lives.reduce((s, l) => s + l.squished, 0) / Math.max(lives.length, 1)).toFixed(2),
  };
}

const browser = await chromium.launch({ headless: true, channel: "chromium",
                                        args: ["--enable-gpu", "--ignore-gpu-blocklist", "--mute-audio"] });
const jobs = modes.flatMap((mode) => seeds.map((seed) => ({ mode, seed })));
const runs = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
  while (next < jobs.length) {
    const { mode, seed } = jobs[next++];
    runs.push(await runOne(browser, mode, seed));
  }
}));
await browser.close();

const summary = {};
for (const mode of modes) {
  const mine = runs.filter((r) => r.mode === mode);
  summary[mode] = { all: summarize(mine), styles: {}, sections: {} };
  for (const style of new Set(mine.flatMap((r) => r.lives.map((l) => l.style))))
    summary[mode].styles[style] = summarize(mine, (l) => l.style === style);
  sections.forEach((_, i) => { summary[mode].sections[i] = summarize(mine, (l) => l.section === i); });
}

await writeFile(out, JSON.stringify({ date: new Date().toISOString(), modes, seeds, minutes, turbo, bots,
                                     sections, summary, runs }, null, 2));
const row = (label, s) => label.padEnd(12) + String(s.runs).padStart(5) + String(s.cleared).padStart(9) +
  String(s.deaths).padStart(7) + String(s.stuck).padStart(7) + String(s.medianGained).padStart(9) +
  String(s.hurtsPerRun).padStart(8) + String(s.squishedPerRun).padStart(10);
const header = "".padEnd(12) + " runs  cleared deaths  stuck  gained   hurts  squished";
for (const mode of modes) {
  console.log(`\n${mode}\n${header}\n${row("all", summary[mode].all)}`);
  for (const [style, s] of Object.entries(summary[mode].styles)) console.log(row("  " + style, s));
  for (const [i, s] of Object.entries(summary[mode].sections)) console.log(row("  section " + i, s));
}
console.log("\nwrote " + out);
