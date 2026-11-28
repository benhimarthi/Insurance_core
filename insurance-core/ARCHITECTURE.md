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
`src/shared/` holds what every module may use: `AppError`, identifier formats, hashing helpers,
`stripUndefined` for Firestore, and `cases.js`, the case record every module shares (statuses, audit
events, the human-decision rule, the final premium). Keep it small.

## Ports between modules, before the other modules exist
The conversation module asks for `underwriting` (the rules engine), `documents` (document checks) and
`payments` through ports. Until those are modules, `src/server/conversationPorts.js` plugs the existing
code in; each future module will provide its port from its own `index.js`, and only the wiring changes.

## Modules

| Module | Status | Contents |
|---|---|---|
| `auth` | **done** | roles, permissions, authorization, invitations, member management, access audit trail. Deployable alone (`members` function, no secrets) |
| `tenants` | **done** | insurers (create, rename, demo flag, suspend, web chat key), rules JSON validated, versioned and restorable, tenant loader. Function `tenants`, no secrets |
| `conversation` | **done** (web chat) | the chat flow, questions, NLU, messages, AI extractor, receiving messages from any channel, web chat. Function `webchat` (secrets: `GEMINI_API_KEY`, `PHONE_PEPPER`). WhatsApp still in `src/server/app.js`, on top of the module |
| `underwriting` | **done** | rules engine, review queue, case view, document links, decisions within the premium limit, messages to the customer. Function `underwriting`, no secrets |
| `documents` | planned | ID and registration checks (`src/documents`, document processor adapters) |
| `payment` | **done** | payment links per insurer (demo checkout for demo insurers), signed provider webhooks, exact amount, idempotent; asks the policy module to issue. Functions `paymentWebhook`, `demoPay` (secret: `PAYMENT_WEBHOOK_SECRET`) |
| `policy` | **done** | who may be issued, policy draft from verified data, numbering (registry), PDF, storage. No function of its own: used by payment |
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

## The conversation module

```
src/modules/conversation/
  index.js                          createConversationModule({ extractor, underwriting, documents, payments?, store, uploads, tenants, pepper })
  domain/
    questions.js                    the question catalogue (fr / en / darija) and value validation
    messages.js                     customer-facing texts (payment and policy use PAY through index.js)
    nlu.js                          language detection, numbers, yes/no, choices, "I want a human"
    inbound.js                      upload limits and content check, web session format, when a case is finished
    limits.js                       abuse limits of the web chat (per session, IP, insurer)
    retention.js                    how long uploads and abandoned conversations are kept
    detour.js                       questions and off-topic messages: insurer knowledge (no prices), answer checks, cap
  application/
    ports.js                        Extractor, Assistant, Underwriting, Documents, Payments, CaseStore, Uploads, TenantLoader, CustomerIds, Delivery
    flow.js                         makeFlow(ports): the conversation state machine
    useCases/handleInbound.js       one message from any channel: dedupe, uploads, flow, one atomic commit, then delivery
    useCases/webChat.js             the web chat: key, session, abuse limits, collect queued replies
    useCases/cleanup.js             nightly data retention
  infrastructure/
    extractors.js                   LLM extractor (Gemini) and the offline rule-based one
    llmAssistant.js                 classifies a non-answer and answers questions from the insurer information
    hmacCustomerIds.js              pseudonymous customer ids (HMAC with PHONE_PEPPER)
    firestoreRateLimiter.js         fixed-window counters shared by all instances
  interface/
    webChatHttp.js                  App Check gate (off / monitor / enforce), error codes -> HTTP answers
```

The customer page is `web/chat.html` (`/chat/{tenantId}` on Firebase Hosting). It calls `/api/webchat/{tenantId}`,
which Hosting forwards to the `webchat` function (same origin, no CORS).

## The underwriting module

```
src/modules/underwriting/
  index.js                          createUnderwritingModule({ authorize, store, tenants, notifier, delivery?, files }), evaluateCase
  domain/
    engine.js                       the rules engine: eligibility, risk score, premium, referral (pure)
    decision.js                     decision input, premium limit (case:decide_high above it), unfinished conversations
    caseView.js                     what underwriters see: queue item, case detail, contact; never file paths
  application/
    ports.js                        Authorizer, CaseStore, TenantLoader, DecisionNotifier, Delivery, Files
    useCases/cases.js               listCases (waiting / recent), getCase, documentLink (5-minute link, audited)
    useCases/decide.js              decide, messageCustomer (one transaction with the audit event and the outbox)
  interface/
    underwritingController.js       the `underwriting` callable
```

## The payment and policy modules

```
src/modules/payment/
  index.js                          createPaymentModule({ store, tenants, gateways, demoGateway?, webhookSecret, policies, messages, delivery? })
  domain/payment.js                 payable statuses, exact amount, link reuse and expiry
  application/useCases/
    requestPayment.js               the conversation's Payments port: create or reuse the link (null: no provider)
    applyPaymentEvent.js            failed / wrong amount / succeeded -> policies.issue, confirmation + PDF
    webhook.js                      signature first, one transaction deduplicated on the event id, then delivery
    demoCheckout.js                 the demo page: GET shows the amount, POST signs the event and takes the same path
  infrastructure/                   webhookSignature (HMAC), demoGateway (Firestore), mockGateway, gatewaySelection
  interface/                        http.js (webhook and page answers), demoPayPage.js

src/modules/policy/
  index.js                          createPolicyModule({ registry, files, verifier? }) -> { issue, getPolicy }
  domain/policy.js                  isApprovedForIssuance, buildPolicyDraft, dates, premium parts
  application/useCases/issuePolicy.js   number (idempotent on the case), render the PDF, store it
  infrastructure/                   pdfRenderer (pdf-lib, QR code), firestorePolicyRegistry, memoryPolicyRegistry
```

Customer texts (PAY) and the decision notice (`announceDecision`) belong to the conversation module; the payment
module receives them as ports. Policies are stored under `tenants/{t}/policies/`, outside the `uploads/` retention.

## The tenants module

```
src/modules/tenants/
  index.js                          createTenantsModule({ db, authorize, configTemplate }), createTenantLoader
  domain/
    tenant.js                       insurer identity, statuses, policy-number prefix
    ruleConfig.js                   validateRuleConfig: what the engine, questions, documents, policy and PDF read
    conditions.js                   the engine's condition grammar (keep OPERATORS in sync with the engine)
    adminEvent.js                   audit record of changes to an insurer or its rules
  application/
    ports.js                        Authorizer (from the auth module), TenantStore, TenantUnitOfWork, KeyService, Clock
    useCases/tenants.js             getTenant, createTenant, updateTenant, setTenantStatus, rotateWebchatKey
    useCases/ruleConfig.js          getRuleConfig, checkRuleConfig, updateRuleConfig, list/get/restore versions
  infrastructure/
    firestoreTenantStore.js         tenants, configs, configMeta, configVersions, adminEvents, tenantSecrets
    tenantLoader.js                 what the chat, payment and policy code use (60 s cache)
    cryptoKeyService.js             web chat keys
  interface/
    tenantsController.js            the `tenants` callable: { action, tenantId, reason, ... }
```

Modules depend on each other through ports wired in the app's composition root (`index.js`): the tenants
module receives `authorize` from the auth module and never imports it. The auth module owns permissions
(`config:read`, `config:write`, `tenants:manage`).
