'use strict';

const { AppError } = require('../../../../shared/errors');
const { TENANT_ID_RE, ID_RE } = require('../../../../shared/ids');
const { ACTOR, newEvent } = require('../../../../shared/cases');
const { WAITING, queueItem, caseDetail, contactView } = require('../../domain/caseView');

const LIST_LIMIT = 100;
const EVENTS_LIMIT = 200;
const LINK_TTL_MS = 5 * 60 * 1000;

const requireIds = (tenantId, caseId) => {
  if (!TENANT_ID_RE.test(tenantId || '')) throw new AppError('invalid-argument', 'Invalid tenant.');
  if (caseId !== undefined && !ID_RE.test(caseId || '')) throw new AppError('invalid-argument', 'Invalid caseId.');
};

/** Reading cases: the review queue, one case in full, and its documents (case:read). */
function makeCaseQueries({ authorizer, store, files }) {
  /** view: 'waiting' (cases a person must look at) or 'recent' (every case, last updated first). */
  async function listCases({ caller, tenantId, view = 'waiting', reason }) {
    requireIds(tenantId);
    await authorizer.authorize({ caller, tenantId, permission: 'case:read', reason });
    if (!['waiting', 'recent'].includes(view)) throw new AppError('invalid-argument', 'view must be waiting or recent.');
    const lists = view === 'waiting'
      ? await Promise.all(WAITING.map((status) => store.listCases(tenantId, { status, limit: LIST_LIMIT })))
      : [await store.listCases(tenantId, { limit: LIST_LIMIT })];
    const cases = lists.flat().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, LIST_LIMIT);
    return { view, cases: cases.map(queueItem) };
  }

  async function getCase({ caller, tenantId, caseId, reason }) {
    requireIds(tenantId, caseId);
    await authorizer.authorize({ caller, tenantId, permission: 'case:read', reason });
    const c = await store.getCase(tenantId, caseId);
    if (!c) throw new AppError('not-found', 'CASE_NOT_FOUND');
    const [events, customer] = await Promise.all([
      store.listCaseEvents(tenantId, caseId, EVENTS_LIMIT),
      c.customerId ? store.getCustomer(tenantId, c.customerId) : null,
    ]);
    return caseDetail(c, { events, contact: contactView(customer) });
  }

  /** A 5-minute link to a document photo. Every opening is written to the case's audit trail. */
  async function documentLink({ caller, tenantId, caseId, docType, reason }) {
    requireIds(tenantId, caseId);
    const ctx = await authorizer.authorize({ caller, tenantId, permission: 'case:read', reason });
    const c = await store.getCase(tenantId, caseId);
    if (!c) throw new AppError('not-found', 'CASE_NOT_FOUND');
    const doc = c.documents && Object.prototype.hasOwnProperty.call(c.documents, docType) ? c.documents[docType] : null;
    if (!doc || !doc.source) throw new AppError('not-found', 'DOCUMENT_NOT_FOUND');
    if (!(await files.exists(doc.source))) throw new AppError('not-found', 'DOCUMENT_GONE'); // past the retention period
    await store.appendEvent(tenantId, caseId, newEvent({ type: 'document_viewed', actor: { kind: ACTOR.HUMAN, id: ctx.uid }, payload: { docType, role: ctx.role } }));
    return { url: await files.getSignedUrl(doc.source, LINK_TTL_MS), expiresInSec: LINK_TTL_MS / 1000 };
  }

  return { listCases, getCase, documentLink };
}

module.exports = { makeCaseQueries };
