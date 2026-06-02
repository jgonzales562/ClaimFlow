import assert from "node:assert/strict";
import { scrypt as scryptCallback } from "node:crypto";
import { test } from "node:test";
import { promisify } from "node:util";
import { hashPassword, verifyPassword } from "../apps/web/lib/auth/password.ts";

const scrypt = promisify(scryptCallback);

test("verifyPassword accepts valid scrypt password hashes", async () => {
  const passwordHash = await hashPassword("correct-password");

  const matches = await verifyPassword("correct-password", passwordHash);

  assert.equal(matches, true);
  assert.match(passwordHash, /^scrypt\$v1\$n=16384,r=8,p=1,l=64\$/);
});

test("verifyPassword rejects incorrect passwords for valid scrypt hashes", async () => {
  const passwordHash = await hashPassword("correct-password");

  const matches = await verifyPassword("wrong-password", passwordHash);

  assert.equal(matches, false);
});

test("verifyPassword rejects legacy plaintext password values", async () => {
  const matches = await verifyPassword("correct-password", "correct-password");

  assert.equal(matches, false);
});

test("verifyPassword accepts legacy scrypt password hashes", async () => {
  const passwordHash = await hashLegacyPassword("correct-password");

  const matches = await verifyPassword("correct-password", passwordHash);

  assert.equal(matches, true);
});

test("verifyPassword rejects malformed scrypt hashes", async () => {
  assert.equal(await verifyPassword("correct-password", "scrypt"), false);
  assert.equal(await verifyPassword("correct-password", "scrypt$not-hex$abcd"), false);
  assert.equal(await verifyPassword("correct-password", "scrypt$abcd$not-hex"), false);
});

async function hashLegacyPassword(password: string): Promise<string> {
  const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
