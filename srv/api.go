package srv

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
}

func jsonErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}

func (s *Server) storeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		jsonErr(w, http.StatusNotFound, s.missingChannelText())
	case errors.Is(err, ErrBadAuth):
		jsonErr(w, http.StatusUnauthorized, "missing or wrong bearer: use the client-derived auth value, not the URL key")
	case errors.Is(err, ErrTooBig):
		jsonErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("request or sealed event too large (ciphertext limit: %d bytes)", maxBlobBytes))
	case errors.Is(err, ErrChannelFull):
		jsonErr(w, http.StatusTooManyRequests, fmt.Sprintf("channel is full (limits: %d events, %d bytes total)", maxEvents, maxChannelBytes))
	case errors.Is(err, ErrTooManyChans):
		jsonErr(w, http.StatusTooManyRequests, "channel creation rate limit reached; try again later")
	case errors.Is(err, ErrBadBlob):
		jsonErr(w, http.StatusBadRequest, `body must be JSON {"nonce":"<base64url 12 bytes>","ct":"<base64url>"}`)
	default:
		// The error text stays out of the log: database errors can echo
		// request-derived values, and the log policy admits no such strings.
		slog.Error("internal request failure")
		jsonErr(w, http.StatusInternalServerError, "internal error")
	}
}

// bearer returns the Authorization bearer token, or "".
func bearer(r *http.Request) string {
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(a, "Bearer "))
	}
	return ""
}

// maxWait caps the wait= parameter of reads and posts.
const maxWait = 24 * time.Hour

// parseWait reads wait=S (default 0), capped at maxWait.
func parseWait(q url.Values) (time.Duration, error) {
	v := q.Get("wait")
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, errors.New("wait must be a non-negative integer (seconds)")
	}
	return time.Duration(min(n, int(maxWait/time.Second))) * time.Second, nil
}

// parseSince reads since=N (default -1: everything).
func parseSince(q url.Values) (int64, error) {
	v := q.Get("since")
	if v == "" {
		return -1, nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < -1 {
		return 0, errors.New("since must be an integer >= -1")
	}
	return n, nil
}

// parseLast reads the required CAS cursor.
func parseLast(v string) (int64, error) {
	if v == "" {
		return 0, errors.New("missing last=N (the id of the newest event you have read)")
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < -1 {
		return 0, errors.New("last must be an integer >= -1")
	}
	return n, nil
}

// channel loads a channel without inspecting credentials.
func (s *Server) channel(r *http.Request) (*Channel, error) {
	return s.Store.Channel(r.PathValue("id"))
}

// authorizeEvents authenticates the client-derived bearer against its stored hash.
func (s *Server) authorizeEvents(w http.ResponseWriter, r *http.Request) (*Channel, bool) {
	c, err := s.channel(r)
	if err != nil {
		s.storeErr(w, err)
		return nil, false
	}
	if !c.CheckAuth(bearer(r)) {
		s.storeErr(w, ErrBadAuth)
		return nil, false
	}
	return c, true
}

const (
	maxCreateBodyBytes = 4096
	maxEventBodyBytes  = maxBlobBytes*4/3 + 1024
)

// readBody rejects actual oversized bodies, including chunked requests.
func (s *Server) readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err == nil {
		return body, true
	}
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		jsonErr(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("request body too large (limit: %d bytes)", limit))
	} else {
		jsonErr(w, http.StatusBadRequest, "cannot read request body")
	}
	return nil, false
}

