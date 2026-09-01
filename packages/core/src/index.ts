/**
 * @mantyl/core — workflows and domain services.
 * Owns the canonical data flow (architecture spec §5); collectors, verifiers
 * and renderers plug into it through typed interfaces.
 */

export { ExitCode } from "./exit-codes.js";
export type { ExitCodeValue } from "./exit-codes.js";
export { createRunContext } from "./run-context.js";
export type { RunContext, RunContextOptions } from "./run-context.js";
export { initProject } from "./init.js";
export type { InitResult } from "./init.js";
export { detectSecrets, redactText } from "./redaction.js";
export type { SecretFinding, RedactionResult } from "./redaction.js";
export { scanProject } from "./scan.js";
export type { ScanResult, ScanOptions, SessionSummary } from "./scan.js";
export { detectCapabilities } from "./capabilities.js";
export type { Capabilities } from "./capabilities.js";
export { extractFacts } from "./facts.js";
export type { Fact } from "./facts.js";
export { claimsFromSessions, claimsFromReadme } from "./claims.js";
export type { ClaimCandidate } from "./claims.js";
export { verifyProject } from "./verify.js";
export type { VerifyResult, VerifyOptions } from "./verify.js";
export { decisionsFromSessions } from "./decisions.js";
export type { DecisionCandidate } from "./decisions.js";
export { reconcileProject } from "./reconcile.js";
export type { ReconcileProjectResult } from "./reconcile.js";
export {
  analyzeProject,
  buildAnalysisInput,
  providerFromConfig,
  AnthropicAnalysisProvider,
  AnalysisOutputSchema,
  DEFAULT_ANALYSIS_MODEL,
} from "./analysis.js";
export type {
  AnalysisInput,
  AnalysisOutput,
  AnalysisProvider,
  ProjectAnalysis,
} from "./analysis.js";
export { generateProject } from "./generate.js";
export type { GenerateResult } from "./generate.js";
export { receiveProject } from "./receive.js";

export { openFindings, prepareAccept, recordAcceptance } from "./accept.js";
export type { ReceiveReport, ReceiveOptions, CheckComparison } from "./receive.js";
export { buildFileManifest, diffManifests } from "./manifest.js";
export { packProject, extractBundle, PackError } from "./pack.js";
export type { PackedBundle } from "./pack.js";
export { preparePublish, publishPassport, PassportInvalidError } from "./publish.js";
export type { PreparedPublish, PublishResult } from "./publish.js";
export type { FileManifest } from "./manifest.js";
