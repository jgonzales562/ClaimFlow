import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SCRYPT_PREFIX = "scrypt";
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${SCRYPT_PREFIX}$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!passwordHash.startsWith(`${SCRYPT_PREFIX}$`)) {
    // Legacy fallback for pre-hash seeded records.
    return password === passwordHash;
  }

  const parts = passwordHash.split("$");
  if (parts.length !== 3) {
    return false;
  }

  const [, saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex, "hex");
  const storedKey = Buffer.from(keyHex, "hex");
  const derivedKey = (await scrypt(password, salt, storedKey.length)) as Buffer;

  if (storedKey.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(storedKey, derivedKey);
}
