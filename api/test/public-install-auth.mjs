// Software authenticator for loopback installation tests, never a production credential.
import crypto from 'node:crypto';
const b64 = value => Buffer.from(value).toString('base64url');
const sha = value => crypto.createHash('sha256').update(value).digest();
const head = (kind, n) => n < 24 ? Buffer.from([(kind << 5) | n]) : n < 256 ? Buffer.from([(kind << 5) | 24, n]) : Buffer.from([(kind << 5) | 25, n >> 8, n & 255]);
const string = value => Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
const bytes = value => Buffer.concat([head(2, value.length), value]);
export function publicInstallAuthenticator(origin) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = publicKey.export({ format: 'jwk' }), raw = crypto.randomBytes(16), id = b64(raw), rp = new URL(origin).hostname;
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(key.x, 'base64url'), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(key.y, 'base64url')]);
  let counter = 0;
  const base = response => ({ id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform', response });
  return {
    attestation(challenge) {
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      const auth = Buffer.concat([sha(rp), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, raw.length]), raw, cose]);
      const object = Buffer.concat([Buffer.from([0xa3]), string('fmt'), string('none'), string('attStmt'), Buffer.from([0xa0]), string('authData'), bytes(auth)]);
      return base({ clientDataJSON: b64(client), attestationObject: b64(object), transports: ['internal'] });
    },
    assertion(challenge) {
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
      const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
      const auth = Buffer.concat([sha(rp), Buffer.from([0x05]), count]);
      return base({ clientDataJSON: b64(client), authenticatorData: b64(auth), signature: b64(crypto.sign('sha256', Buffer.concat([auth, sha(client)]), privateKey)), userHandle: null });
    }
  };
}
