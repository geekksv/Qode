// Creates the schema and brings an older one forward.
//
// Safe to run repeatedly: tables use IF NOT EXISTS and each column is added
// only when missing. It never overwrites a destination.
require("./load-env.js");
const { db, normaliseUrl, keyProblem, newEditToken, hashToken } = require("../api/_db.js");

async function columns(c, table) {
  const r = await c.execute("PRAGMA table_info(" + table + ")");
  return r.rows.map((row) => row.name);
}

async function addColumn(c, table, name, decl) {
  const have = await columns(c, table);
  if (have.includes(name)) return false;
  await c.execute("ALTER TABLE " + table + " ADD COLUMN " + name + " " + decl);
  return true;
}

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

  // One row per rate-limited action. Cheap, and it means a limit survives a
  // cold start, which an in-memory counter would not.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS writes (
      ip      TEXT NOT NULL,
      at      INTEGER NOT NULL
    )
  `);
  await c.execute(`CREATE INDEX IF NOT EXISTS writes_ip_at ON writes (ip, at)`);

  // Added when links became public: possession of the printed code cannot be
  // what proves ownership, so each link carries its own secret.
  const added = [];
  if (await addColumn(c, "links", "edit_hash", "TEXT")) added.push("edit_hash");
  if (await addColumn(c, "links", "creator_ip", "TEXT")) added.push("creator_ip");
  await c.execute(`CREATE INDEX IF NOT EXISTS links_created ON links (created_at)`);

  console.log("db: schema ready" + (added.length ? " (added " + added.join(", ") + ")" : ""));

  // Seed, for a first deploy. Existing keys are left exactly as they are.
  const seeds = process.argv.slice(2).reduce((acc, arg) => {
    const i = arg.indexOf("=");
    if (i > 0) acc[arg.slice(0, i)] = arg.slice(i + 1);
    return acc;
  }, {});

  for (const [key, raw] of Object.entries(seeds)) {
    const url = normaliseUrl(raw);
    const kp = keyProblem(key);
    if (kp || !url) {
      console.error("db: skipped " + key + " — " + (kp || "not a usable URL: " + raw));
      continue;
    }
    const now = Date.now();
    const token = newEditToken();
    const r = await c.execute({
      sql:
        "INSERT INTO links (key, url, created_at, updated_at, edit_hash) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(key) DO NOTHING",
      args: [key, url, now, now, hashToken(token)],
    });
    if (r.rowsAffected) {
      console.log("db: created " + key + " -> " + url);
      console.log("    edit key: " + token + "   (shown once)");
    } else {
      console.log("db: " + key + " already exists, left alone");
    }
  }

  const rows = await c.execute("SELECT key, url, hits, edit_hash FROM links ORDER BY key");
  console.log("db: " + rows.rows.length + " link(s):");
  for (const row of rows.rows) {
    console.log("    " + row.key + "  ->  " + row.url +
      "  (" + row.hits + " hits, " + (row.edit_hash ? "owned" : "NO EDIT KEY — admin only") + ")");
  }
})().catch((e) => {
  console.error("db: FAILED — " + e.message);
  process.exit(1);
});
