const crypto = require("crypto");

// NOTE: User requested hard-coded secret.
// If you later want env-based config, swap this for process.env.PASSCODE_SECRET.
const SECRET = "DHUSAMES";

// Authenticated encryption (integrity + confidentiality)
const ALGO = "aes-256-gcm";
const KEY = crypto.createHash("sha256").update(SECRET, "utf8").digest(); // 32 bytes
const IV_BYTES = 12; // recommended for GCM

function isEncryptedString(value) {
  if (typeof value !== "string") return false;
  // enc:v1:<ivHex>:<tagHex>:<cipherHex>
  return value.startsWith("enc:v1:") && value.split(":").length === 5;
}

function encryptString(plain) {
  if (plain === null || plain === undefined) return plain;
  if (typeof plain !== "string") plain = String(plain);
  if (plain === "") return "";
  if (isEncryptedString(plain)) return plain;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);

  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `enc:v1:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

function decryptString(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") value = String(value);
  if (value === "") return "";
  if (!isEncryptedString(value)) return value;

  const parts = value.split(":");
  const ivHex = parts[2];
  const tagHex = parts[3];
  const dataHex = parts[4];

  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");

  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString("utf8");
}

function decryptPasscodeFields(passcodeLike) {
  if (!passcodeLike) return passcodeLike;

  const obj =
    typeof passcodeLike.toObject === "function"
      ? passcodeLike.toObject()
      : { ...passcodeLike };

  if (Object.prototype.hasOwnProperty.call(obj, "password")) {
    obj.password = decryptString(obj.password);
  }
  if (Object.prototype.hasOwnProperty.call(obj, "pin")) {
    obj.pin = decryptString(obj.pin);
  }

  return obj;
}

module.exports = {
  encryptString,
  decryptString,
  decryptPasscodeFields,
  isEncryptedString,
};


