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

"""Local decision server for the badguys, running Laya on Apple silicon via laya-mlx.

Speaks the request/response format of TypeSafe's /v1/systemone (Jev), plus one
extension: a question may carry its own "state", which then replaces the shared
state for that question. That lets every badguy describe its own situation while
all of them are still answered in a single forward pass. "model" picks one of
the Laya checkpoints (see Models).

    cd tools/laya-server && uv run server.py

tools/jev-proxy/server.mjs relays /api/laya here.
"""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import laya_mlx as laya
import numpy as np
from huggingface_hub import snapshot_download
from laya_mlx.agent import collate_items
from laya_mlx.common import confidence_from_probs, temp_bucket

MAX_BODY = 1024 * 1024
MAX_QUESTIONS = 256


def resolve(model):
    """Local path of a Hub checkpoint; only touches the network if it is missing."""
    try:
        return snapshot_download(model, local_files_only=True)
    except Exception:
        print(f"Downloading {model} ...", flush=True)
        return snapshot_download(model)


def predict(agent, shared_state, questions):
    """Agent.system_one, but every question may bring its own state.

    Mirrors laya_mlx.agent.Agent.system_one (laya-mlx 0.1) apart from preparing each
    question against its own state; the answers match asking one question at a time.
    The action head and the score legend are left out, as the game uses neither.
    """
    items, internal, ids = [], [], []
    for qid, question in questions.items():
        question = dict(question)
        state = question.pop("state", shared_state)
        prepared, converted = agent.prepare(state, {qid: question})
        items += prepared
        internal += converted
        ids.append(qid)

    answers = {}
    for start in range(0, len(items), agent.batch_size):
        chunk = items[start : start + agent.batch_size]
        batch = collate_items(
            chunk,
            agent.tok.pad_token_id,
            pad_to_multiple=agent.pad_to_multiple,
            max_length=agent.cfg.get("max_len", 512),
        )
        logits, _ = agent.forward(batch)
        logits = np.asarray(logits)
        if not np.isfinite(logits).all():
            raise FloatingPointError("Non-finite model outputs")
        for row, item in enumerate(chunk):
            qid, q = ids[start + row], internal[start + row]
            k, qtype = len(item["markers"]), item["qtype"]
            scale = agent.temperature_by_options.get(temp_bucket(qtype, k), agent.temperature[qtype])
            z = logits[row, :k] / max(1e-3, float(scale))
            p = np.exp(z - z.max())
            p /= p.sum()
            answer = {"type": q["t"], "confidence": round(confidence_from_probs(p, k), 4)}
            if q["t"] == "choice":
                labels = list(q["crit"])
                answer["choice"] = labels[int(p.argmax())]
                answer["probabilities"] = {label: round(float(v), 4) for label, v in zip(labels, p)}
            elif q["t"] == "score":
                answer["score"] = round(float((np.arange(k) * p).sum()), 4)
                answer["probabilities"] = {str(i): round(float(v), 4) for i, v in enumerate(p)}
            else:
                answer["noul"] = round(float(p[1]), 4)
                answer["confidence"] = round(max(float(p[1]), 1.0 - float(p[1])), 4)
            answers[qid] = answer
    return answers, sum(len(item["ids"]) for item in items)


class Models:
    """The checkpoints requests may ask for by "model", loaded on first use."""

    ALLOWED = ("aac6fef/laya-mlx", "aac6fef/laya-multilingual-mlx", "aac6fef/laya-typed-decisions-mlx")

    def __init__(self, default, **options):
        self.default = default
        self.options = options
        self.agents = {}

    def get(self, name=None):
        name = name or self.default
        if name not in self.ALLOWED:
            raise ValueError(f"model must be one of {', '.join(self.ALLOWED)}")
        if name not in self.agents:
            started = time.perf_counter()
            agent = laya.load(resolve(name), **self.options)
            # Warm up so that the first request from the game is not the slow one.
            predict(agent, "warm up", {"q": {"type": "choice", "instructions": "warm up", "criteria": ["a", "b"]}})
            print(f"Loaded {name} in {time.perf_counter() - started:.1f} s", flush=True)
            self.agents[name] = agent
        return name, self.agents[name]


def make_handler(models):
    class Handler(BaseHTTPRequestHandler):
        def send(self, status, body):
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path != "/v1/systemone":
                return self.send(404, {"error": "not found"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.send(413, {"error": "request too large"})
            try:
                request = json.loads(self.rfile.read(length))
                questions = request["questions"]
                if not isinstance(questions, dict) or not 0 < len(questions) <= MAX_QUESTIONS:
                    raise ValueError(f"questions must be an object with 1-{MAX_QUESTIONS} entries")
                model_name, agent = models.get(request.get("model"))
                started = time.perf_counter()
                answers, tokens = predict(agent, request.get("state", ""), questions)
                elapsed = (time.perf_counter() - started) * 1000
            except (KeyError, TypeError, ValueError) as error:
                return self.send(422, {"error": str(error)})
            sys.stderr.write(f"laya {model_name}: {len(questions)} questions, {elapsed:.1f} ms\n")
            self.send(200, {
                "model": model_name,
                "answers": answers,
                "usage": {"input_tokens": tokens, "output_tokens": 0},
                "inference_ms": round(elapsed, 1),
            })

        def log_request(self, code="-", size="-"):
            pass  # do_POST prints one line per answered request instead

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    # Requests without "model" get this one. The English checkpoint was the
    # most accurate for the basic prompt (mk/emscripten/laya-prompt.js), the
    # typed-decisions one for the rich prompt (laya-rich-prompt.js).
    parser.add_argument("--model", default="aac6fef/laya-mlx", choices=Models.ALLOWED)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--compile", action="store_true", help="mx.compile the model (first use per shape is slow)")
    args = parser.parse_args()

    models = Models(args.model, batch_size=args.batch_size, compile=args.compile)
    models.get()

    server = HTTPServer((args.host, args.port), make_handler(models))
    print(f"http://{args.host}:{args.port}/v1/systemone", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
