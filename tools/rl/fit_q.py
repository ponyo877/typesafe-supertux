#  SuperTux
#  Copyright (C) 2026 ponyo877
#
#  This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#  GNU General Public License for more details.
#
#  You should have received a copy of the GNU General Public License
#  along with this program.  If not, see <http://www.gnu.org/licenses/>.

"""Decides the policy from what training has seen so far (train.mjs runs this).

    uv run --project tools/distill python tools/rl/fit_q.py <stats.json> <out.json> [--final]

<stats.json> names its teacher: a table in mk/emscripten ("teacher") or a
file ("teacher_path"), and may list the actions to consider ("actions",
default: the badguys' orders but patrol). A teacher with finer facts
(tools/coevo --extend) keeps its table for the rich prompt's facts and lists
what differs ("delta"); "extra_radix" then gives the sizes of the extra facts,
which come last in every index.

<stats.json> holds, for every (situation, order) tried, the sum and sum of
squares of the returns and how many there were. Returns are noisy and most
situations are rare, so:

- LightGBM learns the return from the facts and the order (fitted Q), which
  lets similar situations share what was learned in each;
- how far off that estimate tends to be is measured on (situation, order)
  pairs it was not trained on;
- each situation's own average and the estimate are combined by how much
  each can be trusted (the fewer the tries, the more the estimate counts);
- a situation leaves the teacher's order only when another order is ahead by
  more than Z standard errors of that combination.

Writes the orders that differ from the teacher's ("greedy") and, for every
busy situation, the orders still worth trying there ("explore"). With
--final, situations never met are decided from the fitted estimate alone, by
the same margin.
"""

import base64
import json
import os
import re
import sys

import lightgbm as lgb
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

Z = 2.0           # standard errors an order must be ahead by
MIN_TRIES = 30    # own tries both orders need before one can replace the other;
                  # returns are mostly 0 and now and then about 1, so a handful
                  # of tries says little whatever the arithmetic claims
ACTIONS = np.arange(1, 10)  # every order but patrol
EXPLORE_MIN = 40  # a situation needs this many tries to get its own list


def load_teacher(name, path=None):
    with open(path or os.path.join(REPO, "mk", "emscripten", f"{name}-table.js")) as f:
        text = f.read()
    table = json.loads(re.search(r"= (\{.*\});", text, re.S).group(1))
    packed = np.frombuffer(base64.b64decode(table["packed"]), dtype=np.uint8)
    orders = np.empty(packed.size * 2, dtype=np.uint8)
    orders[0::2] = packed & 15
    orders[1::2] = packed >> 4
    radix = [len(values) for _, values in table["domains"]]
    delta = {int(k): int(v) for k, v in table.get("delta", {}).items()}
    return orders, radix, delta


def decode(indices, radix):
    codes = np.zeros((len(indices), len(radix)), dtype=np.int32)
    rest = np.array(indices, dtype=np.int64)
    for column in range(len(radix) - 1, -1, -1):
        codes[:, column] = rest % radix[column]
        rest //= radix[column]
    return codes


