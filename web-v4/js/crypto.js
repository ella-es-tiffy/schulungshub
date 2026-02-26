/* ================================================================
   SchulungsHub v4 – Crypto (PBKDF2-SHA256, HMAC)
   Shared between app and login
   ================================================================ */
const Crypto = (() => {
  const DATA_KEY = "SchulungsHub-Siebdruck-2026";

  function bytesToHex(b) { return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join(""); }
  function hexToBytes(h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i*2, i*2+2), 16); return b; }

  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }

  async function pbkdf2(password, saltHex, iterations) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations }, key, 256);
    return bytesToHex(new Uint8Array(bits));
  }

  async function verifyPassword(password, storedHash) {
    const p = String(storedHash || "").split("$");
    if (p.length !== 4 || p[0] !== "pbkdf2_sha256") return false;
    const iter = parseInt(p[1], 10);
    if (!iter || iter <= 0) return false;
    return timingSafeEqual(await pbkdf2(password, p[2], iter), p[3]);
  }

  async function createPasswordHash(password) {
    const iter = 120000;
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    return `pbkdf2_sha256$${iter}$${salt}$${await pbkdf2(password, salt, iter)}`;
  }

  async function sha256Hex(text) {
    return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
  }

  async function hmacSign(message) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(DATA_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return bytesToHex(new Uint8Array(sig));
  }

  async function hmacVerify(message, signature) {
    const expected = await hmacSign(message);
    return timingSafeEqual(expected, signature);
  }

  return { bytesToHex, hexToBytes, timingSafeEqual, pbkdf2, verifyPassword, createPasswordHash, sha256Hex, hmacSign, hmacVerify, DATA_KEY };
})();

/* Global shortcuts (used across modules) */
const verifyPassword = Crypto.verifyPassword;
const createPasswordHash = Crypto.createPasswordHash;
const sha256Hex = Crypto.sha256Hex;
const hmacSign = Crypto.hmacSign;
const hmacVerify = Crypto.hmacVerify;
