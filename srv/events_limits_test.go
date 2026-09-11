package srv

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestBlobCaps: caps count ciphertext bytes, on the encrypted transport.
func TestBlobCaps(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	big := bytes.Repeat([]byte("x"), maxBlobBytes+1)
	nonce := make([]byte, 12)
	blob, _ := json.Marshal(map[string]string{"nonce": b64u(nonce), "ct": b64u(big)})
	if resp, _ := do(t, "POST", a.url("/events?last=0"), string(blob), bearerHdr(a.ks.Auth)); resp.StatusCode != 413 {
		t.Errorf("oversize blob: %d", resp.StatusCode)
	}
	// A 64 KiB text seals below the event cap.
	if code, _ := a.post(t, 0, strings.Repeat("é", (64<<10)/2)); code != 200 {
		t.Errorf("64 KiB text: %d", code)
	}
	// Fill the channel byte cap with CAS appends.
	ct := bytes.Repeat([]byte("x"), maxBlobBytes)
	last := int64(1)
	for {
		seq, _, err := s.Store.Append(a.id, last, Blob{Nonce: nonce, CT: ct}, "test", time.Now())
		if err == ErrChannelFull {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		last = seq
	}
	var total int64
	s.Store.db.QueryRow(`SELECT SUM(LENGTH(ct)) FROM events WHERE channel_id=?`, a.id).Scan(&total)
	if total > maxChannelBytes || total < maxChannelBytes-maxBlobBytes {
		t.Errorf("total %d", total)
	}
	small := Blob{Nonce: nonce, CT: bytes.Repeat([]byte("x"), padTo+16)} // what a short message seals to
	for {
		seq, _, err := s.Store.Append(a.id, last, small, "test", time.Now())
		if err == ErrChannelFull {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		last = seq
	}
	var top int
	s.Store.db.QueryRow(`SELECT MAX(seq) FROM events WHERE channel_id=?`, a.id).Scan(&top)
	if code, _ := a.post(t, top, "one more"); code != 429 {
		t.Errorf("full channel: %d", code)
	}
}

func TestChannelByteCapHTTP(t *testing.T) {
	now := time.Unix(1789000000, 0)
	s, ts := newTestServer(t, func(s *Server) { s.Now = func() time.Time { return now } })
	id, k := createChannel(t, ts) // Start empty so the boundary is exact.
	ks, err := ParseK(k)
	if err != nil {
		t.Fatal(err)
	}
	last := -1
	for _, tc := range []struct {
		name              string
		size, status      int
		wantLast, wantSum int
	}{
		{"first maximum event", 512 << 10, 200, 0, 512 << 10},
		{"leave one minimum event", (512 << 10) - 16, 200, 1, (1 << 20) - 16},
		{"one byte over capacity", 17, 429, 1, (1 << 20) - 16},
		{"exactly 1048576 bytes", 16, 200, 2, 1 << 20},
		{"already full", 16, 429, 2, 1 << 20},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := now.Add(-time.Hour)
			if _, err := s.Store.db.Exec(`UPDATE channels SET last_activity=? WHERE id=?`, before.Unix(), id); err != nil {
				t.Fatal(err)
			}
			blob, err := json.Marshal(map[string]string{"nonce": b64u(make([]byte, 12)), "ct": b64u(make([]byte, tc.size))})
			if err != nil {
				t.Fatal(err)
			}
			resp, body := do(t, "POST", ts.URL+"/c/"+id+"/events?last="+strconv.Itoa(last), string(blob), bearerHdr(ks.Auth))
			if resp.StatusCode != tc.status {
				t.Fatalf("post: %d %s", resp.StatusCode, body)
			}
			var reply eventReply
			if err := json.Unmarshal([]byte(body), &reply); err != nil {
				t.Fatal(err)
			}
			wantActivity := before
			if tc.status == http.StatusOK {
				wantActivity = now
				if reply.Posted == nil || !*reply.Posted || reply.ID == nil || *reply.ID != int64(tc.wantLast) || reply.Last != int64(tc.wantLast) {
					t.Fatalf("accepted post: %s", body)
				}
			} else if reply.Posted != nil || reply.Error != "channel is full (limits: 10000 events, 1048576 bytes total)" {
				t.Fatalf("capacity refusal: %s", body)
			}
			var head, count, total int
			if err := s.Store.db.QueryRow(`SELECT MAX(seq), COUNT(*), SUM(LENGTH(ct)) FROM events WHERE channel_id=?`, id).Scan(&head, &count, &total); err != nil {
				t.Fatal(err)
			}
			if head != tc.wantLast || count != tc.wantLast+1 || total != tc.wantSum {
				t.Fatalf("stored head/count/bytes: %d/%d/%d, want %d/%d/%d", head, count, total, tc.wantLast, tc.wantLast+1, tc.wantSum)
			}
			channel, err := s.Store.Channel(id)
			if err != nil || !channel.LastActivity.Equal(wantActivity) {
				t.Fatalf("activity: %+v %v, want %v", channel, err, wantActivity)
			}
			last = tc.wantLast
		})
	}
}

