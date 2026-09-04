# Mantyl plugin for Claude Code

Generates a verifiable project passport at the end of a build session:
repository evidence, this session's agent history, and checks executed
in a Docker sandbox, with every claim labelled by who proved it.

Install from this repository:

```
/plugin marketplace add jopli11/mantyl-cli
/plugin install mantyl
```

Then `/mantyl:passport` runs the loop, or just ask for "the handover
passport" and the skill triggers. Requires Node 20+, git, and Docker
Desktop for executed checks (without Docker the passport records
skipped checks honestly). The CLI itself is free, local-first and
telemetry-free: https://www.mantyl.dev/docs
