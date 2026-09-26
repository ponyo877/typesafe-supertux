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

// Co-evolution with a Tux that gets through the whole level.
//
//   node tools/coevo/league.mjs --tux <table> --enemy <table> [--generations 4] [--prefix h]
//        [--enemy-iterations 12] [--enemy-minutes 8] [--dagger-rounds 12] [--delays 0,2] [--noise 0.03] [--resume]
//
// Every generation:
//   1. The badguys learn (coevo.mjs enemy: reinforcement learning, as in
//      the earlier co-evolutions) against the Tux champion, the earlier
//      Tuxes and a few bot styles, on the sections and whole runs.
//   2. Every Tux plays every kind of badguys from the start in search.html
//      (the way the videos are made): how far each gets. The new badguys
//      become the champions if the Tux champion gets less far against them.
//   3. Tux learns (dagger.mjs: the table's mistakes, fixed by search)
//      against every kind of badguys so far, from the Tux champion.
// The table of how far each Tux got against each kind of badguys goes to
// league.json after every step; run it again with --resume to go on.
//
// Needs the web build, tools/jev-proxy/server.mjs on 8765 and the uv
// environment of tools/distill.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const build = join(repo, "build.wasm");
const tablesDir = join(here, "tables");
const leagueFile = join(here, "league.json");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) =>
  arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]] : pairs, []));
const generations = Number(args.generations || 4);
const prefix = args.prefix || "h";
const BOTS = ["bot:rusher", "bot:stomper", "bot:hopper", "bot:sprinter"];
const TURBO = 20;  // as dagger.mjs: runs of 40 steps and more at once play out unlike real time
const DELAYS = (args.delays || "0,2").split(",").map(Number);  // waits before Tux starts (dagger.mjs)
// Badguys that now and then do something else (jev-controller.js ?noise=):
// Tux learns against them and is judged on them too; the badguys are
// judged without.
const NOISE = Number(args.noise || 0.03);
const NOISE_SEEDS = [1, 2, 3];

const league = args.resume && existsSync(leagueFile) ? JSON.parse(await readFile(leagueFile, "utf8")) : {
  generation: 0,
  tuxes: [args.tux],
  enemies: ["off", "coevo4"],
  champions: { tux: args.tux, enemy: args.enemy },
  // enemy -> tux -> { reached, maxX, seconds }
  results: {},
};
const save = () => writeFile(leagueFile, JSON.stringify(league, null, 1));
// The noisy badguys: the champion's (Trained AI's at first).
const championKind = () => (league.champions.enemy === "enemy-g17" ? "coevo4" : league.champions.enemy);
const noisyKinds = () => [championKind()];
// Tux learns against the classic badguys, Trained AI's and the champion's:
// the earlier tables differ from those in a few situations only, and every
// kind of badguys is a game per page to keep in memory.
const learnKinds = () => {
  const kinds = ["off", "coevo4", championKind()];
  // And the earlier badguys the Tux champion does worst against, so that
  // what beat those is not forgotten.
  const older = league.enemies.filter((e) => !kinds.includes(e) && e !== "enemy-g17")
    .map((e) => [e, far(e, league.champions.tux)]).filter(([, x]) => x < 14000).sort((a, b) => a[1] - b[1]);
  if (older.length) kinds.push(older[0][0]);
  return [...new Set(kinds)];
};

function run(script, scriptArgs, retries = 0) {
  for (let attempt = 0; ; attempt++) {
    console.log(`> node ${script} ${scriptArgs.join(" ")}`);
    try {
      execFileSync("node", [join(here, script), ...scriptArgs], { stdio: "inherit", cwd: here });
      return;
    } catch (error) {
      // A browser that dies under the load of many games is not the end:
      // dagger.mjs saves as it goes and goes on from its own table.
      if (attempt >= retries) throw error;
      console.log(`  ${script} failed (${error.message.split("\n")[0]}); again`);
      if (script === "dagger.mjs") scriptArgs[scriptArgs.indexOf("--from") + 1] = scriptArgs[scriptArgs.indexOf("--name") + 1];
    }
  }
}

/** Closes a browser; closing has been seen to hang, so not for long. */
async function closeBrowser(browser) {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
  try { browser.process()?.kill("SIGKILL"); } catch {}
}

// --- how far every Tux gets against every kind of badguys -----------------------

