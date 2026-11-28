'use strict';

const { evaluateCase } = require('../modules/underwriting');
const documents = require('../documents/documents');
const { requestPayment } = require('../policy/lifecycle');

/**
 * Plugs the code not yet split into modules (rules engine, documents, payment) into the ports the
 * conversation module asks for. When underwriting, documents and payment become modules, their
 * index.js provides these and this file goes away.
 */
function legacyConversationPorts({ documentProcessor, paymentAdapter = null }) {
  return {
    underwriting: { evaluate: evaluateCase },
    documents: {
      requiredTypes: documents.requiredTypes,
      missingTypes: documents.missingTypes,
      labelOf: documents.labelOf,
      accept: documents.acceptDocument,
      crossCheck: documents.crossCheck,
      process: (args) => documentProcessor.process(args),
    },
    payments: paymentAdapter ? { requestPayment: (args) => requestPayment({ ...args, paymentAdapter }) } : null,
  };
}

module.exports = { legacyConversationPorts };