def main():
    stats_path, out_path = sys.argv[1], sys.argv[2]
    final = "--final" in sys.argv
    with open(stats_path) as f:
        stats = json.load(f)
    base_orders, radix, delta = load_teacher(stats.get("teacher"), stats.get("teacher_path"))
    extra = int(np.prod(stats.get("extra_radix", [1])))
    radix = radix + list(stats.get("extra_radix", []))

    class Teacher:
        """The teacher's order for a (possibly finer) situation index."""
        def __getitem__(self, s):
            s = int(s)
            return delta.get(s, int(base_orders[s // extra]))

    teacher = Teacher()
    global ACTIONS, Z, MIN_TRIES
    Z = float(stats.get("z", Z))
    MIN_TRIES = float(stats.get("min_tries", MIN_TRIES))
    if "actions" in stats:
        ACTIONS = np.array(stats["actions"])
    offset = int(ACTIONS[0])  # column a of the arrays below is action a + offset

    rows = np.array(stats["rows"], dtype=float)  # index, order, sum, sumsq, n
    index, order, total, squares, n = rows.T
    index = index.astype(np.int64)
    order = order.astype(np.int32)
    mean = total / n

    # Spread of a single return, pooled over everything tried more than once.
    several = n > 1
    sigma2 = float((squares[several] - total[several] ** 2 / n[several]).sum() / (n[several] - 1).sum())

    features = np.column_stack([decode(index, radix), order])
    names = [f"f{i}" for i in range(len(radix))] + ["order"]
    params = dict(objective="regression", learning_rate=0.05, num_leaves=63,
                  min_sum_hessian_in_leaf=50, lambda_l2=10.0, verbose=-1, seed=1)

    def train(mask):
        return lgb.train(params, lgb.Dataset(features[mask], mean[mask], weight=n[mask], feature_name=names,
                                             categorical_feature=names), num_boost_round=300)

    # How far off the estimate is for pairs it has not seen: hold out a fifth
    # of them, and subtract the part of the error that is only the noise of
    # their own averages.
    held = np.random.default_rng(1).random(len(n)) < 0.2
    checked = held & (n >= 30)
    if checked.sum() >= 20:
        error = mean[checked] - train(~held).predict(features[checked])
        fit_var = max(float(np.average(error ** 2 - sigma2 / n[checked], weights=n[checked])), 1e-4)
        measured = True
    else:
        fit_var = sigma2  # too little to tell: trust the estimate like a single try
        measured = False
    model = train(np.ones(len(n), dtype=bool))

    states = np.unique(index)
    state_codes = decode(states, radix)
    grid = np.column_stack([np.repeat(state_codes, len(ACTIONS), axis=0), np.tile(ACTIONS, len(states))])
    fitted = model.predict(grid).reshape(len(states), len(ACTIONS))

    # Per situation and order: own tries combined with the estimate.
    position = {s: i for i, s in enumerate(states)}
    tries = np.zeros_like(fitted)
    sums = np.zeros_like(fitted)
    sums2 = np.zeros_like(fitted)
    for s, o, t, t2, c in zip(index, order, total, squares, n):
        tries[position[s], o - offset] += c
        sums[position[s], o - offset] += t
        sums2[position[s], o - offset] += t2
    # Each pair's own spread, but never below the pooled one.
    own_var = np.where(tries > 1, (sums2 - sums ** 2 / np.maximum(tries, 1)) / np.maximum(tries - 1, 1), sigma2)
    spread = np.maximum(own_var, sigma2)
    precision = tries / spread + 1 / fit_var
    variance = 1 / precision
    q = variance * (sums / spread + fitted / fit_var)

    greedy, explore = [], []
    significant = 0
    for i, s in enumerate(states):
        t = int(teacher[s]) - offset
        if t < 0 or t >= len(ACTIONS):  # the teacher says patrol, which training never uses
            t = int(np.argmax(q[i]))
        # The best order among those tried enough to be judged.
        judged = tries[i] >= MIN_TRIES
        best = int(np.argmax(np.where(judged, q[i], -np.inf))) if judged.any() else t
        margin = q[i, best] - q[i, t]
        switch = (best != t and judged[t] and judged[best] and
                  margin > Z * np.sqrt(variance[i, best] + variance[i, t]))
        if switch:
            greedy.append([int(s), best + offset])
            significant += 1
        if tries[i].sum() >= EXPLORE_MIN:
            chosen = best if switch else t
            # Orders that could still turn out best (upper bound above the chosen
            # one), and those not yet tried enough to judge.
            upper = q[i] + Z * np.sqrt(variance[i])
            candidates = [a + offset for a in range(len(ACTIONS))
                          if a != chosen and (upper[a] >= q[i, chosen] or tries[i, a] < MIN_TRIES)]
            if candidates:
                explore.append([int(s), candidates])

    unmet = 0
    if final and measured and extra == 1:
        # Situations never met: the fitted estimate alone, by the same margin.
        met = set(int(s) for s in states)
        size = int(np.prod(radix))
        margin_needed = Z * np.sqrt(2 * fit_var)
        chunk = 1 << 16
        for start in range(0, size, chunk):
            block = np.arange(start, min(start + chunk, size))
            codes = decode(block, radix)
            grid = np.column_stack([np.repeat(codes, len(ACTIONS), axis=0), np.tile(ACTIONS, len(block))])
            estimate = model.predict(grid).reshape(len(block), len(ACTIONS))
            best = estimate.argmax(1)
            for j, s in enumerate(block):
                if int(s) in met:
                    continue
                t = int(teacher[s]) - offset
                if 0 <= t < len(ACTIONS) and best[j] != t and estimate[j, best[j]] - estimate[j, t] > margin_needed:
                    greedy.append([int(s), int(best[j]) + offset])
                    unmet += 1

    with open(out_path, "w") as f:
        json.dump({"greedy": greedy, "explore": explore, "sigma": sigma2 ** 0.5, "fit_sd": fit_var ** 0.5,
                   "significant": significant, "states": int(len(states)), "unmet": unmet}, f)


if __name__ == "__main__":
    main()
