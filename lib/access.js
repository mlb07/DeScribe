// Who may see what. The owner (whoever knows the main DeScribe passcode) sees everything.
// Guests come in through a list's or a project's permanent link (its QR code) and only
// ever see that list, or that project's lists. A list or project can also have its own
// password, which guests must enter first.
//
// Passwords are never stored as they are: only a salted scrypt hash. What a guest's
// phone keeps is a signed ticket ("guest token", "unlock token"), checked with a secret
// that only this Mac knows, so nothing on the phone can be edited to reach more.

import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const LINK_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to mix up

export const MIN_PASSWORD = 4;
export const MAX_PASSWORD = 200;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(password).normalize('NFC'), salt, 32);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export async function passwordMatches(password, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const expected = Buffer.from(stored.hash, 'hex');
  const actual = await scrypt(String(password ?? '').normalize('NFC'), Buffer.from(stored.salt, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

// A new code for a permanent link (the part after /p/ in the QR code).
export const newLinkCode = () => [...randomBytes(10)].map((byte) => LINK_LETTERS[byte % LINK_LETTERS.length]).join('');

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (text) => JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));

// A signed ticket: the content can be read, but not changed without the Mac's secret.
export function signTicket(secret, content) {
  const body = encode(content);
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function readTicket(secret, ticket) {
  const [body, signature] = String(ticket || '').split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  let given;
  try {
    given = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return decode(body);
  } catch {
    return null;
  }
}
