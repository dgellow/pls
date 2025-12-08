/**
 * Structured error with code for programmatic handling.
 *
 * Every error must answer: What happened? Why? How do I fix it?
 */
export class PlsError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PlsError';
  }
}
