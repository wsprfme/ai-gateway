import crypto from 'node:crypto';

const secret = process.env.APP_SECRET;
if (!secret || secret.length < 16) {
  throw new Error('APP_SECRET wajib diisi di .env (minimal 16 karakter).');
}

const encKey = crypto.createHash('sha256').update('enc:' + secret).digest();
const macKey = crypto.createHash('sha256').update('mac:' + secret).digest();

// AES-256-GCM untuk menyimpan API key provider di database.
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, enc] = payload.split('.').map((x) => Buffer.from(x, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function generateApiKey() {
  return 'sk-gw-' + crypto.randomBytes(24).toString('base64url');
}

export function safeEqual(a, b) {
  return crypto.timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

// Token sesi dashboard: payload base64url + HMAC.
export function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', macKey).update(data).digest('base64url');
  return `${data}.${mac}`;
}

export function verifySession(token) {
  if (!token) return null;
  const [data, mac] = token.split('.');
  if (!data || !mac) return null;
  const expected = crypto.createHmac('sha256', macKey).update(data).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}
