import * as fs from "node:fs";

/**
 * Read a secret by name. If `${name}_FILE` is set, the secret is read from that
 * file (trimmed) and takes precedence over the plaintext `${name}` env var.
 * Returns undefined when neither is present.
 */
export function readSecret(name: string): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    return fs.readFileSync(filePath, "utf-8").trim();
  }
  return process.env[name];
}

/**
 * Read a required secret. Throws if neither `${name}` nor `${name}_FILE` yields a value.
 */
export function requireSecret(name: string): string {
  const value = readSecret(name);
  if (!value) {
    throw new Error(`Missing required secret: ${name} (set ${name} or ${name}_FILE)`);
  }
  return value;
}
