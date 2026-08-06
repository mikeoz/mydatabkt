const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const verify = require('./verify.cjs');

const AUD = 'bkt://mike0z/MedBucket';
const ISS = 'https://consent.opn.li';
const CONSENT = 'https://consent.opn.li';

function b64url(x){ return Buffer.from(x).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function mint(priv, kid, claims){
  const h = b64url(JSON.stringify({ alg:'EdDSA', typ:'JWT', kid }));
  const p = b64url(JSON.stringify(claims));
  const sig = crypto.sign(null, Buffer.from(h + '.' + p), priv);
  return h + '.' + p + '.' + b64url(sig);
}

(async () => {
  const now = Math.floor(Date.now()/1000);
  const realPriv = crypto.createPrivateKey(fs.readFileSync(path.join(os.homedir(),'.otn-keys','consent-ed25519-private.pem'),'utf8'));
  const realPub = crypto.createPublicKey(realPriv).export({ type:'spki', format:'pem' });
  const kid = 'otn-consent-' + crypto.createHash('sha256').update(realPub).digest('hex').slice(0,8);
  const attacker = crypto.generateKeyPairSync('ed25519');

  const good     = mint(realPriv, kid, { iss:ISS, sub:'m1', aud:AUD, jti:'d-good', iat:now, exp:now+300, otn:{ allowed:true, agent_entity_id:'a1', scope:{ actions:['read'], file_ids:null }, audit_hash:'abc' } });
  const forged   = mint(attacker.privateKey, kid, { iss:ISS, sub:'m1', aud:AUD, jti:'d-atk', iat:now, exp:now+300, otn:{ allowed:true, scope:{ actions:['read'] } } });
  const wrongBkt = mint(realPriv, kid, { iss:ISS, sub:'m1', aud:'bkt://someone/else', jti:'d-wb', iat:now, exp:now+300, otn:{ allowed:true, scope:{ actions:['read'] } } });
  const expired  = mint(realPriv, kid, { iss:ISS, sub:'m1', aud:AUD, jti:'d-exp', iat:now-1000, exp:now-600, otn:{ allowed:true, scope:{ actions:['read'] } } });

  const opts = { bktAddress:AUD, issuer:ISS, consentUrl:CONSENT };
  const run = async (label, jwt) => { const v = await verify.verifyProof(jwt, opts); console.log(label.padEnd(28), v.valid ? 'ACCEPTED' : 'REJECTED', v.valid ? '' : '(' + v.reason + ')'); };

  await run('valid signed proof', good);
  await run('attacker-signed proof', forged);
  await run('wrong-bucket proof', wrongBkt);
  await run('expired proof', expired);
  await run('junk allowed:true', 'x.y.z');
})();
