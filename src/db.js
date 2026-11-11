// Thin helpers over the D1 binding (env.DB).

const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));

export function stmt(db, sql, ...params) {
  return db.prepare(sql).bind(...clean(params));
}

export async function all(db, sql, ...params) {
  return (await stmt(db, sql, ...params).all()).results;
}

export async function first(db, sql, ...params) {
  return await stmt(db, sql, ...params).first();
}

export async function run(db, sql, ...params) {
  return await stmt(db, sql, ...params).run();
}

/** Run several statements in one round trip (and one transaction). Returns rows per statement. */
export async function batch(db, statements) {
  const res = await db.batch(statements);
  return res.map((r) => r.results || []);
}

export const now = () => new Date().toISOString();
export const addSeconds = (s, from = Date.now()) => new Date(from + s * 1000).toISOString();

/** "2026-11-01T09:12:40.000Z" -> "2026-11-01T09:12:40Z" (what the Python version returned). */
export function iso(t) {
  return t ? String(t).replace(/\.000Z$/, "Z") : null;
}
