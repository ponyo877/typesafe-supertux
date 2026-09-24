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

"""Turns the labeled situations into the table the badguys follow.

    cd tools/distill && uv run fit.py [--name llm] [--model "..."]
    uv run --project tools/distill python tools/distill/fit.py --spec <spec.json>

Reads situations.jsonl and labels/part-*.jsonl (LABELING.md). Situations
labeled more than once (the shared ones) take the most common answer. Only
the situations met in play are labeled, about a thousand of the 442,368 the
facts allow; LightGBM learns from them what to do in the others. Labeled
situations keep their label exactly.

Writes mk/emscripten/<name>-table.js: every combination of the facts, in the
order of DOMAINS, one order per combination, packed two to a byte.

--spec makes a table for something else, such as Tux in tools/coevo: a JSON
file with "name", "model", "domains", "orders" (the answers, by code), the
"situations" file, the "labels" glob and the "out" path.
"""

import argparse
import base64
import collections
import glob
import itertools
import json
import os

import lightgbm as lgb
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

# The facts of laya-rich-prompt.js, in the order the table is indexed by.
DOMAINS = [
    ("height", ["same level", "above me", "above me and falling toward me", "below me"]),
    ("invincible", [False, True]),
    ("fireball", [False, True]),
    ("kind", ["viciousivy", "walkingleaf", "igel", "snail", "mrbomb", "jumpy"]),
    ("ready", [False, True]),
    ("distance", ["touching", "near", "medium", "far"]),
    ("wall", [False, True]),
    ("vertical", ["on the ground", "rising", "falling"]),
    ("landing_near", [False, True]),
    ("spikes", [False, True]),
    ("recovering", [False, True]),
    ("between", [False, True]),
    ("beyond", [False, True]),
    ("motion", ["coming toward me", "moving away", "standing"]),
]
ORDERS = ["patrol", "charge", "retreat", "hold", "jump", "ambush", "intercept", "stalk", "flank", "special"]


def encode(facts):
    return [values.index(facts[name]) for name, values in DOMAINS]


def index_of(codes):
    index = 0
    for (_, values), code in zip(DOMAINS, codes):
        index = index * len(values) + code
    return index


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", default="llm")
    parser.add_argument("--model", default="Claude Opus 5.5 (Claude Code), distilled with LightGBM")
    parser.add_argument("--spec")
    args = parser.parse_args()

    global DOMAINS, ORDERS
    situations_path = os.path.join(HERE, "situations.jsonl")
    labels_glob = os.path.join(HERE, "labels", "part-*.jsonl")
    out = os.path.join(REPO, "mk", "emscripten", f"{args.name}-table.js")
    if args.spec:
        with open(args.spec) as f:
            spec = json.load(f)
        base = os.path.dirname(os.path.abspath(args.spec))
        DOMAINS = [(name, values) for name, values in spec["domains"]]
        ORDERS = spec["orders"]
        args.name, args.model = spec["name"], spec["model"]
        situations_path = os.path.join(base, spec["situations"])
        labels_glob = os.path.join(base, spec["labels"])
        out = os.path.join(base, spec["out"])

    situations = {}
    with open(situations_path) as f:
        for line in f:
            s = json.loads(line)
            situations[s["id"]] = s

    votes = collections.defaultdict(list)
    for path in sorted(glob.glob(labels_glob)):
        with open(path) as f:
            for line in f:
                if line.strip():
                    label = json.loads(line)
                    if label["order"] not in ORDERS:
                        raise SystemExit(f"{path}: unknown order {label['order']!r} for {label['id']}")
                    votes[label["id"]].append(label["order"])

    missing = [i for i in situations if i not in votes]
    if missing:
        raise SystemExit(f"{len(missing)} situations have no label, e.g. {missing[:5]}")

    shared = {i: v for i, v in votes.items() if len(v) > 1}
    if shared:
        unanimous = sum(len(set(v)) == 1 for v in shared.values())
        pairs = [(a, b) for v in shared.values() for a, b in itertools.combinations(v, 2)]
        print(f"shared situations: {len(shared)}, unanimous {unanimous}, "
              f"pairwise agreement {sum(a == b for a, b in pairs) / len(pairs):.2f}")

    labels = {i: collections.Counter(v).most_common(1)[0][0] for i, v in votes.items()}
    ids = sorted(labels)
    x = np.array([encode(situations[i]["facts"]) for i in ids])
    y = np.array([ORDERS.index(labels[i]) for i in ids])
    weight = np.sqrt(np.array([situations[i]["count"] for i in ids], dtype=float))

    counts = collections.Counter(labels.values())
    print("labels:", ", ".join(f"{o} {counts[o]}" for o in ORDERS if counts[o]))

    params = dict(objective="multiclass", num_class=len(ORDERS), learning_rate=0.1, num_leaves=31,
                  min_data_in_leaf=1, min_sum_hessian_in_leaf=1e-3, lambda_l2=1.0, verbose=-1, seed=1)
    features = [name for name, _ in DOMAINS]

    # How well it guesses situations it has not seen: five-fold, by situation.
    rng = np.random.default_rng(1)
    folds = rng.permutation(len(ids)) % 5
    right = 0
    for k in range(5):
        train, test = folds != k, folds == k
        booster = lgb.train(params, lgb.Dataset(x[train], y[train], weight=weight[train], feature_name=features,
                                                categorical_feature=features), num_boost_round=150)
        right += int((booster.predict(x[test]).argmax(1) == y[test]).sum())
    print(f"unseen situations guessed as labeled: {right / len(ids):.2f} (5-fold)")

    booster = lgb.train(params, lgb.Dataset(x, y, weight=weight, feature_name=features, categorical_feature=features),
                        num_boost_round=150)

    grid = np.array(list(itertools.product(*[range(len(values)) for _, values in DOMAINS])), dtype=np.int32)
    table = booster.predict(grid, num_threads=0).argmax(1).astype(np.uint8)
    for codes, order in zip(x, y):
        table[index_of(codes)] = order

    packed = (table[0::2] | (table[1::2] << 4)).astype(np.uint8)
    spread = collections.Counter(table.tolist())
    print("table:", ", ".join(f"{ORDERS[o]} {n / len(table):.1%}" for o, n in spread.most_common()))

    with open(out, "w") as f:
        f.write("// Generated by tools/distill/fit.py; do not edit.\n")
        f.write("// What a badguy does in every combination of the facts of laya-rich-prompt.js.\n")
        f.write(f"window.POLICY_TABLES = window.POLICY_TABLES || {{}};\n")
        f.write(f"window.POLICY_TABLES[{json.dumps(args.name)}] = ")
        json.dump({
            "model": args.model,
            "domains": [[name, values] for name, values in DOMAINS],
            "orders": ORDERS,
            "packed": base64.b64encode(packed.tobytes()).decode(),
        }, f)
        f.write(";\n")
    print(f"wrote {out} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
