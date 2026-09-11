package srv

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBrowserPollRecovery(t *testing.T) {
	requireNode(t)
	script, err := browserFS.ReadFile("browser/poll.js")
	if err != nil {
		t.Fatal(err)
	}
	runNode(t, readFile(t, "testdata/poll_recovery_setup.cjs")+string(script)+readFile(t, "testdata/poll_recovery_bindings.cjs")+readFile(t, "testdata/poll_recovery_checks.cjs"))
}

func TestBrowserPollNetwork(t *testing.T) {
	chrome := os.Getenv("CHROME_BIN")
	if chrome == "" {
		t.Skip("set CHROME_BIN for actual fetch/body cancellation and delivery tests")
	}
	s, ts := newTestServer(t, func(s *Server) { s.Retention = 0 })
	id, key := createChannel(t, ts)
	_, page := do(t, "GET", ts.URL+"/c/"+id, "", htmlHdr())
	page = replaceStartup(t, page, readFile(t, "testdata/poll_network.js"))
	var mu sync.Mutex
	var nextStall string
	var reads, stalled, canceled int
	result := make(chan string, 1)
	app := s.Handler()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/test-result":
			b, _ := io.ReadAll(r.Body)
			result <- string(b)
			return
		case "/test-stall":
			mu.Lock()
			nextStall = r.URL.Query().Get("phase")
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		case "/test-state":
			mu.Lock()
			defer mu.Unlock()
			json.NewEncoder(w).Encode(map[string]int{"reads": reads, "stalled": stalled, "canceled": canceled})
			return
		case "/c/" + id:
			if r.Method == "GET" {
				w.Header().Set("Content-Type", "text/html")
				io.WriteString(w, page)
				return
			}
		case "/c/" + id + "/events":
			if r.Method == "GET" {
				mu.Lock()
				reads++
				phase := nextStall
				nextStall = ""
				if phase != "" {
					stalled++
				}
				mu.Unlock()
				if phase != "" {
					if phase == "restart" {
						writeRestarting(w, false)
						return
					}
					if phase == "body" {
						w.Header().Set("Content-Type", "application/json")
						io.WriteString(w, `{"last":`)
						http.NewResponseController(w).Flush()
					}
					<-r.Context().Done()
					mu.Lock()
					canceled++
					mu.Unlock()
					return
				}
			}
		}
		app.ServeHTTP(w, r)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, chrome, "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--user-data-dir="+t.TempDir(), server.URL+"/c/"+id+"#"+key)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); cmd.Wait() }()
	select {
	case got := <-result:
		if !strings.Contains(got, `"ok":true`) {
			t.Fatal(got)
		}
		t.Log(got)
	case <-ctx.Done():
		t.Fatal("browser poll test timed out")
	}
}
