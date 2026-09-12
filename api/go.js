// Resolves /go/<key> against the database and redirects.
//
// This is the endpoint printed codes actually hit, so it is the one place in
// the project where latency and correctness are not negotiable — someone is
// standing in front of a poster waiting for it.
//
// A miss returns a real 404 page rather than an empty response or, worse, a
// redirect somewhere arbitrary. An unknown key must never become an open
// redirect.
const { db, validKey, clientIp } = require("./_db.js");

function escapeHtml(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(res, status, title, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    "<title>" + escapeHtml(title) + "</title>" +
    "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;" +
    "font:15px/1.6 system-ui,-apple-system,sans-serif;background:#08090a;color:#f4f4f5;" +
    "padding:24px;text-align:center}h1{font-size:17px;font-weight:600;margin:0 0 8px}" +
    "p{margin:0 0 16px;color:#8a8f99;font-size:13.5px}" +
    "a{color:#6a83ff;text-decoration:none}</style></head><body><div>" +
    body +
    "</div></body></html>"
  );
}

module.exports = async function handler(req, res) {
  const key = String((req.query && req.query.key) || "").toLowerCase();

  if (!validKey(key)) {
    return page(res, 404, "Unknown code — Qode",
      "<h1>This code doesn't point anywhere</h1>" +
      "<p>The address it carries isn't one this site recognises.</p>" +
      '<a href="/">Go to Qode</a>');
  }

  let row;
  try {
    const r = await db().execute({
      sql: "SELECT url FROM links WHERE key = ? LIMIT 1",
      args: [key],
    });
    row = r.rows[0];
  } catch (e) {
    // The database being down must not look like a dead link — a visitor
    // retrying in a minute should succeed, so say so rather than 404.
    return page(res, 503, "Temporarily unavailable — Qode",
      "<h1>Can't reach this code right now</h1>" +
      "<p>Something is wrong on our side. Please try again in a moment.</p>");
  }

  if (!row) {
    return page(res, 404, "Unknown code — Qode",
      "<h1>This code doesn't point anywhere</h1>" +
      "<p>It may have been removed, or the address was mistyped.</p>" +
      '<a href="/">Go to Qode</a>');
  }

  // Fire-and-forget. A scan must not wait on a counter, and a failed count is
  // never a reason to fail the redirect.
  db().execute({ sql: "UPDATE links SET hits = hits + 1 WHERE key = ?", args: [key] })
    .catch(() => {});

  // 302, not 301: a permanent redirect gets cached by browsers and
  // intermediaries, which would defeat the entire point of being switchable.
  res.statusCode = 302;
  res.setHeader("Location", row.url);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end();
};
