/**
 * MyDataBkt Agent — Consent Proof Verification (Step 2/3; agent side of GAP-L1-45)
 * Verifies the EdDSA-signed proof from the Consent Server (/v1/pubkey) BEFORE
 * the agent mints a session token. Fail closed. Built-in crypto + fetch only.
 */
const crypto = require('crypto');
const _pubkeys = new Map(); // kid -> KeyObject

function b64urlToBuf(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function b64urlToJson(s) { return JSON.parse(b64urlToBuf(s).toString('utf8')); }

async function fetchPubkeys(consentUrl) {
  const url = String(consentUrl).replace(/\/$/, '') + '/v1/pubkey';
  const res = await fetch(url);
  if (!res.ok) throw new Error('pubkey fetch failed: HTTP ' + res.status);
  const info = await res.json();
  if (info.pem && info.kid) { try { _pubkeys.set(info.kid, crypto.createPublicKey(info.pem)); } catch (e) {} }
  for (const jwk of (info.keys || [])) {
    if (jwk && jwk.kid) { try { _pubkeys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch (e) {} }
  }
  return _pubkeys.size;
}

async function getKey(kid, consentUrl) {
  if (kid && _pubkeys.has(kid)) return _pubkeys.get(kid);
  await fetchPubkeys(consentUrl);
  return kid ? (_pubkeys.get(kid) || null) : null;
}

async function verifyProof(jwt, opts) {
  const { bktAddress, issuer, consentUrl } = opts || {};
  if (!jwt || typeof jwt !== 'string') return { valid: false, reason: 'no proof present' };
  const parts = jwt.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed proof' };
  let header, payload;
  try { header = b64urlToJson(parts[0]); payload = b64urlToJson(parts[1]); }
  catch (e) { return { valid: false, reason: 'undecodable proof' }; }
  if (header.alg !== 'EdDSA') return { valid: false, reason: 'unexpected alg: ' + header.alg };
  let key;
  try { key = await getKey(header.kid, consentUrl); }
  catch (e) { return { valid: false, reason: 'cannot load signing key: ' + e.message }; }
  if (!key) return { valid: false, reason: 'unknown signing key: ' + header.kid };
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, b64urlToBuf(parts[2])); }
  catch (e) { return { valid: false, reason: 'signature check error: ' + e.message }; }
  if (!ok) return { valid: false, reason: 'bad signature' };
  const now = Math.floor(Date.now() / 1000);
  if (issuer && payload.iss !== issuer) return { valid: false, reason: 'wrong issuer' };
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { valid: false, reason: 'expired or no expiry' };
  if (!payload.otn || payload.otn.allowed !== true) return { valid: false, reason: 'decision not allowed' };
  if (bktAddress && payload.aud !== bktAddress) return { valid: false, reason: 'proof is for a different bucket: ' + payload.aud };
  return { valid: true, claims: payload };
}

module.exports = { verifyProof, fetchPubkeys };
