'use strict';

/** Customer-facing messages. Never expose internal reasons, scores or AI proposals to the customer. */

const L = (fr, en, darija) => ({ fr, en, darija });

const MESSAGES = {
  intro: L(
    'Bonjour ! Je vais vous aider à obtenir une offre d’assurance auto. Quelques questions rapides :',
    'Hello! I will help you get a car insurance quote. A few quick questions:',
    'مرحبا! غادي نعاونك تاخد عرض ديال تأمين الطوموبيل. غير شي أسئلة قصار:'
  ),
  retry: L(
    'Désolé, je n’ai pas compris votre réponse.',
    'Sorry, I did not understand your answer.',
    'سمح ليا، ما فهمتش الجواب ديالك.'
  ),
  handoff: L(
    'Je vous mets en relation avec un conseiller qui va continuer avec vous.',
    'I am connecting you with an advisor who will continue with you.',
    'غادي نوصلك مع مستشار باش يكمل معاك.'
  ),
  review: L(
    'Merci ! Votre dossier est complet. Un souscripteur va le valider et nous revenons vers vous très vite.',
    'Thank you! Your file is complete. An underwriter will review it and we will get back to you shortly.',
    'شكرا! الملف ديالك كامل. واحد من المختصين غادي يراجعو وغادي نرجعو ليك قريب.'
  ),
  declined: L(
    'Merci pour vos informations. Nous ne pouvons malheureusement pas vous proposer de contrat en ligne. Un conseiller peut vous contacter.',
    'Thank you for your information. Unfortunately we cannot offer you a contract online. An advisor can contact you.',
    'شكرا على المعلومات. للأسف ما نقدروش نقترحو عليك عقد أونلاين. ممكن مستشار يتصل بيك.'
  ),
  confirmed: L(
    'Parfait ! Nous préparons votre contrat.',
    'Great! We are preparing your contract.',
    'مزيان! كنحضرو ليك العقد.'
  ),
  closed: L(
    'D’accord, n’hésitez pas à revenir quand vous voulez.',
    'Understood, feel free to come back any time.',
    'واخا، رجع وقت ما بغيتي.'
  ),
  quotedReprompt: L(
    'Souhaitez-vous continuer ? (oui/non)',
    'Would you like to continue? (yes/no)',
    'واش بغيتي تكمل؟ (إيه/لا)'
  ),
  waiting: L(
    'Votre dossier est en cours de traitement.',
    'Your file is being processed.',
    'الملف ديالك قيد المعالجة.'
  ),
  offTopic: L(
    'Je peux seulement vous aider pour votre assurance auto. Reprenons :',
    'I can only help with your car insurance. Let us continue:',
    'نقدر نعاونك غير فالتأمين ديال الطوموبيل. نكملو:'
  ),
};

const QUOTE = {
  fr: (total, cur) => `Bonne nouvelle ! Votre prime estimée est de ${total} ${cur}. Souhaitez-vous continuer ? (oui/non)`,
  en: (total, cur) => `Good news! Your estimated premium is ${total} ${cur}. Would you like to continue? (yes/no)`,
  darija: (total, cur) => `خبر زوين! الثمن التقريبي ديال التأمين هو ${total} ${cur}. واش بغيتي تكمل؟ (إيه/لا)`,
};

const JOIN = { fr: ' et ', en: ' and ', darija: ' و ' };
const join = (labels, lang) => labels.join(JOIN[lang] || JOIN.fr);

