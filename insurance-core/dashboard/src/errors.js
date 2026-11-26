/**
 * Error handling shared by the whole dashboard layer.
 * Server errors (callables) carry a stable reason in `message`: EMAIL_NOT_VERIFIED, MFA_REQUIRED,
 * FORBIDDEN, REASON_REQUIRED, INVITATION_INVALID, LAST_ADMIN, CANNOT_CHANGE_SELF, LIMIT_EXCEEDED...
 * Firebase Auth errors carry `auth/...` codes. Both are turned into one ApiError the UI can show.
 */

export const MESSAGES = {
  fr: {
    EMAIL_NOT_VERIFIED: 'Vérifiez d’abord votre adresse e-mail.',
    MFA_REQUIRED: 'La double authentification est requise. Reconnectez-vous avec votre code.',
    FORBIDDEN: 'Vous n’avez pas accès à cette action.',
    REASON_REQUIRED: 'Indiquez le motif de cette action (5 caractères minimum).',
    REASON_CANCELLED: 'Action annulée : aucun motif indiqué.',
    INVITATION_INVALID: 'Cette invitation est invalide, expirée ou déjà utilisée.',
    LAST_ADMIN: 'Impossible : il doit rester au moins un administrateur actif.',
    CANNOT_CHANGE_SELF: 'Vous ne pouvez pas modifier votre propre accès.',
    ROLE_NOT_GRANTABLE: 'Vous ne pouvez pas attribuer ce rôle.',
    ROLE_NOT_MANAGEABLE: 'Vous ne pouvez pas gérer cet utilisateur.',
    LIMIT_EXCEEDED: 'Ce montant dépasse votre limite : un responsable souscription doit décider.',
    'auth/invalid-credential': 'E-mail ou mot de passe incorrect.',
    'auth/wrong-password': 'E-mail ou mot de passe incorrect.',
    'auth/user-not-found': 'E-mail ou mot de passe incorrect.',
    'auth/invalid-email': 'Adresse e-mail invalide.',
    'auth/too-many-requests': 'Trop de tentatives. Réessayez dans quelques minutes.',
    'auth/user-disabled': 'Ce compte est désactivé.',
    'auth/network-request-failed': 'Problème de connexion réseau. Réessayez.',
    'auth/invalid-verification-code': 'Code incorrect.',
    'auth/code-expired': 'Code expiré : saisissez le code actuel de votre application.',
    'auth/email-already-in-use': 'Un compte existe déjà avec cet e-mail : connectez-vous.',
    'auth/weak-password': 'Mot de passe trop faible (8 caractères minimum).',
    'auth/requires-recent-login': 'Par sécurité, reconnectez-vous puis réessayez.',
    unauthenticated: 'Votre session a expiré. Reconnectez-vous.',
    unavailable: 'Service momentanément indisponible. Réessayez.',
    default: 'Une erreur est survenue. Réessayez.',
  },
  en: {
    EMAIL_NOT_VERIFIED: 'Please verify your email address first.',
    MFA_REQUIRED: 'Two-factor authentication is required. Sign in again with your code.',
    FORBIDDEN: 'You do not have access to this action.',
    REASON_REQUIRED: 'Give a reason for this action (at least 5 characters).',
    REASON_CANCELLED: 'Action cancelled: no reason given.',
    INVITATION_INVALID: 'This invitation is invalid, expired or already used.',
    LAST_ADMIN: 'Not possible: at least one active administrator must remain.',
    CANNOT_CHANGE_SELF: 'You cannot change your own access.',
    ROLE_NOT_GRANTABLE: 'You cannot assign this role.',
    ROLE_NOT_MANAGEABLE: 'You cannot manage this user.',
    LIMIT_EXCEEDED: 'This amount is above your limit: an underwriting manager must decide.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/user-not-found': 'Incorrect email or password.',
    'auth/invalid-email': 'Invalid email address.',
    'auth/too-many-requests': 'Too many attempts. Try again in a few minutes.',
    'auth/user-disabled': 'This account is disabled.',
    'auth/network-request-failed': 'Network problem. Try again.',
    'auth/invalid-verification-code': 'Incorrect code.',
    'auth/code-expired': 'Code expired: enter the current code from your app.',
    'auth/email-already-in-use': 'An account already exists with this email: sign in.',
    'auth/weak-password': 'Password too weak (at least 8 characters).',
    'auth/requires-recent-login': 'For security, sign in again and retry.',
    unauthenticated: 'Your session has expired. Sign in again.',
    unavailable: 'Service temporarily unavailable. Try again.',
    default: 'Something went wrong. Try again.',
  },
};

const ACTIONS = {
  EMAIL_NOT_VERIFIED: 'verify_email',
  MFA_REQUIRED: 'sign_in_again',
  unauthenticated: 'sign_in_again',
  INVITATION_INVALID: 'check_invitation',
  FORBIDDEN: 'contact_admin',
  'auth/requires-recent-login': 'sign_in_again',
};

const RETRYABLE = new Set(['unavailable', 'auth/network-request-failed', 'internal', 'deadline-exceeded']);

export class ApiError extends Error {
  constructor({ code, reason, message, retryable = false, action = null }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;       // permission-denied, failed-precondition, auth/invalid-credential, ...
    this.reason = reason;   // stable key used to pick the message (EMAIL_NOT_VERIFIED, ...)
    this.retryable = retryable;
    this.action = action;   // verify_email | sign_in_again | check_invitation | contact_admin | null
  }
}

/** Turns anything thrown by Firebase Auth, a callable or our own code into an ApiError. */
export function normalizeError(err, lang = 'fr') {
  if (err instanceof ApiError) return err;
  const rawCode = String((err && err.code) || '').replace(/^functions\//, '');
  const table = MESSAGES[lang] || MESSAGES.fr;
  const serverReason = err && typeof err.message === 'string' && table[err.message] ? err.message : null;
  const reason = serverReason || (table[rawCode] ? rawCode : 'default');
  return new ApiError({
    code: rawCode || 'unknown',
    reason,
    message: table[reason],
    retryable: RETRYABLE.has(rawCode),
    action: ACTIONS[reason] || null,
  });
}

export const describeError = (err, lang = 'fr') => normalizeError(err, lang).message;

export const NOTICES = {
  fr: {
    mfa_enrolled: 'Double authentification activée. Reconnectez-vous pour l’utiliser.',
    mfa_missing: 'Reconnectez-vous avec votre code de double authentification.',
    idle_timeout: 'Vous avez été déconnecté après une période d’inactivité.',
    signed_out: 'Vous êtes déconnecté.',
    password_reset: 'Si un compte existe avec cet e-mail, un lien de réinitialisation vient d’être envoyé.',
    verification_sent: 'E-mail de vérification envoyé.',
  },
  en: {
    mfa_enrolled: 'Two-factor authentication enabled. Sign in again to use it.',
    mfa_missing: 'Sign in again with your two-factor code.',
    idle_timeout: 'You were signed out after a period of inactivity.',
    signed_out: 'You are signed out.',
    password_reset: 'If an account exists for this email, a reset link has just been sent.',
    verification_sent: 'Verification email sent.',
  },
};

/** Message for an ApiError in the language being displayed (the reason key is language-neutral). */
export function errorText(err, lang = 'fr') {
  const table = MESSAGES[lang] || MESSAGES.fr;
  return (err && table[err.reason]) || table.default;
}
