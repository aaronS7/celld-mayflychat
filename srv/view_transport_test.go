package srv

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestBrowserTransport runs the served channel script against the real relay:
// derived bearers, expiry, CAS conflicts, command folding, Python
// interoperability, and the composer's input checks. The page posts under a
// long self-asserted name so grouping and header bounds see a realistic worst case.
func TestBrowserTransport(t *testing.T) {
	requireNode(t)
	requirePython(t)
	_, ts := newTestServer(t, func(s *Server) {
		old := time.Now().Add(-23 * time.Hour)
		s.Now = func() time.Time { return old }
	})
	a := newSeededChannel(t, ts, "Go")
	client := savedClient(t, ts)
	resp, html := do(t, "GET", a.url(""), "", htmlHdr())
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	script := inlineScript(t, html, "app")
	expMatch := regexp.MustCompile(`id="exp" datetime="([^"]+)"`).FindStringSubmatch(html)
	if len(expMatch) != 2 {
		t.Fatal("expiry datetime missing")
	}
	cfg := map[string]string{"host": ts.URL, "url": a.url(""), "key": a.k, "expires": expMatch[1], "client": client,
		"retentionMS": "86400000", "src": a.read(t, -1).Messages[0].Src, "name": "zo\u00eb " + strings.Repeat("\u00e9", 400)}
	config, _ := json.Marshal(cfg)
	// Run the served script with WebCrypto and a small DOM stub. Fetches use
	// the real server; controlled decrypt delays exercise concurrent folds.
	prelude := readFile(t, "testdata/view_transport_setup.cjs")
	checks := readFile(t, "testdata/view_transport_checks.cjs")
	runNode(t, "const config="+string(config)+";\n"+prelude+script+checks)
	// Every event the page wrote opens with the channel key alone.
	undecryptable, invalid := 0, 0
	for _, m := range a.read(t, -1).Messages {
		switch m.Text {
		case "(undecryptable message)":
			undecryptable++
		case "(invalid message)":
			invalid++
		}
	}
	if undecryptable != 0 || invalid != 0 {
		t.Fatalf("browser events unreadable by a key holder: %d undecryptable, %d invalid", undecryptable, invalid)
	}
}
