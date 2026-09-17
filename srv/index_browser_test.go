package srv

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestIndexBrowser checks layout, scripts, and requests in Chrome at phone and desktop widths.
// Only the document loads, nothing overflows, and creation is always enabled.
// Set CHROME_BIN to run it.
func TestIndexBrowser(t *testing.T) {
	chrome := os.Getenv("CHROME_BIN")
	if chrome == "" {
		t.Skip("set CHROME_BIN to a Chrome/Chromium executable for real DOM/network tests")
	}
	for _, tc := range []struct {
		name  string
		width int
		dark  bool
	}{
		{"light-phone", 390, false}, {"dark-phone", 390, true},
		{"light-desktop", 1280, false}, {"dark-desktop", 1280, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newTestServer(t)
			var mu sync.Mutex
			var requests []string
			result := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/test-result":
					b, _ := io.ReadAll(r.Body)
					result <- string(b)
				case "/test-frame":
					w.Header().Set("Content-Type", "text/html")
					io.WriteString(w, strings.NewReplacer("EXPECT_DARK", strconv.FormatBool(tc.dark), "EXPECT_WIDTH", strconv.Itoa(tc.width)).Replace(readFile(t, "testdata/index_frame.html")))
				default:
					mu.Lock()
					requests = append(requests, r.URL.RequestURI())
					mu.Unlock()
					s.Handler().ServeHTTP(withoutCSPForDOMTests{w}, r)
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 60*time.Second)
			defer cancel()
			startBrowser(t, ctx, browserPage{Chrome: chrome, URL: server.URL + "/test-frame", Dark: tc.dark})
			var got struct {
				OK          bool   `json:"ok"`
				Error       string `json:"error"`
				Disabled    bool   `json:"disabled"`
				Visible     bool   `json:"visible"`
				Scripts     int    `json:"scripts"`
				NewChannel  bool   `json:"newChannel"`
				ScrollWidth int    `json:"scrollWidth"`
				InnerWidth  int    `json:"innerWidth"`
				Dark        bool   `json:"dark"`
				Background  string `json:"background"`
				BrandOK     bool   `json:"brandOK"`
				FooterOK    bool   `json:"footerOK"`
				Focusable   int    `json:"focusable"`
			}
			select {
			case raw := <-result:
				if err := json.Unmarshal([]byte(raw), &got); err != nil || !got.OK {
					t.Fatalf("browser: %s %v", raw, err)
				}
				t.Log(raw)
			case <-ctx.Done():
				t.Fatal("browser test timed out")
			}
			if got.Disabled || !got.Visible {
				t.Errorf("creation button disabled=%v visible=%v", got.Disabled, got.Visible)
			}
			if got.Scripts == 0 || !got.NewChannel {
				t.Errorf("public creation lacks scripts: scripts=%d newChannel=%v", got.Scripts, got.NewChannel)
			}
			if got.ScrollWidth > got.InnerWidth || got.InnerWidth != tc.width {
				t.Errorf("horizontal overflow or wrong viewport at %dpx: scrollWidth %d, innerWidth %d", tc.width, got.ScrollWidth, got.InnerWidth)
			}
			if got.Dark != tc.dark {
				t.Fatalf("scheme under test: dark=%v", got.Dark)
			}
			if want := map[bool]string{false: "rgb(246, 234, 217)", true: "rgb(25, 14, 25)"}[tc.dark]; got.Background != want {
				t.Errorf("desert theme background %q, want %q", got.Background, want)
			}
			if !got.BrandOK || !got.FooterOK {
				t.Errorf("shared shell: brand=%v footer=%v", got.BrandOK, got.FooterOK)
			}
			if got.Focusable < 6 {
				t.Errorf("keyboard reach: %d focusable controls", got.Focusable)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(requests) != 1 || requests[0] != "/" {
				t.Fatalf("landing page must fetch only its document: %v", requests)
			}
		})
	}
}

// TestIndexNativeNavigationBrowser uses trusted Chrome input, not synthetic DOM clicks.
func TestIndexNativeNavigationBrowser(t *testing.T) {
	chrome := os.Getenv("CHROME_BIN")
	if chrome == "" {
		t.Skip("set CHROME_BIN to a Chrome/Chromium executable for native navigation tests")
	}
	requireNode(t)
	s, ts := newTestServer(t)
	channel := newSeededChannel(t, ts, "Fixture")
	deleted := newSeededChannel(t, ts, "Deleted fixture")
	if response, _ := do(t, "DELETE", deleted.url(""), "", bearerHdr(deleted.ks.Auth)); response.StatusCode != http.StatusNoContent {
		t.Fatalf("delete fixture: %d", response.StatusCode)
	}
	// A second local origin exercises ordinary external Markdown links without
	// depending on a public site or changing their native target behavior.
	external := ts.URL + "/docs/about.md"
	if status, _ := channel.post(t, 0, "[A document]("+external+")"); status != http.StatusOK {
		t.Fatal(status)
	}
	var mu sync.Mutex
	creates := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/test-creates" {
			mu.Lock()
			defer mu.Unlock()
			io.WriteString(w, strconv.Itoa(creates))
			return
		}
		if r.Method == "POST" && r.URL.Path == "/new" {
			mu.Lock()
			creates++
			mu.Unlock()
		}
		s.Handler().ServeHTTP(w, r)
	}))
	defer server.Close()
	config, _ := json.Marshal(map[string]string{
		"chrome": chrome, "host": server.URL, "profile": t.TempDir(),
		"channel": "/c/" + channel.id + "#" + channel.k, "external": external,
		"missing": "/c/" + deleted.id + "#" + deleted.k,
	})
	// This fixture exercises 18 creation gestures plus ordinary navigation in
	// one Chrome process. Allow enough time on a small VM with the race detector;
	// the per-step readiness assertions still bound individual failures.
	t.Log(runNodeWithin(t, "const config="+string(config)+";\n"+readFile(t, "testdata/chrome.cjs")+readFile(t, "testdata/chrome_navigation.cjs")+readFile(t, "testdata/index_native_navigation.cjs"), 180*time.Second))
}
