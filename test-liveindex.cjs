const fs = require('fs');
const path = require('path');
const os = require('os');
const { RelayConnection, buildManifest } = require('./agent.cjs');

const folder = path.join(os.homedir(), 'opnli', 'mydatabkt', 'live-test');
fs.rmSync(folder, { recursive: true, force: true });
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'a.txt'), 'aaa');

const rc = new RelayConnection({ bktAddress: 'bkt://mike0z/MedBucket', entityId: 'x' }, buildManifest(folder), folder);
const pushes = [];
rc.send = (o) => { if (o && o.type === 'register') pushes.push(o.manifest.length); };
rc.startWatching();

const wait = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  console.log('initial manifest:', rc.manifest.length);
  fs.writeFileSync(path.join(folder, 'b.txt'), 'bbb');
  await wait(1800);
  console.log('after ADD    -> manifest:', rc.manifest.length, '| pushed:', JSON.stringify(pushes));
  fs.unlinkSync(path.join(folder, 'a.txt'));
  await wait(1800);
  console.log('after DELETE -> manifest:', rc.manifest.length, '| pushed:', JSON.stringify(pushes));
  rc.disconnect();
  fs.rmSync(folder, { recursive: true, force: true });
  process.exit(0);
})();
