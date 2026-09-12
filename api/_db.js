// Shared Turso handle plus the small helpers every endpoint needs.
//
// Credentials are read from the environment and never leave the server. The
// browser talks only to /api/links and /go/<key>; it never sees a database
// URL or token, which is the whole reason those endpoints exist.
const { createClient } = require("@libsql/client");

let client = null;

function db() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  client = createClient({ url, authToken });
  return client;
}

// Keys become URL path segments and get printed onto paper, so they are held
// to what survives a URL, a filename and a label equally well.
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const KEY_MAX = 64;
const URL_MAX = 2048;

function normaliseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (raw.length > URL_MAX) return null;
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  // http(s) only. Without this a saved link could aim a printed code at
  // javascript: or data:, turning it into a delivery vehicle for a script.
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.href;
}

function validKey(key) {
  return typeof key === "string" && key.length <= KEY_MAX && KEY_RE.test(key);
}

// Rate limiting is only as good as the identity it counts against, so the
// order here matters. x-vercel-forwarded-for and x-real-ip are set by the
// platform and cannot be forged by a caller. Plain x-forwarded-for CAN be:
// a client may send its own, and it arrives with the attacker's value at the
// front — so trusting it first would hand anyone an unlimited supply of fresh
// identities and make the limit decorative. It stays last, for local dev.
function clientIp(req) {
  const vercel = req.headers["x-vercel-forwarded-for"];
  if (typeof vercel === "string" && vercel.length) return vercel.split(",")[0].trim();

  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length) return real.trim();

  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();

  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

module.exports = { db, KEY_RE, KEY_MAX, URL_MAX, normaliseUrl, validKey, clientIp, json };