// handleNew stores the public metadata of a client-generated channel.
func (s *Server) handleNew(w http.ResponseWriter, r *http.Request) {
	body, ok := s.readBody(w, r, maxCreateBodyBytes)
	if !ok {
		return
	}
	var in struct {
		ID       string `json:"id"`
		AuthHash string `json:"auth_hash"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		jsonErr(w, http.StatusBadRequest, `body must be JSON {"id","auth_hash"}; generate the key locally`)
		return
	}
	idBytes, err := unb64u(in.ID)
	if err != nil || len(idBytes) != idLen || b64u(idBytes) != in.ID {
		jsonErr(w, http.StatusBadRequest, "id must be 16 bytes as 22 chars of unpadded base64url: HKDF(K, \"mayfly id\")")
		return
	}
	authHash, err := unb64u(in.AuthHash)
	if err != nil || len(authHash) != sha256.Size {
		jsonErr(w, http.StatusBadRequest, "auth_hash must be 32 bytes as unpadded base64url: sha256 of the base64url auth string")
		return
	}
	now := s.Now()
	err = s.quota.charge(s.clientIP(r), now, func() error {
		return s.Store.CreateChannel(in.ID, authHash, now)
	})
	if errors.Is(err, ErrExists) {
		jsonErr(w, http.StatusConflict, "a channel with this id exists")
		return
	}
	if err != nil {
		s.storeErr(w, err)
		return
	}
	note(r, "created", true)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Location", "/c/"+in.ID)
	w.WriteHeader(http.StatusSeeOther)
	fmt.Fprintln(w, "/c/"+in.ID)
}

// handleDelete deletes a channel and its events for any bearer holder.
func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	noteUnknownParams(r)
	if err := s.Store.DeleteChannel(r.PathValue("id"), bearer(r)); err != nil {
		s.storeErr(w, err)
		return
	}
	note(r, "deleted", true)
	w.WriteHeader(http.StatusNoContent)
}

// eventReply is the body of every event response.
type eventReply struct {
	Error  string  `json:"error,omitempty"`
	Posted *bool   `json:"posted,omitempty"`
	ID     *int64  `json:"id,omitempty"`
	Last   int64   `json:"last"`
	More   bool    `json:"more"`
	Events []Event `json:"events"`
}

func (s *Server) writeEvents(w http.ResponseWriter, code int, rp eventReply) {
	if rp.Events == nil {
		rp.Events = []Event{}
	}
	writeJSON(w, code, rp)
}

// handleGetEvents serves one page of events after since, optionally waiting for new ones.
func (s *Server) handleGetEvents(w http.ResponseWriter, r *http.Request) {
	noteUnknownParams(r, "since", "wait")
	c, ok := s.authorizeEvents(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	since, err := parseSince(q)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	wait, err := parseWait(q)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	note(r, "since", since, "wait", wait.Seconds())
	pg, err := s.Store.WaitEvents(c.ID, since, wait, r.Context().Done(), s.stopping)
	if errors.Is(err, ErrRestarting) {
		writeRestarting(w, false)
		return
	}
	if err != nil {
		s.storeErr(w, err)
		return
	}
	if r.Context().Err() != nil {
		note(r, "client_gone", true)
	}
	note(r, "n", len(pg.Events), "last", pg.Last)
	s.writeEvents(w, http.StatusOK, eventReply{Last: pg.Last, More: pg.More, Events: pg.Events})
}

// handlePostEvent appends one envelope by compare-and-swap on last, then
// optionally waits for replies to it.
func (s *Server) handlePostEvent(w http.ResponseWriter, r *http.Request) {
	noteUnknownParams(r, "last", "wait")
	c, ok := s.authorizeEvents(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	last, err := parseLast(q.Get("last"))
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	wait, err := parseWait(q)
	if err != nil {
		jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	body, ok := s.readBody(w, r, maxEventBodyBytes)
	if !ok {
		return
	}
	var in struct{ Nonce, CT string }
	if err := json.Unmarshal(body, &in); err != nil {
		s.storeErr(w, ErrBadBlob)
		return
	}
	b, err := ParseBlob(in.Nonce, in.CT)
	if err != nil {
		s.storeErr(w, err)
		return
	}
	note(r, "wait", wait.Seconds(), "len", len(b.CT), "last", last)
	seq, missed, err := s.Store.Append(c.ID, last, b, s.clientIP(r), s.Now())
	if errors.Is(err, ErrConflict) {
		note(r, "conflict_behind", len(missed.Events), "channel_last", missed.Last)
		f := false
		s.writeEvents(w, http.StatusConflict, eventReply{Error: "conflict", Posted: &f, Last: missed.Last, More: missed.More, Events: missed.Events})
		return
	}
	if err != nil {
		s.storeErr(w, err)
		return
	}
	note(r, "id", seq)
	pg, err := s.Store.WaitEvents(c.ID, seq, wait, r.Context().Done(), s.stopping)
	switch {
	case errors.Is(err, ErrRestarting):
		// The append committed. Acknowledge it without waiting for replies or
		// claiming a later cursor that the client has not received.
		pg = Page{Last: seq}
	case err != nil:
		s.storeErr(w, err)
		return
	}
	if r.Context().Err() != nil {
		note(r, "client_gone", true)
	}
	note(r, "n", len(pg.Events))
	t := true
	s.writeEvents(w, http.StatusOK, eventReply{Posted: &t, ID: &seq, Last: pg.Last, More: pg.More, Events: pg.Events})
}

// Event is one stored ciphertext envelope and server-supplied metadata.
// The server does not interpret CT.
type Event struct {
	Seq   int64  `json:"seq"`
	TS    string `json:"ts"` // RFC3339, server time
	Src   string `json:"src"`
	Nonce string `json:"nonce"` // base64url
	CT    string `json:"ct"`    // base64url
}

// Blob is the ciphertext half of an event, as posted.
type Blob struct {
	Nonce []byte
	CT    []byte
}

// ParseBlob validates the wire form {"nonce","ct"}.
func ParseBlob(nonce, ct string) (Blob, error) {
	n, err := unb64u(nonce)
	if err != nil || len(n) != nonceLen {
		return Blob{}, ErrBadBlob
	}
	c, err := unb64u(ct)
	if err != nil || len(c) < 16 {
		return Blob{}, ErrBadBlob
	}
	if len(c) > maxBlobBytes {
		return Blob{}, ErrTooBig
	}
	return Blob{Nonce: n, CT: c}, nil
}
