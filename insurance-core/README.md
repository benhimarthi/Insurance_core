# insurance-core

Generic AI underwriting assistant for insurers: rules engine, multilingual chat flow, document
verification, payment and policy PDF, plus the Firebase Cloud Functions layer that runs it on
WhatsApp and web chat. Demo-ready, with adapters to swap in an insurer's own systems.

The code is being organised as feature modules following clean architecture: see [ARCHITECTURE.md](ARCHITECTURE.md).

For building the user interfaces, see the [frontend blueprint](docs/frontend-blueprint.pdf): every screen, its states, the calls it makes, the roles and the error codes, with diagrams and screenshots.

## Layout
| Path | Role |
|---|---|
| `src/rules`, `config/tenants/*` | Rules engine; all insurer logic is in the tenant JSON |
| `src/conversation` | Chat flow (fr / en / darija), question catalogue, messages |
| `src/documents`, `src/adapters/documentProcessor.js` | ID and registration checks, cross-checks |
| `src/policy`, `src/payment` | Quote to payment to policy PDF; webhook signature verification |
| `src/verification` | QR verification links: unguessable codes, public read-only view |
| `src/modules/auth` | Auth module (clean architecture): roles, permissions, invitations, member management, audit of access changes |
| `src/modules/conversation` | Conversation module: chat flow, questions, AI extractor, receiving messages, web chat (`webchat` function) |
| `src/modules/underwriting` | Underwriting module: rules engine, review queue, cases, decisions, messages to customers (`underwriting` function) |
| `src/modules/payment`, `src/modules/policy` | Payment links, provider webhooks, demo checkout; policy issuance, numbering, PDF |
| `src/modules/tenants` | Tenants module: insurers (create, rename, suspend), their rules JSON (validated, versioned, restorable), the tenant loader |
| `src/shared` | Shared kernel: errors, identifier formats, hashing helpers |
| `src/server` | Framework-agnostic handlers, Firestore repository, outbox (not yet split into modules) |
| `src/channels`, `src/adapters` | WaSender, Gemini, storage, demo payment, policy numbering |
| `index.js` | Cloud Functions entry (thin HTTP adapter) |
| `dashboard/` | Dashboard login and tenant switcher (own `package.json` and tests, see its README) |
| `web/` | On Firebase Hosting: the staff web app (`/`) and the customer chat page (`/chat/{tenantId}`) |

## Deploy module by module
Firebase project: `my-super-manager-app` (`.firebaserc`). `ENABLED_MODULES` in `.env.my-super-manager-app`
selects which modules' functions exist: today `auth` (`members`) and `tenants` (`tenants`), neither needs
secrets. The GitHub Actions workflow `.github/workflows/deploy.yml` runs all tests, then deploys those
functions, the Firestore rules and indexes, and the staff web app (`web/`) to Firebase Hosting. It runs on
every push to `main` that touches `insurance-core/`, or by hand (Actions tab > Deploy > Run workflow).
If a deploy stopped halfway (for example a schedule was not created), run it by hand and put the function names in
"Functions to redeploy" (e.g. `conversationCleanup`): the CLI skips unchanged functions unless they are named.

MFA is **off** for this first deploy (`REQUIRE_MFA=false` in `.env.my-super-manager-app`,
`VITE_REQUIRE_MFA=false` in `web/.env`, `mfaOk()` returns true in `firestore.rules`). Turn it back on in
all three places, after enabling Identity Platform and TOTP, before any real customer data.

One-time setup:
1. Firebase console: Blaze plan; **Firestore** database `(default)` (region `eur3` or `europe-west1`);
   **Authentication** > Sign-in method > **Email/Password** enabled.
2. As project owner, enable these APIs once (Google Cloud console > APIs & Services > Library): Cloud Functions,
   Cloud Build, Artifact Registry, Cloud Run Admin, Eventarc, Pub/Sub, Firebase Hosting, Firebase Extensions,
   Secret Manager, Cloud Resource Manager, Cloud Billing. The deploy account
   cannot enable APIs itself (unless you also give it Service Usage Admin).
3. Google Cloud console > IAM > Service accounts: create `github-deployer` with the roles
   **Firebase Admin**, **Cloud Functions Admin**, **Service Account User** and **Service Usage Consumer**,
   then Keys > Add key > JSON.
4. GitHub repo > Settings > Secrets and variables > Actions: add `FIREBASE_SERVICE_ACCOUNT` with the whole JSON
   file as value, then delete the file from your computer.
5. Run the workflow. The web app is then at `https://my-super-manager-app.web.app`.

