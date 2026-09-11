package srv

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"sync"
	"time"
)

const (
	maxBlobBytes    = 512 << 10 // per event, decoded ciphertext bytes including the authentication tag
	maxEvents       = 10000
	maxChannelBytes = 1 << 20 // total ciphertext per channel
	pageBytes       = 1 << 20 // max ciphertext returned per read
	pageEvents      = 500     // max events returned per read
)

var (
	ErrNotFound    = errors.New("not found")
	ErrBadAuth     = errors.New("bad bearer")
	ErrConflict    = errors.New("conflict")
	ErrTooBig      = errors.New("event too large")
	ErrChannelFull = errors.New("channel full")
	ErrBadBlob     = errors.New("bad blob")
	ErrExists      = errors.New("channel exists")
	ErrRestarting  = errors.New("restarting")
)

// Channel is the metadata stored for a channel.
type Channel struct {
	ID           string
	AuthHash     []byte
	LastActivity time.Time
}

// AuthHash returns sha256(bearer), the only form of the bearer the server stores.
func AuthHash(bearer string) []byte {
	h := sha256.Sum256([]byte(bearer))
	return h[:]
}

// CheckAuth reports whether bearer is this channel's client-derived bearer.
func (c Channel) CheckAuth(bearer string) bool {
	return bearer != "" && subtle.ConstantTimeCompare(AuthHash(bearer), c.AuthHash) == 1
}

// Store owns channel transactions and long-poll notifications.
// It knows nothing about HTTP; handlers call it and map its errors to responses.
type Store struct {
	db      *sql.DB
	mu      sync.Mutex
	waiters map[string]chan struct{}
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db, waiters: make(map[string]chan struct{})}
}

// Close releases the database.
func (s *Store) Close() error {
	return s.db.Close()
}

// notifyCh returns a channel closed the next time channel id changes.
func (s *Store) notifyCh(id string) <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch, ok := s.waiters[id]
	if !ok {
		ch = make(chan struct{})
		s.waiters[id] = ch
	}
	return ch
}

func (s *Store) notify(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ch, ok := s.waiters[id]; ok {
		close(ch)
		delete(s.waiters, id)
	}
}