// TestCursorNeverAcknowledgesUnseen: a read's "last" must never exceed the
// highest seq actually returned (or "since", when nothing is returned).
func TestCursorNeverAcknowledgesUnseen(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	stop := make(chan struct{})
	blob := Blob{Nonce: make([]byte, 12), CT: make([]byte, 32)}
	go func() {
		last := int64(0)
		for {
			select {
			case <-stop:
				return
			default:
			}
			seq, _, err := s.Store.Append(a.id, last, blob, "x", time.Now())
			if err != nil {
				return
			}
			last = seq
		}
	}()
	for i := 0; i < 300; i++ {
		since := int64(i) - 1
		pg, err := s.Store.Events(a.id, since)
		if err != nil {
			t.Fatal(err)
		}
		evs, last := pg.Events, pg.Last
		if len(evs) == 0 && last > since {
			t.Fatalf("since=%d: empty but last=%d", since, last)
		}
		if len(evs) > 0 && (evs[len(evs)-1].Seq != last || evs[0].Seq != since+1) {
			t.Fatalf("since=%d: evs %d..%d last=%d", since, evs[0].Seq, evs[len(evs)-1].Seq, last)
		}
	}
	close(stop)
}

func TestPagingAndByteCap(t *testing.T) {
	now := time.Unix(1789000000, 0)
	s, ts := newTestServer(t, func(s *Server) { s.Now = func() time.Time { return now } })
	a := newSeededChannel(t, ts, "Alpha")
	blob := Blob{Nonce: make([]byte, 12), CT: bytes.Repeat([]byte("x"), maxBlobBytes)}
	// Synthetic history exceeds the configured cap, only in this disposable DB.
	// The fixture must exceed a read page to exercise byte paging.
	const fixtureBytes = 6 << 20
	n := fixtureBytes/maxBlobBytes - 1 // seq 0 (fixture) takes a little room
	before := now.Add(-time.Hour)
	if _, err := s.Store.db.Exec(`INSERT INTO events (channel_id, seq, ts, src, nonce, ct) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) SELECT ?, i, ?, 'x', ?, ? FROM n`, n, a.id, before.Unix(), blob.Nonce, blob.CT); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.db.Exec(`UPDATE channels SET last_activity=? WHERE id=?`, before.Unix(), a.id); err != nil {
		t.Fatal(err)
	}
	var originalBytes int
	if err := s.Store.db.QueryRow(`SELECT SUM(LENGTH(ct)) FROM events WHERE channel_id=?`, a.id).Scan(&originalBytes); err != nil {
		t.Fatal(err)
	}
	if originalBytes <= maxChannelBytes || originalBytes > fixtureBytes {
		t.Fatalf("oversized history fixture size: %d", originalBytes)
	}
	// A current cursor still cannot append to an already-overcap channel.
	resp, body := a.request(t, "POST", "&last="+strconv.Itoa(n), &Inner{From: "Alpha", Text: "overcap"})
	if resp.StatusCode != http.StatusTooManyRequests || !strings.Contains(body, "1048576 bytes total") {
		t.Fatalf("oversized history append: %d %s", resp.StatusCode, body)
	}
	// Paged HTTP reads preserve the complete history and acknowledge only each page.
	since, pages, got := int64(0), 0, 0
	for {
		resp, body := a.request(t, "GET", "&since="+strconv.FormatInt(since, 10), nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("oversized history read: %d %s", resp.StatusCode, body)
		}
		var pg eventReply
		if err := json.Unmarshal([]byte(body), &pg); err != nil {
			t.Fatal(err)
		}
		if len(pg.Events) == 0 {
			break
		}
		if pg.More != (pg.Last < int64(n)) {
			t.Fatalf("page since=%d: more=%v", since, pg.More)
		}
		pages++
		got += len(pg.Events)
		total := 0
		for i, e := range pg.Events {
			stored, err := ParseBlob(e.Nonce, e.CT)
			if err != nil || !bytes.Equal(stored.CT, blob.CT) || !bytes.Equal(stored.Nonce, blob.Nonce) || e.Seq != since+1+int64(i) || e.Src != "x" || e.TS != before.UTC().Format(time.RFC3339) {
				t.Fatalf("oversized history event %d changed: %v", e.Seq, err)
			}
			total += len(stored.CT)
		}
		if total > pageBytes || pg.Last != pg.Events[len(pg.Events)-1].Seq {
			t.Fatalf("page since=%d: %d bytes, %d..%d last=%d", since, total, pg.Events[0].Seq, pg.Events[len(pg.Events)-1].Seq, pg.Last)
		}
		since = pg.Last
	}
	perPage := pageBytes / maxBlobBytes
	if got != n || pages <= 1 || pages != (n+perPage-1)/perPage {
		t.Fatalf("got %d events in %d pages", got, pages)
	}
	// 409 body is paged too, on the encrypted transport.
	resp, body = a.request(t, "POST", "&last=0", &Inner{From: "Alpha", Text: "stale"})
	if resp.StatusCode != 409 || len(body) > pageBytes*4/3+pageBytes/8 {
		t.Fatalf("409: %d, %d bytes", resp.StatusCode, len(body))
	}
	var missed eventReply
	if err := json.Unmarshal([]byte(body), &missed); err != nil {
		t.Fatal(err)
	}
	if missed.Posted == nil || *missed.Posted || missed.Error != "conflict" || !missed.More || missed.Last != int64(perPage) || len(missed.Events) != perPage {
		t.Fatalf("conflict page: last=%d more=%v events=%d error=%q", missed.Last, missed.More, len(missed.Events), missed.Error)
	}
	var head, count, total int
	if err := s.Store.db.QueryRow(`SELECT MAX(seq), COUNT(*), SUM(LENGTH(ct)) FROM events WHERE channel_id=?`, a.id).Scan(&head, &count, &total); err != nil {
		t.Fatal(err)
	}
	if head != n || count != n+1 || total != originalBytes {
		t.Fatalf("oversized history history changed: head=%d count=%d bytes=%d", head, count, total)
	}
	channel, err := s.Store.Channel(a.id)
	if err != nil || !channel.LastActivity.Equal(before) {
		t.Fatalf("oversized history reads/refusals changed activity: %+v %v", channel, err)
	}
	resp, body = do(t, "DELETE", a.url(""), "", bearerHdr(a.ks.Auth))
	if resp.StatusCode != http.StatusNoContent || body != "" {
		t.Fatalf("oversized history delete: %d %s", resp.StatusCode, body)
	}
	if _, err := s.Store.Channel(a.id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("oversized history channel survived deletion: %v", err)
	}
	if err := s.Store.db.QueryRow(`SELECT COUNT(*) FROM events WHERE channel_id=?`, a.id).Scan(&count); err != nil || count != 0 {
		t.Fatalf("oversized history events survived deletion: %d %v", count, err)
	}
	// count cap
	a2 := newSeededChannel(t, ts, "Alpha")
	small := Blob{Nonce: make([]byte, 12), CT: make([]byte, 32)}
	// Bulk-fill straight into sqlite (Append's per-call SUM makes 10k calls slow).
	if _, err := s.Store.db.Exec(`INSERT INTO events (channel_id, seq, ts, src, nonce, ct) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) SELECT ?, i, 0, 'x', ?, ? FROM n`, maxEvents-2, a2.id, small.Nonce, small.CT); err != nil {
		t.Fatal(err)
	}
	if seq, _, err := s.Store.Append(a2.id, maxEvents-2, small, "x", time.Now()); err != nil || seq != maxEvents-1 {
		t.Fatalf("last slot: %d %v", seq, err)
	}
	if _, _, err := s.Store.Append(a2.id, maxEvents-1, small, "x", time.Now()); err != ErrChannelFull {
		t.Fatalf("count cap: %v", err)
	}
	pg, _ := s.Store.Events(a2.id, 0)
	if len(pg.Events) != pageEvents || !pg.More {
		t.Fatalf("event page: %d more=%v", len(pg.Events), pg.More)
	}
}

