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

// Co-evolution: Tux and the badguys take turns learning against each other.
//
//   node tools/coevo/coevo.mjs collect [--minutes 20]
//       Lets the bot styles of tools/eval play against the badguy tables and
//       counts the situations Tux meets, for Claude to label (LABELING.md).
//   node tools/coevo/coevo.mjs run [--generations 5] [--iterations 15] [--minutes 10] [--player-minutes 20]
//        [--player-iterations 15] [--z 2] [--min-tries 30] [--extend] [--learn-shield] [--gate-minutes 10]
//       Every generation, Tux learns against the league of badguys (classic
//       and every badguy table so far), then the badguys learn against the
//       league of Tuxes (the bot styles and every Tux table so far). Each
//       side starts from its latest table; the newest opponent is met half
//       the time, the older ones the rest, so neither side can win by
//       forgetting what beat the older ones. Learning is as in tools/rl
//       (fit_q.py). Progress is kept in state.json; run it again to go on.
//   node tools/coevo/coevo.mjs tune --from <tux table> --name <new name> [--practice wall] [--iterations 15]
//        [--player-minutes 10]
//       Tux learns on from one of his tables against the champion badguys and
//       the classic ones, on the sections and, three times as often, on the
//       practice sections of sections.json (e.g. "wall": the wall at
//       x = 1904, climbed by the two platforms before it, which Tux never
//       gets to try otherwise).
//   node tools/coevo/coevo.mjs enemy --from <badguy table> --name <new> --players <tux>[:weight],bot:<style>,...
//        [--full] [--iterations 15] [--minutes 10] [--turbo 20]
//       One badguy table learns on its own against the Tuxes given (as the
//       badguys learn in `run`), on the whole level only with --full.
//   node tools/coevo/coevo.mjs eval [--minutes 30] [--full-minutes 120] [--enemies a,b] [--players c,d]
//       Plays every badguy table against every Tux, on the sections and on
//       the whole level, and writes the table of clear rates to results.json.
//
// Needs the web build, tools/jev-proxy/server.mjs serving it on 8765 and the
// uv environment of tools/distill. Tables go to tools/coevo/tables/.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
// Read the way the page reads it.
const factsContext = {};
vm.runInNewContext(await readFile(join(here, "player-facts.js"), "utf8"), factsContext);
const PlayerFacts = factsContext.PlayerFacts;

