import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_VERSION = "v1";
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

type ScryptParams = {
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const key = await deriveScryptKey(password, salt, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    keyLength: SCRYPT_KEY_LENGTH,
  });

  return [
    SCRYPT_PREFIX,
    SCRYPT_VERSION,
    `n=${SCRYPT_COST},r=${SCRYPT_BLOCK_SIZE},p=${SCRYPT_PARALLELIZATION},l=${SCRYPT_KEY_LENGTH}`,
    salt.toString("hex"),
    key.toString("hex"),
  ].join("$");
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const parts = passwordHash.split("$");
  if (parts[0] !== SCRYPT_PREFIX) {
    return false;
  }

  if (parts.length === 3) {
    return verifyLegacyScryptPassword(password, parts[1], parts[2]);
  }

  if (parts.length !== 5 || parts[1] !== SCRYPT_VERSION) {
    return false;
  }

  const params = parseScryptParams(parts[2]);
  if (!params) {
    return false;
  }

  return verifyScryptPassword(password, parts[3], parts[4], params);
}

async function verifyLegacyScryptPassword(
  password: string,
  saltHex: string,
  keyHex: string,
): Promise<boolean> {
  return verifyScryptPassword(password, saltHex, keyHex, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    keyLength: Buffer.from(keyHex, "hex").length,
  });
}

async function verifyScryptPassword(
  password: string,
  saltHex: string,
  keyHex: string,
  params: ScryptParams,
): Promise<boolean> {
  if (!isValidHexToken(saltHex) || !isValidHexToken(keyHex)) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const storedKey = Buffer.from(keyHex, "hex");
  if (storedKey.length !== params.keyLength) {
    return false;
  }

  const derivedKey = await deriveScryptKey(password, salt, params);

  if (storedKey.length !== derivedKey.length) {
    return false;
  }

  return timingSafeEqual(storedKey, derivedKey);
}

function parseScryptParams(value: string): ScryptParams | null {
  const parsed = new Map(
    value.split(",").map((entry) => {
      const [key, rawValue] = entry.split("=");
      return [key, Number.parseInt(rawValue ?? "", 10)];
    }),
  );
  const cost = parsed.get("n");
  const blockSize = parsed.get("r");
  const parallelization = parsed.get("p");
  const keyLength = parsed.get("l");

  if (
    !isValidScryptInteger(cost, 2, 1_048_576) ||
    !isValidScryptInteger(blockSize, 1, 32) ||
    !isValidScryptInteger(parallelization, 1, 16) ||
    !isValidScryptInteger(keyLength, 32, 128)
  ) {
    return null;
  }

  return {
    cost,
    blockSize,
    parallelization,
    keyLength,
  };
}

function deriveScryptKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      params.keyLength,
      {
        N: params.cost,
        r: params.blockSize,
        p: params.parallelization,
        maxmem: SCRYPT_MAXMEM,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

function isValidScryptInteger(
  value: number | undefined,
  min: number,
  max: number,
): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isValidHexToken(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}
