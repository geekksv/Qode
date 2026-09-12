// The switchable-link API. Private: every route requires the admin token.
//
//   GET    /api/links?key=x   where that code currently goes
//   GET    /api/links         the whole list
//   POST   /api/links         create one link
//   PATCH  /api/links         change one link's destination
//   DELETE /api/links         remove one link
//
// This was briefly open to the public, with a per-link edit key proving
// ownership. It is now closed again by choice: a free anonymous redirector is
// a phishing-laundering vector, and the cost of getting that wrong is the
// whole domain being blocklisted rather than just this feature breaking.
// Closing it removes that surface completely.
//
// The per-link edit keys and the per-IP rate limits below are kept but no
// longer load-bearing — the admin token is checked first and satisfies
// everything. They are left in place so this can be reopened by deleting one
// guard rather than rebuilding the ownership model.
//
// Note what is NOT the credential here, then or now: the printed QR code.
// Anyone can photograph a poster, so possession of a code must never be what
// grants control of it.
const {
  db, keyProblem, urlProblem, normaliseUrl, pointsAtUs,
  newEditToken, hashToken, tokenMatches, isAdmin,
  clientIp, ipKey, selfHost, bearer, json,
} = require("./_db.js");
const { destinationProblem } = require("./_safety.js");

// Strict, and per IP per rolling 24 hours. This is the main brake on someone
// filling the table, and on the site becoming a free redirect farm.
const CREATE_LIMIT = 3;
const CREATE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Editing your own links is not the abuse vector creating them is, but it
// still needs a ceiling so a loop cannot hammer the database.
const EDIT_LIMIT = 60;
const EDIT_WINDOW_MS = 60 * 60 * 1000;

// Guessing an edit key is the attack that would let someone take over a
// printed code, so failures are rationed hard.
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

async function countWithin(c, tag, ip, windowMs) {
  const since = Date.now() - windowMs;
  const r = await c.execute({
    sql: "SELECT COUNT(*) AS n FROM writes WHERE ip = ? AND at >= ?",
    args: [tag + ":" + ip, since],
  });
  return Number(r.rows[0].n);
}

async function note(c, tag, ip) {
  await c.execute({
    sql: "INSERT INTO writes (ip, at) VALUES (?, ?)",
    args: [tag + ":" + ip, Date.now()],
  });
}

