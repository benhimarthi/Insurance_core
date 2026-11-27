# Architecture

The backend is organised as **feature modules** following clean architecture. Each feature
(authentication, conversation, underwriting, payment, policies...) is a module under
`src/modules/<name>/`, and can be developed, tested and deployed on its own.

## Inside a module

```
src/modules/<name>/
  index.js          composition root + the module's ONLY public entry point
  domain/           business rules: entities, value objects, policies. Pure functions, no I/O
  application/      use cases (one per action) and ports.js (the interfaces they need)
  infrastructure/   implementations of the ports: Firestore, Firebase Auth, HTTP APIs, crypto
  interface/        delivery: translating requests (callables, webhooks) to use cases
```

**Dependency rule:** dependencies point inwards only.

| Layer | May depend on |
|---|---|
| `domain` | `domain`, `src/shared` |
| `application` | `application`, `domain`, `src/shared` |
| `infrastructure`, `interface` | anything inside the module, npm packages |
| `index.js` | everything in the module (it wires the layers) |

`domain` and `application` use no npm package and no Node built-in (`crypto`, `fs`...): anything
with side effects goes behind a port. Code outside a module imports it only through its `index.js`.
`test/architecture.test.js` enforces all of this, so `npm test` fails on a violation.

## SOLID, concretely
- **S**: one use case per file (`inviteMember`, `acceptInvitation`...), one adapter per port.
- **O**: a new action (`members` callable) is one entry in the controller's table; a new role is one entry in `domain/roles.js`.
- **L**: any implementation of a port can replace another (Firestore store in production, in-memory in tests).
- **I**: small ports: the auth module needs a `TenantDirectory` with two methods, not the whole tenants repository.
- **D**: use cases receive their ports as arguments; only `index.js` knows the concrete classes.

## Shared kernel
`src/shared/` holds what every module may use and that has no business meaning: `AppError`,
identifier formats, hashing helpers, `stripUndefined` for Firestore. Keep it small.

## Modules

| Module | Status | Contents |
|---|---|---|
| `auth` | **done** | roles, permissions, authorization, invitations, member management, access audit trail. Deployable alone (`members` function, no secrets) |
| `tenants` | planned | insurer settings and configuration loading (`src/server/tenants.js`) |
| `conversation` | planned | chat flow, questions, NLU, messages (`src/conversation`), WhatsApp and web chat channels |
| `underwriting` | planned | rules engine (`src/rules`), referrals and underwriter decisions |
| `documents` | planned | ID and registration checks (`src/documents`, document processor adapters) |
| `payment` | planned | payment links, webhook verification, demo checkout (`src/payment`, payment adapters) |
| `policy` | planned | issuance, numbering, PDF (`src/policy`, policy admin adapters) |
| `verification` | planned | public QR verification (`src/verification`) |

Until a feature is migrated, its code stays where it is and `src/server/app.js` keeps wiring it.
Migrate one module at a time, keeping the existing tests green.

## The auth module

```
src/modules/auth/
  index.js                          createAuthModule({ db, authAdmin, requireMfa, ... })
  domain/
    permissions.js, roles.js        the role matrix (firestore.rules mirrors it)
    identity.js                     who is calling, independent of Firebase
    member.js, invitation.js        entities and their rules
    accessPolicy.js                 authorization rules and guards (no escalation, last admin, MFA, reasons)
    auditEvent.js                   shape of an access-change audit record
  application/
    ports.js                        AuthStore, AuthUnitOfWork, TenantDirectory, SessionRevoker, TokenService, Clock
    useCases/                       authorize, inviteMember, revokeInvitation, acceptInvitation,
                                    manageMember (changeRole, setStatus, removeMember), queries, bootstrapMember
  infrastructure/
    firestoreAuthStore.js           members, invitations, audit events, transactions
    firestoreTenantDirectory.js     insurer names
    firebaseSessionRevoker.js       revokes refresh tokens
    cryptoTokenService.js           invitation tokens and hashes
  interface/
    firebaseIdentity.js             Firebase { uid, token } -> Identity (only place that knows Firebase claims)
    membersController.js            the `members` callable: { action, ... } -> use case
```

Public API (`require('./src/modules/auth')`): `createAuthModule`, `ROLES`, `PERMISSIONS`, `TENANT_ROLES`,
`can`, `isTenantRole`, `isPlatformRole`, `INVITE_TTL_MS`. Other modules use `authModule.authorize()`
(for example the underwriter decision checks `case:decide`).
