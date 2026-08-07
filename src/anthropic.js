'use strict';
// A minimal Anthropic Messages API client over Node's built-in fetch.
// Tower's dependency budget is one (node-pty); the official SDK would be a
// second for what amounts to a single POST endpoint. The user brings their
// own key; nothing else is ever sent anywhere.

// The env override exists for tests (point at a local mock); it is not a
// supported way to send transcripts anywhere other than Anthropic.
const API_URL = (process.env.TOWER_ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const API_VERSION = '2023-06-01';

// Resolves with the parsed response body; rejects with err.status set for
// HTTP errors so callers can tell an invalid key (401) from a flaky network.
async function createMessage({ apiKey, model, maxTokens, system, messages, timeoutMs = 30000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages,
      }),
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? `request timed out after ${timeoutMs}ms` : `network error: ${e.message}`);
    err.status = 0; // no HTTP response at all
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = await res.json(); } catch { /* leave null */ }
  if (!res.ok) {
    const detail = body && body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return body;
}

function extractText(response) {
  if (!response || !Array.isArray(response.content)) return '';
  return response.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
}

// 401/403 mean the key itself is bad; anything else is "could not verify".
async function verifyKey(apiKey, model) {
  try {
    await createMessage({
      apiKey,
      model,
      maxTokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
      timeoutMs: 15000,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, status: e.status || 0, message: e.message, invalidKey: e.status === 401 || e.status === 403 };
  }
}

module.exports = { createMessage, extractText, verifyKey };
