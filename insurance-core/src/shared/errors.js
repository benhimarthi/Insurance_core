'use strict';

/**
 * Error with a code that maps 1:1 to Firebase HttpsError codes:
 * 'unauthenticated' | 'invalid-argument' | 'permission-denied' | 'not-found' | 'failed-precondition' | ...
 * Messages in UPPER_SNAKE_CASE are stable codes the front end reacts to.
 * `details` (optional, JSON-safe) reaches the client as HttpsError details, e.g. validation errors.
 */
class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { AppError };
