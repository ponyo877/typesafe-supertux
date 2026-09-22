#!/usr/bin/env node
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

// Asks Laya every question of the rich prompt (mk/emscripten/laya-rich-prompt.js)
// for every combination of its facts, fits each question's threshold and
// writes mk/emscripten/laya-rich-table.js, so ?ai=laya-rich runs in any
// browser without the model.
//
//   cd tools/laya-server && uv run server.py        # in another terminal
//   node tools/laya-server/export-rich-table.mjs
//
// Run it again whenever laya-rich-prompt.js changes; the page refuses a table
// made for a different prompt.

import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const prompt = require("../../mk/emscripten/laya-rich-prompt.js");
const LAYA_URL = process.env.LAYA_URL || "http://127.0.0.1:8766/v1/systemone";
// Answered the rich prompt's questions best of the three checkpoints.
const MODEL = process.env.LAYA_MODEL || "aac6fef/laya-typed-decisions-mlx";
const output = fileURLToPath(new URL("../../mk/emscripten/laya-rich-table.js", import.meta.url));

async function ask(questions) {
  const response = await fetch(LAYA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state: "", questions }),
  });
  if (!response.ok)
    throw new Error("HTTP " + response.status + " " + await response.text());
  return (await response.json()).answers;
}

/** The threshold with the best balanced accuracy (the mean of the hit rates
    on yes and on no), so that rare yeses are not traded away. */
function fitThreshold(samples) {
  const positives = samples.filter((s) => s.truth).length;
  const negatives = samples.length - positives;
  const candidates = [...new Set(samples.map((s) => s.p))].sort((a, b) => a - b).concat([1.01]);
  let best = { balanced: -1, threshold: 0.5, correct: 0 };
  for (const threshold of candidates) {
    const tp = samples.filter((s) => s.truth && s.p >= threshold).length;
    const tn = samples.filter((s) => !s.truth && s.p < threshold).length;
    const balanced = (tp / positives + tn / negatives) / 2;
    if (balanced > best.balanced)
      best = { balanced, threshold, correct: tp + tn };
  }
  return best;
}

const table = { model: MODEL, nouls: {} };
let correct = 0;
let total = 0;
try {
  for (const question of prompt.QUESTIONS) {
    const combos = prompt.combinations(question);
    const sentences = [...new Set(combos.map((f) => question.sentence(f)))];
    const answers = await ask(Object.fromEntries(sentences.map((s, i) => ["s" + i, prompt.noul(question, s)])));
    const p = Object.fromEntries(sentences.map((s, i) => [s, answers["s" + i].noul]));

    const fit = fitThreshold(combos.map((f) => ({ p: p[question.sentence(f)], truth: question.truth(f) })));
    correct += fit.correct;
    total += combos.length;
    table.nouls[question.name] = {
      instructions: question.instructions,
      criteria: question.criteria,
      threshold: fit.threshold,
      balanced_accuracy: Math.round(fit.balanced * 1000) / 1000,
      accuracy: fit.correct + "/" + combos.length,
      answers: p,
    };
    console.log(`${question.name.padEnd(11)} ${String(combos.length).padStart(3)} inputs, ${String(sentences.length).padStart(3)} sentences:` +
                ` ${fit.correct}/${combos.length} right, balanced ${fit.balanced.toFixed(2)} at threshold ${fit.threshold.toFixed(3)}`);
  }
} catch (error) {
  console.error(`Laya server at ${LAYA_URL} failed: ${error.message}`);
  console.error("Start it with: cd tools/laya-server && uv run server.py");
  process.exit(1);
}
console.log(`all questions: ${correct}/${total} inputs answered as intended`);

// How often the whole decision (first yes wins) picks the intended tactic,
// over random situations.
let seed = 12345;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (values) => values[Math.floor(random() * values.length)];
const domain = {};
for (const question of prompt.QUESTIONS)
  Object.assign(domain, question.domain);
const thresholds = Object.fromEntries(Object.entries(table.nouls).map(([name, n]) => [name, n.threshold]));
const intendedThresholds = Object.fromEntries(prompt.QUESTIONS.map((q) => [q.name, 0.5]));
const tally = {};
let agree = 0;
const SAMPLES = 20000;
for (let i = 0; i < SAMPLES; i++) {
  const f = Object.fromEntries(Object.entries(domain).map(([fact, values]) => [fact, pick(values)]));
  const intended = prompt.decide(f, (q) => (q.truth(f) ? 1 : 0), intendedThresholds).order;
  const laya = prompt.decide(f, (q, s) => table.nouls[q.name].answers[s], thresholds).order;
  agree += intended === laya;
  tally[intended] = tally[intended] || { n: 0, same: 0 };
  tally[intended].n++;
  tally[intended].same += intended === laya;
}
console.log(`whole decision: ${(100 * agree / SAMPLES).toFixed(1)}% of ${SAMPLES} random situations as intended`);
console.log("  by intended tactic: " + Object.entries(tally)
  .map(([order, t]) => `${order} ${(100 * t.same / t.n).toFixed(0)}% (${t.n})`).join(", "));

await writeFile(output,
  "// Generated by tools/laya-server/export-rich-table.mjs from mk/emscripten/laya-rich-prompt.js; do not edit.\n" +
  "window.LAYA_RICH_TABLE = " + JSON.stringify(table, null, 1) + ";\n");
console.log(`Wrote ${Object.values(table.nouls).reduce((n, q) => n + Object.keys(q.answers).length, 0)} answers from ${MODEL} to ${output}`);
