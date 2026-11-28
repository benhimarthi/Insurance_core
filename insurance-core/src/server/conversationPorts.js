'use strict';

const { evaluateCase } = require('../modules/underwriting');
const documents = require('../documents/documents');

/**
 * Plugs the rules engine (underwriting module) and the document checks (not yet a module) into the
 * ports the conversation module asks for; `payments` is the payment module's requestPayment, if any.
 * When documents becomes a module, its index.js provides that port and this file goes away.
 */
function legacyConversationPorts({ documentProcessor, payments = null }) {
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
    payments,
  };
}

module.exports = { legacyConversationPorts };