const parse = (text) => JSON.parse(text.slice(text.indexOf("] = ") + 4, text.lastIndexOf(";")));
// "off", "coevo4", a badguy table, or any of those with "~" for noise.
const aiQuery = async (kind) => {
  const ai = kind.replace(/~$/, "");
  const extra = kind.endsWith("~") ? `&noise=${NOISE}` : "";
  if (ai === "off" || ai === "coevo4") return `ai=${ai}${extra}`;
  await copyFile(join(tablesDir, `${ai}.js`), join(build, `${ai}-table.js`));
  return `ai=table&table=${encodeURIComponent(ai)}${extra}`;
};

async function measure(enemies, tuxes, { again = true } = {}) {
  // Resuming, only what has not been measured yet.
  if (!again) {
    const missing = (e) => tuxes.some((t) => !(league.results[e] || {})[t]);
    enemies = enemies.filter(missing);
    if (!enemies.length) return;
  }
  const play = await readFile(join(build, "play.html"), "utf8");
  const marker = /<script src="laya-prompt\.js[^"]*"><\/script>/;
// Everyone's counts and headstones stay out of automated play: headstones
// are objects in the level, and would change it.
const STATS_SCRIPT = /<script src="stats\.js[^"]*"><\/script>/;
  await copyFile(join(here, "player-facts.js"), join(build, "coevo-player-facts.js"));
  await copyFile(join(here, "search.js"), join(build, "coevo-search.js"));
  const v = Date.now();
  await writeFile(join(build, "search.html"), play.replace(STATS_SCRIPT, "").replace(marker, (m) =>
    `<script src="coevo-player-facts.js?v=${v}"></script>\n  <script src="coevo-search.js?v=${v}"></script>\n  ${m}`));
  const tables = {};
  for (const tux of tuxes) {
    const t = parse(await readFile(join(tablesDir, `${tux}.js`), "utf8"));
    tables[tux] = { packed: t.packed, extra: t.extra, delta: t.delta || {}, react: !!t.react };
  }
  const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--mute-audio"] });
  // A few games at a time: each is a page of a few hundred MB.
  let nextEnemy = 0;
  await Promise.all(Array.from({ length: Math.min(4, enemies.length) }, async () => {
   while (nextEnemy < enemies.length) {
    const enemy = enemies[nextEnemy++];
    const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage()  // own storage: the game keeps its config and saves there;
    await page.goto(`http://127.0.0.1:8765/search.html?${await aiQuery(enemy)}&v=${v}`, { timeout: 300000 });
    await page.waitForFunction(() => document.title.startsWith("SuperTux"), null, { timeout: 300000 });
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.__search_ready());
    league.results[enemy] = league.results[enemy] || {};
    for (const tux of tuxes) {
      league.results[enemy][tux] = [];
      // Clean badguys at every timing; noisy ones with every noise seed.
      const runs = enemy.endsWith("~") ? NOISE_SEEDS.map((seed) => ({ delay: 0, seed }))
                                       : DELAYS.map((delay) => ({ delay, seed: 1 }));
      for (const { delay, seed } of runs) {
        const r = await page.evaluate(([t, turbo, waits, seed]) => window.__search_policy(112, 576, 13380, waits, t, turbo, seed, 300),
                                      [tables[tux], TURBO, Array(delay).fill(2), seed]);
        league.results[enemy][tux].push({ delay, seed, reached: r.reached, maxX: r.maxX, seconds: r.seconds });
      }
    }
    await page.context().close().catch(() => {});
   }
  }));
  await closeBrowser(browser);
  await save();
}

/** How far a Tux gets against some badguys, on average over the timings. */
const far = (enemy, tux) => {
  const rs = (league.results[enemy] || {})[tux];
  return !rs ? 0 : rs.reduce((sum, r) => sum + (r.reached ? 14000 : r.maxX), 0) / rs.length;
};

function show() {
  const tuxes = league.tuxes;
  console.log(["", ...tuxes].map((s) => String(s).padEnd(14)).join(""));
  for (const enemy of [...league.enemies, ...noisyKinds().map((k) => k + "~")])
    console.log([enemy, ...tuxes.map((t) => { const rs = (league.results[enemy] || {})[t];
      return !rs ? "-" : rs.map((r) => (r.reached ? "GOAL" : String(r.maxX))).join("/"); })]
      .map((s) => String(s).padEnd(14)).join(""));
}