// Document stage. Functions take (lang, labels or label).
const DOC = {
  request: (lang, labels) => ({
    fr: `Merci ! Pour finaliser, envoyez-moi une photo de : ${join(labels, 'fr')}.`,
    en: `Thank you! To finish, please send me a photo of: ${join(labels, 'en')}.`,
    darija: `شكرا! باش نكملو، صيفط ليا تصويرة ديال: ${join(labels, 'darija')}.`,
  }[lang] || `Merci ! Pour finaliser, envoyez-moi une photo de : ${join(labels, 'fr')}.`),
  received: (lang, label) => ({
    fr: `Document reçu : ${label}.`,
    en: `Received: ${label}.`,
    darija: `توصلت ب: ${label}.`,
  }[lang] || `Document reçu : ${label}.`),
  remaining: (lang, labels) => ({
    fr: `Il me manque encore : ${join(labels, 'fr')}.`,
    en: `Still missing: ${join(labels, 'en')}.`,
    darija: `باقي خصني: ${join(labels, 'darija')}.`,
  }[lang] || `Il me manque encore : ${join(labels, 'fr')}.`),
  ILLEGIBLE: (lang, label) => ({
    fr: `La photo (${label}) n’est pas assez lisible. Pouvez-vous la renvoyer plus nette, bien éclairée et sans reflet ?`,
    en: `The photo (${label}) is not clear enough. Could you resend it sharper, well lit and without glare?`,
    darija: `التصويرة ديال (${label}) ماشي واضحة. ممكن تعاود تصيفطها واضحة وفيها الضو مزيان؟`,
  }[lang] || `La photo (${label}) n’est pas assez lisible. Pouvez-vous la renvoyer plus nette ?`),
  EXPIRED: (lang, label) => ({
    fr: `Ce document (${label}) semble expiré. Pouvez-vous envoyer un document en cours de validité ?`,
    en: `This document (${label}) appears to be expired. Could you send a valid one?`,
    darija: `هاد الوثيقة (${label}) باينة سالات الصلاحية. صيفط ليا وحدة صالحة.`,
  }[lang] || `Ce document (${label}) semble expiré. Pouvez-vous envoyer un document en cours de validité ?`),
  WRONG_TYPE: (lang, labels) => ({
    fr: `Je n’ai pas reconnu ce document. J’attends : ${join(labels, 'fr')}.`,
    en: `I did not recognise this document. I am expecting: ${join(labels, 'en')}.`,
    darija: `ما عرفتش هاد الوثيقة. كنتسنى: ${join(labels, 'darija')}.`,
  }[lang] || `Je n’ai pas reconnu ce document. J’attends : ${join(labels, 'fr')}.`),
};

const pick = (obj, lang) => obj[lang] || obj.fr;

// Payment and underwriter-decision messages.
const PAY = {
  link: (lang, url, amount, cur) => pick({
    fr: `Pour finaliser, réglez ${amount} ${cur} via ce lien sécurisé : ${url}`,
    en: `To finish, please pay ${amount} ${cur} using this secure link: ${url}`,
    darija: `باش نكملو، خلص ${amount} ${cur} من هاد الرابط الآمن: ${url}`,
  }, lang),
  received: (lang, num, start, end) => pick({
    fr: `Paiement reçu, merci ! Votre contrat ${num} est actif du ${start} au ${end}. Le document est en pièce jointe.`,
    en: `Payment received, thank you! Your policy ${num} is active from ${start} to ${end}. The document is attached.`,
    darija: `توصلنا بالخلاص، شكرا! العقد ديالك ${num} خدام من ${start} حتى ${end}. لقا الوثيقة فالمرفق.`,
  }, lang),
  failed: (lang, url) => pick({
    fr: `Le paiement n’a pas abouti. Vous pouvez réessayer avec le même lien : ${url}`,
    en: `The payment did not go through. You can try again with the same link: ${url}`,
    darija: `الخلاص ما نجحش. تقدر تعاود بنفس الرابط: ${url}`,
  }, lang),
  checking: (lang) => pick({
    fr: 'Nous avons bien reçu votre paiement et nous le vérifions. Un conseiller vous recontacte rapidement.',
    en: 'We received your payment and are verifying it. An advisor will contact you shortly.',
    darija: 'توصلنا بالخلاص وكنراجعوه. غادي يتصل بيك مستشار قريب.',
  }, lang),
  approved: (lang, total, cur) => pick({
    fr: `Bonne nouvelle, votre dossier est validé ! Votre prime est de ${total} ${cur}. Souhaitez-vous continuer ? (oui/non)`,
    en: `Good news, your file is approved! Your premium is ${total} ${cur}. Would you like to continue? (yes/no)`,
    darija: `خبر زوين، الملف ديالك تقبل! الثمن هو ${total} ${cur}. واش بغيتي تكمل؟ (إيه/لا)`,
  }, lang),
  rejected: (lang) => pick({
    fr: 'Après étude de votre dossier, nous ne pouvons malheureusement pas donner suite. Un conseiller peut vous contacter pour en discuter.',
    en: 'After reviewing your file, we unfortunately cannot proceed. An advisor can contact you to discuss it.',
    darija: 'من بعد دراسة الملف ديالك، للأسف ما قدرناش نكملو. ممكن مستشار يتصل بيك باش نهضرو.',
  }, lang),
  issued: (lang) => pick({
    fr: 'Votre contrat est actif. Pour toute question, un conseiller reste à votre disposition.',
    en: 'Your policy is active. For any question, an advisor is at your disposal.',
    darija: 'العقد ديالك خدام. إلا عندك شي سؤال، مستشار كاين باش يعاونك.',
  }, lang),
};

const t = (msg, lang) => msg[lang] || msg.fr;
const quoteMessage = (lang, total, currency) => (QUOTE[lang] || QUOTE.fr)(total, currency);

module.exports = { MESSAGES, DOC, PAY, t, quoteMessage };
