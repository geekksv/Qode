// Shared Turso handle plus the validation every endpoint depends on.
//
// Credentials are read from the environment and never leave the server. The
// browser talks only to /api/links and /go/<key>; it never sees a database
// URL or token, which is the whole reason those endpoints exist.
//
// Since anyone can create a link here, this file is also where the abuse
// surface is narrowed: what a key may be called, what a destination may point
// at, and how ownership of a link is proved.
const crypto = require("crypto");
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
// to what survives a URL, a filename and a printed label equally well.
const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const KEY_MIN = 3;
const KEY_MAX = 40;
const URL_MAX = 2048;

// Names that would collide with a route, impersonate the site's own
// furniture, or read as though Qode itself vouches for the destination.
// Someone landing on /go/login or /go/verify should not be doing so because a
// stranger claimed the word.
const RESERVED = new Set([
  "go", "api", "switch", "wizard", "bulk", "studio", "admin", "administrator",
  "login", "log-in", "signin", "sign-in", "signup", "sign-up", "auth", "oauth",
  "account", "accounts", "password", "reset", "verify", "verification",
  "secure", "security", "update", "confirm", "billing", "payment", "pay",
  "invoice", "wallet", "bank", "support", "help", "settings", "config",
  "qode", "www", "mail", "email", "root", "test", "null", "undefined",
  "favicon", "robots", "sitemap", "assets", "static", "js", "css", "img",
  "images", "wasm", "vendor", "r",
]);

function keyProblem(raw) {
  if (typeof raw !== "string") return "That name isn't usable.";
  const key = raw.trim().toLowerCase();
  if (!key) return "Give it a name.";
  if (key.length < KEY_MIN) return "Names need at least " + KEY_MIN + " characters.";
  if (key.length > KEY_MAX) return "Names can be at most " + KEY_MAX + " characters.";
  if (!KEY_RE.test(key)) {
    return "Lowercase letters, digits and hyphens only, starting with a letter or digit.";
  }
  if (key.endsWith("-")) return "Names can't end with a hyphen.";
  if (key.indexOf("--") !== -1) return "Names can't contain two hyphens in a row.";
  if (RESERVED.has(key)) return '"' + key + '" is reserved.';
  return null;
}

// Hosts a public redirector must never send anyone to. Loopback and the
// private ranges are the interesting ones: without this, a link here could be
// used to point somebody's browser at a device on their own network, and the
// redirect would arrive carrying that browser's local trust.
function hostProblem(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");

  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return "That address is only reachable on one machine, so a printed code could never open it.";
  }
  if (h === "[::1]" || h === "[::]") return "That address isn't reachable from a phone.";

  // Bare IPv4. Legitimate destinations have names; an IP literal in a printed
  // QR is almost always either a mistake or an attempt to hide something.
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return "Use a domain name rather than a bare IP address.";
  }
  if (h.startsWith("[")) return "Use a domain name rather than a bare IP address.";

  // A hostname with no dot cannot resolve publicly.
  if (h.indexOf(".") === -1) return "That doesn't look like a public web address.";

  return null;
}

function urlProblem(value) {
  if (typeof value !== "string" || !value.trim()) return "Give it a destination.";
  const raw = value.trim();
  if (raw.length > URL_MAX) return "That address is too long.";

  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return "That isn't a complete web address. It needs the https:// too.";
  }
  // http(s) only. Without this a saved link could aim a printed code at
  // javascript: or data:, turning it into a delivery vehicle for a script.
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "Only http:// and https:// addresses can be used.";
  }
  if (u.username || u.password) {
    return "Addresses with a username or password in them aren't allowed.";
  }
  const hp = hostProblem(u.hostname);
  if (hp) return hp;

  return null;
}

// A link that points at this site's own redirector would either loop forever
// or be used to build a chain that hides where someone actually ends up.
function pointsAtUs(value, selfHost) {
  if (!selfHost) return false;
  try {
    const u = new URL(value);
    return u.hostname.toLowerCase() === selfHost.toLowerCase() &&
      /^\/(go|r)(\/|$)/.test(u.pathname);
  } catch (e) {
    return false;
  }
}

function normaliseUrl(value) {
  if (urlProblem(value)) return null;
  return new URL(String(value).trim()).href;
}

// ---- Ownership ------------------------------------------------------------

// Anyone can make a link, so possession of the printed code cannot be what
// proves ownership — otherwise photographing a poster would be enough to
// hijack it. Each link gets its own secret instead, shown once at creation
// and stored only as a hash.
function newEditToken() {
  return crypto.randomBytes(18).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

// Length-independent comparison. A plain === leaks a secret a character at a
// time through response timing.
function tokenMatches(supplied, storedHash) {
  if (!storedHash) return false;
  const a = Buffer.from(hashToken(supplied), "hex");
  const b = Buffer.from(String(storedHash), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAdmin(supplied) {
  const expected = process.env.QODE_ADMIN_TOKEN || "";
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(String(supplied || ""), "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

// ---- Request helpers ------------------------------------------------------

// Rate limiting is only as good as the identity it counts against, so the
// order here matters. x-vercel-forwarded-for and x-real-ip are set by the
// platform and cannot be forged by a caller. Plain x-forwarded-for CAN be: a
// client may send its own, and it arrives with the attacker's value at the
// front — so trusting it first would hand anyone an unlimited supply of fresh
// identities and make the limits decorative. It stays last, for local dev.
function clientIp(req) {
  const vercel = req.headers["x-vercel-forwarded-for"];
  if (typeof vercel === "string" && vercel.length) return vercel.split(",")[0].trim();

  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length) return real.trim();

  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();

  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// Stored rather than the raw address: this is abuse accounting, not a log of
// who visited, and a hash counts just as well as the address itself.
function ipKey(ip) {
  return crypto.createHash("sha256").update(String(ip), "utf8").digest("hex").slice(0, 32);
}

function selfHost(req) {
  const h = req.headers["x-forwarded-host"] || req.headers["host"] || "";
  return String(h).split(":")[0];
}

function bearer(req) {
  const header = req.headers["authorization"] || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

module.exports = {
  db,
  KEY_RE, KEY_MIN, KEY_MAX, URL_MAX, RESERVED,
  keyProblem, urlProblem, hostProblem, normaliseUrl, pointsAtUs,
  newEditToken, hashToken, tokenMatches, isAdmin,
  clientIp, ipKey, selfHost, bearer, json,
};