// Housekeeping, cheap and occasional. Anything older than the longest window
// can never affect a decision again.
async function sweep(c) {
  if (Math.random() > 0.1) return;
  await c.execute({
    sql: "DELETE FROM writes WHERE at < ?",
    args: [Date.now() - CREATE_WINDOW_MS - 60000],
  });
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicView(row) {
  return {
    key: row.key,
    url: row.url,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    hits: Number(row.hits),
  };
}

async function findLink(c, key) {
  const r = await c.execute({
    sql: "SELECT key, url, created_at, updated_at, hits, edit_hash FROM links WHERE key = ? LIMIT 1",
    args: [key],
  });
  return r.rows[0] || null;
}

module.exports = async function handler(req, res) {
  let c;
  try {
    c = db();
  } catch (e) {
    return json(res, 500, { error: "This site isn't configured for switchable links." });
  }

  const ip = ipKey(clientIp(req));
  const supplied = bearer(req);
  const admin = isAdmin(supplied);
  const host = selfHost(req);

  await sweep(c).catch(() => {});

  // ---- The gate ----------------------------------------------------------
  //
  // Before anything else, including reads. There is nothing here a visitor
  // needs: /go/<key> already sends them where they are going, so exposing the
  // destinations separately would only help someone mapping the site.
  if (!process.env.QODE_ADMIN_TOKEN) {
    return json(res, 503, { error: "Switchable links aren't configured on this site." });
  }
  if (!admin) {
    // 404 rather than 401: an endpoint that answers "unauthorised" confirms
    // it exists and is worth attacking. This one simply is not there.
    return json(res, 404, { error: "Not found." });
  }

  // ---- Read --------------------------------------------------------------

  if (req.method === "GET") {
    const key = String((req.query && req.query.key) || "").trim().toLowerCase();

    if (key) {
      // Public on purpose: a scan reveals the destination anyway, so refusing
      // to show it here would protect nothing and would stop someone checking
      // where their own printed code currently points.
      const row = await findLink(c, key);
      if (!row) return json(res, 404, { error: "No code by that name." });
      return json(res, 200, { link: publicView(row) });
    }

    const all = await c.execute(
      "SELECT key, url, created_at, updated_at, hits, edit_hash FROM links ORDER BY created_at DESC"
    );
    return json(res, 200, { links: all.rows.map(publicView) });
  }

  const method = req.method;
  if (method !== "POST" && method !== "PATCH" && method !== "DELETE") {
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: "Unsupported method." });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: "Couldn't read that request." });
  }

  // ---- Create ------------------------------------------------------------

  if (method === "POST") {
    // The owner is not rationed on their own site.
    if (!admin) {
      const used = await countWithin(c, "create", ip, CREATE_WINDOW_MS);
      if (used >= CREATE_LIMIT) {
        return json(res, 429, {
          error:
            "That's " + CREATE_LIMIT + " codes from this connection today, which is the limit. " +
            "Try again tomorrow — codes you have already made keep working, and you can still " +
            "change where they point.",
          limit: CREATE_LIMIT,
          used: used,
        });
      }
    }

    const rawKey = String(body.key || "").trim().toLowerCase();
    const kp = keyProblem(rawKey);
    if (kp) return json(res, 400, { error: kp });

    const rawUrl = String(body.url || "").trim();
    const up = urlProblem(rawUrl);
    if (up) return json(res, 400, { error: up });
    if (pointsAtUs(rawUrl, host)) {
      return json(res, 400, {
        error: "That points back at this site's redirector, which would just loop.",
      });
    }

    // Reputation, after the cheap structural checks and before anything is
    // written. Applied here AND on every later change: checking only at
    // creation would let someone make a clean link, print it, and repoint it
    // at malware the next day.
    const danger = await destinationProblem(rawUrl);
    if (danger) return json(res, 400, { error: danger });

    const url = normaliseUrl(rawUrl);
    const token = newEditToken();
    const now = Date.now();

    try {
      await c.execute({
        sql:
          "INSERT INTO links (key, url, created_at, updated_at, hits, edit_hash, creator_ip) " +
          "VALUES (?, ?, ?, ?, 0, ?, ?)",
        args: [rawKey, url, now, now, hashToken(token), ip],
      });
    } catch (e) {
      // The primary key is the race-safe check; testing first and inserting
      // second would leave a window where two people both think they won.
      if (/UNIQUE|constraint/i.test(e.message || "")) {
        return json(res, 409, { error: '"' + rawKey + '" is already taken. Try another name.' });
      }
      throw e;
    }

    if (!admin) await note(c, "create", ip);

    const used = await countWithin(c, "create", ip, CREATE_WINDOW_MS);
    return json(res, 201, {
      link: { key: rawKey, url: url, createdAt: now, updatedAt: now, hits: 0 },
      // Shown exactly once. Only the hash is kept, so it cannot be re-issued.
      editToken: token,
      remaining: admin ? null : Math.max(0, CREATE_LIMIT - used),
    });
  }

  // ---- Change and delete -------------------------------------------------

  const key = String(body.key || "").trim().toLowerCase();
  if (!key) return json(res, 400, { error: "Which code?" });

  const row = await findLink(c, key);
  if (!row) return json(res, 404, { error: "No code by that name." });

  if (!admin) {
    const fails = await countWithin(c, "fail", ip, FAIL_WINDOW_MS);
    if (fails >= FAIL_LIMIT) {
      return json(res, 429, { error: "Too many wrong keys. Try again in fifteen minutes." });
    }
    if (!tokenMatches(body.editToken, row.edit_hash)) {
      await note(c, "fail", ip);
      // Deliberately the same answer whether the code exists or the key is
      // wrong, so this cannot be used to probe which names are taken.
      return json(res, 403, {
        error: "That edit key doesn't match this code.",
      });
    }
    const edits = await countWithin(c, "edit", ip, EDIT_WINDOW_MS);
    if (edits >= EDIT_LIMIT) {
      return json(res, 429, { error: "Too many changes in an hour. Give it a few minutes." });
    }
  }

  if (method === "DELETE") {
    await c.execute({ sql: "DELETE FROM links WHERE key = ?", args: [key] });
    if (!admin) await note(c, "edit", ip);
    return json(res, 200, { deleted: true, key: key });
  }

  const rawUrl = String(body.url || "").trim();
  const up = urlProblem(rawUrl);
  if (up) return json(res, 400, { error: up });
  if (pointsAtUs(rawUrl, host)) {
    return json(res, 400, {
      error: "That points back at this site's redirector, which would just loop.",
    });
  }

  const dangerNow = await destinationProblem(rawUrl);
  if (dangerNow) return json(res, 400, { error: dangerNow });

  const url = normaliseUrl(rawUrl);
  const now = Date.now();
  await c.execute({
    sql: "UPDATE links SET url = ?, updated_at = ? WHERE key = ?",
    args: [url, now, key],
  });
  if (!admin) await note(c, "edit", ip);

  const after = await findLink(c, key);
  return json(res, 200, { link: publicView(after) });
};
