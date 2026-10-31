const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const STATE_DIR = path.join(os.homedir(), '.mydatabkt');
const ACCOUNT_FILE = path.join(STATE_DIR, 'account.json');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const RELAY_URL = process.env.OTN_RELAY_URL || 'wss://otn-relay.fly.dev';
const CONSENT_URL = process.env.OTN_CONSENT_URL || 'https://consent.opn.li';
const CONNECT_URL = process.env.OPNLI_CONNECT_URL || 'https://opn.li/connect';
const REGISTRY_URL = process.env.OTN_REGISTRY_URL || 'https://bktregistry.com';

let win = null;
let relay = null;

function ensureStateDir() { try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {} }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJson(f, obj) { ensureStateDir(); fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8'); }

function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 430, resizable: false, fullscreenable: false, title: 'MyDataBkt',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
}

function currentStatus() {
  const account = readJson(ACCOUNT_FILE);
  const config = readJson(CONFIG_FILE);
  return {
    activated: !!(account && account.member_id),
    email: account ? account.email : null,
    folder: config ? config.folder : null,
    bktAddress: config ? config.bkt_address : null,
    connected: !!(relay && relay.ws && relay.ws.readyState === 1)
  };
}
function pushStatus() { if (win) win.webContents.send('status', currentStatus()); }

function startActivation() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const memberId = u.searchParams.get('member_id') || u.searchParams.get('account_id');
    if (memberId) {
      writeJson(ACCOUNT_FILE, {
        account_id: u.searchParams.get('account_id') || memberId,
        member_id: memberId,
        entity_id: u.searchParams.get('entity_id') || '',
        email: u.searchParams.get('email') || '',
        access_token: u.searchParams.get('access_token') || '',
        refresh_token: u.searchParams.get('refresh_token') || '',
        anon_key: u.searchParams.get('anon_key') || '',
        activated: new Date().toISOString()
      });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:-apple-system;padding:40px;text-align:center"><h2>MyDataBkt activated</h2><p>You can close this tab and return to the app.</p></body></html>');
      setTimeout(() => { try { srv.close(); } catch (e) {} }, 500);
      if (win) { win.show(); win.focus(); }
      pushStatus();
    } else { res.writeHead(400); res.end('missing member_id'); }
  });
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    shell.openExternal(CONNECT_URL + '?callback=' + encodeURIComponent('http://127.0.0.1:' + port));
  });
}

async function registerBucket(account, bucketName) {
  const entityId = account.entity_id || account.member_id;
  try {
    const res = await fetch(REGISTRY_URL + '/api/public/v1/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: entityId, relay_endpoint: 'https://otn-relay.fly.dev', functions_endpoint: 'https://otn-relay.fly.dev/agent-authorize' })
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.bkt_prefix) return 'bkt://' + j.bkt_prefix + '/' + bucketName;
    console.warn('Bucket registration returned no prefix: ' + JSON.stringify(j));
    return null;
  } catch (e) { console.warn('Bucket registration error: ' + e.message); return null; }
}

function startAgent() {
  const account = readJson(ACCOUNT_FILE);
  const config = readJson(CONFIG_FILE);
  if (!account || !account.member_id || !config || !config.folder || !config.bkt_address) return;
  if (relay) { try { relay.disconnect(); } catch (e) {} relay = null; }
  const { RelayConnection, buildManifest } = require('./agent.cjs');
  const agentConfig = { folder: config.folder, relay: RELAY_URL, bktAddress: config.bkt_address, entityId: account.entity_id || account.member_id, consentUrl: CONSENT_URL, issuer: CONSENT_URL };
  relay = new RelayConnection(agentConfig, buildManifest(config.folder), config.folder);
  relay.connect();
  relay.startWatching();
  // Start at login: setLoginItemSettings works on Mac and Windows.
  // On Linux, create a .desktop autostart file instead.
  if (process.platform === 'linux') {
    try {
      const autostartDir = require('path').join(require('os').homedir(), '.config', 'autostart');
      require('fs').mkdirSync(autostartDir, { recursive: true });
      const desktop = '[Desktop Entry]\nType=Application\nName=MyDataBkt\nExec=' + process.execPath + '\nX-GNOME-Autostart-enabled=true\n';
      require('fs').writeFileSync(require('path').join(autostartDir, 'mydatabkt.desktop'), desktop);
    } catch (e) {}
  } else {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch (e) {}
  }
}

ipcMain.handle('get-status', () => currentStatus());
ipcMain.handle('sign-in', () => { startActivation(); return true; });
ipcMain.handle('pick-folder', async () => {
  const account = readJson(ACCOUNT_FILE);
  if (!account || !account.member_id) return { error: 'not activated' };
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  const folder = r.filePaths[0];
  const bucketName = path.basename(folder).replace(/[^a-zA-Z0-9_-]/g, '') || 'MyBucket';
  const bktAddress = (await registerBucket(account, bucketName)) || ('bkt://' + account.member_id.slice(0, 8) + '/' + bucketName);
  writeJson(CONFIG_FILE, { folder: folder, bkt_address: bktAddress, bucket_name: bucketName });
  startAgent();
  pushStatus();
  return { folder: folder, bktAddress: bktAddress };
});

app.whenReady().then(() => {
  ensureStateDir();
  createWindow();
  try { startAgent(); } catch (e) { console.error('startAgent failed: ' + e.message); }
  setInterval(pushStatus, 2000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { /* keep the bucket agent running in the background */ });
