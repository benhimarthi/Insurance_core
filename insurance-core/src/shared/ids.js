'use strict';

/** Identifier formats shared by every module. */
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

module.exports = { TENANT_ID_RE, ID_RE };
