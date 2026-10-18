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
REPAIR_TOOLS_FILE = ROOT / "ai" / "needle2" / "repair-tools.json"
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
    for key in ("error", "stderr", "message", "log", "symptom", "trigger", "recovery_reason", "behaviour", "behavior"):
        value = record.get(key, "").strip()
        if value and value.lower() not in {part.lower() for part in parts}:
            parts.append(value)
    return " | ".join(parts)[:64]


def make_example(query: str, issue_id: str, evidence: str, tools: list[dict]) -> dict:
    return {
        "query": query,
        "tools": tools,
        "answers": [{
            "name": "lookup_documented_issue",
            "arguments": {"id": issue_id, "evidence": evidence[:64]},
        }],
    }


def make_repair_example(query: str, issue_id: str, tool_name: str, evidence: str, tools: list[dict]) -> dict:
    return {
        "query": f"Repair issue {issue_id} if safe. Evidence: {query}",
        "tools": tools,
        "answers": [{
            "name": "request_repair_tool",
            "arguments": {"tool": tool_name, "issueId": issue_id, "evidence": evidence[:64]},
        }],
    }


def query_variants(record: dict[str, str], evidence: str) -> list[str]:
    return [evidence, f"NexusPanel error: {evidence}"]


def main() -> int:
    markdown = CORPUS.read_text(encoding="utf-8-sig")
    repair_contract = json.loads(REPAIR_TOOLS_FILE.read_text(encoding="utf-8"))
    records = read_records(markdown)
    usable = [(record, evidence_for(record)) for record in records]
    usable = [(record, evidence) for record, evidence in usable if evidence]
    if len(usable) < 50:
        print(f"Only {len(usable)} usable issue records found; refusing to train on a thin corpus.", file=sys.stderr)
        return 2

    registry = {}
    for record, _ in usable:
        issue = {
            "error": record.get("error", "") or record.get("stderr", "") or record.get("message", ""),
            "cause": record.get("cause", ""),
            "fix": record.get("fix", ""),
            "httpStatus": record.get("http_status", ""),
            "exitCode": record.get("exit_code", ""),
        }
        repair_tool = repair_contract.get("issueMap", {}).get(record["id"])
        if repair_tool:
            issue["repairTool"] = repair_tool
        registry[record["id"]] = issue

    # Needle's local trainer truncates from the right. Keep both function names
    # present in every prompt so the model learns when to classify and when to
    # request a repair. Compact schemas keep all labels within 256 tokens;
    # runtime still supplies the full schemas and validates requests in Node.
    lookup_tool = {
        "name": "lookup_documented_issue",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "evidence": {"type": "string"},
            },
            "required": ["id", "evidence"],
        },
    }
    repair_request_schema = {
        "name": repair_contract["tool"]["name"],
        "parameters": {
            "type": "object",
            "properties": {
                "tool": {"type": "string"},
                "issueId": {"type": "string"},
                "evidence": {"type": "string"},
            },
            "required": ["tool", "issueId", "evidence"],
        },
    }

    examples = []
    for record, evidence in usable:
        issue_id = record["id"]
        for query in query_variants(record, evidence):
            training_tools = [lookup_tool, repair_request_schema]
            examples.append(make_example(query, issue_id, evidence, training_tools))
            repair_tool = repair_contract.get("issueMap", {}).get(issue_id)
            if repair_tool:
                examples.append(make_repair_example(query, issue_id, repair_tool, evidence, training_tools))
    negative_count = max(1, (len(examples) + 6) // 7)
    for index in range(negative_count):
        examples.append({"query": NEGATIVE_QUERIES[index % len(NEGATIVE_QUERIES)], "tools": [lookup_tool, repair_request_schema], "answers": []})

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
