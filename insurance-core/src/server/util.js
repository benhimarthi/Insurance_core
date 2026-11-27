'use strict';

const crypto = require('crypto');
const { AppError } = require('../shared/errors');
const { TENANT_ID_RE, ID_RE } = require('../shared/ids');
const { sha256, newId, safeEqual } = require('../shared/crypto');
const { stripUndefined } = require('../shared/firestore');

/** Stable pseudonymous customer id: raw phone numbers are never used as document ids. */
const customerKey = (pepper, contact) => crypto.createHmac('sha256', pepper).update(String(contact)).digest('hex').slice(0, 32);

// The shared helpers now live in src/shared; re-exported here for the modules not migrated yet.
module.exports = { TENANT_ID_RE, ID_RE, AppError, sha256, newId, customerKey, safeEqual, stripUndefined };
