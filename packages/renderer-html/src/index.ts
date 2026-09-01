/**
 * @mantyl/renderer-html — a PURE consumer of passport.json (spec §4).
 * Deterministic, self-contained HTML in the Signal Console design language
 * (tokens ported from the design system — the portable contract at work).
 * Never reruns analysis, never alters evidence statuses.
 */

import type { Passport, SourceRef, TruthStatus } from "@mantyl/schema";

const STATUS_META: Record<TruthStatus, { label: string; tone: "pos" | "neg" | "warn" | "dim" }> = {
  "mantyl-verified": { label: "MANTYL VERIFIED", tone: "pos" },
  "locally-verified": { label: "LOCALLY VERIFIED", tone: "pos" },
  "repository-confirmed": { label: "REPO", tone: "dim" },
  "agent-reported": { label: "AGENT", tone: "warn" },
  "creator-confirmed": { label: "CREATOR", tone: "dim" },
  inferred: { label: "INFERRED", tone: "dim" },
  contradicted: { label: "CONTRADICTED", tone: "neg" },
  unresolved: { label: "UNRESOLVED", tone: "warn" },
};

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ref(r: SourceRef): string {
  switch (r.kind) {
    case "file":
      return esc(r.lines ? `${r.path}:${r.lines[0]}` : r.path);
    case "commit":
      return `commit ${esc(r.sha.slice(0, 7))}`;
    case "session":
      return `session ${esc(`${r.sessionId}#${r.messageId}`)}`;
    case "check":
      return `check ${esc(r.checkId)}`;
    case "creator":
      return `assertion ${esc(r.assertionId)}`;
  }
}

function refsHtml(list: SourceRef[]): string {
  if (list.length === 0) return `<span class="refs">no refs</span>`;
  return `<span class="refs">${list.map(ref).join(" · ")}</span>`;
}

function badge(status: TruthStatus): string {
  const meta = STATUS_META[status];
  return `<span class="badge badge-${meta.tone}">${meta.label}</span>`;
}

/* Signal Console tokens — ported from the design system (colors.css). */
const CSS = `
:root{--surface-0:#090D12;--surface-1:#0D131A;--surface-2:#121A23;--surface-3:#18222D;
--text-1:#E9EEF3;--text-2:#93A1AE;--text-3:#5A6875;--signal:#FFC400;
--data-pos:#3DDC97;--data-neg:#FF6B5E;--line:rgba(233,238,243,.09);--line-strong:rgba(233,238,243,.22);}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--surface-0);color:var(--text-1);font:16px/1.6 system-ui,sans-serif;padding:48px 24px}
main{max-width:860px;margin:0 auto}
h1{font-size:28px;letter-spacing:-.02em}
h2{font-size:15px;margin:40px 0 12px;color:var(--signal);text-transform:uppercase;letter-spacing:.14em;
font-family:ui-monospace,monospace;font-weight:600}
.head{border:1px solid var(--line-strong);border-top:2px solid var(--signal);border-radius:4px;
background:var(--surface-2);padding:20px;margin-bottom:8px}
.meta{font-family:ui-monospace,monospace;font-size:11px;color:var(--text-3);letter-spacing:.06em;
text-transform:uppercase;margin-top:8px;word-break:break-all}
ul{list-style:none}
li{border:1px solid var(--line);border-radius:2px;background:var(--surface-2);padding:10px 14px;
margin-bottom:6px;font-size:14px;color:var(--text-2)}
li p{margin-top:4px}
.badge{display:inline-block;font-family:ui-monospace,monospace;font-size:10px;font-weight:700;
letter-spacing:.1em;padding:2px 7px;border-radius:2px;border:1px solid currentColor;margin-right:8px}
.badge-pos{color:var(--data-pos)} .badge-neg{color:var(--data-neg)}
.badge-warn{color:var(--signal)} .badge-dim{color:var(--text-3)}
.refs{display:block;font-family:ui-monospace,monospace;font-size:11px;color:var(--text-3);margin-top:4px}
.narrative{border-left:2px solid var(--signal);padding:10px 14px;background:var(--surface-3);
border-radius:0 2px 2px 0;color:var(--text-2);font-size:14px}
code{font-family:ui-monospace,monospace;font-size:13px;color:var(--text-1)}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);font-family:ui-monospace,monospace;
font-size:11px;color:var(--text-3);letter-spacing:.1em;text-transform:uppercase;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
`;

