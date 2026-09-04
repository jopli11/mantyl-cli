# Mantyl

**Deliver AI-built software without delivering a black box.**

Mantyl turns a repository and its coding-agent history into a verified,
recipient-ready **project passport**: what exists, how it works, what was
decided, what was proven, and what remains unknown.

- **Local-first** — everything runs on your machine; no account, no upload.
- **Evidence, not vibes** — every statement carries source references and an
  explicit truth status. An LLM may *interpret*; it can never mark anything
  verified.
- **Two-sided trust** — the recipient independently re-verifies the passport
  with `mantyl receive`; they never have to take your word for it.

```
npm install -g mantyl
```

Requires Node 20.12+. Treat Docker Desktop as a prerequisite for the full
result — it powers sandbox verification, where the passport's strongest
evidence comes from. Without it, checks are honestly recorded as skipped.

## Quickstart

```bash
cd your-project
mantyl init       # write mantyl.config.json
mantyl scan       # facts, claims and decisions from repo + agent history
mantyl verify     # execute install/build/test/lint in an isolated sandbox
mantyl generate   # assemble passport.json + human-readable reports
```

Artefacts land in `.mantyl/`: `passport.json` (the canonical, digest-stamped
contract), `passport.md` and `passport.html` (readable reports), plus the
evidence files behind every statement.

On the receiving side:

```bash
mantyl receive --passport passport.json
```

This recomputes the passport digest, fingerprints the delivered files,
compares the commit, and re-executes the recorded checks in the recipient's
own sandbox. Any divergence is named precisely — a modified file, a check
that no longer passes — and exits non-zero.

## The truth model

Every claim, decision, risk and setup step carries one of eight statuses.
The three you will see most:

| Status | Meaning |
| --- | --- |
| `locally-verified` | Executed successfully by the CLI's sandbox on this machine |
| `repository-confirmed` | The repository itself shows it |
| `agent-reported` | The coding agent said it — recorded, not proven |

Contradictions are surfaced, never hidden: a claim of "rate limiting" with no
rate-limiting code becomes `contradicted`, with references to both the claim
and the evidence against it.

## Agent history

Mantyl reads Claude Code session stores, plus Cursor chat history and
OpenAI Codex CLI sessions in beta, to extract *claims* (what the agent said
it did) and *decisions* (what was chosen, by the agent or by you — your own
recorded words are `creator-confirmed`). Cursor support needs Node 22.13+.
All transcript text passes through fail-closed secret redaction before it is
stored or analysed.

## Optional LLM analysis

With `llm.provider: "anthropic"` in `mantyl.config.json` and an
`ANTHROPIC_API_KEY` (env var or gitignored `.env`), Mantyl adds an inferred
architecture narrative and risk list. Analysis is interpretation only: it sees
redacted excerpts, its output is schema-validated locally, and everything it
produces is permanently marked `inferred`. The pipeline is complete without
it — `llm.provider: "none"` is first-class.

## Commands

| Command | Purpose |
| --- | --- |
| `mantyl init` | Create `mantyl.config.json` |
| `mantyl scan` | Collect repository, git and agent-session observations |
| `mantyl verify` | Run checks in an isolated Docker sandbox (network off after install) |
| `mantyl generate` | Assemble and digest-stamp the passport + reports (`--no-llm` skips analysis for one run) |
| `mantyl ci` | The pipeline for CI: verify then generate, GitHub outputs and job summary on Actions (exit 0/4/5) |
| `mantyl attest` | Seal the passport as an in-toto/DSSE attestation with your key pair (`--generate-keys`) |
| `mantyl receive` | Independently validate a received passport (exit 7 on divergence; `--attestation` binds a DSSE envelope) |
| `mantyl accept` | Recipient's closing act: full recheck, findings acknowledged by id, detached acceptance record bound to the passport digest |
| `mantyl doctor` | Check the local environment |
| `mantyl config` | Show the resolved configuration |

Exit codes are stable and documented for CI use: `0` ok · `2` invalid config ·
`3` not a workable project · `4` verification failed · `5` sandbox unavailable ·
`6` invalid passport · `7` receive divergence.

---

Mantyl output is evidence-backed, not a certification. [mantyl.dev](https://mantyl.dev)
