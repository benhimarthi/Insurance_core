'use strict';

/**
 * Error with a code that maps 1:1 to Firebase HttpsError codes:
 * 'unauthenticated' | 'invalid-argument' | 'permission-denied' | 'not-found' | 'failed-precondition' | ...
 * Messages in UPPER_SNAKE_CASE are stable codes the front end reacts to.
 */
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = { AppError };
