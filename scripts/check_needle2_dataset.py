#!/usr/bin/env python3
"""Fail if Needle's right-truncating trainer would clip any answer tokens."""

from __future__ import annotations

import argparse
import json
import sys

from needle.model.finetune import render_example
from needle.model.tokenizer import get_tokenizer


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("jsonl", nargs="?", default="data/needle2/repair-train.jsonl")
    parser.add_argument("--max-len", type=int, default=256)
    args = parser.parse_args()

    tokenizer = get_tokenizer()
    total = 0
    no_answer = 0
    clipped = 0
    max_tokens = 0
    with open(args.jsonl, encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            example = json.loads(line)
            prompt, target = render_example(example)
            prompt_tokens = 1 + len(tokenizer.encode(prompt))  # BOS + prompt
            target_tokens = len(tokenizer.encode(target)) + 1  # target + EOS
            sequence_tokens = prompt_tokens + target_tokens
            total += 1
            max_tokens = max(max_tokens, sequence_tokens)
            if prompt_tokens >= args.max_len:
                no_answer += 1
                clipped += 1
            elif sequence_tokens > args.max_len:
                clipped += 1

    print(json.dumps({
        "examples": total,
        "maxSequenceTokens": max_tokens,
        "maxTrainingLength": args.max_len,
        "examplesWithoutAnswerTokens": no_answer,
        "examplesWithTruncatedAnswers": clipped,
    }, indent=2))
    return 2 if not total or clipped else 0


if __name__ == "__main__":
    raise SystemExit(main())