const [command, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.reduce((pairs, arg, i, all) =>
  arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
const tabs = Number(args.tabs || 6);
const turbo = Number(args.turbo || 80);
const minutes = Number(args.minutes || 10);
// Tux makes far fewer decisions than the badguys (a move lasts until it is
// done, a death takes three seconds), so he plays longer per iteration.
const playerMinutes = Number(args["player-minutes"] || 2 * minutes);
const build = resolve(repo, "build.wasm");
const base = "http://127.0.0.1:8765";
const tablesDir = join(here, "tables");
const stateFile = join(here, "state.json");
const sections = JSON.parse(await readFile(join(here, "sections.json"), "utf8"));

const ENEMY_ACTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// The styles of tools/eval/bot.js that play in the league, each as its own
// opponent ("bot:<style>"); waiter, bunny and zigzag are kept for checking only.
const BOT_STYLES = ["rusher", "stomper", "cautious", "hopper", "sprinter", "backstepper", "chaotic", "stalker",
                    "jumper"];

// Facts the badguys' tables may look at beyond the rich prompt's (--extend;
// computed in mk/emscripten/jev-controller.js from src/port/jev_bridge.cpp's
// state): the player just landed, his speed and size, a badguy within a
// tile, another badguy already attacking him, the badguy's zone of the level
// (400 px each), so it can learn what works where, and whether the player
// keeps jumping.
const EXTRA = [
  ["landed", [false, true]],
  ["speed", ["still", "walk", "run"]],
  ["size", ["small", "big"]],
  ["close", [false, true]],
  ["ally_attacking", [false, true]],
  ["zone", Array.from({ length: 38 }, (_, i) => i)],
  ["hopping", [false, true]],
];
const PLAYER_ACTIONS = PlayerFacts.MOVES.map((_, i) => i);

// --- tables -----------------------------------------------------------------

function parseTable(text) {
  return JSON.parse(text.slice(text.indexOf("] = ") + 4, text.lastIndexOf(";")));
}

async function loadTable(path) {
  return parseTable(await readFile(path, "utf8"));
}

async function saveTable(path, name, model, domains, orders, codes, finer) {
  const packed = new Uint8Array(codes.length / 2);
  for (let i = 0; i < packed.length; i++)
    packed[i] = codes[2 * i] | (codes[2 * i + 1] << 4);
  await writeFile(path,
    "// Generated by tools/coevo/coevo.mjs; do not edit.\n" +
    "window.POLICY_TABLES = window.POLICY_TABLES || {};\n" +
    `window.POLICY_TABLES[${JSON.stringify(name)}] = ` +
    JSON.stringify({ model, domains, orders, packed: Buffer.from(packed).toString("base64"), ...(finer || {}) }) + ";\n");
}

function unpack(table) {
  const bytes = Buffer.from(table.packed, "base64");
  const codes = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    codes[2 * i] = bytes[i] & 15;
    codes[2 * i + 1] = bytes[i] >> 4;
  }
  return codes;
}

// --- pages ------------------------------------------------------------------

async function openPages(sectionList, count) {
  const play = await readFile(join(build, "play.html"), "utf8");
  const marker = /<script src="laya-prompt\.js[^"]*"><\/script>/;
  const v = Date.now();
  await copyFile(join(repo, "tools", "eval", "bot.js"), join(build, "eval-bot.js"));
  await copyFile(join(here, "player-facts.js"), join(build, "coevo-player-facts.js"));
  await copyFile(join(here, "page.js"), join(build, "coevo-page.js"));
  await writeFile(join(build, "coevo.html"), play.replace(marker, (m) =>
    `<script src="eval-bot.js?v=${v}"></script>\n  <script src="coevo-player-facts.js?v=${v}"></script>\n` +
    `  <script src="coevo-page.js?v=${v}"></script>\n  ${m}`));

  const browser = await chromium.launch({ headless: true, channel: "chromium",
                                          args: ["--enable-gpu", "--ignore-gpu-blocklist", "--mute-audio"] });
  const pages = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    page.on("pageerror", (e) => console.error(`[tab ${i}] pageerror`, e.message));
    await page.goto(`${base}/coevo.html?ai=llm&seed=${200 + i}&lag=1&gameseed=${args.gameseed || 1}` +
                    // Tables that learned when to retreat play without the
                    // page's shield (page.js keeps it for those that did not).
                    `${args["learn-shield"] || command === "enemy" ? "&shield=0" : ""}` +
                    `&sections=${encodeURIComponent(JSON.stringify(sectionList))}`);
    await page.waitForFunction(() => document.title.startsWith("SuperTux"), null, { timeout: 300000 });
    await page.waitForTimeout(1000);
    page.started = false;
    return page;
  }));
  return { browser, pages };
}

/** Plays `seconds` of game time in every page with this setup; returns what
    the pages collected. */
async function play(pages, setup, seconds) {
  return Promise.all(pages.map(async (page, i) => {
    await page.evaluate((s) => window.__coevo_set(s), { ...setup, seed: setup.seed * 100 + i });
    const target = await page.evaluate(([t, s, first]) => {
      if (first) window.__eval_start(t, s);
      else window.__eval_continue(t, s);
      return window.__eval.gameTime + s;
    }, [turbo, seconds, !page.started]);
    page.started = true;
    for (;;) {
      await page.waitForTimeout(1500);
      if (await page.evaluate((end) => window.__eval.gameTime >= end - 0.1, target))
        break;
    }
    return page.evaluate(() => window.__coevo_collect());
  }));
}

// --- leagues ----------------------------------------------------------------

const enemyDomains = (await loadTable(join(repo, "mk", "emscripten", "llm-table.js"))).domains;

async function entry(name, path, weight) {
  if (!path)
    return { name, weight };
  const table = await loadTable(path);
  return {
    name, weight, packed: table.packed,
    // Tables that learned when to retreat do without the shield.
    shield: !table.learned_shield,
    ...(table.extra ? { extra: table.extra, delta: Object.entries(table.delta).map(([k, v]) => [Number(k), v]) } : {}),
    ...(table.react ? { react: true } : {}),
  };
}

/** The newest opponent half the time, the others the rest. */
async function league(members) {
  const others = members.length > 1 ? 0.5 / (members.length - 1) : 0;
  return Promise.all(members.map(({ name, path }, i) =>
    entry(name, path, i === members.length - 1 ? (members.length > 1 ? 0.5 : 1) : others)));
}

