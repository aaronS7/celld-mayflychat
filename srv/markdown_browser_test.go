package srv

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMarkdownBrowser(t *testing.T) {
	chrome := os.Getenv("CHROME_BIN")
	if chrome == "" {
		t.Skip("set CHROME_BIN to a Chrome/Chromium executable for real DOM/network tests")
	}
	checks, err := os.ReadFile("testdata/markdown.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []struct {
		name, width      string
		dark, readerOnly bool
	}{
		{"desktop-light", "1280", false, false},
		{"mobile-light", "390", false, false},
		{"reader-only-light", "390", false, true},
		{"desktop-dark", "1280", true, false},
		{"mobile-dark", "390", true, false},
		{"reader-only-dark", "390", true, true},
	} {
		t.Run(mode.name, func(t *testing.T) {
			headers := map[string]string{"Accept": "text/html"}
			width, readerOnly := mode.width, mode.readerOnly
			s, ts := newTestServer(t)
			key := NewK()
			ks, err := Derive(key)
			if err != nil {
				t.Fatal(err)
			}
			id := ks.ID
			creation, _ := json.Marshal(map[string]string{"id": id, "auth_hash": b64u(AuthHash(ks.Auth))})
			if resp, body := do(t, "POST", ts.URL+"/new", string(creation), nil); resp.StatusCode != 303 {
				t.Fatalf("create: %d %s", resp.StatusCode, body)
			}
			_, page := do(t, "GET", ts.URL+"/c/"+id, "", headers)
			page = replaceStartup(t, page, readFile(t, "browser/create.js"))
			page += fmt.Sprintf("<script>const READER_ONLY = %t, EXPECT_DARK = %t;\n", readerOnly, mode.dark) + strings.ReplaceAll(string(checks), "</script", `<\/script`) + "</script>"
			var mu sync.Mutex
			requests := []map[string]string{}
			result := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/test-result":
					b, _ := io.ReadAll(r.Body)
					result <- string(b)
				case r.URL.Path == "/test-network":
					mu.Lock()
					defer mu.Unlock()
					json.NewEncoder(w).Encode(requests)
				case strings.HasPrefix(r.URL.Path, "/probe/"):
					mu.Lock()
					requests = append(requests, map[string]string{"path": r.URL.RequestURI(), "referer": r.Header.Get("Referer")})
					mu.Unlock()
					w.Header().Set("Content-Type", "image/png")
					png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6u0AAAAASUVORK5CYII=")
					w.Write(png)
				case r.URL.Path == "/test-frame":
					w.Header().Set("Content-Type", "text/html")
					fmt.Fprintf(w, `<iframe style="border:0;width:%spx;height:900px" src="/c/%s#%s"></iframe>`, width, id, b64u(key))
				case r.Method == "GET" && r.URL.Path == "/c/"+id:
					w.Header().Set("Content-Type", "text/html")
					// No CSP or Referrer-Policy: independently verify sanitization and image consent.
					io.WriteString(w, page)
				default:
					s.Handler().ServeHTTP(w, r)
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
			defer cancel()
			startBrowser(t, ctx, browserPage{Chrome: chrome, URL: server.URL + "/test-frame", Dark: mode.dark})
			select {
			case got := <-result:
				if !strings.Contains(got, `"ok":true`) {
					t.Fatal(got)
				}
				t.Log(got)
			case <-ctx.Done():
				t.Fatal("browser test timed out")
			}
		})
	}
}