function section(title: string, items: string[], emptyText: string): string {
  const body = items.length > 0 ? `<ul>${items.join("")}</ul>` : `<ul><li>${emptyText}</li></ul>`;
  return `<h2>${title}</h2>${body}`;
}

export function renderPassportHtml(passport: Passport): string {
  const p = passport;

  const claims = p.claims.map(
    (c) =>
      `<li>${badge(c.status)}${esc(c.text)}${refsHtml(c.refs)}${
        c.contradictions.length > 0
          ? `<span class="refs">contradicted by: ${c.contradictions.map(ref).join(" · ")}</span>`
          : ""
      }</li>`
  );

  const risks = p.risks.map(
    (r) =>
      `<li>${badge(r.status)}(${r.severity}) ${esc(r.text)}${
        r.remediation ? `<p>remediation: ${esc(r.remediation)}</p>` : ""
      }${refsHtml(r.refs)}</li>`
  );

  const env = p.setup.env.map(
    (e) =>
      `<li><code>${esc(e.name)}</code> · ${
        e.documented ? "documented" : `<strong style="color:var(--data-neg)">NOT documented</strong>`
      }${refsHtml(e.refs)}</li>`
  );

  const steps = p.setup.steps.map(
    (s) => `<li>${badge(s.status)}<code>${esc(s.command)}</code>${refsHtml(s.refs)}</li>`
  );

  const checks = p.verification.results.map(
    (r) =>
      `<li>${badge(
        r.outcome === "passed" ? "locally-verified" : r.outcome === "skipped" ? "unresolved" : "contradicted"
      )}<code>${esc(r.checkId)}</code> · ${r.outcome}${
        r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ""
      } · ${r.durationMs}ms</li>`
  );

  const incomplete = p.incomplete.map((i) => `<li>${esc(i.title)}${refsHtml(i.refs)}</li>`);

  const decisions = p.decisions.map(
    (d) =>
      `<li>${badge(d.status)}${d.date ? `<span class="refs">${esc(d.date)}</span> ` : ""}${esc(
        d.title
      )}${d.rationale !== d.title ? `<p>${esc(d.rationale)}</p>` : ""}${refsHtml(d.refs)}</li>`
  );

  const modules = p.architecture.modules.map(
    (m) => `<li><code>${esc(m.path)}</code>${refsHtml(m.refs)}</li>`
  );

  const party = (who: { name: string; organisation?: string | undefined; date: string }) =>
    `${esc(who.name)}${who.organisation ? ` (${esc(who.organisation)})` : ""} · ${esc(who.date)}`;
  const acceptance = p.acceptance
    ? [
        `<li>${badge("creator-confirmed")}Delivered by: ${party(p.acceptance.deliveredBy)}</li>`,
        p.acceptance.acceptedBy
          ? `<li>${badge("creator-confirmed")}Accepted by: ${party(p.acceptance.acceptedBy)}</li>`
          : `<li>${badge("unresolved")}Not yet accepted.</li>`,
        ...(p.acceptance.acknowledgedFindings.length > 0
          ? [
              `<li>Findings acknowledged at acceptance: ${p.acceptance.acknowledgedFindings
                .map((id) => `<code>${esc(id)}</code>`)
                .join(" · ")}</li>`,
            ]
          : []),
      ]
    : [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Passport · ${esc(p.project.name)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="head">
<h1>Project passport · ${esc(p.project.name)}</h1>
<div class="meta">Mantyl ${esc(p.run.toolVersion)} · ${esc(p.run.timestamp)} · commit ${esc(
    p.run.commit ?? "none"
  )} · stack ${esc(p.project.stack.join(", "))}</div>
<div class="meta">passport digest ${esc(p.integrity.passportDigest ?? "unstamped")}</div>
</div>
${p.architecture.narrative ? `<h2>Architecture (inferred)</h2><div class="narrative">${esc(p.architecture.narrative.text)}</div>` : ""}
${section("Verification", checks, "No checks executed. Run mantyl verify before delivering.")}
${section("Modules", modules, "No modules recorded.")}
${section("Decisions", decisions, "No decisions recorded.")}
${section("Claims", claims, "No claims recorded.")}
${section("Risks &amp; unknowns", risks, "None recorded.")}
${section("Incomplete work", incomplete, "None recorded.")}
${section("Setup", steps, "No setup steps recorded.")}
${section("Environment", env, "No environment variables referenced.")}
${p.acceptance ? section("Acceptance", acceptance, "") : ""}
<footer><span>Generated with Mantyl</span><span>Evidence-backed · Not a certification</span></footer>
</main>
</body>
</html>
`;
}