async function loadState() {
  if (existsSync(stateFile))
    return JSON.parse(await readFile(stateFile, "utf8"));
  return {
    generation: 0,
    enemies: [
      { name: "classic", path: null },
      { name: "llm", path: join(repo, "mk", "emscripten", "llm-table.js") },
      { name: "rl2", path: join(repo, "mk", "emscripten", "rl2-table.js") },
    ],
    players: [
      { name: "bot", path: null },
      { name: "tux-llm", path: join(tablesDir, "tux-llm.js") },
    ],
  };
}

// --- one side learning --------------------------------------------------------

/** Adds every run's outcome to the record of who beat whom. */
function note(state, results) {
  state.record = state.record || {};
  for (const r of results.flatMap((x) => x.runs)) {
    const key = `${r.enemy}|${r.player}`;
    const c = state.record[key] || (state.record[key] = [0, 0]);
    c[0] += 1;
    if (r.end === "cleared") c[1] += 1;
  }
}

/** How often Tux gets through, from the record; null when too few runs. */
function clearRate(state, enemy, player, min = 20) {
  const c = (state.record || {})[`${enemy}|${player}`];
  return c && c[0] >= min ? c[1] / c[0] : null;
}

/** Prioritised fictitious self-play: the opponents the learner does worst
    against are met most. `self` is the learner's name so far, `fallback` its
    teacher's, used until the learner has enough runs of its own. */
function pfspWeights(state, isPlayer, opponents, self, fallback) {
  return opponents.map((o) => {
    const rate = (who) => isPlayer ? clearRate(state, o.name, who) : clearRate(state, who, o.name);
    const cleared = rate(self) ?? rate(fallback) ?? 0.5;
    const loss = isPlayer ? 1 - cleared : cleared;  // how badly the learner does
    return (loss + 0.05) ** 2;
  });
}

/** Every opponent still gets at least `floor` of the games, so none of them
    (the bot styles the badguys beat easily, old generations) is forgotten. */
function withFloor(weights, floor = 0.02) {
  const total = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.max(w / total, floor));
  const sum = shares.reduce((a, b) => a + b, 0);
  return shares.map((w) => w / sum);
}

/**
 * Trains one table. `teacherInfo` is where it starts, `opponentInfos` whom it
 * plays; `pfsp` weights them by how badly the learner does against each,
 * otherwise evenly. Returns the new table's { name, path }.
 */
