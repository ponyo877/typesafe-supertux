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

// Tries one sequence of Tux's moves in the game page, for search.mjs.
//
// The level starts over (every badguy back in its place), Tux is put down
// at a spot, and the moves of player-facts.js are played one after another,
// each the way tools/coevo/page.js plays it: a move on the ground lasts its
// seconds, a jump holds the key for its time and ends when he lands. Since
// the level starts over the same way every time and Tux plays the same
// inputs, a sequence always ends the same way, so search.mjs can build on
// the ones that went well. What he saw before each move comes back with it,
// to learn from.

(function () {
  "use strict";

  const LOOK = 0.03;      // seconds of game time between looks, as bot.js
  const HALF_LOOK = LOOK / 2;
  const LAND_BY = 1.5;    // a jump that has not landed by then is over
  const STUCK_SECONDS = 6;  // as bot.js: a table's run ends when he gets nowhere

  let run = null;

  function send(input) {
    Module.ccall("jev_set_player_input", null, ["number"], [input]);
  }

  window.jev_on_bench = function (json) {
    if (!run)
      return;
    const b = JSON.parse(json);
    run.time += LOOK;
    run.last = b;
    if (run.phase === "restarting")
      return;
    if (run.phase === "placing") {
      if (!b.alive)
        return;
      // As tools/eval/bot.js does it, so a sequence found here plays out
      // the same way there: the first move is chosen at the next look.
      Module.ccall("jev_bench_warp", null, ["number", "number"], [run.x, run.bottom]);
      run.phase = "playing";
      return;
    }
    if (!b.alive) {
      finish(b, false);
      return;
    }
    if (b.x > run.maxX + 8) {
      run.progressTime = run.time;
    }
    if (run.policy && (run.time - run.progressTime > STUCK_SECONDS || run.time > run.limit)) {
      finish(b, true);
      return;
    }
    run.maxX = Math.max(run.maxX, b.x);
    run.topY = Math.min(run.topY, b.y);
    if (b.x >= run.goal) {
      finish(b, true);
      return;
    }

    const move = run.move;
    // Times are sums of looks; half a look either way keeps the rounding
    // of those sums from deciding (page.js and search.js alike).
    const done = !move || (move.jumping ? (run.time > move.landBy + HALF_LOOK || (b.ground && run.time > move.start + 0.15 + HALF_LOOK))
                                        : run.time >= move.until - HALF_LOOK);
    if (done) {
      if (run.next >= run.moves.length && run.policy) {
        // Past the given moves, the table plays (__search_policy).
        run.moves.push(run.policy(PlayerFacts.extendedIndex(b, run.zones)));
      }
      if (run.next >= run.moves.length) {
        // A moment for the last move to play out.
        if (!run.after) run.after = run.time + 0.3;
        if (run.time >= run.after) finish(b, true);
        send(0);
        return;
      }
      const index = PlayerFacts.extendedIndex(b, run.zones);
      // Situations other runs rely on keep their move (dagger.mjs).
      const choice = run.fixed && run.fixed.has(index) ? run.fixed.get(index) : run.moves[run.next];
      run.next++;
      const spec = PlayerFacts.MOVES[choice];
      run.pairs.push([index, choice, Math.round(b.x), Math.round(b.y)]);
      run.move = spec.jump && b.ground
        ? { spec, start: run.time, jumping: true, jumpUntil: run.time + spec.jump, landBy: run.time + LAND_BY,
            released: !(run.lastInput & 16) }
        : { spec, start: run.time, jumping: false, until: run.time + (spec.seconds || 0.2) };
    }
    let input = run.move.spec.input;
    if (run.move.jumping) {
      if (!run.move.released) {
        run.move.released = true;
        run.move.jumpUntil += 0.03;
      } else if (run.time < run.move.jumpUntil - HALF_LOOK) {
        input |= 16;
      }
    }
    run.lastInput = input;
    send(input);
  };

  function finish(b, alive, won = false) {
    const r = run;
    run = null;
    send(0);
    r.resolve({ alive: alive && b.alive, x: Math.round(b.x), y: Math.round(b.y), ground: b.ground,
                maxX: Math.round(r.maxX), topY: Math.round(r.topY), reached: won || b.x >= r.goal,
                seconds: +(r.time).toFixed(2), pairs: r.pairs });
  }

  /** Like __search_try, but once the moves are done a table plays on: one
      of Tux's tables as tools/coevo keeps them ({ packed, extra, delta }),
      until he is past `goal`, dies, gets nowhere for a while or `limit`
      seconds are up. How a table does, and where it fails, in the very way
      the sequences were found. */
  window.__search_policy = function (x, bottom, goal, moves, table, turbo, gameSeed, limit) {
    const bytes = Uint8Array.from(atob(table.packed), (c) => c.charCodeAt(0));
    const zones = table.extra || 0;  // its finer facts, for PlayerFacts.extendedIndex
    const size = table.extra ? table.extra.reduce((n, [, values]) => n * values.length, 1) : 0;
    const delta = new Map(Object.entries(table.delta || {}).map(([k, v]) => [Number(k), v]));
    const plain = (i) => (bytes[i >> 1] >> ((i & 1) * 4)) & 15;
    const policy = (index) => delta.has(index) ? delta.get(index) : plain(size ? Math.floor(index / size) : index);
    return window.__search_try(x, bottom, goal, moves, zones, turbo, gameSeed, policy, limit);
  };

  /** A first attempt that only waits: the page's first one is unlike the
      others (the badguys' controller skips its very first state), so the
      page is ready once this is over. */
  window.__search_ready = function () {
    return window.__search_try(112, 576, 1e9, [2, 2, 2, 2, 2, 2], 0, 80, 1);
  };

  const previous = window.jev_on_event;
  window.jev_on_event = function (json) {
    const e = JSON.parse(json);
    if (run && e.type === "restart") {
      run.phase = "placing";
      // The badguys' noise starts here, not with the steps of the attempt
      // before that come first.
      if (window.jev_noise_seed) window.jev_noise_seed(run.gameSeed);
    }
    // Past the goal poles the level ends on its own; Tux has made it.
    else if (run && run.last && e.type === "level_finished" && e.detail === "win")
      finish(run.last, true, true);
    if (previous)
      previous(json);
  };

  /** Plays `moves` from (x, bottom) until Tux is past `goal`, dies or the
      moves are done. zones: the finer facts of the table the pairs are
      for (a list as tables keep it, or a number of zones);
      gameSeed: the game's random numbers at the start; fixed: [index, move]
      pairs to play whatever the moves say. */
  window.__search_try = function (x, bottom, goal, moves, zones, turbo, gameSeed, policy = null, limit = 300,
                                  fixed = null) {
    window.jev_inline = true;
    // The same random numbers at every start (bot.js's ?gameseed=), in the
    // game and in the badguys' controller (?noise=).
    Module.ccall("jev_set_bench_seed", null, ["number"], [gameSeed]);
    return new Promise((resolve) => {
      run = { x, bottom, goal, moves: [...moves], zones, resolve, time: 0, phase: "restarting", next: 0, move: null,
              lastInput: 0, pairs: [], maxX: x, topY: 1e9, policy, limit, progressTime: 0, gameSeed,
              fixed: fixed && new Map(fixed) };
      Module.ccall("jev_set_bench", null, ["number"], [LOOK]);
      Module.ccall("jev_set_turbo", null, ["number"], [turbo]);
      Module.ccall("jev_bench_restart", null, [], []);
    });
  };
})();
