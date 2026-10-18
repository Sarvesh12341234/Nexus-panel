#!/usr/bin/env python3
"""Build a local Needle 2 tool-calling dataset from the error catalogue."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / "docs" / "AI-TRAINING-CORPUS.md"
OUT_DIR = ROOT / "data" / "needle2"
TRAINING_FILE = OUT_DIR / "repair-train.jsonl"
REGISTRY_FILE = ROOT / "ai" / "needle2" / "known-issues.json"
NEGATIVE_QUERIES = [
    "What is the weather in Paris today?",
    "Write a poem about a redstone castle.",
    "How do I make a chocolate cake?",
    "Who won the football match yesterday?",
    "Translate hello into Japanese.",
    "Tell me a joke about a creeper.",
    "What is the capital of Canada?",
    "Explain how photosynthesis works.",
]


def scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, str) else str(parsed)
        except json.JSONDecodeError:
            return value[1:-1]
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def read_records(markdown: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for block in re.findall(r"```yaml\s*\n(.*?)```", markdown, flags=re.S | re.I):
        current: dict[str, str] | None = None
        last_key = ""
        for line in block.splitlines():
            match = re.match(r"^-\s+id:\s*([A-Za-z0-9_.-]+)\s*$", line)
            if match:
                if current:
                    records.append(current)
                current = {"id": match.group(1)}
                last_key = ""
                continue
            if current is None:
                continue
            field = re.match(r"^\s{2}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
            if field:
                last_key = field.group(1)
                current[last_key] = scalar(field.group(2))
            elif last_key and line.startswith(" " * 5) and line.strip():
                current[last_key] += " " + scalar(line.strip())
        if current:
            records.append(current)

    # Keep the last occurrence of an ID and preserve source order. Duplicate IDs
    # would otherwise make the model's answer ambiguous.
    unique: dict[str, dict[str, str]] = {}
    for record in records:
        unique[record["id"]] = record
    return list(unique.values())


def evidence_for(record: dict[str, str]) -> str:
    parts = []
    for key in ("error", "stderr", "message", "symptom", "trigger", "behaviour", "behavior"):
        value = record.get(key, "").strip()
        if value and value.lower() not in {part.lower() for part in parts}:
            parts.append(value)
    return " | ".join(parts)[:320]


def make_example(query: str, issue_id: str, evidence: str, tools: list[dict]) -> dict:
    return {
        "query": query,
        "tools": tools,
        "answers": [{
            "name": "lookup_documented_issue",
            "arguments": {"id": issue_id, "evidence": evidence[:320]},
        }],
        "reasoning": f"The supplied NexusPanel error text matches documented issue {issue_id}; preserve the evidence verbatim.",
    }


def main() -> int:
    markdown = CORPUS.read_text(encoding="utf-8-sig")
    records = read_records(markdown)
    usable = [(record, evidence_for(record)) for record in records]
    usable = [(record, evidence) for record, evidence in usable if evidence]
    if len(usable) < 50:
        print(f"Only {len(usable)} usable issue records found; refusing to train on a thin corpus.", file=sys.stderr)
        return 2

    registry = {}
    for record, _ in usable:
        registry[record["id"]] = {
            "error": record.get("error", "") or record.get("stderr", "") or record.get("message", ""),
            "cause": record.get("cause", ""),
            "fix": record.get("fix", ""),
            "httpStatus": record.get("http_status", ""),
            "exitCode": record.get("exit_code", ""),
        }

    tools = [{
        "name": "lookup_documented_issue",
        "description": "Identify one NexusPanel issue by its stable documentation ID. This is read-only triage; it cannot execute repairs, commands, or API operations. Return only an ID evidenced by the supplied error text.",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Exact issue ID from the NexusPanel training corpus."},
                "evidence": {"type": "string", "description": "Short exact excerpt from the supplied log or symptom."},
            },
            "required": ["id", "evidence"],
        },
    }]

    examples = []
    for record, evidence in usable:
        issue_id = record["id"]
        examples.append(make_example(evidence, issue_id, evidence, tools))
        examples.append(make_example(f"NexusPanel problem: {evidence} How should I diagnose this?", issue_id, evidence, tools))
    negative_count = max(1, (len(examples) + 6) // 7)
    for index in range(negative_count):
        examples.append({"query": NEGATIVE_QUERIES[index % len(NEGATIVE_QUERIES)], "tools": tools, "answers": []})

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    with TRAINING_FILE.open("w", encoding="utf-8", newline="\n") as stream:
        for example in examples:
            stream.write(json.dumps(example, ensure_ascii=False) + "\n")
    REGISTRY_FILE.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({
        "corpusRecordEntries": len(re.findall(r"(?m)^-\s+id:", markdown)),
        "uniqueIssueIds": len(records),
        "issuesWithEvidence": len(usable),
        "trainingExamples": len(examples),
        "negativeExamples": sum(not row["answers"] for row in examples),
        "trainingFile": str(TRAINING_FILE),
        "registryFile": str(REGISTRY_FILE),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
