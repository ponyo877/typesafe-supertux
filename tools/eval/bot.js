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

// The player for the benchmark (bench.mjs loads this into the game page).
//
// The game hands it its own view of the level through the exported
// jev_set_bench(): Tux's position and speed, how far ahead the next wall,
// gap and spikes are, and where the badguys are. The decision models never
// see this; it only stands in for a human's eyes. The bot answers within the
// same logic step, so it reacts as fast at turbo speed as in real time.
//
// Every life, it picks one of a few styles and randomises its parameters, so
// the badguys cannot be judged against a single way of playing:
//   rusher       runs and hops over whatever comes
//   stomper      walks and jumps onto badguys on purpose
//   cautious     stops when a badguy comes its way and waits for an opening
//   hopper       keeps making small hops
//   sprinter     always runs and clears badguys with long jumps from afar
//   backstepper  steps back when a badguy comes, then jumps
//   chaotic      now and then presses something at random
//   stalker      vaults over badguys at the last moment to get behind them
//   jumper       hops all the time
// and, kept out of training for checking only:
//   waiter       waits for any badguy ahead to come, and stomps it
//   bunny        jumps again the moment it lands
//   zigzag       steps back every second or so, then goes on
// With ?lag=1, every life also reacts late by a random 0 to 0.15 seconds.
//
// The level is played in sections (sections.json): each run starts the level
// over, so every badguy is back in its place, puts Tux at the start of the
// next section and ends when he reaches its end ("cleared"), dies ("death"),
// makes no progress for a while ("stuck", terrain the bot cannot handle) or
// takes too long ("slow").
//
// Page parameters: ?seed=<n> for the random numbers, ?bots=a,b,c for the
// styles to draw from (default: rusher,stomper,cautious), ?lag=1 to react
// late, ?sections=<json>
// (a section may set its own time limit in "seconds").
//
// Results go to window.__eval: every run with its section, how it ended, how
// far it got, how long it lasted and what happened on the way.

