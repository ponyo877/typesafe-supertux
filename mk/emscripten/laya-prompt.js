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

// How the badguys' situation is put to Laya. Shared by the page
// (jev-controller.js) and by tools/laya-server/export-table.mjs, which
// precomputes Laya's answer for every situation into laya-table.js.
//
// Laya (a 421M encoder) does not weigh conditions like Jev: given the Jev
// prompt it picks "jump" for nearly everything. What it does is match text,
// so a small planner sums each badguy's situation up in one sentence and the
// options are keywords. Over all 24 option orders this got 7-8 of 10
// canonical situations right, but it rarely picks the dodge (see shielded()
// in jev-controller.js).

(function (root) {
  "use strict";

  const INSTRUCTIONS = "Which action fits my situation?";

  const CRITERIA = {
    charge: "open ground, player ahead",
    retreat: "falling onto me, invincible, danger",
    hold: "wall, player far away",
    jump: "ledge above, wall close",
  };

  // Every value src/port/jev_bridge.cpp reports for the facts describe()
  // reads; keep in sync.
  const FACTS = {
    distance: ["touching", "near", "medium", "far"],
    player_height: ["same level", "above me", "above me and falling toward me", "below me"],
    wall_in_my_way: [false, true],
    invincible: [false, true],
  };

  function describe(player, enemy) {
    const near = enemy.distance === "touching" || enemy.distance === "near";
    if (enemy.player_height === "above me and falling toward me")
      return "The player is above me and falling onto me.";
    if (player.invincible)
      return "The player is invincible.";
    if (enemy.wall_in_my_way)
      return "A wall blocks my way and the player is " + (near ? "close." : "far away.");
    if (enemy.player_height === "above me" && near)
      return "The player stands on a ledge right above me.";
    return "The player is on open ground ahead of me, " + enemy.distance + ".";
  }

  /** Every sentence describe() can produce. */
  function situations() {
    const all = new Set();
    for (const distance of FACTS.distance)
      for (const player_height of FACTS.player_height)
        for (const wall_in_my_way of FACTS.wall_in_my_way)
          for (const invincible of FACTS.invincible)
            all.add(describe({ invincible }, { distance, player_height, wall_in_my_way }));
    return [...all];
  }

  // Every badguy brings its own state (an extension of the Jev format that
  // tools/laya-server understands), so all are answered in one forward pass.
  function question(situation) {
    return { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA, state: situation };
  }

  function questions(state) {
    const result = {};
    for (const [id, enemy] of Object.entries(state.enemies))
      result[id] = question(describe(state.player, enemy));
    return result;
  }

  const api = { INSTRUCTIONS, CRITERIA, describe, situations, question, questions };
  if (typeof module === "object" && module.exports)
    module.exports = api;
  else
    root.LayaPrompt = api;
})(this);
