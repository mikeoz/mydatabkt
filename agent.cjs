#!/usr/bin/env node
/**
 * Local Bucket Agent — OTN Build 15-B (Task C-1, updated)
 *
 * A file-serving agent that runs on the NHB's machine. It:
 *   1. Indexes a designated folder into a manifest (filename, size, type).
 *   2. Connects outbound to the OTN relay service via WebSocket.
 *   3. Serves files when the relay routes an authorized request.
 *   4. Extracts text from PDFs on the NHB's machine before sending,
 *      so the agent receives readable text (not opaque bytes).
 *
 * Usage:
 *   node local-bkt-agent.js --folder ~/Desktop/MyRecords --relay wss://otn-relay.fly.dev
 *
 * Shape note: this script becomes the core of the downloadable "MyDataBkt" app.
 */

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const verify = require('./verify.cjs');

let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  console.warn('Warning: pdf-parse not installed. PDF text extraction disabled. Run: npm install pdf-parse');
}

// --- Config from CLI args or environment ---
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    folder: null,
    relay: process.env.OTN_RELAY_URL || 'wss://otn-relay.fly.dev',
    bktAddress: process.env.OTN_BKT_ADDRESS || 'bkt://mike0z/MedBucket',
    entityId: process.env.OTN_ENTITY_ID || 'e5eff3ee-63d0-415d-9103-f8900fb40d58',
    consentUrl: process.env.OTN_CONSENT_URL || 'https://consent.opn.li',
    issuer: process.env.OTN_CONSENT_ISSUER || 'https://consent.opn.li',
  };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--folder' || args[i] === '-f') && args[i + 1]) config.folder = args[++i];
    else if ((args[i] === '--relay' || args[i] === '-r') && args[i + 1]) config.relay = args[++i];
    else if ((args[i] === '--bkt' || args[i] === '-b') && args[i + 1]) config.bktAddress = args[++i];
    else if (args[i] === '--entity-id' && args[i + 1]) config.entityId = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: node local-bkt-agent.js --folder <path> [--relay <wss://...>] [--bkt <bkt://...>]');
      process.exit(0);
    }
  }
  if (!config.folder) { console.error('Error: --folder is required.'); process.exit(1); }
  if (config.folder.startsWith('~')) config.folder = path.join(require('os').homedir(), config.folder.slice(1));
  return config;
}

// --- Manifest: recursive index of the designated folder ---
const DOTFILE_RE = /(?:^|[\/])(?:\.[^/\\])/;
const MAX_MANIFEST_FILES = 5000;

function isDotfile(name) {
  return name.startsWith('.') || name.startsWith('._');
}

function buildManifest(folderPath) {
  if (!fs.existsSync(folderPath)) { console.error('Error: folder not found: ' + folderPath); process.exit(1); }
  const manifest = [];
  const mimeTypes = { '.pdf':'application/pdf', '.csv':'text/csv', '.json':'application/json', '.txt':'text/plain', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.doc':'application/msword', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls':'application/vnd.ms-excel', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.md':'text/markdown', '.html':'text/html', '.htm':'text/html', '.mov':'video/quicktime', '.mp4':'video/mp4', '.zip':'application/zip' };

  function walk(dir, rel) {
    var entries;
    try { entries = fs.readdirSync(dir); } catch (e) { console.warn('Cannot read ' + dir + ': ' + e.message); return; }
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i];
      if (isDotfile(name)) continue;
      var fullPath = path.join(dir, name);
      var relPath = rel ? rel + '/' + name : name;
      var stat;
      try { stat = fs.statSync(fullPath); } catch (e) { continue; }
      if (stat.isDirectory()) { walk(fullPath, relPath); continue; }
      if (!stat.isFile()) continue;
      if (manifest.length >= MAX_MANIFEST_FILES) return;
      manifest.push({
        file_id: crypto.createHash('sha256').update(relPath).digest('hex').slice(0, 16),
        filename: relPath,
        size_bytes: stat.size,
        mime_type: mimeTypes[path.extname(name).toLowerCase()] || 'application/octet-stream',
        modified: stat.mtime.toISOString(),
      });
    }
  }

  walk(folderPath, '');
  if (manifest.length >= MAX_MANIFEST_FILES) {
    console.warn('Manifest capped at ' + MAX_MANIFEST_FILES + ' files. Some files may not appear.');
  }
  return manifest;
}

// --- PDF text extraction (runs on NHB's machine) ---
async function extractPdfText(filePath) {
  if (!pdfParse) return null;
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text || null;
  } catch (err) {
    console.error('PDF text extraction failed for ' + filePath + ': ' + err.message);
    return null;
  }
}

// --- Relay connection: outbound WebSocket ---
class RelayConnection {
  constructor(config, manifest, folderPath) {
    this.config = config;
    this.manifest = manifest;
    this.folderPath = folderPath;
    this.ws = null;
    this.reconnectDelay = 2000;
    this.maxReconnectDelay = 30000;
    this.shouldReconnect = true;
    this._sessionTokens = new Map();
  }

