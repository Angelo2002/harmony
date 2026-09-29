import { randomBytes, scrypt, scryptSync, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const SCHEME = 'scrypt';
const KEY_LENGTH = 64;
const COST = { N: 16384, r: 8, p: 1 };

function parse(stored: string): { cost: { N: number; r: number; p: number }; salt: Buffer; hash: Buffer } | null {
  const [scheme, costPart, saltPart, hashPart] = stored.split('$');
  if (scheme !== SCHEME || !costPart || !saltPart || !hashPart) return null;

  const [n, r, p] = costPart.split(',').map(Number);
  if (!n || !r || !p) return null;

  return {
    cost: { N: n, r, p },
    salt: Buffer.from(saltPart, 'base64'),
    hash: Buffer.from(hashPart, 'base64'),
  };
}

/**
 * Hashes a password with scrypt, which ships with Node itself. The stored
 * string is self-describing (`scheme$params$salt$hash`) so the cost can be
 * raised later without invalidating existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, COST);
  return `${SCHEME}$${COST.N},${COST.r},${COST.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;

  const derived = await scryptAsync(password, parsed.salt, parsed.hash.length, parsed.cost);
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

/**
 * Compared against when a username does not exist, so that a missing account
 * takes roughly the same time to reject as a wrong password.
 */
export const DUMMY_PASSWORD_HASH: string = (() => {
  const salt = randomBytes(16);
  const derived = scryptSync('harmony-dummy-password', salt, KEY_LENGTH, COST);
  return `${SCHEME}$${COST.N},${COST.r},${COST.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
})();
