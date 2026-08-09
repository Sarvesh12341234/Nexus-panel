# UI/JS deep audit

Added review coverage for:
- duplicate element IDs
- unbalanced HTML script/style tags
- inline event handlers
- unsafe innerHTML assignments
- missing fetch response checks
- unhandled JSON parsing
- client-side secret exposure
- graph API read-only behavior
- repair-flow event rendering

The audit is conservative and reports review candidates rather than claiming every match is a vulnerability.