  connect() {
    console.log('Connecting to relay: ' + this.config.relay);
    this.ws = new WebSocket(this.config.relay, {
      headers: { 'x-bkt-address': this.config.bktAddress, 'x-entity-id': this.config.entityId },
    });
    this.ws.on('open', () => {
      console.log('Connected to relay.');
      this.reconnectDelay = 2000;
      this.send({ type: 'register', bkt_address: this.config.bktAddress, entity_id: this.config.entityId, manifest: this.manifest });
    });
    this.ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { console.error('Invalid message from relay'); return; }
      this.handleMessage(msg);
    });
    this.ws.on('close', (code, reason) => {
      console.log('Relay connection closed: ' + code + ' ' + reason);
      if (this.shouldReconnect) this.scheduleReconnect();
    });
    this.ws.on('error', (err) => { console.error('Relay error: ' + err.message); });
  }

  send(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }

  scheduleReconnect() {
    console.log('Reconnecting in ' + (this.reconnectDelay / 1000) + 's...');
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'registered': console.log('Registered with relay as ' + (msg.bkt_address || this.config.bktAddress)); break;
      case 'agent-authorize': this.handleAuthorize(msg); break;
      case 'manifest-request': this.handleManifestRequest(msg); break;
      case 'file-request': this.handleFileRequest(msg); break;
      case 'ping': this.send({ type: 'pong', request_id: msg.request_id }); break;
      case 'error': console.error('Relay error: ' + msg.message); break;
      default: console.log('Unknown message type: ' + msg.type);
    }
  }

  async handleAuthorize(msg) {
    const { request_id, consent_proof, card_set } = msg;
    const proofJwt = consent_proof && consent_proof.proof;
    const vr = await verify.verifyProof(proofJwt, {
      bktAddress: this.config.bktAddress,
      issuer: this.config.issuer,
      consentUrl: this.config.consentUrl,
    });
    if (!vr.valid) {
      console.log('REFUSED authorize: ' + vr.reason);
      this.send({ type: 'agent-authorize-response', request_id, error: 'Consent proof rejected: ' + vr.reason, status: 403 });
      return;
    }
    const claims = vr.claims;
    const scope = (claims.otn && claims.otn.scope) || { actions: ['read'], file_ids: null };
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(claims.exp * 1000).toISOString();
    this._sessionTokens.set(sessionToken, {
      decision_id: claims.jti,
      audit_hash: claims.otn && claims.otn.audit_hash,
      bkt_address: claims.aud,
      scope: scope,
      card_set: card_set,
      created: new Date().toISOString(),
      expires: expiresAt,
    });
    console.log('Authorized (verified proof): decision=' + claims.jti + ', token=' + sessionToken.slice(0, 8) + '..., expires=' + expiresAt);
    this.send({ type: 'agent-authorize-response', request_id, session_token: sessionToken, expires_at: expiresAt, allowed_ops: scope.actions || ['read'], status: 200 });
  }

  async handleManifestRequest(msg) {
    const { request_id, session_token } = msg;
    const session = this.validateToken(session_token);
    if (!session) { this.send({ type: 'manifest-response', request_id, error: 'Invalid or expired token', status: 403 }); return; }
    const actions = (session.scope && session.scope.actions) || [];
    if (!actions.includes('read')) { this.send({ type: 'manifest-response', request_id, error: 'Scope does not permit read', status: 403 }); return; }
    if (await this.checkRevoked(session.decision_id)) { this._sessionTokens.delete(session_token); this.send({ type: 'manifest-response', request_id, error: 'Consent revoked', status: 403 }); return; }
    console.log('Serving manifest: ' + this.manifest.length + ' files');
    this.send({ type: 'manifest-response', request_id, manifest: this.manifest, bkt_address: this.config.bktAddress, status: 200 });
  }

  async handleFileRequest(msg) {
    const { request_id, session_token, file_id } = msg;
    const session = this.validateToken(session_token);
    if (!session) { this.send({ type: 'file-response', request_id, error: 'Invalid or expired token', status: 403 }); return; }
    const actions = (session.scope && session.scope.actions) || [];
    if (!actions.includes('read')) { this.send({ type: 'file-response', request_id, error: 'Scope does not permit read', status: 403 }); return; }
    const scopedFiles = session.scope && session.scope.file_ids;
    if (Array.isArray(scopedFiles) && !scopedFiles.includes(file_id)) { this.send({ type: 'file-response', request_id, error: 'File not in authorized scope', status: 403 }); return; }
    if (await this.checkRevoked(session.decision_id)) { this._sessionTokens.delete(session_token); this.send({ type: 'file-response', request_id, error: 'Consent revoked', status: 403 }); return; }
    const entry = this.manifest.find(f => f.file_id === file_id);
    if (!entry) { this.send({ type: 'file-response', request_id, error: 'File not found', status: 404 }); return; }
    try {
      const fullPath = path.join(this.folderPath, entry.filename);
      const content = fs.readFileSync(fullPath);

      // Extract text from PDFs on the NHB's machine
      let contentText = null;
      if (entry.mime_type === 'application/pdf') {
        contentText = await extractPdfText(fullPath);
        if (contentText) {
          console.log('Serving file: ' + entry.filename + ' (' + entry.size_bytes + ' bytes, text extracted: ' + contentText.length + ' chars)');
        } else {
          console.log('Serving file: ' + entry.filename + ' (' + entry.size_bytes + ' bytes, text extraction failed — sending base64)');
        }
      } else {
        console.log('Serving file: ' + entry.filename + ' (' + entry.size_bytes + ' bytes)');
      }

      const response = {
        type: 'file-response',
        request_id,
        file_id,
        filename: entry.filename,
        mime_type: entry.mime_type,
        size_bytes: entry.size_bytes,
        status: 200,
      };

      // Send extracted text if available; always include base64 as fallback
      if (contentText) {
        response.content_text = contentText;
      }
      response.content_base64 = content.toString('base64');

      this.send(response);
    } catch (err) {
      console.error('Error reading file: ' + err.message);
      this.send({ type: 'file-response', request_id, error: 'File read error', status: 500 });
    }
  }

  validateToken(token) {
    const session = this._sessionTokens.get(token);
    if (!session) return null;
    if (new Date(session.expires) < new Date()) { this._sessionTokens.delete(token); return null; }
    return session;
  }

  async checkRevoked(decisionId) {
    if (!decisionId) return false;
    const now = Date.now();
    if (!this._revocationCache) this._revocationCache = new Map();
    const cached = this._revocationCache.get(decisionId);
    if (cached && (now - cached.ts) < 5000) return cached.revoked;
    try {
      let base = this.config.consentUrl;
      if (base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
      const res = await fetch(base + '/v1/decision-status/' + encodeURIComponent(decisionId));
      if (!res.ok) return false;
      const j = await res.json();
      const rv = j.revoked === true;
      this._revocationCache.set(decisionId, { revoked: rv, ts: now });
      return rv;
    } catch (e) { return false; }
  }

  reindex() {
    try {
      this.manifest = buildManifest(this.folderPath);
      this.send({ type: 'register', bkt_address: this.config.bktAddress, entity_id: this.config.entityId, manifest: this.manifest });
      console.log('Re-indexed: ' + this.manifest.length + ' files; pushed updated manifest to relay.');
    } catch (e) { console.error('Reindex failed: ' + e.message); }
  }

  startWatching() {
    try {
      const self = this;
      this._watcher = fs.watch(this.folderPath, { persistent: true, recursive: true }, function (eventType, filename) {
        if (filename && isDotfile(path.basename(filename))) return;
        if (self._reindexTimer) clearTimeout(self._reindexTimer);
        self._reindexTimer = setTimeout(function () { self.reindex(); }, 600);
      });
      console.log('Watching folder recursively for changes (live index active).');
    } catch (e) {
      console.warn('Folder watch unavailable; live index disabled: ' + e.message);
    }
  }

  disconnect() { this.shouldReconnect = false; if (this._watcher) this._watcher.close(); if (this.ws) this.ws.close(); }
}

