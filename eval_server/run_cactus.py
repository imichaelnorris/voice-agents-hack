#!/usr/bin/env python3
"""Run a batch of prompts through Cactus's Python build with the same INT4
weights the phone runs. Same input/output format as run_batch.mjs and
run_local.mjs so analyze.mjs can score uniformly.

Usage:
    source ~/github/cactus/venv/bin/activate
    python eval_server/run_cactus.py <batch.json> [--out file.jsonl] [--weights DIR]

The weights directory should be the Cactus-converted model dir (e.g.
~/github/cactus/weights/gemma-4-e2b-it). cactus_complete reads INT4
quantized weights when that's how they were converted — same bytes the
iPhone Cactus build is loading.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# Allow importing the Cactus python module straight from the repo checkout.
CACTUS_REPO = Path.home() / "github/cactus"
sys.path.insert(0, str(CACTUS_REPO / "python" / "src"))

from cactus import cactus_init, cactus_destroy, cactus_complete  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("batch", help="path to a batch JSON file")
    ap.add_argument(
        "--out",
        default=None,
        help="output jsonl (defaults to <batch>.cactus_int4.results.jsonl)",
    )
    ap.add_argument(
        "--weights",
        default=str(CACTUS_REPO / "weights" / "gemma-4-e2b-it"),
        help="path to converted model weights directory",
    )
    args = ap.parse_args()

    batch_path = Path(args.batch)
    batch = json.loads(batch_path.read_text())
    prompts = batch.get("prompts", [])
    if not prompts:
        print("no prompts", file=sys.stderr)
        return 2

    out_path = Path(args.out) if args.out else batch_path.with_suffix("").with_suffix(
        ".cactus_int4.results.jsonl"
    )
    print(f"[cactus] {len(prompts)} prompts → {args.weights}")
    print(f"[cactus] writing to {out_path}")

    print("[cactus] loading model (this can take a moment)...")
    t0 = time.time()
    model = cactus_init(args.weights, None, False)
    print(f"[cactus] model loaded in {time.time() - t0:.1f}s")

    started = time.time()
    n_ok = n_err = 0
    with out_path.open("w") as out:
        for p in prompts:
            ident = p.get("id") or f"{p.get('label', 'p')}-{int(time.time() * 1000) % 1000000}"
            sys_prompt = p.get("systemPrompt") or batch.get("systemPrompt")
            req_options = p.get("options") or batch.get("options") or {}
            messages = []
            if sys_prompt:
                messages.append({"role": "system", "content": sys_prompt})
            messages.append({"role": "user", "content": p["prompt"]})

            options = {
                "temperature": req_options.get("temperature", 0.7),
                "max_tokens": req_options.get("maxTokens", 1024),
            }

            t_start = time.time()
            response_text = None
            error = None
            try:
                raw = cactus_complete(
                    model, json.dumps(messages), json.dumps(options), None, None
                )
                result = json.loads(raw)
                if result.get("success"):
                    response_text = result.get("response", "")
                else:
                    error = result.get("error") or "cactus complete failed (no error)"
            except Exception as e:  # noqa: BLE001
                error = f"{type(e).__name__}: {e}"
            duration_ms = int((time.time() - t_start) * 1000)

            rec = {
                "id": ident,
                "label": p.get("label"),
                "prompt": p.get("prompt"),
                "systemPrompt": sys_prompt,
                "response": response_text,
                "error": error,
                "durationMs": duration_ms,
                "receivedAt": int(time.time() * 1000),
            }
            out.write(json.dumps(rec) + "\n")
            out.flush()

            tag = "err" if error else "ok "
            preview = ((response_text or error or "").splitlines() or [""])[0][:80]
            print(f"[{tag}] {ident} ({duration_ms / 1000:.1f}s) {preview}")
            if error:
                n_err += 1
            else:
                n_ok += 1

    cactus_destroy(model)
    elapsed = time.time() - started
    print(f"[cactus] done — {n_ok} ok, {n_err} err in {elapsed:.1f}s → {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
