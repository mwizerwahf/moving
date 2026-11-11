#!/usr/bin/env node
// Command line tasks against the D1 database (replaces "python -m app.manage").
//
//   npm run manage -- create-user admin            (asks for the password; Cloudflare database)
//   npm run manage -- create-user admin --local    (the local database used by "npm run dev")
//
// Devices, API tokens and webhooks are managed in the web interface (Settings).
import { execSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";

const DB_NAME = "car-gateway";
// Must match PBKDF2_ITERATIONS in src/config.js (default 50000).
const ITERATIONS = 50000;

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function hashPassword(password, iterations = ITERATIONS) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2_sha256$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

const sqlString = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function d1Execute(sql, where) {
  // Write the SQL to a file so the password hash never appears in the process list. A short
  // relative name, because on Windows the command goes through a shell (no quoting problems).
  const file = `.manage-${process.pid}.sql`;
  writeFileSync(file, sql);
  try {
    // Every part of this command is a fixed value from this script (no user input).
    execSync(`npx wrangler d1 execute ${DB_NAME} ${where} --file=${file} --yes`, { stdio: "inherit" });
  } finally {
    unlinkSync(file);
  }
}

async function createUser(username, where, passwordArg) {
  if (!username) throw new Error("usage: create-user <name> [--local] [--password ...]");
  let pw = passwordArg;
  if (!pw) {
    pw = await ask("Password (12+ characters): ", true);
    if (pw.length >= 12 && pw !== (await ask("Again: ", true))) throw new Error("Passwords do not match.");
  }
  if (pw.length < 12) throw new Error("Password must be 12 characters or more.");
  d1Execute(
    `INSERT INTO users (username, pw_hash) VALUES (${sqlString(username)}, ${sqlString(hashPassword(pw))}) ` +
    "ON CONFLICT (username) DO UPDATE SET pw_hash = excluded.pw_hash;\n", where);
  console.log(`User ${username} saved (${where === "--local" ? "local" : "Cloudflare"} database).`);
}

async function main() {
  const args = process.argv.slice(2);
  const where = args.includes("--local") ? "--local" : "--remote";
  const pi = args.indexOf("--password");
  const password = pi >= 0 ? args[pi + 1] : null;
  const rest = args.filter((a, i) => !a.startsWith("--") && (pi < 0 || i !== pi + 1));
  const [cmd, name] = rest;
  if (cmd === "create-user") return createUser(name, where, password);
  console.log("Commands:\n  create-user <name> [--local]   create a web user, or reset their password");
  process.exitCode = cmd ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("manage.mjs")) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
