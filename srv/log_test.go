package srv

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRequestLogging(t *testing.T) {
	buf := captureLogs(t)
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "sender-log-secret")
	a.post(t, 0, "message-log-secret")
	a.post(t, 0, "unposted-log-secret")
	do(t, "GET", a.url("/events?query-name-secret=query-value-secret&since=invalid-cursor-secret"), "", bearerHdr(a.ks.Auth))
	do(t, "POST", a.url("/events"), "", bearerHdr(a.ks.Auth))
	do(t, "GET", a.url("/path-secret"), "", bearerHdr(a.k, map[string]string{"User-Agent": "user-agent-secret"}))
	do(t, "GET", ts.URL+"/c/id-secret/path-secret", "", nil)
	do(t, "GET", ts.URL+"/unknown-root-secret", "", nil)
	do(t, "GET", ts.URL+"/docs/doc-name-secret", "", nil)
	// Test a mux redirect whose response echoes a path: the logger must not capture it.
	do(t, "GET", ts.URL+"/c/"+a.id+"//redirect-secret", "", nil)
	// CONNECT trailing-slash redirects put the request path in r.Pattern.
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest("CONNECT", "/c/connect-redirect-canary", nil))
	if w.Code != http.StatusTemporaryRedirect || w.Header().Get("Location") != "/c/connect-redirect-canary/" {
		t.Fatalf("CONNECT redirect: %d %q", w.Code, w.Header().Get("Location"))
	}
	if _, err := s.Store.db.Exec(`CREATE TRIGGER fail_logging BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'database-error-secret'); END`); err != nil {
		t.Fatal(err)
	}
	resp, body := a.request(t, "POST", "&last=1", &Inner{From: a.name, Text: "failed-post-secret"})
	if resp.StatusCode != 500 || strings.Contains(body, "database-error-secret") {
		t.Fatalf("internal error reflected details: %d %s", resp.StatusCode, body)
	}
	logs := buf.String()
	for _, want := range []string{`route="GET /c/{id}/events"`, `route="POST /c/{id}/events"`, "route=/c/{id}/{rest...}", "route=unmatched", "route=unmatched status=307", "unknown_params=1", "bad_route=true", "status=400", "status=409", "status=500", "conflict_behind=1", "channel=" + a.id[:6], "bytes=", "ms="} {
		if !strings.Contains(logs, want) {
			t.Errorf("log missing %q:\n%s", want, logs)
		}
	}
	for _, secret := range []string{a.k, a.ks.Auth, a.id, "sender-log-secret", "message-log-secret", "unposted-log-secret", "query-name-secret", "query-value-secret", "invalid-cursor-secret", "path-secret", "id-secret", "user-agent-secret", "unknown-root-secret", "doc-name-secret", "redirect-secret", "connect-redirect-canary", "database-error-secret", "failed-post-secret"} {
		if strings.Contains(logs, secret) {
			t.Errorf("log contains %q:\n%s", secret, logs)
		}
	}
}

func TestSyntheticServerArtifacts(t *testing.T) {
	logs := captureLogs(t)
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "artifact-sender-canary")
	if code, _ := a.post(t, 0, "artifact-message-canary"); code != 200 {
		t.Fatal(code)
	}
	if code, _ := a.post(t, 0, "artifact-rejected-canary"); code != 409 {
		t.Fatal(code)
	}
	// Exercise wrong-key and invalid request errors without adding plaintext rows.
	do(t, "GET", a.url("/events"), "", bearerHdr(a.k))
	do(t, "POST", a.url("/events?last=1"), `{"nonce":"artifact-invalid-canary","ct":"bad"}`, bearerHdr(a.ks.Auth))
	var seq int
	var name, path string
	if err := s.Store.db.QueryRow(`PRAGMA database_list`).Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	key, _ := unb64u(a.k)
	canaries := [][]byte{[]byte(a.k), key, a.ks.Enc, []byte(a.ks.Auth), []byte(a.url("") + "#" + a.k), []byte("artifact-sender-canary"), []byte("artifact-message-canary"), []byte("artifact-rejected-canary"), []byte("artifact-invalid-canary")}
	check := func(label string, b []byte) {
		t.Helper()
		for _, canary := range canaries {
			if bytes.Contains(b, canary) {
				t.Errorf("%s contains synthetic plaintext or usable credential", label)
			}
		}
	}
	scanFiles := func() {
		t.Helper()
		entries, err := os.ReadDir(filepath.Dir(path))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) == 0 {
			t.Fatal("no database artifacts inspected")
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			b, err := os.ReadFile(filepath.Join(filepath.Dir(path), e.Name()))
			if err != nil {
				t.Fatal(err)
			}
			check(e.Name(), b)
		}
	}
	scanFiles() // Includes live WAL and shared-memory sidecars when present.
	check("application logs", []byte(logs.String()))
	if _, err := s.Store.Reap(time.Now().Add(25*time.Hour), DefaultRetention); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		t.Fatal(err)
	}
	scanFiles()
	check("application logs after deletion", []byte(logs.String()))
}