(function () {
  "use strict";

  const BENCH_INTERVAL = 0.03;  // seconds of game time between looks
  const INPUT = { left: 1, right: 2, up: 4, down: 8, jump: 16, action: 32 };

  const params = new URLSearchParams(location.search);
  const styles = (params.get("bots") || "rusher,stomper,cautious").split(",");
  const sections = JSON.parse(params.get("sections") || "[]");
  const STUCK_SECONDS = 6;
  const RUN_SECONDS = 40;

  // mulberry32: small, seedable, good enough for picking parameters.
  let seed = (Number(params.get("seed")) || 1) >>> 0;
  function random() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const between = (a, b) => a + (b - a) * random();

  const STYLES = {
    rusher: () => ({ run: random() < 0.7, react: between(50, 110), hold: between(0.15, 0.4), wait: 0, stomp: false }),
    stomper: () => ({ run: random() < 0.3, react: between(90, 170), hold: between(0.25, 0.5), wait: 0, stomp: true }),
    cautious: () => ({ run: false, react: between(40, 90), hold: between(0.2, 0.45), wait: between(90, 200), stomp: false }),
    jumper: () => ({ run: random() < 0.5, react: between(40, 80), hold: between(0.2, 0.5), wait: 0, stomp: false,
                     every: between(0.6, 1.4) }),
    hopper: () => ({ run: random() < 0.4, react: between(50, 90), hold: between(0.08, 0.16), wait: 0, stomp: false,
                     every: between(0.35, 0.7) }),
    sprinter: () => ({ run: true, react: between(140, 220), hold: between(0.45, 0.6), wait: 0, stomp: false }),
    backstepper: () => ({ run: false, react: between(40, 80), hold: between(0.3, 0.5), wait: 0, stomp: true,
                          backstep: between(90, 160) }),
    chaotic: () => ({ run: random() < 0.5, react: between(40, 120), hold: between(0.1, 0.5), wait: 0, stomp: false,
                      chaos: between(0.3, 0.6) }),
    stalker: () => ({ run: true, react: between(30, 70), hold: between(0.55, 0.7), wait: 0, stomp: false }),
    bunny: () => ({ run: random() < 0.6, react: between(40, 80), hold: between(0.15, 0.45), wait: 0, stomp: false,
                    every: between(0.05, 0.15) }),
    zigzag: () => ({ run: false, react: between(40, 90), hold: between(0.2, 0.4), wait: 0, stomp: false,
                     zigzag: between(0.8, 1.6), zigBack: between(0.25, 0.4) }),
    waiter: () => ({ run: false, react: between(20, 45), hold: between(0.3, 0.45), wait: between(150, 260), stomp: true,
                     waitAny: true }),
  };

  const result = window.__eval = { lives: [], gameTime: 0, looks: 0, trace: [] };
  let target = Infinity;      // game seconds to play, then stop
  let done = false;
  // "restarting": waiting for the level to start over; "placing": the level
  // is new, Tux goes to the section start at the next look; "playing".
  let phase = "restarting";
  let runs = 0;
  let life = null;
  let style = null;
  let p = null;

  let setInput = null;
  let time = 0;               // game time, counted from the looks
  let jumpUntil = -1;         // hold jump until this time
  let jumpReleased = true;    // jump must be let go before the next one
  let lastJump = 0;
  let progressX = 0;
  let progressTime = 0;
  // Stuck at a wall too high for a standing jump: back off, then take a
  // running jump with the button held down, as a person would.
  let escape = null;          // { until, backUntil }
  let history = [];           // recent looks, for reacting late
  let lag = 0;                // looks this life reacts late by
  let stepUntil = -1;         // backstepper: stepping back until then
  let chaosUntil = -1;        // chaotic: pressing chaosInput until then
  let chaosInput = 0;

  function startLife(x, section) {
    // tools/coevo may say which style plays this run.
    const forced = window.__eval_before_start ? window.__eval_before_start() : null;
    style = forced || styles[Math.floor(random() * styles.length)];
    p = STYLES[style]();
    life = { section, style, params: p, start: time, startX: x, maxX: x, hurts: 0, squished: 0, killed: 0, end: null };
    progressX = x;
    progressTime = time;
    escape = null;
    history = [];
    lag = params.get("lag") === "1" ? Math.round(between(0, 0.15) / BENCH_INTERVAL) : 0;
    life.lag = +(lag * BENCH_INTERVAL).toFixed(2);
    stepUntil = chaosUntil = -1;
    // tools/coevo picks who plays this run (and notes it in the life).
    if (window.__eval_on_start)
      window.__eval_on_start(life);
  }

  function endLife(how) {
    if (!life)
      return;
    life.end = how;
    life.seconds = +(time - life.start).toFixed(2);
    life.gained = Math.round(life.maxX - life.startX);
    result.lives.push(life);
    life = null;
    if (window.__eval_on_end)
      window.__eval_on_end(how);
  }

  function restart() {
    phase = "restarting";
    send(0);
    Module.ccall("jev_bench_restart", null, [], []);
  }

  function wantsJump(b) {
    if (!b.ground)
      return false;
    // Terrain first: anything in the way at running distance.
    const reach = p.run ? 1.6 : 1;
    if ((b.wall >= 0 && b.wall < 24 * reach) || (b.gap >= 0 && b.gap < 20 * reach) ||
        (b.spikes >= 0 && b.spikes < 40 * reach))
      return true;
    if (p.every && time - lastJump > p.every)
      return true;

    for (const [dx, dy, vx] of b.enemies) {
      if (Math.abs(dy) > 48)
        continue;
      // Ahead, or closing in from behind.
      const ahead = dx > -8 && dx < p.react + (p.stomp ? 30 : 0);
      const behind = dx < 0 && dx > -60 && vx > 20;
      if (ahead || behind)
        return true;
    }
    return false;
  }

  function wantsToWait(b) {
    if (!p.wait)
      return false;
    return b.enemies.some(([dx, dy, vx]) => Math.abs(dy) < 48 && dx > p.react && dx < p.wait && (p.waitAny || vx < -10));
  }

  function finish() {
    if (done)
      return;
    done = true;
    Module.ccall("jev_set_turbo", null, ["number"], [0]);
    Module.ccall("jev_set_bench", null, ["number"], [0]);
    endLife("timeout");
  }

  function look(b) {
    if (done)
      return;
    time += BENCH_INTERVAL;
    result.gameTime = time;
    result.looks++;
    if (time >= target) {
      finish();
      return;
    }
    // Where Tux was, once a second, to find where bots get stuck.
    if (result.looks % Math.round(1 / BENCH_INTERVAL) === 0)
      result.trace.push([Math.round(time), Math.round(b.x), Math.round(b.y)]);

    if (!b.alive || phase === "restarting")
      return;
    if (phase === "placing") {
      const index = runs++ % sections.length;
      const section = sections[index];
      Module.ccall("jev_bench_warp", null, ["number", "number"], [section.x, section.bottom]);
      startLife(section.x, index);
      phase = "playing";
      return;
    }
    if (!life)
      return;
    const section = sections[life.section];
    if (b.x >= section.end) {
      endLife("cleared");
      restart();
      return;
    }
    if (time - progressTime > STUCK_SECONDS || time - life.start > (section.seconds || RUN_SECONDS)) {
      endLife(time - progressTime > STUCK_SECONDS ? "stuck" : "slow");
      restart();
      return;
    }
    life.maxX = Math.max(life.maxX, b.x);
    if (b.x > progressX + 8) {
      progressX = b.x;
      progressTime = time;
    }

    // A learned Tux (tools/coevo) plays instead of the styles, when there is one.
    if (window.__eval_player) {
      const input = window.__eval_player(b, time);
      if (input !== null) {
        send(input);
        return;
      }
    }

    // What the bot acts on: the look from `lag` looks ago.
    history.push(b);
    if (history.length > lag + 1)
      history.shift();
    const seen = history[0];

    if (!escape && b.ground && time - progressTime > 0.8) {
      const back = between(0.3, 0.7);
      escape = { backUntil: time + back, until: time + back + 1.5 };
    }
    if (escape) {
      if (time > escape.until || b.x > progressX + 24) {
        escape = null;
        progressTime = time;
      } else {
        let input = time < escape.backUntil ? INPUT.left : INPUT.right | INPUT.action;
        if (time >= escape.backUntil + 0.25 && time < jumpUntil) {
          input |= INPUT.jump;
        } else if (time >= escape.backUntil + 0.25 && b.ground && jumpReleased) {
          jumpUntil = time + 0.7;
          jumpReleased = false;
          lastJump = time;
          input |= INPUT.jump;
        } else if (time >= jumpUntil) {
          jumpReleased = true;
        }
        send(input);
        return;
      }
    }

    if (p.chaos) {
      if (time >= chaosUntil && random() < p.chaos * BENCH_INTERVAL / 0.3) {
        const choices = [0, INPUT.left, INPUT.right, INPUT.right | INPUT.action, INPUT.right | INPUT.jump];
        chaosInput = choices[Math.floor(random() * choices.length)];
        chaosUntil = time + 0.3;
      }
      if (time < chaosUntil) {
        send(chaosInput);
        return;
      }
    }

    if (p.zigzag && time >= stepUntil + p.zigzag)
      stepUntil = time + p.zigBack;
    if (p.backstep && time >= stepUntil + 0.6 &&
        seen.enemies.some(([dx, dy, vx]) => Math.abs(dy) < 48 && dx > p.react && dx < p.backstep && vx < -10))
      stepUntil = time + 0.25;
    if (time < stepUntil) {
      progressTime = time;
      send(INPUT.left);
      return;
    }

    let input = 0;
    if (!wantsToWait(seen)) {
      input |= INPUT.right;
      if (p.run)
        input |= INPUT.action;
    } else {
      progressTime = time;  // waiting on purpose is not being stuck
    }

    if (time < jumpUntil) {
      input |= INPUT.jump;
    } else if (!jumpReleased) {
      jumpReleased = true;
    } else if (wantsJump(seen)) {
      jumpUntil = time + p.hold;
      jumpReleased = false;
      lastJump = time;
      input |= INPUT.jump;
    }

    send(input);
  }

  function send(input) {
    if (!setInput)
      setInput = Module.cwrap("jev_set_player_input", null, ["number"]);
    setInput(input);
  }

  window.jev_on_bench = function (json) {
    look(JSON.parse(json));
  };

  window.jev_on_event = function (json) {
    if (done)
      return;
    const e = JSON.parse(json);
    // Every start of the level, after a death or a restart asked for, begins
    // the next run.
    if (e.type === "restart") phase = "placing";
    else if (e.type === "player_death") endLife("death");
    else if (e.type === "level_finished") endLife(e.detail === "win" ? "goal" : "lost");
    else if (!life) return;
    else if (e.type === "player_hurt") life.hurts++;
    else if (e.type === "badguy_squished") life.squished++;
    else if (e.type === "badguy_killed") life.killed++;
  };

  // Called by bench.mjs once the level runs.
  window.__eval_start = function (turbo, seconds, collect) {
    target = seconds;
    // Counts the situations the badguys meet (the facts the rich prompt
    // decides on), to know which ones a new policy must cover.
    if (collect && window.LayaRichPrompt) {
      result.facts = {};
      const previous = window.jev_on_state;
      window.jev_on_state = function (json) {
        const state = JSON.parse(json);
        if (!done && state.player.power !== undefined) {
          for (const enemy of Object.values(state.enemies)) {
            const key = JSON.stringify(LayaRichPrompt.facts(state.player, enemy));
            result.facts[key] = (result.facts[key] || 0) + 1;
          }
        }
        previous(json);
      };
    }
    window.jev_inline = true;
    Module.ccall("jev_set_bench", null, ["number"], [BENCH_INTERVAL]);
    Module.ccall("jev_set_turbo", null, ["number"], [turbo]);
    restart();
  };

  window.__eval_finish = function () {
    finish();
    return result;
  };

  // Called by tools/rl/train.mjs to play on for another stretch of game time
  // in the same page (the lives so far stay in the result).
  window.__eval_continue = function (turbo, seconds) {
    done = false;
    target = time + seconds;
    Module.ccall("jev_set_bench", null, ["number"], [BENCH_INTERVAL]);
    Module.ccall("jev_set_turbo", null, ["number"], [turbo]);
    restart();
  };
})();
