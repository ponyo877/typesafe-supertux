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

// The rich prompt (?ai=laya-rich): every badguy is asked nine yes/no
// questions (Laya's "noul"), one per tactic, each about the few facts that
// matter for it. The first tactic answered with yes wins. Shared by the page
// and by tools/laya-server/export-rich-table.mjs, which asks Laya every
// question the game can produce and stores the answers in laya-rich-table.js.
//
// Why this shape (measured with laya-typed-decisions-mlx on every input):
// - One 9-way choice got 23 of 72 situations right, a two-stage choice 16:
//   Laya cannot weigh many facts at once, and its choices depend on the order
//   of the options. A noul has no option order.
// - Negations fool it ("No fireball." reads like a fireball), so every
//   sentence says what is there, not what is missing.
// - Its probabilities sit close together, so each question gets its own
//   threshold, fitted over all of that question's inputs. With those, the
//   nine questions answer 139 of their 166 possible inputs as intended.
//
// The truth() functions spell out what each question is meant to detect.
// They are only used to fit the thresholds and to report the accuracy; the
// answers the badguys act on are Laya's.

(function (root) {
  "use strict";

  const DISTANCES = ["touching", "near", "medium", "far"];
  const DIST = {
    touching: "The player is touching me.",
    near: "The player is near me.",
    medium: "The player is at medium distance.",
    far: "The player is far away.",
  };
  const HEIGHT = {
    "same level": "The player walks on my level.",
    "above me": "The player stands on a ledge above me.",
    "above me and falling toward me": "The player drops right onto my head.",
    "below me": "The player walks down below me.",
  };
  const MOTION = {
    "coming toward me": "The player walks toward me.",
    "moving away": "The player walks away from me.",
    "standing": "The player stands still.",
  };
  const SPECIAL = {
    igel: "My roll attack",
    mrbomb: "My fuse",
    jumpy: "My high hop",
    viciousivy: "My floating leap",
    walkingleaf: "My floating leap",
  };
  const KINDS = ["viciousivy", "walkingleaf", "igel", "snail", "mrbomb", "jumpy"];
  const near = (distance) => distance === "touching" || distance === "near";
  const wallSentence = (f) =>
    near(f.distance) ? "A wall blocks my path and the player is close behind it."
                     : "A wall blocks my path and the player is far away.";

  // In the order they are tried; `order` is what the badguy then does.
  const QUESTIONS = [
    {
      name: "retreat", order: "retreat",
      instructions: "Should I run away from the player now?",
      domain: { height: Object.keys(HEIGHT), invincible: [false, true] },
      sentence: (f) => HEIGHT[f.height] + (f.invincible ? " The player shines with star power." : " The player looks ordinary."),
      truth: (f) => f.height === "above me and falling toward me" || f.invincible,
      criteria: { true: "drops onto my head, star power, danger", false: "walks on my level, ledge above me, down below me, ordinary" },
    },
    {
      name: "dodge_fire", order: "jump",
      instructions: "Should I jump to dodge now?",
      domain: { fireball: [false, true] },
      sentence: (f) => f.fireball ? "A fireball flies straight at me." : "The air around me is calm.",
      truth: (f) => f.fireball,
      criteria: { true: "fireball flies at me", false: "calm air" },
    },
    {
      name: "special", order: "special",
      instructions: "Should I use my special move now?",
      domain: { kind: KINDS, ready: [false, true], distance: DISTANCES, wall: [false, true] },
      sentence: (f) =>
        (f.kind in SPECIAL ? SPECIAL[f.kind] + (f.ready ? " is charged and ready." : " is still recharging.")
                           : "I have no special move.") +
        " " + DIST[f.distance] + (f.wall ? " A wall blocks my path." : " My path is open."),
      truth: (f) => f.kind in SPECIAL && f.ready && f.distance !== "far" && !f.wall,
      criteria: { true: "charged and ready, player close, path open", false: "still recharging, far away, wall blocks my path, no special move" },
    },
    {
      name: "intercept", order: "intercept",
      instructions: "Should I run to where the player lands?",
      domain: { vertical: ["on the ground", "rising", "falling"], landing_near: [false, true] },
      sentence: (f) =>
        f.vertical === "on the ground" ? "The player walks on the ground." :
        (f.vertical === "rising" ? "The player jumps upward." : "The player comes down from a jump.") +
        (f.landing_near ? " The player will land right next to me." : " The player will land far from me."),
      truth: (f) => f.vertical !== "on the ground" && f.landing_near,
      criteria: { true: "jumping, will land next to me", false: "walks on the ground, will land far from me" },
    },
    {
      name: "jump_over", order: "jump",
      instructions: "Should I jump over the obstacle now?",
      domain: { wall: [false, true], distance: DISTANCES },
      sentence: (f) => f.wall ? wallSentence(f) : "My path is open.",
      truth: (f) => f.wall && near(f.distance),
      criteria: { true: "wall, player close behind it", false: "open path, player far away" },
    },
    {
      name: "hold", order: "hold",
      instructions: "Should I stay where I am?",
      domain: { spikes: [false, true], wall: [false, true], distance: DISTANCES },
      sentence: (f) =>
        (f.spikes ? "Thorny spikes lie ahead of me." : "Soft grass lies ahead of me.") +
        " " + (f.wall ? wallSentence(f) : "My path is open."),
      truth: (f) => f.spikes || (f.wall && !near(f.distance)),
      criteria: { true: "thorny spikes ahead, wall with the player far away", false: "soft grass, open path, player close behind" },
    },
    {
      name: "stalk", order: "stalk",
      instructions: "Should I keep my distance for now?",
      domain: { recovering: [false, true] },
      sentence: (f) => f.recovering ? "The player blinks after getting hurt." : "The player is solid and hittable.",
      truth: (f) => f.recovering,
      criteria: { true: "blinks after getting hurt", false: "solid and hittable" },
    },
    {
      name: "flank", order: "flank",
      instructions: "Should I go around the player to the other side?",
      domain: { between: [false, true], beyond: [false, true], distance: DISTANCES },
      sentence: (f) =>
        (f.between ? "A friend stands between me and the player." : "I am the closest to the player.") +
        (f.beyond ? " A friend waits behind the player." : " The space behind the player is empty.") +
        " " + DIST[f.distance],
      truth: (f) => f.between && !f.beyond && (f.distance === "near" || f.distance === "medium"),
      criteria: { true: "friend between me and the player, empty space behind the player", false: "closest to the player, friend waits behind the player, far away, touching" },
    },
    {
      name: "ambush", order: "ambush",
      instructions: "Should I wait in hiding for the player?",
      domain: { motion: Object.keys(MOTION), distance: DISTANCES },
      sentence: (f) => MOTION[f.motion] + " " + DIST[f.distance],
      truth: (f) => f.motion === "coming toward me" && (f.distance === "medium" || f.distance === "far"),
      criteria: { true: "walks toward me, medium distance, far away", false: "walks away, stands still, near, touching" },
    },
  ];
  const DEFAULT_ORDER = "charge";

  /** The facts the questions read, from the state the game sends. */
  function facts(player, enemy) {
    return {
      height: enemy.player_height,
      invincible: !!player.invincible,
      fireball: !!enemy.fireball_coming,
      kind: enemy.kind,
      ready: enemy.special === "ready",
      distance: enemy.distance,
      wall: !!enemy.wall_in_my_way,
      vertical: player.vertical,
      landing_near: enemy.landing === "near me",
      spikes: !!enemy.spikes_ahead,
      recovering: !!player.recovering,
      between: !!enemy.ally_between,
      beyond: !!enemy.ally_beyond_player,
      motion: enemy.player_motion,
    };
  }

  /** Every combination of a question's facts. */
  function combinations(question) {
    let all = [{}];
    for (const [fact, values] of Object.entries(question.domain))
      all = all.flatMap((partial) => values.map((value) => ({ ...partial, [fact]: value })));
    return all;
  }

  function noul(question, sentence) {
    return { type: "noul", instructions: question.instructions, criteria: question.criteria, state: sentence };
  }

  /** The tactic to follow, given `answer(question, sentence)` -> P(yes) and
      each question's threshold. Also returns why, for the HUD. */
  function decide(f, answer, thresholds) {
    for (const question of QUESTIONS) {
      const p = answer(question, question.sentence(f));
      if (p >= thresholds[question.name])
        return { order: question.order, because: question.name, p };
    }
    return { order: DEFAULT_ORDER, because: "default", p: 1 };
  }

  const api = { QUESTIONS, DEFAULT_ORDER, facts, combinations, noul, decide };
  if (typeof module === "object" && module.exports)
    module.exports = api;
  else
    root.LayaRichPrompt = api;
})(this);
