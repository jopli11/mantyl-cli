/** Stable CLI exit codes — part of the public contract from day one. */
export const ExitCode = {
  Ok: 0,
  GenericError: 1,
  InvalidConfig: 2,
  NotAProject: 3,
  VerificationFailed: 4,
  SandboxUnavailable: 5,
  PassportInvalid: 6,
  ReceiveDivergence: 7,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
