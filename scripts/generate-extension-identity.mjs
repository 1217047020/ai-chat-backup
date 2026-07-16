import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privateKeyPath = resolve(projectRoot, ".keys", "ai-chat-backup-private.pem");
const publicKeyPath = resolve(projectRoot, "config", "extension-public-key.txt");

const extensionIdFromPublicKey = (publicKeyDer) => {
  const digest = createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
};

if (existsSync(privateKeyPath) || existsSync(publicKeyPath)) {
  if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
    throw new Error(
      "Extension identity is incomplete. Restore both the private key and public key before continuing."
    );
  }

  const privateKey = readFileSync(privateKeyPath, "utf8");
  const manifestKey = readFileSync(publicKeyPath, "utf8").trim();
  const publicKeyDer = Buffer.from(manifestKey, "base64");
  const derivedPublicKeyDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (!derivedPublicKeyDer.equals(publicKeyDer)) {
    throw new Error("The stored private key does not match the manifest public key.");
  }
  console.log(`Existing extension ID: ${extensionIdFromPublicKey(publicKeyDer)}`);
  console.log(`Private key retained at: ${privateKeyPath}`);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

mkdirSync(dirname(privateKeyPath), { recursive: true });
mkdirSync(dirname(publicKeyPath), { recursive: true });
writeFileSync(privateKeyPath, privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
writeFileSync(publicKeyPath, `${publicKey.toString("base64")}\n`, {
  encoding: "utf8",
  flag: "wx"
});

console.log(`Generated extension ID: ${extensionIdFromPublicKey(publicKey)}`);
console.log(`Private key (keep secret): ${privateKeyPath}`);
console.log(`Manifest public key: ${publicKeyPath}`);
