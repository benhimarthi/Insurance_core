# insurance-core

Generic AI underwriting assistant for insurers: rules engine, multilingual chat flow, document
verification, payment and policy PDF, plus the Firebase Cloud Functions layer that runs it on
WhatsApp and web chat. Demo-ready, with adapters to swap in an insurer's own systems.

The code is being organised as feature modules following clean architecture: see [ARCHITECTURE.md](ARCHITECTURE.md).

## Layout
| Path | Role |
|---|---|
| `src/rules`, `config/tenants/*` | Rules engine; all insurer logic is in the tenant JSON |
| `src/conversation` | Chat flow (fr / en / darija), question catalogue, messages |
| `src/documents`, `src/adapters/documentProcessor.js` | ID and registration checks, cross-checks |
| `src/policy`, `src/payment` | Quote to payment to policy PDF; webhook signature verification |
| `src/verification` | QR verification links: unguessable codes, public read-only view |
| `src/modules/auth` | Auth module (clean architecture): roles, permissions, invitations, member management, audit of access changes |
| `src/shared` | Shared kernel: errors, identifier formats, hashing helpers |
| `src/server` | Framework-agnostic handlers, Firestore repository, outbox, tenants |
| `src/channels`, `src/adapters` | WaSender, Gemini, storage, demo payment, policy numbering |
| `index.js` | Cloud Functions entry (thin HTTP adapter) |
| `dashboard/` | Dashboard login and tenant switcher (own `package.json` and tests, see its README) |

## Deploy the auth module alone
The `members` function needs no secrets and builds only the auth module, so access management can go live first:
1. Firebase project on the Blaze plan with Firestore and Authentication (email/password) enabled.
2. `.env.<project>`: `REQUIRE_MFA=false` until Identity Platform MFA is enabled (and relax `mfaOk()` in `firestore.rules`).
3. `firebase deploy --only functions:members,firestore`
4. Step 7 of the full deploy below (platform admin, first insurer admin).

## Run the tests
`npm install && npm test` (no Firebase project or emulator needed: a strict Firestore double is used).

## Deploy
1. `firebase use <project>`; enable Firestore, Storage, Cloud Functions (Blaze plan).
2. Secrets: `firebase functions:secrets:set WASENDER_API_KEY WASENDER_WEBHOOK_SECRET PAYMENT_WEBHOOK_SECRET PHONE_PEPPER GEMINI_API_KEY VERIFY_SECRET`
   (`PHONE_PEPPER` and `VERIFY_SECRET` are long random strings. Never change `PHONE_PEPPER` later or customers lose their active case. Changing `VERIFY_SECRET` invalidates every QR code already printed.)
3. Params (`.env.<project>` file): `FIRESTORE_DATABASE_ID`, `GEMINI_MODEL`, `DEMO_PAYMENTS=true`, `DEMO_PAY_BASE_URL=<demoPay URL>` and `VERIFY_BASE_URL=<verify URL>` (second deploy, once the URLs are known; without `VERIFY_BASE_URL` the PDF simply has no QR code).
4. `firebase deploy --only functions,firestore`
5. Seed a demo tenant: `npm run seed -- demo-insurer` (prints the web chat key).
6. In WaSender, set the webhook to `<whatsappWebhook URL>/demo-insurer` with your webhook secret.
7. People and roles (see "Authentication and roles" below): make yourself platform admin with
   `node scripts/grant-platform-role.js <uid> platform_admin`, create the insurer's first admin with
   `node scripts/add-member.js demo-insurer <uid> tenant_admin <email>`, then invite everyone else from the dashboard.
8. Firestore TTL: enable it on the `expireAt` field for collections `outbox` and `dedupe`.
9. Cloud Storage: the runtime service account needs "Service Account Token Creator" to sign URLs.

## Before real customer data
- Replace the demo payment adapter with the provider's (CMI, Stripe...) and per-tenant webhook secrets.
- Replace the Firestore policy admin with the insurer's system; keep idempotency on the case id.
- Set a retention policy for uploaded documents; turn on App Check for `underwriterDecision`.
- Verify the WaSender media download and document sending (marked UNVERIFIED in `src/channels/whatsapp.js`).
- Have a native speaker proofread the darija messages.

## QR verification
Each policy PDF carries a QR code (top right) and the printed link `{verify URL}/{tenantId}/{policyNumber}/{code}`.
- The `code` is an HMAC of tenant and policy number, so links cannot be guessed from sequential policy numbers.
- The page is public and read-only. It shows the insurer, policy number, **initials** of the holder, the plate,
  the plan and the period, with a state: valid, expired, not yet in force or cancelled (set `status: 'cancelled'`
  on the policy document to cancel). Never the full name, premium, contact details or documents.
- A wrong code, an unknown policy and a malformed link return the same "not found" page, and the code is checked
  before any database read. `?format=json` returns the same data for other systems, `?lang=en` switches language.
- It is a public endpoint: put Cloud Armor or a rate limit in front of it for production, and keep `maxInstances` low.

## Authentication and roles
Firebase Auth proves who someone is; the auth module (`src/modules/auth`) decides what they may do. Customers never sign in
(they are identified by WhatsApp number or web session); accounts are for staff only.

| Role | Scope | Can |
|---|---|---|
| `tenant_admin` | one insurer | manage people, see cases, policies and settings. Cannot decide cases |
| `underwriter` | one insurer | decide referred cases up to the insurer's premium limit |
| `underwriting_manager` | one insurer | underwriter + decisions above the limit + rules and tariff changes |
| `auditor` | one insurer | read-only, including the audit trail |
| `platform_admin` | all insurers (your team) | manage access and configuration. **No case access** |

- **One person, several insurers:** roles are per insurer, stored in `tenants/{t}/members/{uid}`, so a
  consultant can be underwriter at A and auditor at B. Platform roles are a custom claim set only by
  `scripts/grant-platform-role.js`.
- **Live checks:** every call reads the member document, so disabling or removing someone applies
  immediately (sessions are also revoked). Staff need a verified email and, by default, MFA
  (needs Identity Platform; for early demos set the `REQUIRE_MFA` param to `false` and relax `mfaOk()` in `firestore.rules`).
- **Invitations:** the only way to get a role. The token is returned once to the inviter, only its hash is
  stored, and only the signed-in owner of the invited, verified email can redeem it (7 days, single use).
  Sending the invitation email is up to you (for example the Firebase "Trigger Email" extension).
- **Guards:** nobody changes their own role, the last active `tenant_admin` cannot be removed, nobody can
  grant a role they may not grant, platform staff must give a `reason` on every action (stored in the audit trail).
- **Audit:** every access change is an append-only event in `tenants/{t}/authEvents`, and each case decision
  records the reviewer's role.
- **Callables:** `members` (`myTenants`, `list`, `invite`, `accept`, `revokeInvitation`, `changeRole`,
  `setStatus`, `remove`) and `underwriterDecision`.
- **Read access for the dashboard** comes from `firestore.rules`, which mirrors the role lists in `src/modules/auth/domain/roles.js`.
  The rules are not covered by the automated tests (they need the Firestore emulator): test them there before production.
