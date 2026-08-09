# NexusPanel 5.1 — Hardening

Focus:
- runtime self-tests for the new core
- fail-closed capability authorization helper
- portable installer preflight checks
- parameterized-query safety review helper
- static UI audit helper

Testing policy:
- no test automatically changes permissions, deletes data, or escalates privileges
- destructive operations remain behind the protected-data policy
- tests are designed to run in CI or a staging environment