func TestActualRequestBodyBounds(t *testing.T) {
	for _, endpoint := range []string{"new", "events"} {
		for _, extra := range []int{0, 1, 10000} {
			for _, chunked := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/extra=%d/chunked=%v", endpoint, extra, chunked), func(t *testing.T) {
					s, ts := newTestServer(t)
					a := newSeededChannel(t, ts, "Alpha")
					path, limit, body, headers := "/new", maxCreateBodyBytes, creationBody(t), map[string]string(nil)
					if endpoint == "events" {
						path, limit, headers = "/c/"+a.id+"/events?last=0", maxEventBodyBytes, bearerHdr(a.ks.Auth)
						blob := sealInner(t, a.ks, 1, Inner{From: a.name, Text: "bounded"})
						raw, _ := json.Marshal(map[string]string{"nonce": b64u(blob.Nonce), "ct": b64u(blob.CT)})
						body = string(raw)
					}
					// Whitespace after valid JSON must count toward the limit too.
					body += strings.Repeat(" ", limit-len(body)+extra)
					r := httptest.NewRequest("POST", path, strings.NewReader(body))
					for k, v := range headers {
						r.Header.Set(k, v)
					}
					if chunked {
						r.ContentLength = -1
						r.TransferEncoding = []string{"chunked"}
					}
					w := httptest.NewRecorder()
					s.Handler().ServeHTTP(w, r)
					want := 413
					if extra == 0 {
						want = 303
						if endpoint == "events" {
							want = 200
						}
					}
					if w.Code != want {
						t.Fatalf("actual size %d: %d want %d: %s", len(body), w.Code, want, w.Body.String())
					}
					var channels int
					if err := s.Store.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&channels); err != nil {
						t.Fatal(err)
					}
					if extra > 0 && (channels != 1 || a.readEnvelopes(t).Last != 0) {
						t.Fatal("oversized request mutated storage")
					}
				})
			}
		}
	}
}
