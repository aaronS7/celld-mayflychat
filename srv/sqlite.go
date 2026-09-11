package srv

import (
	"database/sql"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"
)

// errIncompatibleSchema indicates an unmarked nonempty database or an unsupported schema version.
var errIncompatibleSchema = errors.New("incompatible database schema: choose a fresh database path with -db (for example, -db mayfly-new.sqlite3); existing data has not been migrated or deleted")

const schema = `
CREATE TABLE channels (
	id TEXT PRIMARY KEY,
	auth_hash BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	last_activity INTEGER NOT NULL
);
CREATE INDEX channels_last_activity ON channels(last_activity);
CREATE TABLE events (
	channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	ts INTEGER NOT NULL,
	src TEXT NOT NULL,
	nonce BLOB NOT NULL,
	ct BLOB NOT NULL,
	PRIMARY KEY (channel_id, seq)
);`

// openDB opens a SQLite database and prepares pragmas suitable for a small web app.
func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// One connection keeps pragmas effective and serializes CAS appends.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys=ON;"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("enable foreign keys: %w", err)
	}
	if _, err := db.Exec("PRAGMA journal_mode=wal;"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("set WAL: %w", err)
	}
	if _, err := db.Exec("PRAGMA busy_timeout=1000;"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("set busy_timeout: %w", err)
	}
	return db, nil
}

// initDB atomically creates the schema or accepts its existing version marker.
// It refuses unmarked nonempty databases and unsupported versions without migration.
func initDB(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin initialization: %w", err)
	}
	defer tx.Rollback()

	var version int
	if err := tx.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return fmt.Errorf("check schema version: %w", err)
	}
	switch version {
	case 1:
		return nil
	case 0:
		// Only an empty database may adopt the schema.
	default:
		return errIncompatibleSchema
	}
	var nonempty bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM sqlite_schema)`).Scan(&nonempty); err != nil {
		return fmt.Errorf("check empty database: %w", err)
	}
	if nonempty {
		return errIncompatibleSchema
	}
	if _, err := tx.Exec(`PRAGMA user_version=1;` + schema); err != nil {
		return fmt.Errorf("initialize schema: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit initialization: %w", err)
	}
	return nil
}
