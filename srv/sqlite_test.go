package srv

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.sqlite3")
	d, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := initDB(d); err != nil {
		t.Fatal(err)
	}
	authHash := bytes.Repeat([]byte{0x91}, 32)
	nonce := bytes.Repeat([]byte{0x92}, 12)
	ciphertext := []byte{0, 0xff, 0x93, 0x94, 0, 0x95}
	const created, last, timestamp = 1788840000, 1788840300, 1788840300
	const source = "2001:db8::42"
	if _, err := d.Exec(`INSERT INTO channels (id, auth_hash, created_at, last_activity) VALUES ('room', ?, ?, ?)`, authHash, created, last); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO events (channel_id, seq, ts, src, nonce, ct) VALUES ('room', 0, ?, ?, ?, ?)`, timestamp, source, nonce, ciphertext); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, d)
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		d, err = openDB(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := initDB(d); err != nil {
			t.Fatal(err)
		}
		if after := snapshot(t, d); after != before {
			t.Fatalf("restart %d changed database:\nbefore=%s\nafter=%s", i, before, after)
		}
		var hash, gotNonce, ct []byte
		var gotCreated, gotLast, ts int64
		var src string
		if err := d.QueryRow(`SELECT auth_hash, created_at, last_activity, ts, src, nonce, ct FROM channels JOIN events ON channels.id=events.channel_id`).Scan(&hash, &gotCreated, &gotLast, &ts, &src, &gotNonce, &ct); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(hash, authHash) || gotCreated != created || gotLast != last || ts != timestamp || src != source || !bytes.Equal(gotNonce, nonce) || !bytes.Equal(ct, ciphertext) {
			t.Fatalf("stored event changed: %x %d %d %d %q %x %x", hash, gotCreated, gotLast, ts, src, gotNonce, ct)
		}
		if err := d.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSchemaAndPragmas(t *testing.T) {
	d, err := openDB(filepath.Join(t.TempDir(), "t.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := initDB(d); err != nil {
		t.Fatal(err)
	}
	for query, want := range map[string]string{
		`SELECT group_concat(name, ',') FROM (SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name)`: "channels,events",
		`SELECT group_concat(name, ',') FROM pragma_table_info('channels')`:                                     "id,auth_hash,created_at,last_activity",
		`SELECT group_concat(name, ',') FROM pragma_table_info('events')`:                                       "channel_id,seq,ts,src,nonce,ct",
		`PRAGMA user_version`: "1",
		`PRAGMA foreign_keys`: "1",
		`PRAGMA journal_mode`: "wal",
		`PRAGMA busy_timeout`: "1000",
		`PRAGMA synchronous`:  "2", // FULL: do not trade acknowledged durability for restart speed.
	} {
		var got string
		if err := d.QueryRow(query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("%s = %q, want %q", query, got, want)
		}
	}
	if got := d.Stats().MaxOpenConnections; got != 1 {
		t.Errorf("max connections = %d, want 1", got)
	}
	if _, err := d.Exec(`INSERT INTO events VALUES ('missing', 0, 1, '192.0.2.1', X'01', X'02')`); err == nil {
		t.Fatal("accepted event without channel")
	}
	if _, err := d.Exec(`INSERT INTO channels VALUES ('room', X'01', 1, 1); INSERT INTO events VALUES ('room', 0, 1, '192.0.2.1', X'01', X'02')`); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`INSERT INTO events VALUES ('room', 0, 1, '192.0.2.2', X'03', X'04')`); err == nil {
		t.Fatal("accepted duplicate channel sequence")
	}
	if _, err := d.Exec(`DELETE FROM channels WHERE id='room'`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := d.QueryRow(`SELECT COUNT(*) FROM events`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("channel deletion left %d events", count)
	}
}

func TestIncompatibleSchemaUnchanged(t *testing.T) {
	unmarkedSchema := schema + `
		INSERT INTO channels VALUES ('room', X'01', 1, 2);
		INSERT INTO events VALUES ('room', 0, 2, '192.0.2.1', X'02', X'03');`
	for name, fixture := range map[string]string{
		"unmarked populated table":  `CREATE TABLE existing (value TEXT); INSERT INTO existing VALUES ('preserve this data');`,
		"unmarked schema":           unmarkedSchema,
		"unknown version with data": unmarkedSchema + `PRAGMA user_version=2;`,
		"unknown version empty":     `PRAGMA user_version=2;`,
		"unmarked view only":        `CREATE VIEW existing AS SELECT 1;`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "incompatible.sqlite3")
			d, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := d.Exec(fixture); err != nil {
				t.Fatal(err)
			}
			before := snapshot(t, d)
			if err := d.Close(); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				d, err = openDB(path)
				if err != nil {
					t.Fatal(err)
				}
				err = initDB(d)
				if !errors.Is(err, errIncompatibleSchema) {
					t.Fatalf("initDB = %v, want incompatible schema", err)
				}
				if !strings.Contains(err.Error(), "fresh database") || !strings.Contains(err.Error(), "-db") {
					t.Fatalf("error lacks fresh-database instruction: %v", err)
				}
				if after := snapshot(t, d); after != before {
					t.Fatalf("refusal %d changed database:\nbefore=%s\nafter=%s", i, before, after)
				}
				if err := d.Close(); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestReopenCustomizedSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "custom.sqlite3")
	d, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := initDB(d); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Exec(`
		CREATE INDEX events_timestamp ON events(ts);
		CREATE TABLE operator_notes (note TEXT);
		INSERT INTO operator_notes VALUES ('local customization');
		ALTER TABLE channels ADD COLUMN custom INTEGER NOT NULL DEFAULT 0;
	`); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, d)
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	d, err = openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := initDB(d); err != nil {
		t.Fatalf("marked database rejected after customization: %v", err)
	}
	if after := snapshot(t, d); after != before {
		t.Fatalf("customized schema changed on restart:\nbefore=%s\nafter=%s", before, after)
	}
}

func TestInitFailureRollsBack(t *testing.T) {
	d, err := openDB(filepath.Join(t.TempDir(), "full.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	// Four pages fit channels and its indexes, but not the events table.
	// Exercise a real failure partway through Init rather than a separate tx.
	if _, err := d.Exec(`PRAGMA max_page_count=4`); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, d)
	if err := initDB(d); err == nil || !strings.Contains(err.Error(), "full") {
		t.Fatalf("initDB = %v, want database full", err)
	}
	if after := snapshot(t, d); after != before {
		t.Fatalf("failed initialization persisted partial schema:\nbefore=%s\nafter=%s", before, after)
	}
	if _, err := d.Exec(`PRAGMA max_page_count=100`); err != nil {
		t.Fatal(err)
	}
	if err := initDB(d); err != nil {
		t.Fatalf("retry initialization: %v", err)
	}
}

// snapshot records the logical schema, its version, and every table's rows.
// Journal-mode changes made by Open are intentionally not part of this check.
func snapshot(t *testing.T, d *sql.DB) string {
	t.Helper()
	result := map[string][][]any{
		"schema":         queryValues(t, d, `SELECT * FROM sqlite_schema ORDER BY name`),
		"schema_version": queryValues(t, d, `PRAGMA schema_version`),
		"user_version":   queryValues(t, d, `PRAGMA user_version`),
	}
	for _, row := range queryValues(t, d, `SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name`) {
		name := row[0].(string)
		result[name] = queryValues(t, d, `SELECT * FROM "`+strings.ReplaceAll(name, `"`, `""`)+`" ORDER BY rowid`)
	}
	b, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func queryValues(t *testing.T, d *sql.DB, query string) [][]any {
	t.Helper()
	rows, err := d.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var result [][]any
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		result = append(result, values)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(fmt.Errorf("query %q: %w", query, err))
	}
	return result
}
