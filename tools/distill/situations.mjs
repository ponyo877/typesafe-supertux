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

// Lists the situations badguys meet in play, to be labeled (LABELING.md).
//
//   node tools/eval/bench.mjs --modes laya-rich --collect 1 --out tools/eval/results-facts.json ...
//   node tools/distill/situations.mjs tools/eval/results-facts.json [--parts 4] [--shared 40]
//
// Writes situations.jsonl (every situation, most frequent first, with how
// often it came up) and labels/todo-<n>.jsonl: the situations split into
// parts for labeling side by side. The --shared most frequent ones go into
// every part, so the labels can be checked for agreement.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [input, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.reduce((pairs, arg, i, all) =>
  arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
const parts = Number(args.parts || 4);
const shared = Number(args.shared || 40);

const counts = {};
for (const run of JSON.parse(await readFile(input, "utf8")).runs)
  for (const [key, n] of Object.entries(run.facts || {}))
    counts[key] = (counts[key] || 0) + n;

const situations = Object.entries(counts).sort((a, b) => b[1] - a[1])
  .map(([key, count], id) => ({ id, count, facts: JSON.parse(key) }));

await writeFile(join(here, "situations.jsonl"), situations.map((s) => JSON.stringify(s)).join("\n") + "\n");

const common = situations.slice(0, shared);
for (let part = 0; part < parts; part++) {
  const mine = situations.slice(shared).filter((_, i) => i % parts === part);
  await writeFile(join(here, "labels", `todo-${part}.jsonl`),
                  [...common, ...mine].map((s) => JSON.stringify({ id: s.id, facts: s.facts })).join("\n") + "\n");
}
console.log(`${situations.length} situations, ${parts} parts of about ${shared + Math.ceil((situations.length - shared) / parts)}`);
