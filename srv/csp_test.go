package srv

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// TestBrowserCSP exercises the real response headers and unchanged documents.
// Unlike the iframe-based sanitizer/layout fixtures, it neither rewrites HTML
// nor strips CSP, grants test scripts a nonce, or enables a CDP CSP bypass.
func TestBrowserCSP(t *testing.T) {
	chrome := os.Getenv("CHROME_BIN")
	if chrome == "" {
		t.Skip("set CHROME_BIN for enforced CSP tests in Chrome")
	}
	requireNode(t)
	s, ts := newTestServer(t)
	channel := newSeededChannel(t, ts, "CSP peer")
	var mu sync.Mutex
	requests := map[string]int{}
	creates := 0
	imageReferer := ""
	parent := `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><iframe id="target"></iframe>`
	probes := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/csp-parent" {
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, parent) // An unrestricted parent; the child keeps its real CSP.
			return
		}
		mu.Lock()
		requests[r.URL.Path]++
		if r.URL.Path == "/probe/consented.png" {
			imageReferer = r.Header.Get("Referer")
		}
		mu.Unlock()
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if strings.HasSuffix(r.URL.Path, ".png") {
			w.Header().Set("Content-Type", "image/png")
			png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6u0AAAAASUVORK5CYII=")
			w.Write(png)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, "<!doctype html><title>Probe reached</title>")
	}))
	defer probes.Close()
	app := s.Handler()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/csp-state":
			mu.Lock()
			defer mu.Unlock()
			json.NewEncoder(w).Encode(map[string]any{"requests": requests, "creates": creates})
			return
		case "/csp-parent":
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, parent)
			return
		case "/probe/self-script.js":
			mu.Lock()
			requests[r.URL.Path]++
			mu.Unlock()
			w.Header().Set("Content-Type", "text/javascript")
			io.WriteString(w, "window.csp.executed.push('self-script')")
			return
		}
		if r.Method == "POST" && r.URL.Path == "/new" {
			mu.Lock()
			creates++
			mu.Unlock()
		}
		app.ServeHTTP(w, r)
	}))
	defer server.Close()
	// Prepare a peer's second event, but deliver it only after the real browser
	// poll has rendered the fixture. Browser code is not used to fake a delivery.
	plain, _ := json.Marshal(Inner{From: "CSP peer", Text: "**Polled under CSP**\n\n![first](" + probes.URL + "/probe/consented.png)\n\n![second](" + probes.URL + "/probe/unconsented.png)\n\n<img src=\"" + probes.URL + "/probe/raw.png\">"})
	nonce, ciphertext, err := Seal(channel.ks.Enc, channel.id, 1, plain)
	if err != nil {
		t.Fatal(err)
	}
	post, _ := json.Marshal(map[string]string{"nonce": b64u(nonce), "ct": b64u(ciphertext)})
	config, _ := json.Marshal(map[string]string{
		"chrome": chrome, "profile": t.TempDir(), "host": server.URL,
		"channel": "/c/" + channel.id + "#" + channel.k,
		"missing": "/c/" + strings.Repeat("A", 22), "probe": probes.URL,
		"post": string(post), "auth": channel.ks.Auth,
	})
	t.Log(runNode(t, "const config="+string(config)+";\n"+readFile(t, "testdata/chrome.cjs")+readFile(t, "testdata/chrome_navigation.cjs")+readFile(t, "testdata/csp.cjs")))
	mu.Lock()
	defer mu.Unlock()
	if !maps.Equal(requests, map[string]int{"/probe/consented.png": 1}) || imageReferer != "" || creates != 1 {
		t.Fatalf("CSP network evidence: requests=%v, image referer=%q, creates=%d", requests, imageReferer, creates)
	}
}

func TestContentSecurityPolicy(t *testing.T) {
	s, ts := newTestServer(t)
	id, key := createChannel(t, ts)
	ks, err := ParseK(key)
	if err != nil {
		t.Fatal(err)
	}
	const base = "default-src 'none'; connect-src 'self'; img-src http: https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	seen := map[string]bool{}
	for _, tc := range []struct {
		path            string
		status, scripts int
	}{
		{"/", 200, 1}, {"/c/" + id, 200, 4}, {"/c/NOPE", 404, 0}, {"/docs/about.md", 200, 3},
	} {
		t.Run(tc.path, func(t *testing.T) {
			for range 2 {
				resp, page := do(t, "GET", ts.URL+tc.path, "", htmlHdr())
				if resp.StatusCode != tc.status {
					t.Fatalf("status: %d", resp.StatusCode)
				}
				policy := resp.Header.Get("Content-Security-Policy")
				match := regexp.MustCompile(`; script-src 'nonce-([A-Za-z0-9_-]+)'`).FindStringSubmatch(policy)
				if len(match) != 2 {
					t.Fatalf("missing script nonce: %q", policy)
				}
				nonce := match[1]
				random, err := unb64u(nonce)
				if err != nil || len(random) != 32 || seen[nonce] {
					t.Fatalf("invalid or reused CSP nonce %q", nonce)
				}
				seen[nonce] = true
				if policy != base+"; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'" || resp.Header.Get("Content-Security-Policy-Report-Only") != "" {
					t.Fatalf("wrong enforced policy: %q", policy)
				}
				scripts, styles := 0, 0
				for _, element := range regexp.MustCompile(`(?s)<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>`).FindAllString(page, -1) {
					tag, _, _ := strings.Cut(element, ">")
					if !strings.Contains(tag, ` nonce="`+nonce+`"`) {
						t.Errorf("missing matching nonce: %s", tag)
					}
					if strings.HasPrefix(tag, "<script") {
						scripts++
					} else {
						styles++
					}
				}
				if scripts != tc.scripts || styles == 0 {
					t.Fatalf("script/style counts: %d/%d", scripts, styles)
				}
				markup := regexp.MustCompile(`(?s)<script\b[^>]*>.*?</script>`).ReplaceAllString(page, "")
				if regexp.MustCompile(`\s(?:on[a-z]+|style)\s*=`).MatchString(markup) {
					t.Error("inline event handler or style attribute cannot run under CSP")
				}
			}
		})
	}
	for _, path := range []string{"/docs/about.md", "/docs/missing.md", "/llms.txt", "/emoji.txt", "/static/client.py", "/static/create.mjs", "/c/" + id, "/c/" + id + "/events", "/missing"} {
		resp, _ := do(t, "GET", ts.URL+path, "", bearerHdr(ks.Auth))
		if got := resp.Header.Get("Content-Security-Policy"); got != base {
			t.Errorf("plain/API %s: %q", path, got)
		}
	}
	close(s.stopping)
	resp, _ := do(t, "GET", ts.URL+"/", "", htmlHdr())
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("Content-Security-Policy") != base {
		t.Fatalf("restart response policy: %d %v", resp.StatusCode, resp.Header)
	}
}