// --- generations --------------------------------------------------------------

await measure([...league.enemies, ...noisyKinds().map((k) => k + "~")], league.tuxes, { again: false });
show();
const last = league.generation + generations;
for (let g = league.generation + 1; g <= last; g++) {
  console.log(`\n=== generation ${g}`);

  // 1. The badguys learn (unless they already did, when resuming).
  const enemyName = `enemy-${prefix}${g}`;
  if (!league.enemies.includes(enemyName)) {
  const players = [`${league.champions.tux}:4`, ...league.tuxes.filter((t) => t !== league.champions.tux), ...BOTS];
  run("coevo.mjs", ["enemy", "--from", league.champions.enemy === "coevo4" ? "enemy-g17" : league.champions.enemy,
                    // The sections too: on whole runs alone, the badguys past
                    // where Tux falls never meet him and learn nothing.
                    "--name", enemyName, "--players", players.join(","),
                    "--iterations", String(args["enemy-iterations"] || 12), "--minutes", String(args["enemy-minutes"] || 8),
                    "--turbo", String(TURBO),
                    // A little easier to change a situation: with the strict
                    // defaults, a generation changed two to eight.
                    "--z", String(args["enemy-z"] || 1.5), "--min-tries", String(args["enemy-min-tries"] || 20)]);
  league.enemies.push(enemyName);

  // 2. How far every Tux gets now.
  await measure([enemyName], league.tuxes);
  const champion = league.champions.enemy === "enemy-g17" ? "coevo4" : league.champions.enemy;
  if (far(enemyName, league.champions.tux) < far(champion, league.champions.tux)) {
    league.champions.enemy = enemyName;
    console.log(`  ${enemyName} stops the Tux champion sooner: the new badguy champion`);
  } else {
    console.log(`  ${enemyName} does not stop the Tux champion sooner; ${league.champions.enemy} stays champion`);
  }
  await save();
  show();
  }

  // 3. Tux learns against every kind of badguys so far.
  const tuxName = `tux-${prefix}${g}`;
  const asAi = (e) => (e === "off" || e === "coevo4" ? e : `table:${e}`);
  const ais = learnKinds().map(asAi);
  // Resuming, a Tux already partly taught goes on from where it was.
  // When the badguy champion stayed, learning from the Tux champion again
  // would only find what it found before: go on from the latest Tux.
  const championStayed = league.lastEnemyChampion === league.champions.enemy;
  league.lastEnemyChampion = league.champions.enemy;
  const from = existsSync(join(tablesDir, `${tuxName}.js`)) ? tuxName
             : championStayed ? league.tuxes[league.tuxes.length - 1] : league.champions.tux;
  run("dagger.mjs", ["--from", from, "--name", tuxName, "--ai", ais.join(","),
                     "--noisy", noisyKinds().map(asAi).join(","), "--noise", String(NOISE),
                     "--noise-seeds", NOISE_SEEDS.join(","),
                     "--tabs", String(args["dagger-tabs"] || 1), "--rounds", String(args["dagger-rounds"] || 12), "--last", championStayed ? "12" : "8", "--keep", "4", "--worst", "2",
                     "--delays", DELAYS.join(","),
                     "--turbo", String(TURBO)], 3);
  league.tuxes.push(tuxName);
  // The champion too, so both are judged on the same badguys.
  await measure([...league.enemies, ...noisyKinds().map((k) => k + "~")], [tuxName, league.champions.tux]);
  const total = (tux) => [...league.enemies, ...noisyKinds().map((k) => k + "~")].reduce((sum, e) => sum + far(e, tux), 0);
  if (total(tuxName) > total(league.champions.tux)) {
    league.champions.tux = tuxName;
    console.log(`  ${tuxName} gets further overall: the new Tux champion`);
  }
  league.generation = g;
  // Stop once neither side has had a new champion for two generations.
  const champions = JSON.stringify(league.champions);
  league.stale = champions === league.lastChampions ? (league.stale || 0) + 1 : 0;
  league.lastChampions = champions;
  await save();
  show();
  if (league.stale >= 2) {
    console.log("no new champion on either side for two generations: stopping");
    break;
  }
}
process.exit(0);
