/** UI texts (fr / en) and role labels. The role KEYS come from the server (src/auth/roles.js). */

export const ROLE_LABELS = {
  fr: { tenant_admin: 'Administrateur', underwriter: 'Souscripteur', underwriting_manager: 'Responsable souscription', auditor: 'Auditeur', platform_admin: 'Équipe plateforme' },
  en: { tenant_admin: 'Administrator', underwriter: 'Underwriter', underwriting_manager: 'Underwriting manager', auditor: 'Auditor', platform_admin: 'Platform team' },
};

export const TEXT = {
  fr: {
    loading: 'Chargement…',
    email: 'Adresse e-mail', password: 'Mot de passe', signIn: 'Se connecter', signUp: 'Créer un compte', forgot: 'Mot de passe oublié ?',
    signOut: 'Se déconnecter',
    inviteBanner: 'Vous avez une invitation. Connectez-vous (ou créez un compte) avec l’adresse e-mail invitée.',
    mfaTitle: 'Double authentification', mfaHelp: 'Saisissez le code à 6 chiffres de votre application d’authentification.', code: 'Code', confirm: 'Valider', cancel: 'Annuler',
    verifyTitle: 'Vérifiez votre e-mail', verifyHelp: 'Cliquez sur le lien envoyé à votre adresse, puis revenez ici.', resend: 'Renvoyer l’e-mail', verified: 'J’ai vérifié mon e-mail',
    enrollTitle: 'Activez la double authentification', enrollHelp: 'Ajoutez ce compte dans une application d’authentification (scan du QR code ou clé ci-dessous), puis saisissez le code affiché.', enrollStart: 'Commencer', secretKey: 'Clé secrète',
    insurer: 'Assureur', platformGroup: 'Accès équipe plateforme', yourGroup: 'Vos assureurs',
    noAccessTitle: 'Aucun accès pour le moment', noAccessHelp: 'Votre compte n’est rattaché à aucun assureur. Ouvrez le lien d’invitation reçu par e-mail ou contactez votre administrateur.',
    chooseTitle: 'Choisissez un assureur', retry: 'Réessayer', switching: 'Changer d’assureur',
    reasonTitle: 'Motif de l’action', reasonHelp: 'Vous agissez sur cet assureur avec un rôle équipe plateforme. Le motif est enregistré dans le journal d’audit.', reasonLabel: 'Motif',
  },
  en: {
    loading: 'Loading…',
    email: 'Email address', password: 'Password', signIn: 'Sign in', signUp: 'Create account', forgot: 'Forgot your password?',
    signOut: 'Sign out',
    inviteBanner: 'You have an invitation. Sign in (or create an account) with the invited email address.',
    mfaTitle: 'Two-factor authentication', mfaHelp: 'Enter the 6-digit code from your authenticator app.', code: 'Code', confirm: 'Confirm', cancel: 'Cancel',
    verifyTitle: 'Verify your email', verifyHelp: 'Click the link sent to your address, then come back here.', resend: 'Resend email', verified: 'I verified my email',
    enrollTitle: 'Turn on two-factor authentication', enrollHelp: 'Add this account to an authenticator app (scan the QR code or use the key below), then enter the code it shows.', enrollStart: 'Start', secretKey: 'Secret key',
    insurer: 'Insurer', platformGroup: 'Platform team access', yourGroup: 'Your insurers',
    noAccessTitle: 'No access yet', noAccessHelp: 'Your account is not linked to any insurer. Open the invitation link you received by email or contact your administrator.',
    chooseTitle: 'Choose an insurer', retry: 'Try again', switching: 'Switch insurer',
    reasonTitle: 'Reason for this action', reasonHelp: 'You are acting on this insurer with a platform team role. The reason is recorded in the audit trail.', reasonLabel: 'Reason',
  },
};

export const t = (lang) => TEXT[lang] || TEXT.fr;
export const roleLabel = (lang, role) => (ROLE_LABELS[lang] || ROLE_LABELS.fr)[role] || role;
