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

// What a learned Tux sees and what it can do (tools/coevo).
//
// The facts come from the benchmark's view of the level (jev_set_bench in
// src/port/jev_bridge.cpp), always looking right, where the level goes. The
// moves are short, whole manoeuvres rather than single keys; a policy table
// picks one per situation, like the badguys' tables pick an order.
//
// Loaded by the game page (as window.PlayerFacts) and by Node (module.exports).

(function (root) {
  "use strict";

  const TILE = 32;

  // The table is indexed by these, in this order.
  const DOMAINS = [
    ["air", ["ground", "rising", "falling"]],
    ["speed", ["still", "walk", "run"]],
    ["wall", ["none", "near low", "near high", "near cliff", "far low", "far high", "far cliff"]],
    ["gap", ["none", "near narrow", "near wide", "far narrow", "far wide"]],
    ["spikes", ["none", "near", "far"]],
    ["ledge", ["none", "ahead low", "ahead high", "behind low", "behind high", "above low", "above high"]],
    ["enemy", ["none", "touching", "near", "medium"]],
    ["enemy_coming", [false, true]],
    ["enemy_kind", ["walker", "bomb", "jumpy"]],
    ["enemy_above", [false, true]],
    ["enemy_behind", [false, true]],
  ];

  // input bits: left 1, right 2, up 4, down 8, jump 16, action 32
  const MOVES = [
    { name: "run", input: 2 | 32, seconds: 0.2 },
    { name: "walk", input: 2, seconds: 0.2 },
    { name: "wait", input: 0, seconds: 0.2 },
    { name: "back", input: 1, seconds: 0.25 },
    { name: "hop", input: 2, jump: 0.12 },
    { name: "jump", input: 2, jump: 0.35 },
    { name: "long jump", input: 2 | 32, jump: 0.6 },
    { name: "high jump", input: 0, jump: 0.6 },
    { name: "back jump", input: 1, jump: 0.6 },
  ];

  const KIND = { mrbomb: "bomb", jumpy: "jumpy" };

  function facts(b) {
    const near = (d, limit) => d >= 0 && d < limit;
    const wallSize = b.wall_h <= 2 * TILE ? "low" : b.wall_h <= 4 * TILE ? "high" : "cliff";
    const wall = b.wall_r < 0 || b.wall_r >= 160 ? "none" : (b.wall_r < 48 ? "near " : "far ") + wallSize;
    const gap = b.gap_r < 0 || b.gap_r >= 160 ? "none" : (b.gap_r < 48 ? "near " : "far ") + (b.gap_w <= 2 * TILE ? "narrow" : "wide");
    const spikes = near(b.spikes_r, 64) ? "near" : near(b.spikes_r, 160) ? "far" : "none";
    let ledge = "none";
    if (b.ledge) {
      const where = Math.abs(b.ledge_dx) < 24 ? "above" : b.ledge_dx > 0 ? "ahead" : "behind";
      ledge = where + (b.ledge_dy <= 3 * TILE ? " low" : " high");
    }

    // The nearest badguy in front, on about the same level.
    let ahead = null;
    let above = false;
    let behind = false;
    for (const [dx, dy, vx, , kind] of b.enemies) {
      if (Math.abs(dx) < 64 && dy < -40 && dy > -200) above = true;
      if (Math.abs(dy) >= 64) continue;
      if (dx >= -8 && dx < 260 && (!ahead || dx < ahead.dx)) ahead = { dx, vx, kind };
      if (dx < -8 && dx > -120) behind = true;
    }
    return {
      air: b.ground ? "ground" : b.vy < 0 ? "rising" : "falling",
      speed: Math.abs(b.vx) < 30 ? "still" : Math.abs(b.vx) < 250 ? "walk" : "run",
      wall, gap, spikes, ledge,
      enemy: !ahead ? "none" : ahead.dx < 40 ? "touching" : ahead.dx < 120 ? "near" : "medium",
      enemy_coming: !!ahead && ahead.vx < -10,
      enemy_kind: ahead ? KIND[ahead.kind] || "walker" : "walker",
      enemy_above: above,
      enemy_behind: behind,
    };
  }

  function index(f) {
    let i = 0;
    for (const [name, values] of DOMAINS) {
      const code = values.indexOf(f[name]);
      if (code < 0) throw new Error("player fact " + name + " = " + f[name]);
      i = i * values.length + code;
    }
    return i;
  }

  const api = { DOMAINS, MOVES, facts, index };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlayerFacts = api;
})(this);
