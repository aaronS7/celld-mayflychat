package srv

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeleteChannelAuthentication(t *testing.T) {
	s, ts := newTestServer(t)
	a, other := newSeededChannel(t, ts, "Alpha"), newSeededChannel(t, ts, "Zulu")
	before, err := s.Store.Channel(a.id)
	if err != nil {
		t.Fatal(err)
	}
	buckets := maps.Clone(s.quota.buckets)
	for name, hdr := range map[string]map[string]string{
		"missing": nil, "empty": bearerHdr(""), "wrong": bearerHdr("not-the-bearer"),
		"URL key": bearerHdr(a.k), "other channel": bearerHdr(other.ks.Auth),
		"not Bearer": {"Authorization": a.ks.Auth}, "query only": nil,
	} {
		t.Run(name, func(t *testing.T) {
			u := a.url("")
			if name == "query only" {
				u += "?token=" + a.ks.Auth
			}
			resp, body := do(t, "DELETE", u, "", hdr)
			if resp.StatusCode != http.StatusUnauthorized || !strings.Contains(body, "missing or wrong bearer") {
				t.Fatalf("unauthorized delete: %d %s", resp.StatusCode, body)
			}
		})
	}
	after, err := s.Store.Channel(a.id)
	if err != nil || !after.LastActivity.Equal(before.LastActivity) || len(a.read(t, -1).Messages) != 1 {
		t.Fatalf("unauthorized deletion changed channel: %+v %v", after, err)
	}
	// There is no creator role or identity header requirement; any capability holder can delete.
	resp, body := do(t, "DELETE", a.url(""), "", bearerHdr(a.ks.Auth))
	if resp.StatusCode != http.StatusNoContent || body != "" || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("delete: %d %q %v", resp.StatusCode, body, resp.Header)
	}
	if _, err := s.Store.Channel(a.id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted channel: %v", err)
	}
	var events int
	if err := s.Store.db.QueryRow(`SELECT COUNT(*) FROM events WHERE channel_id=?`, a.id).Scan(&events); err != nil || events != 0 {
		t.Fatalf("events did not cascade: %d %v", events, err)
	}
	if !maps.Equal(buckets, s.quota.buckets) {
		t.Fatal("delete changed creation credit")
	}
	if got := other.read(t, -1); len(got.Messages) != 1 {
		t.Fatal("delete affected another channel")
	}
	for _, route := range []string{"", "/events", "/view"} {
		if response, _ := do(t, "GET", a.url(route), "", bearerHdr(a.ks.Auth)); response.StatusCode != http.StatusNotFound {
			t.Errorf("deleted GET %s: %d", route, response.StatusCode)
		}
	}
	if response, _ := a.request(t, "POST", "&last=0", &Inner{From: "Alpha", Text: "too late"}); response.StatusCode != http.StatusNotFound {
		t.Errorf("deleted POST: %d", response.StatusCode)
	}
	for _, hdr := range []map[string]string{nil, bearerHdr(a.ks.Auth)} {
		if response, _ := do(t, "DELETE", a.url(""), "", hdr); response.StatusCode != http.StatusNotFound {
			t.Errorf("missing DELETE: %d", response.StatusCode)
		}
	}
}

func TestDeleteChannelWakesPolls(t *testing.T) {
	for _, method := range []string{"GET", "POST"} {
		t.Run(method, func(t *testing.T) {
			s, ts := newTestServer(t)
			id, key := createChannel(t, ts)
			ks, err := ParseK(key)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			u, body := ts.URL+"/c/"+id+"/events?since=-1&wait=86400", ""
			if method == "POST" {
				u = ts.URL + "/c/" + id + "/events?last=-1&wait=86400"
				blob := sealInner(t, ks, 0, Inner{From: "Alpha", Text: "waiting for replies"})
				b, err := json.Marshal(map[string]string{"nonce": b64u(blob.Nonce), "ct": b64u(blob.CT)})
				if err != nil {
					t.Fatal(err)
				}
				body = string(b)
			}
			r := httptest.NewRequest(method, u, strings.NewReader(body)).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer "+ks.Auth)
			done := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				w := httptest.NewRecorder()
				s.Handler().ServeHTTP(w, r)
				done <- w
			}()
			waitSubscribed(t, s.Store, id)
			if response, raw := do(t, "DELETE", ts.URL+"/c/"+id, "", bearerHdr(ks.Auth)); response.StatusCode != http.StatusNoContent {
				t.Fatalf("delete: %d %s", response.StatusCode, raw)
			}
			select {
			case got := <-done:
				if got.Code != http.StatusNotFound {
					t.Fatalf("deleted poll: %d %s", got.Code, got.Body.String())
				}
			case <-time.After(3 * time.Second):
				t.Fatal("delete did not wake poll")
			}
			s.Store.mu.Lock()
			_, leaked := s.Store.waiters[id]
			s.Store.mu.Unlock()
			if leaked {
				t.Fatal("deleted poll left a notifier")
			}
		})
	}
}

