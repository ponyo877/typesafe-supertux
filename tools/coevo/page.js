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

// Both sides of co-evolution in the game page (coevo.mjs loads this next to
// tools/eval/bot.js, which runs the sections, and player-facts.js).
//
// For every run, one badguy policy and one Tux policy are drawn from the
// leagues coevo.mjs hands over. A policy is either built in ("classic"
// badguys, "bot:<style>" for one of the styles of bot.js) or a table: one order or move per
// situation, like the badguys' tables in mk/emscripten. The side being
// trained plays its current table, with some orders or moves tried at random
// among those that might still be better, and notes what it did in which
// situation and what came of it:
//
//   badguys  +1 hit the player, +0.3 close when he died, -1 stomped or
//            killed, -0.2 around when he got through (as tools/rl/learner.js)
//   Tux      +1 for the whole section (paid as he moves right), +1 cleared,
//            -1 died, -0.5 stuck or too slow

(function () {
  "use strict";

  const ENEMY_SAMPLE_EVERY = 0.25;
  const STICK = 0.5;
  const ENEMY_ACTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const TEAM_REWARD = 0.3;
  const CLEARED_PENALTY = -0.2;
  const RECENT = 1;
  const ENEMY_HORIZON = 3, ENEMY_HALF_LIFE = 1;
  const PLAYER_HORIZON = 4, PLAYER_HALF_LIFE = 2;
  const SECTION_LENGTH = 1200;  // px of progress worth +1

  let seed = 1;
  function random() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const decode = (packed) => Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
  const lookUp = (bytes, i) => (bytes[i >> 1] >> ((i & 1) * 4)) & 15;

  /** A league entry as coevo.mjs sends it: { name, weight, packed } or a
      built-in name; the side being trained has greedy/explore/epsilon too. */
  function prepare(entry) {
    const policy = { ...entry };
    if (entry.packed) policy.bytes = decode(entry.packed);
    if (entry.greedy) policy.greedy = new Map(entry.greedy);
    // A table with finer facts: the rich prompt's table plus what differs.
    if (entry.extra) {
      policy.extSize = entry.extra.reduce((n, [, values]) => n * values.length, 1);
      policy.delta = new Map(entry.delta || []);
    }
    if (entry.explore) policy.explore = new Map(entry.explore);
    return policy;
  }

  function pick(league) {
    const total = league.reduce((sum, p) => sum + p.weight, 0);
    let r = random() * total;
    for (const policy of league) {
      r -= policy.weight;
      if (r <= 0) return policy;
    }
    return league[league.length - 1];
  }

  let enemies = [], players = [];
  let enemy = null, player = null;  // this run's
  let enemyDomains = null;
  let countSituations = false;

  // What the side being trained did, and what came of it.
  let enemyDecisions = [], enemyRewards = [];
  let playerDecisions = [], playerRewards = [];
  let runs = [];
  let situations = {};
  let run = 0;
  const badguys = new Map();

  const now = () => window.__eval.gameTime;

  window.__coevo_set = function (setup) {
    enemies = setup.enemies.map(prepare);
    players = setup.players.map(prepare);
    enemyDomains = setup.enemyDomains;
    countSituations = !!setup.countSituations;
    seed = setup.seed >>> 0;
  };

  // Drawn before bot.js picks a style, so a "bot:<style>" Tux can name it.
  window.__eval_before_start = function () {
    enemy = pick(enemies);
    player = pick(players);
    return player.name.startsWith("bot:") ? player.name.slice(4) : null;
  };

  window.__eval_on_start = function (life) {
    run++;
    life.enemy = enemy.name;
    life.player = player.name;
    life.run = run;
    move = null;
    lastX = null;
    badguys.clear();
  };

  window.__eval_on_end = function (how) {
    const life = window.__eval.lives[window.__eval.lives.length - 1];
    runs.push({ enemy: life.enemy, player: life.player, section: life.section, end: how,
                gained: life.gained, seconds: life.seconds });
    const time = now();
    if (enemy && enemy.training && how === "cleared") {
      for (const [uid, badguy] of badguys)
        if (time - badguy.seen <= RECENT) enemyRewards.push([uid, time, CLEARED_PENALTY]);
    }
    if (player && player.training) {
      const reward = { cleared: 1, death: -1, stuck: -0.5, slow: -0.5 }[how] || 0;
      if (reward) playerRewards.push([run, time, reward]);
    }
  };

  // --- badguys ----------------------------------------------------------

  function enemySituation(facts) {
    let index = 0;
    for (const [fact, values] of enemyDomains)
      index = index * values.length + values.indexOf(facts[fact]);
    return index;
  }

  window.jev_decide_override = function (request) {
    const answers = {};
    if (!enemy || enemy.name === "classic")
      return { model: "classic", answers };
    const time = now();
    const { state } = request;
    for (const [id, e] of Object.entries(state.enemies)) {
      const uid = Number(id.slice(1));
      const base = enemySituation(LayaRichPrompt.facts(state.player, e));
      const index = enemy.extra ? base * enemy.extSize + JevPolicy.extraIndex(enemy.extra, state.player, e) : base;
      let order = enemy.greedy && enemy.greedy.has(index) ? enemy.greedy.get(index)
                : enemy.delta && enemy.delta.has(index) ? enemy.delta.get(index)
                : lookUp(enemy.bytes, base);
      // Tables made with the shield retreat when the player drops onto them;
      // the page is loaded without it (?shield=0) when a table learns to
      // decide that for itself.
      const shielded = e.player_height === "above me and falling toward me" || state.player.invincible;
      if (shielded && enemy.shield)
        order = 2;
      if (enemy.training) {
        let badguy = badguys.get(uid);
        if (!badguy) badguys.set(uid, badguy = { next: 0, tryUntil: -1, tryAction: 0, seen: 0, close: false });
        badguy.seen = time;
        badguy.close = e.distance === "touching" || e.distance === "near";
        if (time < badguy.tryUntil) order = badguy.tryAction;
        if (time >= badguy.next && !(shielded && enemy.shield)) {
          badguy.next = time + ENEMY_SAMPLE_EVERY;
          if (time >= badguy.tryUntil && random() < enemy.epsilon) {
            const choices = (enemy.explore && enemy.explore.get(index)) || ENEMY_ACTIONS;
            badguy.tryAction = choices[Math.floor(random() * choices.length)];
            badguy.tryUntil = time + STICK;
            order = badguy.tryAction;
          }
          enemyDecisions.push([uid, time, index, order]);
        }
      }
      answers[id] = { choice: ["patrol", "charge", "retreat", "hold", "jump", "ambush", "intercept",
                               "stalk", "flank", "special"][order], confidence: 1 };
    }
    return { model: enemy.name, answers };
  };

  const previousEvent = window.jev_on_event;
  window.jev_on_event = function (json) {
    const e = JSON.parse(json);
    if (enemy && enemy.training) {
      const uid = Number((e.detail || "").split(":")[1]);
      const time = now();
      if (e.type === "badguy_hit") enemyRewards.push([uid, time, 1]);
      else if (e.type === "badguy_squished" || e.type === "badguy_killed") enemyRewards.push([uid, time, -1]);
      else if (e.type === "player_death") {
        for (const [id, badguy] of badguys)
          if (time - badguy.seen <= RECENT && badguy.close) enemyRewards.push([id, time, TEAM_REWARD]);
      }
    }
    if (previousEvent)
      previousEvent(json);
  };

  // --- Tux --------------------------------------------------------------

  let move = null;      // { spec, until, jumpUntil, landBy, jumping }
  let lastInput = 0;
  let lastX = null;
  let nextCount = 0;

  function chooseMove(index) {
    if (!player.training)
      return lookUp(player.bytes, index);
    let choice = player.greedy && player.greedy.has(index) ? player.greedy.get(index) : lookUp(player.bytes, index);
    if (random() < player.epsilon) {
      const choices = (player.explore && player.explore.get(index)) || PlayerFacts.MOVES.map((_, i) => i);
      choice = choices[Math.floor(random() * choices.length)];
    }
    return choice;
  }

  window.__eval_player = function (b, time) {
    if (!player || player.name.startsWith("bot")) {
      // The styles of bot.js play; count what they meet, to label (coevo.mjs collect).
      if (countSituations && b.ground && time >= nextCount) {
        nextCount = time + 0.2;
        const index = PlayerFacts.index(PlayerFacts.facts(b));
        situations[index] = (situations[index] || 0) + 1;
      }
      return null;
    }

    if (player.training) {
      if (lastX !== null && b.x > lastX)
        playerRewards.push([run, time, (b.x - lastX) / SECTION_LENGTH]);
      lastX = lastX === null ? b.x : Math.max(lastX, b.x);
    }

    const done = !move || (move.jumping ? (time > move.landBy || (b.ground && time > move.start + 0.15))
                                        : time >= move.until);
    if (done) {
      const f = PlayerFacts.facts(b);
      const index = PlayerFacts.index(f);
      if (countSituations) situations[index] = (situations[index] || 0) + 1;
      const choice = chooseMove(index);
      const spec = PlayerFacts.MOVES[choice];
      if (player.training) playerDecisions.push([run, time, index, choice]);
      move = spec.jump && b.ground
        ? { spec, start: time, jumping: true, jumpUntil: time + spec.jump, landBy: time + 1.5, released: !(lastInput & 16) }
        : { spec, start: time, jumping: false, until: time + (spec.seconds || 0.2) };
    }

    let input = move.spec.input;
    if (move.jumping) {
      // The jump key has to be let go before it can start another jump.
      if (!move.released) {
        move.released = true;
        move.jumpUntil += 0.03;
      } else if (time < move.jumpUntil) {
        input |= 16;
      }
    }
    lastInput = input;
    return input;
  };

  // --- results -----------------------------------------------------------

  function returns(decisions, rewards, horizon, halfLife) {
    const byKey = new Map();
    for (const [key, time, reward] of rewards) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push([time, reward]);
    }
    return decisions.map(([key, time, index, action]) => {
      let value = 0;
      for (const [when, reward] of byKey.get(key) || [])
        if (when >= time && when < time + horizon) value += reward * Math.pow(0.5, (when - time) / halfLife);
      return [index, action, +value.toFixed(3)];
    });
  }

  window.__coevo_collect = function () {
    const result = {
      enemySamples: returns(enemyDecisions, enemyRewards, ENEMY_HORIZON, ENEMY_HALF_LIFE),
      playerSamples: returns(playerDecisions, playerRewards, PLAYER_HORIZON, PLAYER_HALF_LIFE),
      runs, situations,
    };
    enemyDecisions = []; enemyRewards = [];
    playerDecisions = []; playerRewards = [];
    runs = []; situations = {};
    return result;
  };
})();