First people:
1. Firebase console > Authentication > Add user (your email). Sign in on the web app and verify your email.
2. Make yourself the first admin of an insurer (needs a key with Firestore access, for example the one above,
   kept locally only for this):
   `GOOGLE_APPLICATION_CREDENTIALS=key.json node scripts/add-member.js demo-insurer <your uid> tenant_admin <email>`
   (and/or `node scripts/grant-platform-role.js <uid> platform_admin` for your team).
3. Everyone else: invite them from the web app; they open the link, create their account and join.

## Insurers and their rules (tenants module)
Each insurer has a rules JSON per line (today `motor`): questions, eligibility, risk, tariff, documents, policy,
payment, branding. In the web app, **Insurer and rules** shows it two ways, editing the same draft:
- **Form**: the values changed day to day (prices, fees, multipliers, risk points and thresholds, eligibility
  outcomes and messages, city zones, documents, policy, payment, limits, branding); conditions are shown in plain
  language, and errors appear under their field.
- **JSON**: everything, including adding rules and changing conditions.
Then:
- **Check** runs the same validator as a save; errors are listed by path (`risk.referAt`, ...).
- **Save** needs a reason and creates a new revision; a save based on an outdated revision is refused, so two
  people cannot overwrite each other. New conversations use the new rules within a minute (60 s cache).
- **History** lists every revision (who, when, why); any revision can be viewed and restored (as a new revision).
- Who: everyone with `config:read` can read; `underwriting_manager` and the platform team can change.
- The **Platform** page (platform team only) creates insurers from a starting template; the settings page also
  lets them rename, flag as demo, suspend/reactivate and issue a new web chat key (shown once).
Insurers created before versioning (for example with `npm run seed`) start at revision 0.

## Web chat (conversation module)
Customers chat at `https://my-super-manager-app.web.app/chat/{tenantId}` (for example `/chat/demo-insurer`):
questions, documents, then a quote or a referral to an underwriter. Real insurers need their web chat key
(`?key=...`, from "Insurer and rules" > Management); demo insurers are open. On a demo insurer, `?demo=1`
adds a "Demo documents" button (sample ID and registration, no real files needed).
Without the payment module, an accepted quote ends with "we are preparing your contract": the insurer follows up.

When a message is not an answer, the assistant (Gemini) steps in before the flow asks its step again:
- **a question** about the insurance (coverages, documents, process): answered from the insurer's own information
  only (`insurerKnowledge` in `domain/detour.js`: name, coverages and guarantees, documents, duration, process; never
  prices). Answers containing an amount with a currency are refused, links are removed, length is capped;
- **off topic**: a polite redirect;
- **unclear**: re-asked as before; after 3 tries an advisor takes over;
- **human**: the customer asks to talk to a person: handed to an advisor. Decided on the intent, not on words
  ("can another person drive?" is a question). Always honoured, even past the detour cap. If the assistant fails,
  the words decide again (fallback), so a request for an advisor is never lost.
At most 5 detours in a row. Works during the questions, the documents and the quote. The audit trail records
`customer_question` with the kind and the step, never the text.

One-time setup before deploying it (`ENABLED_MODULES` contains `conversation`):
1. Gemini API key: https://aistudio.google.com/apikey (same Google account), then in Cloud Shell:
   `firebase functions:secrets:set GEMINI_API_KEY --project my-super-manager-app`
2. Pepper for pseudonymous customer ids (never change it later):
   `openssl rand -hex 32 | firebase functions:secrets:set PHONE_PEPPER --data-file=- --project my-super-manager-app`
3. Firebase console > Storage > Get started (the bucket that keeps customer documents).
4. IAM: give the `github-deployer` service account the **Secret Manager Admin** role (the deploy lets the
   function read its two secrets).
5. `GEMINI_MODEL` in `.env.my-super-manager-app` picks the model; change it there if Google retires it.
6. Google Cloud console > APIs & Services: enable **Cloud Scheduler** (the nightly data-retention job), and
   give `github-deployer` the **Cloud Scheduler Admin** role if the deploy asks for it.
7. Firestore > TTL: add a policy on field `expireAt` for collection group `rateLimits` (as for `outbox` and `dedupe`).

### Web chat security
- **Abuse limits** (`src/modules/conversation/domain/limits.js`), counted in Firestore across all instances:
  per session 20 messages/minute and 300/day, per IP 60/minute and 1,500/day, per insurer 5,000/day (the hard
  cost ceiling); polls 40/minute per session. Over the limit: HTTP 429 with `Retry-After`, before any AI call.
  IPs and sessions are pseudonymized (HMAC with `PHONE_PEPPER`) before they are counted.
- **App Check**: Firebase console > App Check > register the web app with **reCAPTCHA Enterprise**, put the site key
  in `web/.env` (`VITE_RECAPTCHA_SITE_KEY`), deploy with `WEBCHAT_APP_CHECK=monitor`, check the logs for
  "App Check token" warnings, then switch to `enforce`.
