# Mantyl

**Deliver AI-built software without delivering a black box.**

[![npm](https://img.shields.io/npm/v/mantyl)](https://www.npmjs.com/package/mantyl)
[![CI](https://github.com/jopli11/mantyl-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/jopli11/mantyl-cli/actions/workflows/ci.yml)
[![Mantyl passport](https://www.mantyl.dev/api/badge/495fc5a9be5bf678)](https://www.mantyl.dev/p/495fc5a9be5bf678)

Mantyl is a local-first CLI for AI code handover. It turns a repository
and its coding-agent history (Claude Code, Cursor, OpenAI Codex CLI)
into a verified, recipient-ready **project passport**: what the software
contains, how it runs, what was decided during the build, what was
proven by execution, and what remains unknown. Every statement carries
an explicit truth status with evidence references, and the recipient can
independently re-verify the whole document with one command.

That third badge above is not decoration. It is the live passport this
tool generated for its own source, verified by independent re-execution.

![Mantyl demo](https://www.mantyl.dev/demo/mantyl-demo.gif)

## Why this exists

Software built with coding agents concentrates its knowledge in fragile
places: session transcripts, discarded prompts and the operator's
memory. When such a project changes hands, the recipient traditionally
gets source code and assurances. Mantyl replaces the assurances with a
checkable record. An LLM may interpret; it can never mark anything
verified. A claim the code contradicts is surfaced as contradicted, with
the evidence named, never hidden.

## Install

```
npm install -g mantyl
```

Requires Node 20.12+. Docker Desktop is a prerequisite for the full
result: it powers sandbox verification, where the passport's strongest
evidence comes from. Without it, checks are honestly recorded as
skipped. Reading Cursor history needs Node 22.13+.

## Quickstart

```bash
cd your-project
mantyl init       # write mantyl.config.json
mantyl scan       # facts, claims and decisions from repo + agent history
mantyl verify     # execute install/build/test in an isolated sandbox
mantyl generate   # assemble passport.json + human-readable reports
```

Artefacts land in `.mantyl/`: `passport.json` (the canonical,
digest-stamped contract), readable HTML and Markdown reports, and the
evidence files behind every statement. Everything runs on your machine.
Nothing uploads without an explicit publish command, and all transcript
text passes through fail-closed secret redaction before it is stored or
analysed. This repository is the proof of both claims.

On the receiving side:

```bash
npx mantyl receive --passport passport.json
```

This recomputes the passport digest, fingerprints the delivered files,
compares the commit and re-executes the recorded checks in the
recipient's own sandbox. Any divergence is named precisely and exits
non-zero. The person receiving AI-built software never has to take the
builder's word for anything.

## The truth model

Every claim, decision, risk and setup step carries one of eight
statuses. The rule underneath them all: interpretation can never be
upgraded into proof.

| Status | Meaning |
| --- | --- |
| `mantyl-verified` | Independently re-executed and signed by neutral infrastructure |
| `locally-verified` | Executed successfully in this machine's sandbox |
| `repository-confirmed` | The repository itself shows it |
| `agent-reported` | The coding agent said it, recorded but not proven |
| `creator-confirmed` | The builder's own recorded words |
| `inferred` | LLM interpretation, permanently marked as such |
| `contradicted` | The evidence disagrees with the claim |
| `unresolved` | Could not be established either way |

## Supported agents

Mantyl reads Claude Code session stores, Cursor chat history and OpenAI
Codex CLI sessions to extract claims and decisions. The storage layouts
are documented in detail on the site: where Cursor, Claude Code and the
Codex CLI keep session history are each covered at
[mantyl.dev/guides](https://www.mantyl.dev/guides).

## What is in this repository

| Path | Purpose |
| --- | --- |
| `apps/cli` | The `mantyl` command, bundled for npm |
| `packages/schema` | The open `passport.json` contract (Zod, JSON Schema export) |
| `packages/core` | Scan, verify, reconcile, generate, receive, accept |
| `packages/adapter-*` | Claude Code, Cursor and Codex session-store readers |
| `packages/collectors-*` | Git and repository evidence collectors |
| `packages/runner-docker` | The isolated sandbox (network off after install) |
| `packages/verifier-node` | Check planning and execution for Node projects |
| `packages/evidence` | Claim reconciliation against repository evidence |
| `packages/renderer-*` | HTML and Markdown passport renderers |
| `examples` | The seeded fixture project the test suite verifies against |

This repository holds the complete CLI: everything that runs on your
machine is open and auditable here. The hosted passport service and the
Mantyl Verified signing infrastructure live in a separate private
codebase; the signing key never ships in any client. The passport format
itself is open, schemas at
[mantyl.dev/schemas/passport-v1.json](https://www.mantyl.dev/schemas/passport-v1.json).

## Development

```bash
pnpm install
pnpm build
pnpm test
```

The test suite includes determinism gates (two runs must produce
byte-identical passports) and secret-leak gates (planted credentials in
fixtures must never reach any artefact). Sandbox integration tests
self-skip without a Docker daemon and run in CI.

## Docs and links

Full documentation lives at [mantyl.dev/docs](https://www.mantyl.dev/docs):
quickstart, supported agents, the truth model, the command reference
with stable exit codes, and publishing. The reasoning behind the tool is
at [mantyl.dev/manifesto](https://www.mantyl.dev/manifesto).

## License

MIT. Mantyl output is evidence-backed, not a certification.
