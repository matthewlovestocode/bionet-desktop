// @ts-check
/**
 * What this device keeps on disk: the lab's entries, and a few settings.
 *
 * One SQLite file. The entries are the truth and everything shown is worked out from them, so there
 * is no table of items or amounts to fall out of step: lose this file and the lab's web peer, or any
 * other member, hands every entry back.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * @param {string} dir - The folder to keep the file in.
 * @returns The store.
 */
export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "lab.db"));
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists entries (id text primary key, author text not null, seq integer not null, json text not null);
    create index if not exists entries_by_log on entries (author, seq);
    create table if not exists settings (name text primary key, value text not null);
  `);
  const insert = db.prepare("insert or ignore into entries (id, author, seq, json) values (?, ?, ?, ?)");
  const put = db.prepare("insert into settings (name, value) values (?, ?) on conflict(name) do update set value = excluded.value");
  const get = db.prepare("select value from settings where name = ?");

  return {
    /** @returns {import("@biolibs/bionet").SignedEntry[]} Every entry held. */
    entries() {
      return db.prepare("select json from entries order by author, seq").all().map((row) => JSON.parse(String(row["json"])));
    },
    /**
     * @param {{ id: string, signed: import("@biolibs/bionet").SignedEntry }[]} entries - Entries to keep, with their IDs.
     */
    add(entries) {
      db.exec("begin");
      try {
        for (const { id, signed } of entries) insert.run(id, signed.entry.author, signed.entry.seq, JSON.stringify(signed));
        db.exec("commit");
      } catch (cause) {
        db.exec("rollback");
        throw cause;
      }
    },
    /** @param {string} name @returns {string | null} A setting, or `null` if it was never set. */
    setting(name) {
      const row = get.get(name);
      return row === undefined ? null : String(row["value"]);
    },
    /** @param {string} name @param {string | null} value - `null` forgets it. */
    set(name, value) {
      if (value === null) db.prepare("delete from settings where name = ?").run(name);
      else put.run(name, value);
    },
    close: () => db.close(),
  };
}