- **Origins**: browsers may call the web chat only from `https://<project>.web.app` and `.firebaseapp.com`.
- **Uploads**: at most 3 files of 5 MB, JPEG/PNG/WebP/PDF, checked by their content (not the declared type), kept only
  while documents are expected, under `uploads/`.
- **Retention** (`domain/retention.js`, job `conversationCleanup` every night): uploads deleted after 90 days;
  conversations abandoned before a quote or a referral deleted after 30 days with their events and customer record.
  Cases that reached a quote, a human or a policy are kept.
- **Duplicates** are detected per customer and message id.
- **The chat page** forgets a conversation untouched for 24 hours (shared computers); Hosting sends a
  Content-Security-Policy, `X-Frame-Options: DENY` and a Permissions-Policy.
- **Gemini and personal data**: use a **paid** Gemini API key (or Vertex AI) before real customers: on the free tier,
  Google may use the content (ID cards included) to improve its products. Check your CNDP (law 09-08) obligations.

## Underwriting (review queue)
In the web app, **Dossiers** lists the cases waiting for a person (referred by the rules, an advisor asked, a stuck
conversation) and recent cases. A case shows the customer's validated answers, the rules' recommendation with score,
reasons and premium breakdown, the documents with their checks, the contact and the audit trail.
- **Read** (`case:read`): every insurer role except the platform team. Opening a document photo gives a 5-minute link
  and writes `document_viewed` to the case's audit trail; photos are gone after the 90-day retention.
- **Decide** (`case:decide`): approve the proposed premium, approve another premium (above the insurer's
  `underwriterPremiumLimit`, only `underwriting_manager`), or reject. The customer is told in their chat. A
  conversation that stopped before the rules ran can only be rejected, or answered with a message.
- **Write to the customer** (`case:decide`): the message appears in their conversation (audit: length only).
- Opening photos needs the functions' service account (`<project-number>-compute@developer.gserviceaccount.com`) to
  hold **Service Account Token Creator** on itself (signed links).
- `tenant_admin` sees cases but does not decide (separation of duties): decisions need an underwriter role.

## Payment and policy
After "oui", demo insurers get a link to the **demo checkout** (`https://<project>.web.app/pay/...`, no money moves):
"Payer" signs the event a real provider would send and goes through the same webhook path. The amount must be exactly
the one asked; the policy is then numbered (`POL-<prefix>-<year>-<seq>`), its PDF stored under `tenants/{t}/policies/`
and sent in the chat (a 15-minute link). A redelivered or repeated payment never issues a second policy. Real insurers
have no provider yet: their customers get "we are preparing your contract".

One-time setup (`ENABLED_MODULES` contains `payment`):
1. The webhook secret, in Cloud Shell:
   `openssl rand -hex 32 | firebase functions:secrets:set PAYMENT_WEBHOOK_SECRET --data-file=- --project my-super-manager-app`
2. The policy PDF link (and "Voir la photo") need **Service Account Token Creator** for
   `<project-number>-compute@developer.gserviceaccount.com`.
3. `DEMO_PAYMENTS=true` and `DEMO_PAY_BASE_URL=https://<project>.web.app/pay` are in `.env.<project>`.
A real provider (CMI, Stripe...) is a PaymentGateway adapter in `src/modules/payment/infrastructure`, selected per
insurer in `gatewaySelection.js`, with its webhook pointed at the `paymentWebhook` function.

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
8. Firestore TTL: enable it on the `expireAt` field for collections `outbox`, `dedupe` and `rateLimits`.
9. Cloud Storage: the runtime service account needs "Service Account Token Creator" to sign URLs.

## Before real customer data
- Replace the demo payment adapter with the provider's (CMI, Stripe...) and per-tenant webhook secrets.
- Replace the Firestore policy admin with the insurer's system; keep idempotency on the case id.
- Set a retention policy for uploaded documents; turn on App Check for `underwriterDecision`.
- Verify the WaSender media download and document sending (marked UNVERIFIED in `src/channels/whatsapp.js`).
- Have a native speaker proofread the darija messages.

## QR verification (verification module)
Each policy PDF carries a QR code (top right) and the printed link `https://<project>.web.app/v/{tenantId}/{policyNumber}/{code}`
(`VERIFY_BASE_URL`; Hosting forwards `/v/**` to the `verify` function). One-time setup:
`openssl rand -hex 32 | firebase functions:secrets:set VERIFY_SECRET --data-file=- --project my-super-manager-app`
(never change it later: every printed QR code would stop working). Policies issued before verification was on have no QR code.
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