async function learn(pages, { side, state, generation, iterations, name, teacherInfo, opponentInfos, pfsp, midway }) {
  const isPlayer = side === "player";
  const teacher = await loadTable(teacherInfo.path);
  const teacherCodes = unpack(teacher);
  const teacherEntry = await entry(teacherInfo.name, teacherInfo.path, 1);
  const opponents = await Promise.all(opponentInfos.map(({ name, path, weight }) => entry(name, path, weight ?? 1)));
  const statsFile = join(here, `stats-${name}.json`);
  const rowsFile = join(here, `rows-${name}.json`);
  const fitFile = join(here, `fit-${name}.json`);
  const stats = new Map();

  const fit = async (final) => {
    await writeFile(statsFile, JSON.stringify([...stats]));
    await writeFile(rowsFile, JSON.stringify({
      teacher_path: teacherInfo.path, actions: isPlayer ? PLAYER_ACTIONS : ENEMY_ACTIONS,
      z: Number(args.z || 2), min_tries: Number(args["min-tries"] || 30),
      ...(teacher.extra ? { extra_radix: teacher.extra.map(([, values]) => values.length) } : {}),
      rows: [...stats].map(([key, [sum, squares, tries]]) => [...key.split(":").map(Number), sum, squares, tries]),
    }));
    execFileSync("uv", ["run", "--project", join(repo, "tools", "distill"), "python",
                        join(repo, "tools", "rl", "fit_q.py"), rowsFile, fitFile, ...(final ? ["--final"] : [])],
                 { stdio: "inherit" });
    return JSON.parse(await readFile(fitFile, "utf8"));
  };

  let decision = { greedy: [], explore: [] };
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const epsilon = 0.3 + (0.05 - 0.3) * (iteration - 1) / Math.max(iterations - 1, 1);
    if (pfsp) {
      const weights = withFloor(pfspWeights(state, isPlayer, opponents, name, teacherInfo.name));
      opponents.forEach((o, i) => { o.weight = weights[i]; });
    }
    const trainee = { ...teacherEntry, name, weight: 1, training: true, epsilon,
                      greedy: decision.greedy, explore: decision.explore };
    const setup = {
      enemyDomains, seed: generation * 1000 + iteration + (isPlayer ? 0 : 500) + (name.includes("-x") ? 300 : 0),
      enemies: isPlayer ? opponents : [trainee],
      players: isPlayer ? [trainee] : opponents,
    };
    const results = await play(pages, setup, (isPlayer ? playerMinutes : minutes) * 60);
    note(state, results);

    let samples = 0, cleared = 0, judged = 0;
    for (const result of results) {
      for (const [index, action, value] of isPlayer ? result.playerSamples : result.enemySamples) {
        samples++;
        const key = `${index}:${action}`;
        const s = stats.get(key) || [0, 0, 0];
        s[0] += value; s[1] += value * value; s[2] += 1;
        stats.set(key, s);
      }
      for (const r of result.runs) {
        if (r.end === "cleared" || r.end === "death") judged++;
        if (r.end === "cleared") cleared++;
      }
    }
    decision = await fit(false);

    // Halfway, `midway` gets the table as it is now and may bring a new
    // opponent (an exploiter trained against it) into the games.
    if (midway && iteration === Math.floor(iterations / 2)) {
      const snapshot = await saveSnapshot(`${name}-half`, teacher, teacherCodes, decision.greedy);
      const newcomer = await midway(snapshot);
      if (newcomer) opponents.push(await entry(newcomer.name, newcomer.path, 1));
    }
    const mix = pfsp ? "  [" + opponents.map((o) => `${o.name} ${o.weight.toFixed(2)}`).join(", ") + "]" : "";
    console.log(`  ${name} ${iteration}/${iterations}: epsilon ${epsilon.toFixed(2)}, ${samples} decisions, ` +
                `cleared ${(cleared / Math.max(judged, 1)).toFixed(3)} of ${judged}, ` +
                `${decision.significant} of ${decision.states} situations changed` + (iteration === iterations ? mix : ""));
  }

  // Tux's table only changes where it has played; so does a table with finer
  // facts, which has far too many situations to guess the rest.
  const final = await fit(!isPlayer && !teacher.extra);
  const path = join(tablesDir, `${name}.js`);
  const model = `co-evolution generation ${generation} from ${teacherInfo.name}`;
  if (teacher.extra) {
    const delta = { ...teacher.delta };
    for (const [index, action] of final.greedy)
      delta[index] = action;
    await saveTable(path, name, model, teacher.domains, teacher.orders, teacherCodes,
                    { extra: teacher.extra, delta, learned_shield: !!teacher.learned_shield });
  } else {
    const codes = Uint8Array.from(teacherCodes);
    for (const [index, action] of final.greedy)
      codes[index] = action;
    await saveTable(path, name, model, teacher.domains, teacher.orders, codes);
  }
  return { name, path };
}

/** Saves a table: the teacher's with `greedy` applied. */
async function saveSnapshot(name, teacher, teacherCodes, greedy) {
  const path = join(tablesDir, `${name}.js`);
  if (teacher.extra) {
    const delta = { ...teacher.delta };
    for (const [index, action] of greedy) delta[index] = action;
    await saveTable(path, name, `snapshot ${name}`, teacher.domains, teacher.orders, teacherCodes,
                    { extra: teacher.extra, delta, learned_shield: !!teacher.learned_shield });
  } else {
    const codes = Uint8Array.from(teacherCodes);
    for (const [index, action] of greedy) codes[index] = action;
    await saveTable(path, name, `snapshot ${name}`, teacher.domains, teacher.orders, codes);
  }
  return { name, path };
}

/**
 * Champion gating: the candidate and the champion play the same opponents;
 * the candidate takes over only if it does better. Returns the winner.
 */
