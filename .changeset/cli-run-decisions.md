---
'@motir/cli': minor
---

A run in your own agent now records the decisions the agent made where its card left the how open (MOTIR-10000). The agent writes them into its self-report as `decisions` (what the plan said, what it chose, why, and optionally the alternatives); the CLI keeps the well-formed ones, at most 20, and posts them on the run's discrepancy record beside any build-through points, or alone. The sandbox README and the staleness hint now name `ghcr.io/motir-co/motir-sandbox`, the image's home since the org move (MOTIR-9346), and the generated API client carries the pages operations over REST `/api/v1` (MOTIR-9486).
