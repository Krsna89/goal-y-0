// Hand-rolled Web Push sender — no npm dependencies.
//
// Implements just enough of RFC 8291 (message encryption), RFC 8188
// (aes128gcm content coding) and RFC 8292 (VAPID) to POST a notification
// payload to any standards-compliant push service (Chrome/FCM, Firefox,
// Safari/Apple Push, Edge). This is the same algorithm the popular
// `web-push` npm package implements — reimplemented here with only
// node:crypto and node:https so the app keeps its "no npm install needed"
// deploy story.
//
// Keys: generate a VAPID key pair once (see README) and set
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY as environment variables. The
// public key is safe to expose to clients; the private key is not.

const crypto = require('node:crypto');
const https = require('node:https');
const { URL } = require('node:url');

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

const isConfigured = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

function vapidPrivateKeyObject() {
  const pub = fromB64url(VAPID_PUBLIC_KEY);
  const priv = fromB64url(VAPID_PRIVATE_KEY);
  const x = pub.subarray(1, 33);
  const y = pub.subarray(33, 65);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(priv), x: b64url(x), y: b64url(y) },
    format: 'jwk',
  });
}

function buildVapidJWT(audience) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: VAPID_SUBJECT,
  };
  const encHeader = b64url(Buffer.from(JSON.stringify(header)));
  const encPayload = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = encHeader + '.' + encPayload;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: vapidPrivateKeyObject(),
    dsaEncoding: 'ieee-p1363', // raw r||s, as required by JOSE/JWT ES256
  });
  return signingInput + '.' + b64url(sig);
}

// RFC 8291 message encryption (aes128gcm).
function encryptPayload(payloadStr, p256dhB64, authB64) {
  const uaPublic = fromB64url(p256dhB64); // client's 65-byte uncompressed EC point
  const authSecret = fromB64url(authB64); // client's 16-byte auth secret

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // our ephemeral 65-byte public point
  const sharedSecret = ecdh.computeSecret(uaPublic); // 32 bytes

  const salt = crypto.randomBytes(16);

  // Stage 1: combine the ECDH secret with the subscription's auth secret.
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const prkCombine = crypto.createHmac('sha256', authSecret).update(sharedSecret).digest();
  const ikm = crypto
    .createHmac('sha256', prkCombine)
    .update(Buffer.concat([authInfo, Buffer.from([1])]))
    .digest();

  // Stage 2: derive the content-encryption key and nonce from a random salt.
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const cekInfo = Buffer.from('Content-Encoding: aes128gcm\0');
  const cek = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([cekInfo, Buffer.from([1])]))
    .digest()
    .subarray(0, 16);
  const nonceInfo = Buffer.from('Content-Encoding: nonce\0');
  const nonce = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([nonceInfo, Buffer.from([1])]))
    .digest()
    .subarray(0, 12);

  // Single-record content coding: append the 0x02 "last record" delimiter.
  const record = Buffer.concat([Buffer.from(payloadStr, 'utf8'), Buffer.from([2])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([enc, tag]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0); // record size, well above our payload
  const idlen = Buffer.from([asPublic.length]);
  const header = Buffer.concat([salt, rs, idlen, asPublic]);

  return Buffer.concat([header, ciphertext]);
}

function sendPush(subscription, payloadObj, ttlSeconds) {
  return new Promise((resolve, reject) => {
    try {
      if (!isConfigured) return reject(new Error('VAPID keys are not configured.'));
      const { endpoint, keys } = subscription;
      if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
        return reject(new Error('Invalid push subscription.'));
      }
      const body = encryptPayload(JSON.stringify(payloadObj), keys.p256dh, keys.auth);
      const url = new URL(endpoint);
      const audience = url.protocol + '//' + url.host;
      const jwt = buildVapidJWT(audience);

      const options = {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname + url.search,
        port: url.port || 443,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          'Content-Length': body.length,
          TTL: String(ttlSeconds || 86400),
          Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { sendPush, vapidPublicKey: VAPID_PUBLIC_KEY, isConfigured };