async function gate(pages, state, isPlayer, champion, candidate, opponentInfos, seed) {
  const pair = await Promise.all([champion, candidate].map(({ name, path }) => entry(name, path, 1)));
  const opponents = await Promise.all(opponentInfos.map(({ name, path }) => entry(name, path, 1)));
  const results = await play(pages, {
    enemyDomains, seed,
    enemies: isPlayer ? opponents : pair,
    players: isPlayer ? pair : opponents,
  }, Number(args["gate-minutes"] || minutes) * 60);
  note(state, results);
  const runs = results.flatMap((x) => x.runs);
  // For the badguys, the opponents fall into groups (the bot styles, the
  // learned Tuxes, the exploiters) that count the same however many each has,
  // so that doing well against a few exploiters matters as much as against
  // the many learned Tuxes.
  const group = (name) => !isPlayer ? (name.startsWith("bot") ? "bots" : name.includes("-x") ? "exploiters" : "learned")
                                    : "all";
  const score = (who) => {
    const mine = runs.filter((r) => (isPlayer ? r.player : r.enemy) === who);
    const byOpponent = {};
    for (const r of mine) {
      const o = isPlayer ? r.enemy : r.player;
      const c = byOpponent[o] || (byOpponent[o] = [0, 0]);
      c[0]++;
      if (r.end === "cleared") c[1]++;
    }
    const groups = {};
    for (const [o, [n, cleared]] of Object.entries(byOpponent))
      (groups[group(o)] = groups[group(o)] || []).push(cleared / n);
    const means = Object.values(groups).map((rates) => rates.reduce((a, b) => a + b, 0) / rates.length);
    return { runs: mine.length, cleared: means.reduce((a, b) => a + b, 0) / Math.max(means.length, 1),
             groups: Object.fromEntries(Object.entries(groups).map(([k, rates]) =>
               [k, +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(3)])) };
  };
  const a = score(champion.name), b = score(candidate.name);
  const better = isPlayer ? b.cleared > a.cleared : b.cleared < a.cleared;
  console.log(`  gate: ${champion.name} ${a.cleared.toFixed(3)} ${JSON.stringify(a.groups)} (${a.runs}) vs ` +
              `${candidate.name} ${b.cleared.toFixed(3)} ${JSON.stringify(b.groups)} (${b.runs}) -> ` +
              `${better ? candidate.name : champion.name}`);
  return better ? candidate : champion;
}

// --- commands -----------------------------------------------------------------

await mkdir(tablesDir, { recursive: true });

