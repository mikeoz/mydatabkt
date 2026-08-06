const path = require('path');
const os = require('os');
const { RelayConnection, buildManifest } = require('./agent.cjs');

const folder = path.join(os.homedir(), 'opnli', 'mydatabkt', 'test-bucket');
const manifest = buildManifest(folder);
const fid = manifest[0].file_id;

const rc = new RelayConnection({ bktAddress: 'bkt://mike0z/MedBucket', consentUrl: 'https://consent.opn.li' }, manifest, folder);
const out = [];
rc.send = (o) => out.push(o);
function last() { return out[out.length - 1]; }
const future = new Date(Date.now() + 300000).toISOString();

(async () => {
  const decA = 'test-live-notrevoked-' + process.pid;
  rc._sessionTokens.set('tokA', { scope: { actions: ['read'], file_ids: null }, decision_id: decA, expires: future });
  await rc.handleFileRequest({ request_id: '1', session_token: 'tokA', file_id: fid });
  console.log('not-revoked (live status):', 'status=' + last().status, last().error ? '(' + last().error + ')' : '');

  const decB = 'test-revoked-' + process.pid;
  rc._sessionTokens.set('tokB', { scope: { actions: ['read'], file_ids: null }, decision_id: decB, expires: future });
  rc._revocationCache = new Map([[decB, { revoked: true, ts: Date.now() }]]);
  await rc.handleFileRequest({ request_id: '2', session_token: 'tokB', file_id: fid });
  console.log('revoked (refused):', 'status=' + last().status, last().error ? '(' + last().error + ')' : '');
  console.log('session dropped after revoke:', rc.validateToken('tokB') === null);

  process.exit(0);
})();
