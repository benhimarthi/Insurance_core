// Texts of the web app's own pages (the login and switcher texts live in the dashboard package).
export const TEXTS = {
  fr: {
    nav: { cases: 'Dossiers', members: 'Membres', settings: 'Assureur et règles', platform: 'Plateforme' },
    common: { save: 'Enregistrer', cancel: 'Annuler', note: 'Motif du changement (enregistré dans l’historique)', notePh: 'Ex. : nouveau tarif au 1er janvier', loading: 'Chargement…', copy: 'Copier', close: 'Fermer' },
    settings: {
      title: 'Assureur', status: { active: 'actif', suspended: 'suspendu' }, demo: 'démo', id: 'Identifiant',
      notFound: 'Cet assureur n’a pas encore de fiche ni de règles enregistrées.', notFoundPlatform: 'Créez-le depuis l’onglet Plateforme avec le même identifiant : les membres existants le garderont.',
      notFoundOther: 'Demandez à l’équipe plateforme de le créer.',
      manage: 'Gestion (équipe plateforme)', name: 'Nom affiché', isDemo: 'Assureur de démonstration (paiement fictif, chat sans clé)',
      saveInfo: 'Enregistrer', suspend: 'Suspendre', reactivate: 'Réactiver', rotate: 'Nouvelle clé de chat web',
      suspendConfirm: 'Suspendre cet assureur ? Le chat, les paiements et la vérification ne répondront plus.',
      keyShown: 'Clé de chat web (affichée une seule fois, à transmettre à l’intégrateur) :',
    },
    rules: {
      title: 'Règles (assurance auto)', revision: 'Révision', never: 'jamais enregistrées', by: 'par',
      readOnly: 'Lecture seule : votre rôle ne permet pas de modifier les règles.',
      format: 'Mettre en forme', check: 'Vérifier', reset: 'Annuler mes modifications', saveAs: (n) => `Enregistrer comme révision ${n}`,
      valid: 'Règles valides.', invalidTitle: (n) => `${n} problème${n > 1 ? 's' : ''} à corriger :`,
      jsonError: (l, c, m) => `JSON invalide ligne ${l}, colonne ${c} : ${m}`,
      changed: (n) => `Quelqu’un a enregistré la révision ${n} pendant votre modification. Copiez vos changements si besoin, puis rechargez.`,
      reload: 'Recharger la dernière version', saved: (n) => `Révision ${n} enregistrée. Elle s’applique aux nouveaux échanges sous une minute.`,
      unsaved: 'Modifications non enregistrées', leave: 'Vous avez des modifications non enregistrées. Quitter quand même ?',
      history: 'Historique', view: 'Voir', restore: 'Restaurer', restored: (n) => `restaurée depuis la révision ${n}`,
      viewing: (n) => `Révision ${n} (lecture seule)`, restoreNote: 'Motif de la restauration', current: 'actuelle', noHistory: 'Aucune révision enregistrée pour l’instant.',
    },
    platform: {
      title: 'Créer un assureur', id: 'Identifiant (minuscules, chiffres, tirets ; définitif)', name: 'Nom affiché', demo: 'Assureur de démonstration',
      create: 'Créer', created: (id) => `Assureur « ${id} » créé avec des règles de départ (révision 1).`, keyShown: 'Clé de chat web (affichée une seule fois) :',
      help: 'Les règles de départ sont un modèle à adapter ensuite dans « Assureur et règles ». Ajoutez ensuite le premier administrateur de l’assureur.',
    },
    errors: {
      CONFIG_INVALID: 'Les règles contiennent des erreurs.', CONFIG_CHANGED: 'Les règles ont changé entre-temps.',
      TENANT_EXISTS: 'Un assureur avec cet identifiant existe déjà.', TENANT_NOT_FOUND: 'Assureur introuvable.', VERSION_NOT_FOUND: 'Révision introuvable.',
      REASON_REQUIRED: 'Indiquez un motif (5 caractères minimum).', 'Invalid tenant.': 'Identifiant invalide : 3 à 40 caractères, minuscules, chiffres et tirets.',
      'Invalid name.': 'Nom invalide (2 à 100 caractères).',
    },
  },
  en: {
    nav: { cases: 'Cases', members: 'Members', settings: 'Insurer and rules', platform: 'Platform' },
    common: { save: 'Save', cancel: 'Cancel', note: 'Reason for the change (kept in the history)', notePh: 'E.g. new tariff from January 1', loading: 'Loading…', copy: 'Copy', close: 'Close' },
    settings: {
      title: 'Insurer', status: { active: 'active', suspended: 'suspended' }, demo: 'demo', id: 'Identifier',
      notFound: 'This insurer has no settings or saved rules yet.', notFoundPlatform: 'Create it from the Platform tab with the same identifier: existing members keep their access.',
      notFoundOther: 'Ask the platform team to create it.',
      manage: 'Management (platform team)', name: 'Display name', isDemo: 'Demo insurer (fake payment, keyless web chat)',
      saveInfo: 'Save', suspend: 'Suspend', reactivate: 'Reactivate', rotate: 'New web chat key',
      suspendConfirm: 'Suspend this insurer? Chat, payments and verification will stop answering.',
      keyShown: 'Web chat key (shown once, give it to the integrator):',
    },
    rules: {
      title: 'Rules (motor insurance)', revision: 'Revision', never: 'never saved', by: 'by',
      readOnly: 'Read only: your role cannot change the rules.',
      format: 'Format', check: 'Check', reset: 'Discard my changes', saveAs: (n) => `Save as revision ${n}`,
      valid: 'The rules are valid.', invalidTitle: (n) => `${n} problem${n > 1 ? 's' : ''} to fix:`,
      jsonError: (l, c, m) => `Invalid JSON at line ${l}, column ${c}: ${m}`,
      changed: (n) => `Someone saved revision ${n} while you were editing. Copy your changes if needed, then reload.`,
      reload: 'Reload the latest version', saved: (n) => `Revision ${n} saved. New conversations use it within a minute.`,
      unsaved: 'Unsaved changes', leave: 'You have unsaved changes. Leave anyway?',
      history: 'History', view: 'View', restore: 'Restore', restored: (n) => `restored from revision ${n}`,
      viewing: (n) => `Revision ${n} (read only)`, restoreNote: 'Reason for restoring', current: 'current', noHistory: 'No saved revision yet.',
    },
    platform: {
      title: 'Create an insurer', id: 'Identifier (lowercase, digits, hyphens; permanent)', name: 'Display name', demo: 'Demo insurer',
      create: 'Create', created: (id) => `Insurer "${id}" created with starting rules (revision 1).`, keyShown: 'Web chat key (shown once):',
      help: 'The starting rules are a template to adapt in "Insurer and rules". Then add the insurer’s first administrator.',
    },
    errors: {
      CONFIG_INVALID: 'The rules contain errors.', CONFIG_CHANGED: 'The rules changed in the meantime.',
      TENANT_EXISTS: 'An insurer with this identifier already exists.', TENANT_NOT_FOUND: 'Insurer not found.', VERSION_NOT_FOUND: 'Revision not found.',
      REASON_REQUIRED: 'Give a reason (at least 5 characters).', 'Invalid tenant.': 'Invalid identifier: 3 to 40 characters, lowercase, digits and hyphens.',
      'Invalid name.': 'Invalid name (2 to 100 characters).',
    },
  },
};

export const texts = (lang) => TEXTS[lang] || TEXTS.fr;