if (command === "collect") {
  const state = await loadState();
  const { browser, pages } = await openPages([...sections.train, sections.full], tabs);
  const results = await play(pages, {
    enemyDomains, seed: 1, countSituations: true,
    enemies: await league(state.enemies),
    players: [{ name: "bot", weight: 1 }],
  }, minutes * 60);
  await browser.close();

  const counts = {};
  for (const r of results)
    for (const [index, n] of Object.entries(r.situations)) counts[index] = (counts[index] || 0) + n;
  const situations = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([index, count], id) => {
    let rest = Number(index);
    const facts = {};
    for (let d = PlayerFacts.DOMAINS.length - 1; d >= 0; d--) {
      const [fact, values] = PlayerFacts.DOMAINS[d];
      facts[fact] = values[rest % values.length];
      rest = Math.floor(rest / values.length);
    }
    return { id, count, facts };
  });
  await writeFile(join(here, "situations.jsonl"), situations.map((s) => JSON.stringify(s)).join("\n") + "\n");
  const total = situations.reduce((sum, s) => sum + s.count, 0);
  let covered = 0, n90 = 0;
  for (const s of situations) { covered += s.count; n90++; if (covered / total >= 0.95) break; }
  console.log(`${situations.length} situations, ${n90} cover 95% of ${total} looks`);
} else if (command === "run") {
  // Every generation: Tux learns against the badguys (weighted towards those
  // he does worst against), a Tux exploiter learns against the champion
  // badguys alone to find their holes, and the badguys learn against every
  // Tux, exploiters included (weighted the same way). A new table replaces the
  // champion of its side only if it does better against the same opponents;
  // the champions are what the next generation starts from.
  const generations = Number(args.generations || 5);
  const iterations = Number(args.iterations || 15);
  const playerIterations = Number(args["player-iterations"] || iterations);
  const state = await loadState();
  state.champions = state.champions || {
    enemy: state.enemies[state.enemies.length - 1],
    player: state.players.filter((p) => p.path && !p.name.includes("-x")).slice(-1)[0],
  };
  const learned = (list) => list.filter((x) => x.path);
  // --extend: from now on the badguys look at the finer facts (EXTRA), and,
  // with --learn-shield, decide for themselves when to retreat. The champion
  // becomes such a table, for now doing just what it did.
  const championTable = await loadTable(state.champions.enemy.path);
  if (args.extend && !championTable.extra) {
    const name = `${state.champions.enemy.name}-ext`;
    const path = join(tablesDir, `${name}.js`);
    await saveTable(path, name, `${state.champions.enemy.name} with finer facts`, championTable.domains,
                    championTable.orders, unpack(championTable),
                    { extra: EXTRA, delta: {}, learned_shield: !!args["learn-shield"] });
    state.champions.enemy = { name, path };
    state.enemies.push(state.champions.enemy);
  } else if (args.extend && championTable.extra.length < EXTRA.length &&
             championTable.extra.every(([fact], i) => EXTRA[i][0] === fact)) {
    // Facts added at the end since: every situation it knew becomes all the
    // finer ones, which do what it did until they learn otherwise.
    const factor = EXTRA.slice(championTable.extra.length).reduce((n, [, values]) => n * values.length, 1);
    const delta = {};
    for (const [index, order] of Object.entries(championTable.delta))
      for (let j = 0; j < factor; j++) delta[Number(index) * factor + j] = order;
    const name = `${state.champions.enemy.name}-more`;
    const path = join(tablesDir, `${name}.js`);
    await saveTable(path, name, `${state.champions.enemy.name} with more facts`, championTable.domains,
                    championTable.orders, unpack(championTable),
                    { extra: EXTRA, delta, learned_shield: !!championTable.learned_shield });
    state.champions.enemy = { name, path };
    state.enemies.push(state.champions.enemy);
  }
  // The bot takes the league as its styles, each on its own.
  if (state.players.some((p) => p.name === "bot")) {
    state.players = [...BOT_STYLES.map((style) => ({ name: `bot:${style}`, path: null })),
                     ...state.players.filter((p) => p.name !== "bot")];
  }
  for (const style of BOT_STYLES)
    if (!state.players.some((p) => p.name === `bot:${style}`))
      state.players.unshift({ name: `bot:${style}`, path: null });
  const tuxLlm = state.players.find((p) => p.name === "tux-llm");

  const { browser, pages } = await openPages([...sections.train, sections.full], tabs);
  const last = state.generation + generations;
  for (let g = state.generation + 1; g <= last; g++) {
    console.log(`generation ${g}`);
    const tux = await learn(pages, { side: "player", state, generation: g, iterations: playerIterations, name: `tux-g${g}`,
                                     teacherInfo: state.champions.player, opponentInfos: state.enemies, pfsp: true });
    state.players.push(tux);
    state.champions.player = await gate(pages, state, true, state.champions.player, tux, state.enemies, g * 7000);

    // Two exploiters look for holes in the champion badguys: one from the
    // champion Tux (fine holes), one from the plain distilled Tux (rough ones).
    for (const [suffix, from] of [["a", state.champions.player], ["b", tuxLlm]]) {
      const exploiter = await learn(pages, { side: "player", state, generation: g, iterations: playerIterations,
                                             name: `tux-x${g}${suffix}`, teacherInfo: from,
                                             opponentInfos: [state.champions.enemy], pfsp: false });
      state.players.push(exploiter);
    }

    // Halfway through, another exploiter looks for holes in the badguys as
    // they are by then, and joins the games.
    const enemy = await learn(pages, {
      side: "enemy", state, generation: g, iterations, name: `enemy-g${g}`,
      teacherInfo: state.champions.enemy, opponentInfos: state.players, pfsp: true,
      midway: async (snapshot) => {
        const exploiter = await learn(pages, { side: "player", state, generation: g,
                                               iterations: Math.ceil(playerIterations / 2), name: `tux-x${g}c`,
                                               teacherInfo: state.champions.player,
                                               opponentInfos: [snapshot], pfsp: false });
        state.players.push(exploiter);
        return exploiter;
      },
    });
    state.enemies.push(enemy);
    state.champions.enemy = await gate(pages, state, false, state.champions.enemy, enemy, state.players, g * 7000 + 1);
    state.generation = g;
    await writeFile(stateFile, JSON.stringify(state, null, 1));
    console.log(`  champions: ${state.champions.enemy.name}, ${state.champions.player.name}`);
  }
  await browser.close();
} else if (command === "enemy") {
  // One badguy table learns on its own against the Tuxes given, e.g. the
  // learned Tux of dagger.mjs that gets through the whole level:
  //   --from enemy-g17 --name enemy-h1 --players tux-dagger6:3,bot:rusher,bot:stomper [--full]
  const state = await loadState();
  const from = state.enemies.find((e) => e.name === args.from) ||
               { name: args.from, path: join(tablesDir, `${args.from}.js`) };
  // "name" or "name:weight"; a name may be "bot:<style>".
  const players = (args.players || "").split(",").filter(Boolean).map((spec) => {
    const parts = spec.split(":");
    const weight = /^[0-9.]+$/.test(parts.at(-1)) && parts.length > 1 ? Number(parts.pop()) : 1;
    const name = parts.join(":");
    return { name, path: name.startsWith("bot:") ? null : join(tablesDir, `${name}.js`), weight };
  });
  // --full: only whole runs from the start (where a learned Tux plays as
  // it learned to); otherwise the sections too.
  const list = args.full !== undefined ? [sections.full] : [...sections.train, sections.full];
  const { pages } = await openPages(list, tabs);
  const enemy = await learn(pages, { side: "enemy", state, generation: state.generation + 1,
                                     iterations: Number(args.iterations || 15), name: args.name, teacherInfo: from,
                                     opponentInfos: players, pfsp: false });
  state.enemies.push(enemy);
  await writeFile(stateFile, JSON.stringify(state, null, 1));
  console.log(`wrote ${enemy.path}`);
  process.exit(0);
} else if (command === "tune") {
  const state = await loadState();
  const from = state.players.find((p) => p.name === args.from);
  const practice = sections.practice[args.practice || "wall"];
  const list = [...practice, ...sections.train, ...practice, ...practice];
  const { browser, pages } = await openPages(list, tabs);
  const tux = await learn(pages, { side: "player", state, generation: state.generation + 1,
                                   iterations: Number(args.iterations || 15), name: args.name, teacherInfo: from,
                                   opponentInfos: [{ name: "classic", path: null }, state.champions.enemy], pfsp: false });
  await browser.close();
  state.players.push(tux);
  await writeFile(stateFile, JSON.stringify(state, null, 1));
  console.log(`wrote ${tux.path}`);
} else if (command === "eval") {
  const state = await loadState();
  // --enemies a,b and --players c,d play only those (all by default).
  if (args.enemies) state.enemies = args.enemies.split(",").map((n) => state.enemies.find((e) => e.name === n));
  if (args.players) state.players = args.players.split(",").map((n) =>
    state.players.find((p) => p.name === n) || (n.startsWith("bot:") ? { name: n, path: null } : null));
  const matrix = {};
  for (const [label, list] of [["sections", sections.train], ["full", [sections.full]]]) {
    const { browser, pages } = await openPages(list, tabs);
    const results = await play(pages, {
      enemyDomains, seed: 9000 + (label === "full" ? 1 : 0),
      enemies: await Promise.all(state.enemies.map(({ name, path }) => entry(name, path, 1))),
      players: await Promise.all(state.players.map(({ name, path }) => entry(name, path, 1))),
    }, (label === "full" ? Number(args["full-minutes"] || 4 * minutes) : minutes) * 60);
    await browser.close();
    const cell = {};
    for (const r of results.flatMap((x) => x.runs)) {
      const key = `${r.enemy} | ${r.player}`;
      const c = cell[key] || (cell[key] = { runs: 0, cleared: 0, judged: 0, gained: 0 });
      c.runs++;
      c.gained += r.gained;
      if (r.end === "cleared" || r.end === "death") c.judged++;
      if (r.end === "cleared") c.cleared++;
    }
    matrix[label] = cell;
    console.log(`\n${label}: clear rate (runs)`);
    console.log("".padEnd(12) + state.players.map((p) => p.name.padStart(14)).join(""));
    for (const e of state.enemies) {
      console.log(e.name.padEnd(12) + state.players.map((p) => {
        const c = cell[`${e.name} | ${p.name}`];
        return (c ? `${(c.cleared / Math.max(c.runs, 1)).toFixed(2)} (${c.runs})` : "-").padStart(14);
      }).join(""));
    }
  }
  await writeFile(join(here, "results.json"), JSON.stringify({ date: new Date().toISOString(), matrix }, null, 1));
} else {
  console.error("usage: coevo.mjs collect | run | eval   (see the top of the file)");
  process.exit(1);
}
