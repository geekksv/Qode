// Creates the schema and seeds any links that already exist.
//
// Safe to run repeatedly: every statement is IF NOT EXISTS, and the seed only
// inserts keys that are missing. It never overwrites a live destination.
require("./load-env.js");
const { db, normaliseUrl, validKey } = require("../api/_db.js");

const SEED = process.argv.slice(2).reduce((acc, arg) => {
  const i = arg.indexOf("=");
  if (i > 0) acc[arg.slice(0, i)] = arg.slice(i + 1);
  return acc;
}, {});

(async () => {
  const c = db();

  await c.execute(`
    CREATE TABLE IF NOT EXISTS links (
      key         TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      hits        INTEGER NOT NULL DEFAULT 0
    )
  `);

  // One row per IP per window. Cheap, and it means the limit survives a
  // function cold start, which an in-memory counter would not.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS writes (
      ip      TEXT NOT NULL,
      at      INTEGER NOT NULL
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS writes_ip_at ON writes (ip, at)`);

  console.log("db: schema ready");

  const now = Date.now();
  for (const [key, raw] of Object.entries(SEED)) {
    const url = normaliseUrl(raw);
    if (!validKey(key) || !url) {
      console.error("db: skipped invalid seed " + key + " = " + raw);
      continue;
    }
    const r = await c.execute({
      sql: "INSERT INTO links (key, url, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING",
      args: [key, url, now, now],
    });
    console.log("db: seed " + key + " -> " + url + (r.rowsAffected ? " (inserted)" : " (already present, left alone)"));
  }

  const rows = await c.execute("SELECT key, url, hits FROM links ORDER BY key");
  console.log("db: " + rows.rows.length + " link(s):");
  for (const row of rows.rows) console.log("    " + row.key + "  ->  " + row.url + "  (" + row.hits + " hits)");
})().catch((e) => {
  console.error("db: FAILED — " + e.message);
  process.exit(1);
});