// --- Main ---
function main() {
  const config = parseArgs();
  console.log('=== OTN Local Bucket Agent ===');
  console.log('Folder:  ' + config.folder);
  console.log('Relay:   ' + config.relay);
  console.log('Bucket:  ' + config.bktAddress);
  console.log('PDF text extraction: ' + (pdfParse ? 'enabled' : 'DISABLED (install pdf-parse)'));
  console.log('');
  const manifest = buildManifest(config.folder);
  console.log('Indexed ' + manifest.length + ' files:');
  for (const f of manifest) console.log('  ' + f.filename + ' (' + (f.size_bytes / 1024).toFixed(1) + ' KB, ' + f.mime_type + ')');
  console.log('');
  verify.fetchPubkeys(config.consentUrl)
    .then(function (n) { console.log('Loaded ' + n + ' consent verification key(s) from ' + config.consentUrl); })
    .catch(function (e) { console.warn('Could not preload consent key (will retry on demand): ' + e.message); });
  const relay = new RelayConnection(config, manifest, config.folder);
  relay.connect();
  relay.startWatching();
  process.on('SIGINT', () => { console.log('\nShutting down...'); relay.disconnect(); process.exit(0); });
  process.on('SIGTERM', () => { relay.disconnect(); process.exit(0); });
}

module.exports = { RelayConnection, buildManifest, parseArgs };
if (require.main === module) main();
