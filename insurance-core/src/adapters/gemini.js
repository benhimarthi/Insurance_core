'use strict';

/**
 * Gemini over REST (no SDK). Plugs into the existing adapters:
 *   createLlmExtractor({ callModel: gemini.callText })
 *   createLlmDocumentProcessor({ callModel: gemini.callVision })
 * The model name is configurable because model names change: set GEMINI_MODEL.
 */
function createGemini({ apiKey, model = 'gemini-2.5-flash', fetchImpl = fetch, baseUrl = 'https://generativelanguage.googleapis.com/v1beta' }) {
  async function generate(parts) {
    const res = await fetchImpl(`${baseUrl}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) throw new Error(`Gemini request failed with HTTP ${res.status}`);
    const data = await res.json();
    const parts0 = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const text = (parts0 || []).map((p) => p.text || '').join('');
    if (!text) throw new Error('Gemini returned no text');
    return text;
  }

  return {
    callText: (prompt) => generate([{ text: prompt }]),
    callVision: ({ prompt, attachment }) => generate([
      { text: prompt },
      { inline_data: { mime_type: attachment.mimeType, data: Buffer.from(attachment.data).toString('base64') } },
    ]),
  };
}

module.exports = { createGemini };