// CreateChannel stores an empty channel. authHash is sha256(auth).
func (s *Store) CreateChannel(id string, authHash []byte, now time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM channels WHERE id=?`, id).Scan(&exists); err != nil {
		return err
	}
	if exists > 0 {
		return ErrExists
	}
	_, err = tx.Exec(`INSERT INTO channels (id, auth_hash, created_at, last_activity) VALUES (?,?,?,?)`, id, authHash, now.Unix(), now.Unix())
	if err != nil {
		return err
	}
	return tx.Commit()
}

// Channel loads a channel's metadata, or ErrNotFound.
func (s *Store) Channel(id string) (*Channel, error) {
	var c Channel
	var last int64
	err := s.db.QueryRow(`SELECT id, auth_hash, last_activity FROM channels WHERE id=?`, id).Scan(&c.ID, &c.AuthHash, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.LastActivity = time.Unix(last, 0)
	return &c, nil
}

// head returns the newest seq in a channel, -1 for an empty channel, or
// ErrNotFound. It runs inside the caller's transaction.
func head(tx *sql.Tx, channelID string) (int64, error) {
	var mx sql.NullInt64
	if err := tx.QueryRow(`SELECT MAX(seq) FROM events WHERE channel_id=?`, channelID).Scan(&mx); err != nil {
		return 0, err
	}
	if mx.Valid {
		return mx.Int64, nil
	}
	var exists int
	err := tx.QueryRow(`SELECT 1 FROM channels WHERE id=?`, channelID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return -1, err
}

// DeleteChannel authenticates bearer and atomically deletes the channel and its events.
// A successful deletion wakes the channel's long polls without changing creation credit.
func (s *Store) DeleteChannel(id, bearer string) error {
	// Keep authentication and deletion in the same transaction: a stale
	// authorization must not delete a re-created ID with a different hash.
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var c Channel
	err = tx.QueryRow(`SELECT auth_hash FROM channels WHERE id=?`, id).Scan(&c.AuthHash)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return ErrNotFound
	case err != nil:
		return err
	case !c.CheckAuth(bearer):
		return ErrBadAuth
	}
	if _, err := tx.Exec(`DELETE FROM channels WHERE id=? AND auth_hash=?`, id, c.AuthHash); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.notify(id)
	return nil
}

// Page is one bounded read of a channel's log.
type Page struct {
	Events []Event
	Last   int64 // Last is the newest returned seq, or the channel head when empty.
	More   bool  // events newer than Last exist (page was truncated)
}

// Events returns events with seq > since, paged by count and ciphertext bytes.
func (s *Store) Events(channelID string, since int64) (Page, error) {
	// One transaction so the event list and the "last" cursor come from the
	// same snapshot: a cursor that acknowledges an event the caller never
	// received would defeat the read-before-reply CAS.
	tx, err := s.db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Page{}, err
	}
	defer tx.Rollback()
	top, err := head(tx, channelID)
	if err != nil {
		return Page{}, err
	}
	pg := Page{Events: []Event{}, Last: top} // a since ahead of the channel learns the truth
	if top <= since {
		return pg, nil
	}
	rows, err := tx.Query(`SELECT seq, ts, src, nonce, ct FROM events WHERE channel_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`, channelID, since, top, pageEvents)
	if err != nil {
		return Page{}, err
	}
	defer rows.Close()
	// Stop once pageBytes of ciphertext have been returned (always at least
	// one event). "last" is then the seq of the final event returned, so the
	// caller pages by asking again with since=last.
	bytes := 0
	for rows.Next() {
		var e Event
		var ts int64
		var nonce, ct []byte
		if err := rows.Scan(&e.Seq, &ts, &e.Src, &nonce, &ct); err != nil {
			return Page{}, err
		}
		if len(pg.Events) > 0 && bytes+len(ct) > pageBytes {
			break
		}
		bytes += len(ct)
		e.TS = time.Unix(ts, 0).UTC().Format(time.RFC3339)
		e.Nonce, e.CT = b64u(nonce), b64u(ct)
		pg.Events = append(pg.Events, e)
	}
	if err := rows.Err(); err != nil {
		return Page{}, err
	}
	if n := len(pg.Events); n > 0 && pg.Events[n-1].Seq < top {
		pg.Last = pg.Events[n-1].Seq
		pg.More = true
	}
	return pg, nil
}

// WaitEvents returns a page, waiting up to wait for events with seq > since.
// Closing done cancels the client's wait; closing stopping returns ErrRestarting.
func (s *Store) WaitEvents(channelID string, since int64, wait time.Duration, done, stopping <-chan struct{}) (Page, error) {
	deadline := time.Now().Add(wait)
	for {
		select {
		case <-stopping:
			return Page{}, ErrRestarting
		default:
		}
		ch := s.notifyCh(channelID) // subscribe before reading to avoid lost wakeups
		pg, err := s.Events(channelID, since)
		if errors.Is(err, ErrNotFound) {
			// A deleted poll may have subscribed again before discovering deletion.
			s.notify(channelID)
		}
		if err != nil || len(pg.Events) > 0 {
			return pg, err
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return pg, nil
		}
		t := time.NewTimer(remaining)
		select {
		case <-ch:
			t.Stop()
		case <-t.C:
			return pg, nil
		case <-done:
			t.Stop()
			return pg, nil
		case <-stopping:
			t.Stop()
			return Page{}, ErrRestarting
		}
	}
}

// Append adds a blob only if last equals the current maximum seq.
// On ErrConflict the returned page holds events with seq > last.
func (s *Store) Append(channelID string, last int64, b Blob, src string, now time.Time) (int64, *Page, error) {
	if len(b.CT) > maxBlobBytes {
		return 0, nil, ErrTooBig
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, nil, err
	}
	defer tx.Rollback()
	cur, err := head(tx, channelID)
	if err != nil {
		return 0, nil, err
	}
	if cur != last {
		// The pool holds a single connection, so release this transaction
		// before Events opens its own; otherwise it would wait forever.
		tx.Rollback()
		pg, err := s.Events(channelID, last)
		if err != nil {
			return 0, nil, err
		}
		return 0, &pg, ErrConflict
	}
	if cur+1 >= maxEvents {
		return 0, nil, ErrChannelFull
	}
	var total sql.NullInt64
	if err := tx.QueryRow(`SELECT SUM(LENGTH(ct)) FROM events WHERE channel_id=?`, channelID).Scan(&total); err != nil {
		return 0, nil, err
	}
	if total.Int64+int64(len(b.CT)) > maxChannelBytes {
		return 0, nil, ErrChannelFull
	}
	seq := cur + 1
	if _, err := tx.Exec(`INSERT INTO events (channel_id, seq, ts, src, nonce, ct) VALUES (?,?,?,?,?,?)`,
		channelID, seq, now.Unix(), src, b.Nonce, b.CT); err != nil {
		return 0, nil, err
	}
	if _, err := tx.Exec(`UPDATE channels SET last_activity=? WHERE id=?`, now.Unix(), channelID); err != nil {
		return 0, nil, err
	}
	if err := tx.Commit(); err != nil {
		return 0, nil, err
	}
	s.notify(channelID)
	return seq, nil, nil
}

// Reap deletes channels idle longer than retention and wakes their long polls.
// A zero retention disables deletion; negative retention is invalid.
// It returns the number deleted.
func (s *Store) Reap(now time.Time, retention time.Duration) (int64, error) {
	if retention < 0 {
		return 0, errors.New("retention must not be negative")
	}
	if retention == 0 {
		return 0, nil
	}
	cutoff := now.Add(-retention)
	// Stored activity is in whole seconds. Round the exclusive bound up so
	// fractional retention durations still compare correctly to those times.
	bound := cutoff.Unix()
	if cutoff.Nanosecond() != 0 {
		bound++
	}
	rows, err := s.db.Query(`DELETE FROM channels WHERE last_activity<? RETURNING id`, bound)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, id := range ids {
		s.notify(id)
	}
	return int64(len(ids)), nil
}
