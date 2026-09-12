// GET  /api/links  -> the current links (public; they are printed on paper,
//                     so the list is not a secret)
// POST /api/links  -> replace the whole set (requires the admin token)
//
// The write path is the only way anything in this project changes, so it
// carries the two protections that matter: a shared secret, and a per-IP rate
// limit that survives cold starts because it lives in the database.
const crypto = require("crypto");
const { db, validKey, normaliseUrl, clientIp, json } = require("./_db.js");

// Generous for one person editing their own links, tight enough that a script
// hammering this endpoint gets nowhere.
const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Brute-forcing the token is the real attack here, so failures are rationed
// far harder than successes.
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

const MAX_LINKS = 500;

// Length-independent comparison. A plain === leaks the token a character at a
// time through response timing.
function tokenOk(supplied) {
  const expected = process.env.QODE_ADMIN_TOKEN || "";
  if (!expected) return false;
  const a = Buffer.from(String(supplied || ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch, so hash both to a fixed width
  // first and compare that instead.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function underLimit(c, ip, tag, limit, windowMs) {
  const since = Date.now() - windowMs;
  await c.execute({ sql: "DELETE FROM writes WHERE at < ?", args: [Date.now() - 24 * 60 * 60 * 1000] });
  const r = await c.execute({
    sql: "SELECT COUNT(*) AS n FROM writes WHERE ip = ? AND at >= ?",
    args: [tag + ":" + ip, since],
  });
  return Number(r.rows[0].n) < limit;
}

async function note(c, ip, tag) {
  await c.execute({ sql: "INSERT INTO writes (ip, at) VALUES (?, ?)", args: [tag + ":" + ip, Date.now()] });
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

module.exports = async function handler(req, res) {
  const c = db();
  const ip = clientIp(req);

  if (req.method === "GET") {
    const r = await c.execute("SELECT key, url, updated_at, hits FROM links ORDER BY key");
    return json(res, 200, {
      links: r.rows.map((row) => ({
        key: row.key,
        url: row.url,
        updatedAt: Number(row.updated_at),
        hits: Number(row.hits),
      })),
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: "Use GET to read or POST to save." });
  }

  // ---- Auth -------------------------------------------------------------
  if (!process.env.QODE_ADMIN_TOKEN) {
    return json(res, 500, {
      error: "This site has no admin token configured, so saving is disabled.",
    });
  }

  if (!(await underLimit(c, ip, "fail", FAIL_LIMIT, FAIL_WINDOW_MS))) {
    return json(res, 429, {
      error: "Too many failed attempts. Try again in fifteen minutes.",
    });
  }

  const header = req.headers["authorization"] || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!tokenOk(supplied)) {
    await note(c, ip, "fail");
    return json(res, 401, { error: "That password isn't right." });
  }

  // ---- Rate limit -------------------------------------------------------
  if (!(await underLimit(c, ip, "write", WRITE_LIMIT, WRITE_WINDOW_MS))) {
    return json(res, 429, {
      error: "That's " + WRITE_LIMIT + " saves in an hour. Give it a few minutes.",
    });
  }

  // ---- Validate ---------------------------------------------------------
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: "Couldn't read that request." });
  }

  const incoming = body && body.links;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return json(res, 400, { error: "Expected a links object." });
  }

  const keys = Object.keys(incoming);
  if (keys.length > MAX_LINKS) {
    return json(res, 400, { error: "That's more than " + MAX_LINKS + " links." });
  }

  const clean = {};
  for (const rawKey of keys) {
    const key = rawKey.trim().toLowerCase();
    if (!validKey(key)) {
      return json(res, 400, {
        error: '"' + rawKey + '" isn\'t usable as a name. Lowercase letters, digits and hyphens only.',
      });
    }
    const url = normaliseUrl(incoming[rawKey]);
    if (!url) {
      return json(res, 400, {
        error: '"' + key + '" needs a full http or https address.',
      });
    }
    clean[key] = url;
  }

  // ---- Apply ------------------------------------------------------------
  const existing = await c.execute("SELECT key FROM links");
  const had = new Set(existing.rows.map((r) => r.key));
  const now = Date.now();

  const statements = [];
  for (const [key, url] of Object.entries(clean)) {
    statements.push({
      sql:
        "INSERT INTO links (key, url, created_at, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at",
      args: [key, url, now, now],
    });
  }
  for (const key of had) {
    if (!Object.prototype.hasOwnProperty.call(clean, key)) {
      statements.push({ sql: "DELETE FROM links WHERE key = ?", args: [key] });
    }
  }

  // One transaction: a half-applied save would leave some printed codes
  // pointing at the old destination and some at the new one.
  if (statements.length) await c.batch(statements, "write");
  await note(c, ip, "write");

  const after = await c.execute("SELECT key, url, updated_at, hits FROM links ORDER BY key");
  return json(res, 200, {
    saved: true,
    links: after.rows.map((row) => ({
      key: row.key,
      url: row.url,
      updatedAt: Number(row.updated_at),
      hits: Number(row.hits),
    })),
  });
};