func TestDeleteChannelFailureIsAtomic(t *testing.T) {
	logs := captureLogs(t)
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	buckets := maps.Clone(s.quota.buckets)
	notified := s.Store.notifyCh(a.id)
	if _, err := s.Store.db.Exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'delete-database-secret'); END`); err != nil {
		t.Fatal(err)
	}
	resp, body := do(t, "DELETE", a.url(""), "delete-body-secret", bearerHdr(a.ks.Auth))
	if resp.StatusCode != http.StatusInternalServerError || strings.Contains(body, "delete-database-secret") {
		t.Fatalf("failed delete: %d %s", resp.StatusCode, body)
	}
	if _, err := s.Store.Channel(a.id); err != nil {
		t.Fatal("failed delete removed channel:", err)
	}
	if got := a.read(t, -1); len(got.Messages) != 1 {
		t.Fatal("failed delete removed events")
	}
	select {
	case <-notified:
		t.Fatal("failed deletion notified polls")
	default:
	}
	if !maps.Equal(buckets, s.quota.buckets) {
		t.Fatal("failed delete changed creation credit")
	}
	if _, err := s.Store.db.Exec(`DROP TRIGGER fail_delete`); err != nil {
		t.Fatal(err)
	}
	if response, raw := do(t, "DELETE", a.url("?delete-query-secret=delete-value-secret"), "", bearerHdr(a.ks.Auth)); response.StatusCode != http.StatusNoContent {
		t.Fatalf("retry delete: %d %s", response.StatusCode, raw)
	}
	select {
	case <-notified:
	default:
		t.Fatal("successful delete did not notify")
	}
	for _, want := range []string{`route="DELETE /c/{id}"`, "status=204", "status=500", "deleted=true", "unknown_params=1"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("delete logs lack %q: %s", want, logs.String())
		}
	}
	for _, secret := range []string{a.id, a.k, a.ks.Auth, "delete-database-secret", "delete-body-secret", "delete-query-secret", "delete-value-secret"} {
		if strings.Contains(logs.String(), secret) {
			t.Errorf("delete log contains %q", secret)
		}
	}
}

func TestDeleteChannelRecreatedID(t *testing.T) {
	s, ts := newTestServer(t)
	id, key := createChannel(t, ts)
	old, err := ParseK(key)
	if err != nil {
		t.Fatal(err)
	}
	// Retain a successful authorization from the old incarnation.
	stale, err := s.Store.Channel(id)
	if err != nil || !stale.CheckAuth(old.Auth) {
		t.Fatal("old authorization failed:", err)
	}
	if err := s.Store.DeleteChannel(id, old.Auth); err != nil {
		t.Fatal(err)
	}
	replacement, err := Derive(NewK())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Store.CreateChannel(id, AuthHash(replacement.Auth), time.Now()); err != nil {
		t.Fatal(err)
	}
	if response, body := do(t, "DELETE", ts.URL+"/c/"+id, "", bearerHdr(old.Auth)); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("stale bearer deleted re-created ID: %d %s", response.StatusCode, body)
	}
	if _, err := s.Store.Channel(id); err != nil {
		t.Fatal("replacement disappeared:", err)
	}
	if response, body := do(t, "DELETE", ts.URL+"/c/"+id, "", bearerHdr(replacement.Auth)); response.StatusCode != http.StatusNoContent {
		t.Fatalf("replacement bearer: %d %s", response.StatusCode, body)
	}
}

func TestDeleteChannelRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "delete.sqlite3")
	s, err := New(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	a := newSeededChannel(t, ts, "Alpha")
	if response, body := do(t, "DELETE", a.url(""), "", bearerHdr(a.ks.Auth)); response.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d %s", response.StatusCode, body)
	}
	ts.Close()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	for _, table := range []string{"channels", "events"} {
		var count int
		if err := restarted.Store.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("restart %s: count=%d err=%v", table, count, err)
		}
	}
	if err := restarted.Store.DeleteChannel(a.id, a.ks.Auth); !errors.Is(err, ErrNotFound) {
		t.Fatalf("restart forgot deletion: %v", err)
	}
}
