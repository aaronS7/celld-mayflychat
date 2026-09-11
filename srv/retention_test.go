package srv

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestReaper(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	a.post(t, 0, "hi")
	if n, _ := s.Store.Reap(time.Now().Add(23*time.Hour), DefaultRetention); n != 0 {
		t.Fatalf("reaped early: %d", n)
	}
	c, err := s.Store.Channel(a.id)
	if err != nil || c.ID != a.id {
		t.Fatal("channel state missing before reap")
	}
	if n, _ := s.Store.Reap(time.Now().Add(25*time.Hour), DefaultRetention); n != 1 {
		t.Fatalf("reap: %d", n)
	}
	if resp, _ := do(t, "GET", a.url(""), "", nil); resp.StatusCode != 404 {
		t.Errorf("after reap: %d", resp.StatusCode)
	}
	var n int
	s.Store.db.QueryRow(`SELECT COUNT(*) FROM events`).Scan(&n)
	if n != 0 {
		t.Errorf("events not cascaded: %d", n)
	}
	if _, err := s.Store.Channel(a.id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("channel survived reap: %v", err)
	}
}

func TestPollWakeAndReap(t *testing.T) {
	for _, reap := range []bool{false, true} {
		t.Run(fmt.Sprint("reap=", reap), func(t *testing.T) {
			s, ts := newTestServer(t)
			a := newSeededChannel(t, ts, "")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r := httptest.NewRequest("GET", a.url("/events?since=0&wait=86400"), nil).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer "+a.ks.Auth)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				w := httptest.NewRecorder()
				s.Handler().ServeHTTP(w, r)
				done <- w
			}()
			waitSubscribed(t, s.Store, a.id)
			if reap {
				if n, err := s.Store.Reap(time.Now().Add(25*time.Hour), DefaultRetention); err != nil || n != 1 {
					t.Fatalf("reap: %d (%v)", n, err)
				}
			} else {
				do(t, "GET", a.url(""), "", bearerHdr(a.k))
				if resp, b := a.request(t, "POST", "&last=0", &Inner{From: "Alpha", Text: "wake"}); resp.StatusCode != 200 {
					t.Fatalf("wake: %d %s", resp.StatusCode, b)
				}
			}
			select {
			case w := <-done:
				if reap {
					if w.Code != 404 {
						t.Fatalf("expired poll: %d %s", w.Code, w.Body.String())
					}
					s.Store.mu.Lock()
					_, leaked := s.Store.waiters[a.id]
					s.Store.mu.Unlock()
					if leaked {
						t.Fatal("awakened poll recreated deleted notifier")
					}
					return
				}
				var rp eventReply
				if err := json.Unmarshal(w.Body.Bytes(), &rp); err != nil || w.Code != 200 || rp.Last != 1 {
					t.Fatalf("poll wake: %d %s (%v)", w.Code, w.Body.String(), err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("poll did not wake")
			}
		})
	}
}

func TestReapConcurrentAppend(t *testing.T) {
	s, ts := newTestServer(t)
	for i := 0; i < 50; i++ {
		a := newSeededChannel(t, ts, "")
		now := time.Now()
		if _, err := s.Store.db.Exec(`UPDATE channels SET last_activity=? WHERE id=?`, now.Add(-25*time.Hour).Unix(), a.id); err != nil {
			t.Fatal(err)
		}
		notified := s.Store.notifyCh(a.id)
		blob := sealInner(t, a.ks, 1, Inner{From: "Alpha", Text: "alive"})
		start := make(chan struct{})
		var appendErr, reapErr error
		var deleted int64
		var wg sync.WaitGroup
		wg.Go(func() { <-start; _, _, appendErr = s.Store.Append(a.id, 0, blob, "test", now) })
		wg.Go(func() { <-start; deleted, reapErr = s.Store.Reap(now, DefaultRetention) })
		close(start)
		wg.Wait()
		if reapErr != nil {
			t.Fatal(reapErr)
		}
		c, err := s.Store.Channel(a.id)
		switch {
		case appendErr == nil:
			if deleted != 0 || err != nil {
				t.Fatalf("survivor state: deleted=%d channel=%+v err=%v", deleted, c, err)
			}
		case errors.Is(appendErr, ErrNotFound):
			if deleted != 1 || !errors.Is(err, ErrNotFound) {
				t.Fatalf("deleted state: deleted=%d channel=%+v err=%v", deleted, c, err)
			}
		default:
			t.Fatal(appendErr)
		}
		select {
		case <-notified:
		default:
			t.Fatal("append/delete failed to notify")
		}
	}
}

func TestRetentionPolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "negative.sqlite3")
	if _, err := New(path, -time.Second); err == nil {
		t.Fatal("negative retention accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("invalid config touched database: %v", err)
	}
	for _, retention := range []time.Duration{0, 1500 * time.Millisecond, 90 * time.Minute, 3 * time.Hour, DefaultRetention} {
		t.Run(retention.String(), func(t *testing.T) {
			now := time.Unix(1700000000, 0)
			s, ts := newTestServer(t, func(s *Server) {
				s.Retention = retention
				s.Now = func() time.Time { return now }
			})
			id, k := createChannel(t, ts)
			ks, _ := ParseK(k)
			a := chn{ts, id, k, ks, "Alpha"}
			initial, _ := s.Store.Channel(id)
			now = now.Add(time.Hour)
			// Reads, instructions, and wrong-key requests cannot renew lifetime.
			a.read(t, -1)
			do(t, "GET", a.url(""), "", bearerHdr(k))
			do(t, "GET", a.url("/events"), "", bearerHdr(k))
			afterRead, _ := s.Store.Channel(id)
			if !afterRead.LastActivity.Equal(initial.LastActivity) {
				t.Fatal("read extended retention")
			}
			if code, _ := a.post(t, -1, "accepted"); code != 200 {
				t.Fatal(code)
			}
			posted, _ := s.Store.Channel(id)
			if !posted.LastActivity.Equal(now) {
				t.Fatal("accepted post did not extend retention")
			}
			now = now.Add(time.Minute)
			a.post(t, -1, "conflict")
			afterConflict, _ := s.Store.Channel(id)
			if !afterConflict.LastActivity.Equal(posted.LastActivity) {
				t.Fatal("conflict extended retention")
			}
			for _, route := range []string{"", "/view", "/events", "/unknown"} {
				resp, body := do(t, "GET", ts.URL+"/c/missing"+route, "", nil)
				if resp.StatusCode != 404 || !strings.Contains(body, s.retentionText()) {
					t.Errorf("missing lifetime %s: %d %s", route, resp.StatusCode, body)
				}
			}
			_, index := do(t, "GET", ts.URL+"/", "", nil)
			_, guide := do(t, "GET", a.url(""), "", nil)
			if strings.Contains(index, s.retentionText()) {
				t.Fatal("homepage contains lifetime text")
			}
			if !strings.Contains(guide, s.retentionText()) {
				t.Fatal("guide lifetime missing")
			}
			if retention == 0 {
				if n, err := s.Store.Reap(now.Add(10*365*24*time.Hour), 0); err != nil || n != 0 {
					t.Fatalf("zero retention reaped: %d %v", n, err)
				}
				if strings.Contains(guide, "24h") || !strings.Contains(guide, "not automatically deleted") {
					t.Fatal("zero retention misrepresented")
				}
				return
			}
			for _, delta := range []time.Duration{-time.Nanosecond, 0, time.Nanosecond} {
				n, err := s.Store.Reap(posted.LastActivity.Add(retention+delta), retention)
				want := int64(0)
				if delta > 0 {
					want = 1
				}
				if err != nil || n != want {
					t.Fatalf("retention boundary %s: %d want %d: %v", delta, n, want, err)
				}
			}
		})
	}
}

func TestRetentionRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart.sqlite3")
	s, err := New(path, DefaultRetention)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0)
	if err := s.Store.CreateChannel("synthetic", []byte{1}, now); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	for _, retention := range []time.Duration{0, 48 * time.Hour, time.Hour} {
		s, err := New(path, retention)
		if err != nil {
			t.Fatal(err)
		}
		n, err := s.Store.Reap(now.Add(2*time.Hour), s.Retention)
		s.Close()
		want := int64(0)
		if retention == time.Hour {
			want = 1
		}
		if err != nil || n != want {
			t.Fatalf("new policy %s: %d want %d: %v", retention, n, want, err)
		}
	}
}
