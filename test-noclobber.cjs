const WebSocket = require('ws');
const RELAY = 'wss://otn-relay.fly.dev';
const ADDR = 'bkt://test/noclobber-' + process.pid;

function connect(tag) {
  return new Promise((resolve) => {
    const ws = new WebSocket(RELAY, { headers: { 'x-bkt-address': ADDR, 'x-entity-id': tag } });
    const st = { tag, registered: false, error: null, ws };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', bkt_address: ADDR, entity_id: tag, manifest: [] })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'registered') { st.registered = true; resolve(st); }
      if (m.type === 'error') { st.error = m.message; resolve(st); }
    });
    ws.on('error', (e) => { st.error = 'wserr:' + e.message; resolve(st); });
    setTimeout(() => resolve(st), 4000);
  });
}

(async () => {
  const a1 = await connect('agent-1');
  console.log('agent-1: registered=' + a1.registered + (a1.error ? ' error=' + a1.error : ''));
  const a2 = await connect('agent-2');
  console.log('agent-2: registered=' + a2.registered + (a2.error ? ' error=' + a2.error : ''));
  console.log('agent-1 still open after 2nd tried: ' + (a1.ws.readyState === WebSocket.OPEN));
  try { a1.ws.close(); } catch (e) {}
  try { a2.ws.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
})();
