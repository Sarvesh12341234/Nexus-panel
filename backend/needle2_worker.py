#!/usr/bin/env python3
"""Single-server, read-only Needle worker. One process owns one model session."""

from __future__ import annotations

import json
from pathlib import Path
import sys


REPAIR_CONTRACT = json.loads((Path(__file__).resolve().parents[1] / "ai" / "needle2" / "repair-tools.json").read_text(encoding="utf-8"))
ALLOWED_TOOLS = set(REPAIR_CONTRACT["tool"]["parameters"]["properties"]["tool"]["enum"])
ISSUE_TOOL_MAP = REPAIR_CONTRACT.get("issueMap", {})
TOOLS = [{
    "name": "lookup_documented_issue",
    "description": "Identify one NexusPanel issue by its stable documentation ID. This tool only classifies supplied text. It cannot execute repairs, commands, or API operations.",
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Exact issue ID in the NexusPanel documentation."},
            "evidence": {"type": "string", "description": "A short exact excerpt from the input log."},
        },
        "required": ["id", "evidence"],
    },
}, REPAIR_CONTRACT["tool"]]


def main() -> int:
    try:
        import needle

        model_path = sys.argv[1]
        agent = needle.Needle(tools=TOOLS, weights=model_path)
    except Exception as exc:  # report only the error type, not environment secrets
        print(json.dumps({"ready": False, "error": type(exc).__name__}), flush=True)
        return 2

    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                continue
            request_id = int(request.get("requestId", 0))
            # Must match redact() in needle2_agent.js: keep the LAST 1400 chars,
            # otherwise evidence quoted from the tail fails the substring check.
            text = str(request.get("text", ""))[-1400:]
            agent.reset()
            response = agent.complete(text)
            calls = response.get("function_calls", []) if isinstance(response, dict) else []
            result = None
            if calls:
                call = calls[0]
                args = call.get("arguments", {}) if isinstance(call.get("arguments"), dict) else {}
                name = call.get("name")
                if name == "lookup_documented_issue":
                    result = {"kind": "issue", "id": args.get("id"), "evidence": args.get("evidence")}
                elif name == "request_repair_tool":
                    # Reject anything the contract does not allow. The Node side
                    # re-validates, but a hallucinated tool name must never be
                    # forwarded as if it were registered.
                    tool = args.get("tool")
                    issue_id = args.get("issueId")
                    if isinstance(tool, str) and isinstance(issue_id, str) and tool in ALLOWED_TOOLS and ISSUE_TOOL_MAP.get(issue_id) == tool:
                        result = {
                            "kind": "repair-tool",
                            "tool": tool,
                            "issueId": issue_id,
                            "evidence": args.get("evidence"),
                        }
            print(json.dumps({"requestId": request_id, "result": result}), flush=True)
        except Exception as exc:
            print(json.dumps({"requestId": request.get("requestId", 0), "error": type(exc).__name__}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
