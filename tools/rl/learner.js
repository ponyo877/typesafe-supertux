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

// The badguys' side of training (train.mjs loads this into the game page,
// next to the benchmark's bot).
//
// It stands in for the policy table: every badguy's situation (the facts of
// laya-rich-prompt.js) is looked up in the policy train.mjs hands over, and
// now and then a badguy tries another order for a moment instead, preferably
// one that has been tried little in that situation. Every quarter second it
// notes what each badguy did in which situation. Rewards:
//   +1    the badguy hit the player (a Mr. Bomb's blast counts as its own)
//   +0.3  the player died while the badguy was close (it helped corner him)
//   -1    the badguy got stomped or killed
//   -0.2  the player got through the section while the badguy was around
// train.mjs collects the decisions with the rewards that followed them and
// improves the policy.

(function () {
  "use strict";

  const SAMPLE_EVERY = 0.25;  // seconds between noted decisions of a badguy
  const STICK = 0.5;          // seconds an order tried out is kept
  const HORIZON = 3;          // rewards count for this long after a decision...
  const HALF_LIFE = 1;        // ...and half as much every second later
  const ACTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];  // every order but patrol
  const TEAM_REWARD = 0.3;    // for being close when the player dies
  const CLEARED_PENALTY = -0.2;
  const RECENT = 1;           // seconds a badguy counts as "around" after it was seen

  let seed = 1;
  function random() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  let greedy = new Map();     // situation index -> order code
  let explore = new Map();    // situation index -> orders to try first
  let epsilon = 0;
  let teacher = null;         // { domains, orders, bytes } of the table to start from
  const badguys = new Map();  // uid -> { next, tryUntil, tryAction, seen, close }
  let decisions = [];         // [uid, time, situation, order]
  let rewards = [];           // [uid, time, reward]

  const now = () => (window.__eval ? window.__eval.gameTime : 0);

  function situation(facts) {
    let index = 0;
    for (const [fact, values] of teacher.domains)
      index = index * values.length + values.indexOf(facts[fact]);
    return index;
  }

  function teacherOrder(index) {
    return (teacher.bytes[index >> 1] >> ((index & 1) * 4)) & 15;
  }

  window.__rl_set = function (policy) {
    const table = window.POLICY_TABLES[policy.teacher];
    teacher = {
      domains: table.domains,
      orders: table.orders,
      bytes: Uint8Array.from(atob(table.packed), (c) => c.charCodeAt(0)),
    };
    greedy = new Map(policy.greedy);
    explore = new Map(policy.explore || []);
    epsilon = policy.epsilon;
    seed = policy.seed >>> 0;
  };

  window.jev_decide_override = function (request) {
    const time = now();
    const { state } = request;
    const answers = {};
    for (const [id, enemy] of Object.entries(state.enemies)) {
      const uid = Number(id.slice(1));
      const index = situation(LayaRichPrompt.facts(state.player, enemy));
      let order = greedy.has(index) ? greedy.get(index) : teacherOrder(index);

      let badguy = badguys.get(uid);
      if (!badguy)
        badguys.set(uid, badguy = { next: 0, tryUntil: -1, tryAction: 0, seen: 0, close: false });
      badguy.seen = time;
      badguy.close = enemy.distance === "touching" || enemy.distance === "near";
      if (time < badguy.tryUntil)
        order = badguy.tryAction;

      // The shield decides for the badguy there; nothing to learn.
      const shielded = enemy.player_height === "above me and falling toward me" || state.player.invincible;
      if (time >= badguy.next && !shielded) {
        badguy.next = time + SAMPLE_EVERY;
        if (time >= badguy.tryUntil && random() < epsilon) {
          const choices = explore.get(index) || ACTIONS;
          badguy.tryAction = choices[Math.floor(random() * choices.length)];
          badguy.tryUntil = time + STICK;
          order = badguy.tryAction;
        }
        decisions.push([uid, time, index, order]);
      }
      answers[id] = { choice: teacher.orders[order], confidence: 1 };
    }
    return { model: "training", answers };
  };

  /** Gives `reward` to every badguy seen lately (and close, if asked). */
  function rewardAround(reward, closeOnly) {
    const time = now();
    for (const [uid, badguy] of badguys) {
      if (time - badguy.seen <= RECENT && (!closeOnly || badguy.close))
        rewards.push([uid, time, reward]);
    }
  }

  const previousEvent = window.jev_on_event;
  window.jev_on_event = function (json) {
    const e = JSON.parse(json);
    const uid = Number((e.detail || "").split(":")[1]);
    if (e.type === "badguy_hit") rewards.push([uid, now(), 1]);
    else if (e.type === "badguy_squished" || e.type === "badguy_killed") rewards.push([uid, now(), -1]);
    else if (e.type === "player_death") rewardAround(TEAM_REWARD, true);
    if (previousEvent)
      previousEvent(json);
  };

  window.__eval_on_end = function (how) {
    if (how === "cleared")
      rewardAround(CLEARED_PENALTY, false);
  };

  /** The decisions so far as [situation, order, return], and a fresh start. */
  window.__rl_collect = function () {
    const byBadguy = new Map();
    for (const [uid, time, reward] of rewards) {
      if (!byBadguy.has(uid)) byBadguy.set(uid, []);
      byBadguy.get(uid).push([time, reward]);
    }
    const samples = [];
    let hits = 0, stomped = 0;
    for (const [, , reward] of rewards) {
      if (reward === 1) hits++;
      else if (reward === -1) stomped++;
    }
    for (const [uid, time, index, order] of decisions) {
      let value = 0;
      for (const [when, reward] of byBadguy.get(uid) || []) {
        if (when >= time && when < time + HORIZON)
          value += reward * Math.pow(0.5, (when - time) / HALF_LIFE);
      }
      samples.push([index, order, +value.toFixed(3)]);
    }
    decisions = [];
    rewards = [];
    badguys.clear();
    return { samples, hits, stomped };
  };
})();
