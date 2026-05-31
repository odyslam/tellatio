/**
 * Minimal synchronous SQLite driver shim.
 *
 * tellatio runs in two runtimes: the worker is compiled and run under Node
 * (`node dist/index.js`), while the CLI is executed under Bun (`bun src/cli.ts`).
 * `better-sqlite3` is a native Node addon that Bun does not support
 * (https://github.com/oven-sh/bun/issues/4290), and `bun:sqlite` only exists under
 * Bun. This shim exposes a single synchronous interface backed by `better-sqlite3`
 * on Node and `bun:sqlite` on Bun, so the state layer never has to care which
 * runtime it is in.
 *
 * Both backends use positional `?` parameters and support multi-statement `exec`.
 * Transactions are driven manually with BEGIN/COMMIT/ROLLBACK for uniform behavior.
 */

export interface SqliteStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  /** Run `fn` inside a transaction, committing on success and rolling back on throw. */
  transaction(fn: () => void): void;
  close(): void;
}

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function applyPragmas(driver: Pick<SqliteDriver, "exec">): void {
  driver.exec("PRAGMA journal_mode = WAL");
  driver.exec("PRAGMA busy_timeout = 5000");
  driver.exec("PRAGMA foreign_keys = ON");
}

function makeTransaction(exec: (sql: string) => void): (fn: () => void) => void {
  return (fn: () => void) => {
    exec("BEGIN");
    try {
      fn();
      exec("COMMIT");
    } catch (err) {
      exec("ROLLBACK");
      throw err;
    }
  };
}

function openNodeDriver(path: string): SqliteDriver {
  // require (not import) so tsc does not resolve the module at compile time and so
  // it is only loaded on the Node path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  const db = new Database(path);

  const exec = (sql: string) => db.exec(sql);
  applyPragmas({ exec });

  return {
    exec,
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => {
          stmt.run(...params);
        },
        get: (...params) => stmt.get(...params),
        all: (...params) => stmt.all(...params),
      };
    },
    transaction: makeTransaction(exec),
    close: () => db.close(),
  };
}

function openBunDriver(path: string): SqliteDriver {
  // `bun:sqlite` only exists under Bun; require keeps it off the Node code path.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Database } = require("bun:sqlite");
  const db = new Database(path, { create: true });

  const exec = (sql: string) => db.exec(sql);
  applyPragmas({ exec });

  return {
    exec,
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => {
          stmt.run(...params);
        },
        // bun:sqlite returns null for no row; normalize to undefined to match
        // better-sqlite3.
        get: (...params) => stmt.get(...params) ?? undefined,
        all: (...params) => stmt.all(...params),
      };
    },
    transaction: makeTransaction(exec),
    close: () => db.close(),
  };
}

export function openDriver(path: string): SqliteDriver {
  return isBun() ? openBunDriver(path) : openNodeDriver(path);
}
