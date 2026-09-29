/**
 * Milestone 4.2 Step 2 Correction — domain error model, mirroring
 * `packages/brain/src/errors.ts`'s own `BrainError` shape (message + a
 * stable, machine-readable code) exactly, so a caller can
 * `instanceof`-check instead of string-comparing.
 */
export class AiAgentsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export class AgentRunValidationError extends AiAgentsError {
  constructor(message: string) {
    super(message, "agent_run_validation_error");
    this.name = "AgentRunValidationError";
  }
}
