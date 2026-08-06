const path = require('path');
const os = require('os');
const { RelayConnection, buildManifest } = require('./agent.cjs');

const folder = path.join(os.homedir(), 'opnli', 'mydatabkt', 'test-bucket');
const manifest = buildManifest(folder);
const fid = manifest[0].file_id;
const otherFid = 'ffffffffffffffff';

const rc = new RelayConnection({ bktAddress: 'bkt://mike0z/MedBucket' }, manifest, folder);
const out = [];
rc.send = (o) => out.push(o);
const future = new Date(Date.now() + 300000).toISOString();
rc._sessionTokens.set('tok-bucket', { scope: { actions: ['read'], file_ids: null }, expires: future });
rc._sessionTokens.set('tok-fileA',  { scope: { actions: ['read'], file_ids: [fid] }, expires: future });
rc._sessionTokens.set('tok-write',  { scope: { actions: ['write'], file_ids: null }, expires: future });

function last() { return out[out.length - 1]; }
function show(label) { const r = last(); console.log(label.padEnd(34), 'status=' + r.status, r.error ? ('(' + r.error + ')') : ''); }

(async () => {
  rc.handleManifestRequest({ request_id: '1', session_token: 'tok-bucket' }); show('manifest, read scope');
  rc.handleManifestRequest({ request_id: '2', session_token: 'tok-write' });  show('manifest, no-read scope');
  await rc.handleFileRequest({ request_id: '3', session_token: 'tok-fileA', file_id: fid });      show('file IN file-scope');
  await rc.handleFileRequest({ request_id: '4', session_token: 'tok-fileA', file_id: otherFid }); show('file OUTSIDE file-scope');
  await rc.handleFileRequest({ request_id: '5', session_token: 'tok-bucket', file_id: fid });     show('file, bucket scope');
})();
