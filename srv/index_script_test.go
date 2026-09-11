package srv

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestBrowserIndexCreation runs the index page's real script: the key is
// generated in the browser, the server is told only the public metadata, and
// the only way back into the channel is the URL the page navigates to.
func TestBrowserIndexCreation(t *testing.T) {
	requireNode(t)
	_, ts := newTestServer(t)
	resp, html := do(t, "GET", ts.URL+"/", "", nil)
	if resp.StatusCode != 200 || strings.Contains(html, "<form") {
		t.Fatalf("index: %d %s", resp.StatusCode, html)
	}
	if !strings.Contains(html, `href="/docs/security.md"`) {
		t.Fatal("index should link the security and privacy document")
	}
	script := inlineScript(t, html, "")
	config, _ := json.Marshal(map[string]string{"host": ts.URL})
	prelude := readFile(t, "testdata/index_creation_setup.cjs")
	checks := readFile(t, "testdata/index_creation_checks.cjs")
	out := runNode(t, "const config="+string(config)+";\n"+prelude+script+checks)
	var result struct{ Destination string }
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("browser result: %v %s", err, out)
	}
	k := strings.SplitN(result.Destination, "#", 2)[1]
	ks, err := ParseK(k)
	if err != nil {
		t.Fatal(err)
	}
	created := chn{ts, ks.ID, k, ks, "Go"}
	if rp := created.read(t, -1); len(rp.Messages) != 0 || rp.Last != -1 {
		t.Fatalf("a browser-created channel starts empty: %+v", rp)
	}
}

// TestBrowserIndexNavigation exercises only the served landing script, including fragment startup.
func TestBrowserIndexNavigation(t *testing.T) {
	requireNode(t)
	_, ts := newTestServer(t)
	_, html := do(t, "GET", ts.URL+"/", "", nil)
	script := inlineScript(t, html, "")
	for _, hash := range []string{"", "#new", "#NEW", "#new-extra"} {
		t.Run("hash="+hash, func(t *testing.T) {
			config, _ := json.Marshal(map[string]string{"hash": hash})
			prelude := readFile(t, "testdata/index_navigation_setup.cjs")
			checks := readFile(t, "testdata/index_navigation_checks.cjs")
			runNode(t, "const config="+string(config)+";\n"+prelude+script+checks)
		})
	}
}
