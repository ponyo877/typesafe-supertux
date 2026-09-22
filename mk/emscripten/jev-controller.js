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

// Lets a decision model give orders to the badguys near the player.
// The game side is src/port/jev_bridge.cpp: it calls window.jev_on_state()
// every jev_set_send_interval() seconds and takes orders through
// jev_set_order().
//
// A provider (selected with ?ai=<name>) turns the game state into questions
// and asks a model for
//
//   decide({ state, questions }) -> Promise<{ answers }>
//
// in the shape of TypeSafe's /v1/systemone API, which Laya shares. To run a
// model inside the browser (e.g. Laya on WebGPU, should a prompt ever take
// more inputs than a table can hold), add a provider here; nothing else needs
// to change.
//
// Other URL parameters: ?shield=0 (show Laya's own choices), ?interval=<s>
// (how often the game sends its state), ?speed=<x> and ?pursuit=0 / ?reflex=0
// (rich prompt only), ?options=<JEV_OPT_* bits> (for testing).

(function () {
  "use strict";

  // Keep in sync with JevOrder in src/badguy/jev_order.hpp
  const ORDERS = {
    patrol: 0, charge: 1, retreat: 2, hold: 3, jump: 4,
    ambush: 5, intercept: 6, stalk: 7, flank: 8, special: 9,
  };

  // Keep in sync with JEV_OPT_* in src/badguy/jev_order.hpp
  const OPT_RICH = 1, OPT_JUMPY = 2, OPT_PURSUIT = 4, OPT_REFLEX = 8;

  const ORDER_TTL = 1.0;        // seconds an order stays in effect
  const BACKOFF_MS = 1000;      // pause after an error

  // --- Jev: reads the facts and weighs the conditions itself ---------------

  // The model reads these literally, so they spell out when each action pays
  // off in terms of the facts the game reports, without negations (which the
  // model handles poorly). Checked against canonical situations: charging
  // from any distance is picked with 0.8-0.98 confidence, retreating from a
  // falling player with ~0.5-0.6. Jumping is rarely picked, but a charging
  // badguy that runs into a wall jumps anyway (see WalkingBadguy).
  const JEV_CRITERIA = {
    charge: "Run fast toward the player to hit them from the side. Best when the player is on the same level as me or below me, at any distance.",
    retreat: "Run away from the player. Best when the player is above me and falling toward me, or when the player is invincible.",
    hold: "Stand still facing the player. Best when a wall is in my way and the player is far.",
    jump: "Jump toward the player. Best when the player is above me and standing or rising, or when a wall is in my way and the player is near.",
  };

  function jevQuestions(state) {
    const questions = {};
    for (const id of Object.keys(state.enemies)) {
      questions[id] = {
        type: "choice",
        instructions:
          "You control enemy " + id + " in a 2D platformer and your goal is to defeat the player. " +
          "You hurt the player by touching them from the side. You die if the player lands on top of you. " +
          "Look at state.enemies." + id + " and state.player, then pick the best action for " + id + " right now.",
        criteria: JEV_CRITERIA,
      };
    }
    return questions;
  }

  // --- Laya, basic prompt: one situation sentence per badguy ---------------
  // The prompt is in laya-prompt.js (window.LayaPrompt).

  // The prompt boils every situation down to one of a handful of sentences,
  // so Laya's answers are precomputed into laya-table.js
  // (tools/laya-server/export-table.mjs). Looking them up gives exactly what
  // the model would say, in any browser, without downloading it.
  async function lookUp(request) {
    const table = window.LAYA_TABLE;
    if (!table || table.instructions !== LayaPrompt.INSTRUCTIONS ||
        JSON.stringify(table.criteria) !== JSON.stringify(LayaPrompt.CRITERIA))
      throw new Error("laya-table.js was made for another prompt; run tools/laya-server/export-table.mjs");
    const answers = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = table.answers[question.state];
      if (!answer)
        throw new Error("laya-table.js has no answer for \"" + question.state + "\"; run tools/laya-server/export-table.mjs");
      answers[id] = answer;
    }
    return { model: table.model + " (table)", answers };
  }

  // --- Laya, rich prompt: nine yes/no questions per badguy ------------------
  // The prompt is in laya-rich-prompt.js (window.LayaRichPrompt).

  const RICH_MODEL = "aac6fef/laya-typed-decisions-mlx";

  /** The table's entry for a question, if it was made for this wording. */
  function richTableEntry(question) {
    const entry = window.LAYA_RICH_TABLE && window.LAYA_RICH_TABLE.nouls[question.name];
    const current = entry && entry.instructions === question.instructions &&
                    JSON.stringify(entry.criteria) === JSON.stringify(question.criteria);
    return current ? entry : null;
  }

  function richThresholds() {
    return Object.fromEntries(LayaRichPrompt.QUESTIONS.map((q) => {
      const entry = richTableEntry(q);
      return [q.name, entry ? entry.threshold : 0.5];
    }));
  }

  /** Turns each badguy's facts into a tactic, given P(yes) for a question. */
  function decideRich(state, answer, model) {
    const thresholds = richThresholds();
    const answers = {};
    for (const [id, enemy] of Object.entries(state.enemies)) {
      const decision = LayaRichPrompt.decide(LayaRichPrompt.facts(state.player, enemy), answer, thresholds);
      answers[id] = { choice: decision.order, confidence: decision.p, because: decision.because };
    }
    return { model, answers };
  }

  // laya-rich-table.js holds Laya's answer to every question the game can
  // produce (tools/laya-server/export-rich-table.mjs).
  async function lookUpRich(request) {
    for (const question of LayaRichPrompt.QUESTIONS) {
      if (!richTableEntry(question))
        throw new Error("laya-rich-table.js was made for another prompt; run tools/laya-server/export-rich-table.mjs");
    }
    return decideRich(request.state, (question, sentence) => {
      const p = window.LAYA_RICH_TABLE.nouls[question.name].answers[sentence];
      if (p === undefined)
        throw new Error("laya-rich-table.js has no answer for \"" + sentence + "\"; run tools/laya-server/export-rich-table.mjs");
      return p;
    }, window.LAYA_RICH_TABLE.model + " (table)");
  }

  // The same questions asked live (laya-mlx), e.g. to try a changed prompt
  // before exporting the table. Few distinct questions exist, so the answers
  // are kept and only new ones are asked.
  const richCache = new Map();
  async function askRich(request) {
    const pending = new Map();
    for (const enemy of Object.values(request.state.enemies)) {
      const f = LayaRichPrompt.facts(request.state.player, enemy);
      for (const question of LayaRichPrompt.QUESTIONS) {
        const sentence = question.sentence(f);
        const key = question.name + "\n" + sentence;
        if (!richCache.has(key) && !pending.has(key))
          pending.set(key, LayaRichPrompt.noul(question, sentence));
      }
    }
    if (pending.size) {
      const keys = [...pending.keys()];
      const result = await post("/api/laya")({
        model: RICH_MODEL,
        state: "",
        questions: Object.fromEntries(keys.map((key, i) => ["q" + i, pending.get(key)])),
      });
      keys.forEach((key, i) => richCache.set(key, result.answers["q" + i].noul));
    }
    return decideRich(request.state, (question, sentence) => richCache.get(question.name + "\n" + sentence),
                      RICH_MODEL + " (live)");
  }

  // --- Safety layer -------------------------------------------------------

  // Like the safety layer of the laya-mlx Snake demo, this overrides answers
  // that get the badguy killed: Laya picked the dodge for only 10 of 24 option
  // orders when the player falls onto the badguy, and never for an invincible
  // player. ?shield=0 shows Laya's own choices.
  function shielded(state, id) {
    const enemy = state.enemies[id];
    return !!enemy && (enemy.player_height === "above me and falling toward me" || state.player.invincible);
  }

  // --- Providers -----------------------------------------------------------

  function post(url) {
    return async function (request) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok)
        throw new Error("HTTP " + response.status + " " + (await response.text()).slice(0, 120));
      return response.json();
    };
  }

  const params = new URLSearchParams(location.search);
  const richOptions = OPT_RICH | OPT_JUMPY |
    (params.get("pursuit") === "0" ? 0 : OPT_PURSUIT) | (params.get("reflex") === "0" ? 0 : OPT_REFLEX);

  const providers = {
    // TypeSafe's Jev, through tools/jev-proxy (which holds the API key).
    jev: {
      sendInterval: 0.25,
      options: 0,
      // Below this the badguy keeps doing what it did. Dodging comes with
      // lower confidence than charging, yet whenever it is the top choice the
      // player really is about to land on the badguy.
      minConfidence: { charge: 0.5, retreat: 0.35, hold: 0.5, jump: 0.5 },
      buildQuestions: jevQuestions,
      decide: post("/api/jev"),
    },

    // Laya's precomputed answers to the basic prompt; runs in any browser.
    // Same pace and shield as laya-mlx, so the badguys behave the same.
    laya: {
      sendInterval: 0.05,
      options: 0,
      // Laya's confidence is 1 - normalised entropy, which stays low even for
      // right answers over four options; the top choice is used as is.
      minConfidence: {},
      buildQuestions: (state) => LayaPrompt.questions(state),
      shield: true,
      decide: lookUp,
    },

    // The rich prompt: more facts, more tactics (ambush, intercept, stalk,
    // flank, special moves), Jumpy joins in, badguys keep chasing offscreen
    // and dodge stomps by reflex. Precomputed; runs in any browser.
    "laya-rich": {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: true,
      decide: lookUpRich,
    },

    // Laya running on this Mac's GPU through laya-mlx (tools/laya-server),
    // e.g. to try a changed prompt before exporting the table; ?prompt=rich
    // for the rich one. It answers in ~20 ms, so it could take a fresh state
    // every logic step (?interval=0, ~45 decisions/s), but that keeps the GPU
    // busy that also draws the game. 20 per second still reacts five times as
    // often as Jev.
    "laya-mlx": params.get("prompt") === "rich" ? {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: true,
      decide: askRich,
    } : {
      sendInterval: 0.05,
      options: 0,
      minConfidence: {},
      buildQuestions: (state) => LayaPrompt.questions(state),
      shield: true,
      decide: post("/api/laya"),
    },

    // No network and no model: every badguy gets the order from ?mock=<order>
    // (default: a simple rule). For checking the plumbing and the orders.
    mock: {
      sendInterval: 0.25,
      options: 0,
      minConfidence: {},
      buildQuestions: () => ({}),
      async decide(request) {
        const fixed = params.get("mock");
        const answers = {};
        for (const [id, enemy] of Object.entries(request.state.enemies)) {
          let choice = fixed;
          if (!(choice in ORDERS)) {
            if (enemy.player_height === "above me and falling toward me" || request.state.player.invincible) choice = "retreat";
            else if (enemy.wall_in_my_way) choice = (enemy.distance === "far") ? "hold" : "jump";
            else choice = "charge";
          }
          answers[id] = { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { model: "mock", answers };
      },
    },
  };

  // Without ?ai= the badguys behave as usual (the start page picks the mode).
  const providerName = params.get("ai") || "off";
  const provider = providers[providerName];
  const useShield = !!(provider && provider.shield) && params.get("shield") !== "0";
  const sendInterval = params.has("interval") ? Number(params.get("interval")) : provider && provider.sendInterval;
  const options = params.has("options") ? Number(params.get("options")) : provider ? provider.options : 0;
  const speed = params.has("speed") ? Number(params.get("speed")) : 1;

  let latestState = null;
  let busy = false;
  let pausedUntil = 0;
  let setOrder = null;
  let configured = false;
  const recent = [];            // timestamps of recent answers, for the rate
  const tactics = [];           // recent orders, for the mix shown on the HUD
  let answered = 0;
  let overridden = 0;

  const hud = document.createElement("div");
  hud.id = "jev_hud";
  hud.style.cssText =
    "position:fixed;right:8px;top:8px;z-index:10;padding:6px 8px;max-width:380px;" +
    "font:11px/1.4 ui-monospace,Menlo,monospace;color:#d6f5d6;background:#000a;" +
    "border-radius:4px;pointer-events:none;white-space:pre-wrap";
  function showStatus(text) {
    hud.textContent = "AI: " + providerName + (provider ? "" : " (off)") +
      (useShield ? "  shield on" : "") + "\n" + text;
  }

  function tacticMix() {
    const counts = {};
    for (const order of tactics)
      counts[order] = (counts[order] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([order, n]) => order + " " + Math.round(100 * n / tactics.length) + "%").join("  ");
  }

  async function pump() {
    if (busy || !latestState || !provider || performance.now() < pausedUntil)
      return;

    const state = latestState;
    latestState = null;
    busy = true;
    const started = performance.now();
    try {
      const result = await provider.decide({ state, questions: provider.buildQuestions(state) });
      const now = performance.now();

      if (!setOrder)
        setOrder = Module.cwrap("jev_set_order", null, ["number", "number", "number"]);

      const lines = [];
      for (const [id, answer] of Object.entries(result.answers || {})) {
        let choice = answer.choice;
        let note = answer.because && answer.because !== choice ? "  (" + answer.because + ")" : "";
        answered++;
        if (useShield && shielded(state, id) && choice !== "retreat") {
          note = "  (shield: " + choice + ")";
          choice = "retreat";
          overridden++;
        }
        const confidence = answer.confidence ?? 1;
        const confident = confidence >= (provider.minConfidence[choice] ?? 0);
        if (ORDERS[choice] !== undefined && confident) {
          setOrder(Number(id.slice(1)), ORDERS[choice], ORDER_TTL);
          tactics.push(choice);
          if (tactics.length > 300)
            tactics.shift();
        }
        const kind = state.enemies[id] ? state.enemies[id].kind.slice(0, 6) : "";
        lines.push(id.padEnd(10) + " " + kind.padEnd(6) + " " + String(choice).padEnd(9) + " " + confidence.toFixed(2) +
                   (confident ? "" : "  (ignored)") + note);
      }

      recent.push(now);
      while (recent.length && recent[0] < now - 1000)
        recent.shift();
      showStatus(Math.round(now - started) + " ms  " + recent.length + " decisions/s  " + (result.model || "") +
                 (useShield ? "\nshield overrides: " + overridden + "/" + answered : "") +
                 "\n" + tacticMix() +
                 "\n" + lines.join("\n"));
    } catch (error) {
      // The badguys simply fall back to their regular behaviour.
      pausedUntil = performance.now() + BACKOFF_MS;
      showStatus("error: " + error.message);
    } finally {
      busy = false;
    }

    // Only the newest state is worth asking about; older ones were dropped.
    pump();
  }

  window.jev_on_state = function (json) {
    // The runtime is surely up once the game sends a state.
    if (!configured && provider) {
      if (Number.isFinite(sendInterval))
        Module.ccall("jev_set_send_interval", null, ["number"], [sendInterval]);
      Module.ccall("jev_set_options", null, ["number", "number"], [options, speed]);
      configured = true;
      // This state was made before the options: it lacks the rich facts.
      if (options & OPT_RICH)
        return;
    }
    try {
      latestState = JSON.parse(json);
    } catch (error) {
      showStatus("bad state: " + error.message);
      return;
    }
    pump();
  };

  window.addEventListener("DOMContentLoaded", function () {
    // Nothing to report when the badguys behave as usual.
    if (!provider)
      return;
    document.body.appendChild(hud);
    showStatus("waiting for the game...");
  });
})();
