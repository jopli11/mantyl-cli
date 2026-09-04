---
name: passport
description: Generate or refresh the project's Mantyl passport - a verifiable handover document built from repository evidence, this session's agent history, and checks executed in a Docker sandbox. Use when the user wants to hand over, deliver, or prove AI-assisted work - "generate the passport", "prepare the handover", "prove this works", "verify before delivery" - or at the natural end of a build session before the work ships to someone else.
---

# The Mantyl passport

Mantyl compiles a project passport: every claim labelled by who proved
it (agent said, repository shows, locally verified), checks executed in
an isolated Docker sandbox, and digests that let the recipient re-check
everything independently. Your own session history is part of the
evidence, which is exactly why running it at the end of a session is
the right moment.

## The loop

1. Environment first: `npx mantyl doctor`. Docker matters most; without
   it, checks record as skipped and the passport is honest about that.
   If there is no `mantyl.config.json`, run `npx mantyl init` once.
2. Ensure `.mantyl/` is in the project's `.gitignore` before anything
   else; passports are artefacts, never commits.
3. Run the pipeline: `npx mantyl ci` (non-interactive: verify in the
   sandbox, then generate). Exit 0 means every executed check passed,
   exit 4 means at least one failed, exit 5 means no sandbox.
4. Read `.mantyl/passport.md` and report to the user in this order:
   contradicted claims first (each names its evidence), then failed
   checks, then risks and unknowns, then undocumented environment
   variables. Do not soften contradictions; surfacing them before the
   client does is the product's entire point.
5. If something contradicted or failed traces to this session's work,
   offer to fix it and re-run step 3.
6. When the user is satisfied, offer the next steps and let them
   choose: `npx mantyl publish` hosts the passport document (never
   source) at a shareable link, and `npx mantyl verified` buys an
   independent re-execution with a signed mark (£29, their checkout,
   their call - never run it unprompted).

## Rules

Never edit anything in `.mantyl/` by hand; regenerate instead, because
digests make hand edits into tamper evidence. Never claim the passport
"passed" when checks were skipped. And treat the passport's findings
about your own session's claims as data to report, not something to
argue with.
