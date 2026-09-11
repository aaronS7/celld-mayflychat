package srv

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type creatorProgram struct {
	name string
	argv []string
	dir  string
	env  []string
}

func downloadedCreator(t *testing.T, name string) creatorProgram {
	t.Helper()
	filename, runtime := "", ""
	switch name {
	case "Python":
		requirePython(t)
		filename, runtime = "create.py", "python3"
	case "Node":
		requireNode(t)
		filename, runtime = "create.mjs", "node"
	case "Go":
		filename, runtime = "create.go", "go"
	default:
		t.Fatalf("unknown creator %q", name)
	}
	if _, err := exec.LookPath(runtime); err != nil {
		t.Fatalf("%s required for creator tests: %v", runtime, err)
	}
	source, err := os.ReadFile(filepath.Join("static", filename))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, filename)
	if err := os.WriteFile(path, source, 0o644); err != nil {
		t.Fatal(err)
	}
	p := creatorProgram{name: name, argv: []string{runtime, path}, dir: dir}
	if name == "Go" {
		if !bytes.HasPrefix(source, []byte("//go:build ignore\n")) {
			t.Fatal("standalone Go source must be excluded from package builds")
		}
		p.argv, p.env = []string{"go", "run", path}, offlineGoEnv
	}
	return p
}

func runCreator(t *testing.T, creator creatorProgram, args ...string) clientRun {
	t.Helper()
	cmd := exec.Command(creator.argv[0], append(append([]string(nil), creator.argv[1:]...), args...)...)
	cmd.Dir, cmd.Env = creator.dir, append(os.Environ(), creator.env...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	if exit, ok := err.(*exec.ExitError); ok {
		code = exit.ExitCode()
	} else if err != nil {
		return clientRun{-1, out.String(), fmt.Sprintf("could not run the creator: %v\n%s", err, errb.String())}
	}
	return clientRun{code, out.String(), errb.String()}
}

func createdURL(t *testing.T, raw string) (*url.URL, Keys) {
	t.Helper()
	if strings.Count(raw, "\n") != 1 || !strings.HasSuffix(raw, "\n") {
		t.Fatalf("creator must print one URL plus newline: %q", raw)
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		t.Fatal(err)
	}
	keys, err := ParseK(u.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "http" && u.Scheme != "https" || u.Path != "/c/"+keys.ID || u.RawQuery != "" || u.User != nil {
		t.Fatalf("not a canonical channel URL: %q", raw)
	}
	return u, keys
}

// TestCreatorPrograms keeps the creation protocol at its own small entry point:
// a fresh local K, one POST /new, and a locally constructed capability URL.
func TestCreatorPrograms(t *testing.T) {
	for _, name := range []string{"Python", "Node", "Go"} {
		t.Run(name, func(t *testing.T) {
			creator := downloadedCreator(t, name)
			var calls atomic.Int64
			var mu sync.Mutex
			var observed struct {
				headers http.Header
				body    []byte
				method  string
				path    string
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				body, _ := io.ReadAll(r.Body)
				mu.Lock()
				observed = struct {
					headers http.Header
					body    []byte
					method  string
					path    string
				}{r.Header.Clone(), body, r.Method, r.URL.RequestURI()}
				mu.Unlock()
				// An unusable Location and non-JSON body must not influence the URL.
				w.Header().Set("Location", "https://elsewhere.invalid/not-a-channel")
				w.WriteHeader(http.StatusSeeOther)
				fmt.Fprint(w, "not json")
			}))
			defer server.Close()

			got := runCreator(t, creator, server.URL+"/")
			if got.code != 0 || got.stderr != "" {
				t.Fatalf("creator failed: exit %d stdout %q stderr %q", got.code, got.stdout, got.stderr)
			}
			u, keys := createdURL(t, got.stdout)
			if u.Scheme+"://"+u.Host != server.URL || calls.Load() != 1 {
				t.Fatalf("output %q, requests %d", got.stdout, calls.Load())
			}
			mu.Lock()
			headers, body, method, path := observed.headers, observed.body, observed.method, observed.path
			mu.Unlock()
			if method != http.MethodPost || path != "/new" || headers.Get("Authorization") != "" {
				t.Fatalf("request = %s %s auth=%q", method, path, headers.Get("Authorization"))
			}
			var request map[string]string
			if err := json.Unmarshal(body, &request); err != nil {
				t.Fatal(err)
			}
			if len(request) != 2 || request["id"] != keys.ID || request["auth_hash"] != b64u(AuthHash(keys.Auth)) {
				t.Fatalf("creation body = %#v", request)
			}
			if bytes.Contains(body, []byte(u.Fragment)) || bytes.Contains(body, []byte(keys.Auth)) {
				t.Fatal("creation request disclosed K or bearer")
			}
			if len(keys.ID) != 22 || len(keys.Auth) != 43 {
				t.Fatalf("bad derivation lengths: %+v", keys)
			}
		})
	}
}

func TestCreatorRequestAndFailures(t *testing.T) {
	for _, name := range []string{"Python", "Node", "Go"} {
		t.Run(name, func(t *testing.T) {
			creator := downloadedCreator(t, name)
			for _, tc := range []struct {
				name   string
				status int
			}{
				{"NoLocation", http.StatusSeeOther},
				{"BadRequest", http.StatusBadRequest}, {"Forbidden", http.StatusForbidden},
				{"Conflict", http.StatusConflict}, {"RateLimited", http.StatusTooManyRequests},
				{"ServerError", http.StatusInternalServerError}, {"UnexpectedOK", http.StatusOK},
				{"Restarting", http.StatusServiceUnavailable},
			} {
				t.Run(tc.name, func(t *testing.T) {
					var calls atomic.Int64
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						calls.Add(1)
						w.WriteHeader(tc.status)
						fmt.Fprint(w, "plain malformed response")
					}))
					defer server.Close()
					got := runCreator(t, creator, server.URL)
					if tc.status == http.StatusSeeOther {
						if got.code != 0 || got.stderr != "" {
							t.Fatalf("303 without Location: %+v", got)
						}
						createdURL(t, got.stdout)
					} else {
						want := fmt.Sprintf("create: HTTP %d\n", tc.status)
						if tc.status == http.StatusServiceUnavailable {
							want = "create: HTTP 503: Server temporarily unavailable; try again shortly.\n"
						}
						if name == "Go" {
							want += "exit status 1\n"
						}
						if got.code != 1 || got.stdout != "" || got.stderr != want {
							t.Fatalf("HTTP %d: exit %d stdout %q stderr %q", tc.status, got.code, got.stdout, got.stderr)
						}
					}
					if calls.Load() != 1 {
						t.Fatalf("HTTP %d made %d requests", tc.status, calls.Load())
					}
				})
			}
		})
	}
}

func TestCreatorOriginRefusals(t *testing.T) {
	badOrigins := []string{"ftp://example.test", "http://user@example.test", "http://example.test/x", "http://example.test?x", "http://example.test#x", "http://example.test\\x", "http://example.test:bad"}
	for _, name := range []string{"Python", "Node", "Go"} {
		t.Run(name, func(t *testing.T) {
			creator := downloadedCreator(t, name)
			for _, origin := range badOrigins {
				got := runCreator(t, creator, origin)
				if got.code == 0 || got.stdout != "" || got.stderr == "" {
					t.Errorf("%q: exit %d stdout %q stderr %q", origin, got.code, got.stdout, got.stderr)
				}
			}
			help := runCreator(t, creator, "--help")
			if help.code != 0 || help.stdout == "" || help.stderr != "" {
				t.Errorf("help: %+v", help)
			}
			missing := runCreator(t, creator)
			if missing.code == 0 || missing.stdout != "" || missing.stderr == "" {
				t.Errorf("missing origin: %+v", missing)
			}
		})
	}
}

// TestCreatorInteroperability creates a real channel in a fresh synthetic
// Mayfly server, then proves each existing read/post runtime can use it.
func TestCreatorInteroperability(t *testing.T) {
	_, server := newTestServer(t)
	for _, creatorName := range []string{"Python", "Node", "Go"} {
		t.Run(creatorName, func(t *testing.T) {
			created := runCreator(t, downloadedCreator(t, creatorName), server.URL)
			if created.code != 0 || created.stderr != "" {
				t.Fatalf("create: %+v", created)
			}
			channelURL, _ := createdURL(t, created.stdout)
			last := -1
			for _, clientName := range []string{"Python", "Node", "Go"} {
				client := downloadedProgram(t, server, clientName, true)
				if page := runClient(t, client, channelURL.String(), "", "read", "--last", strconv.Itoa(last)).ok(t); page.Last != int64(last) {
					t.Fatalf("%s read: %+v", clientName, page)
				}
				text := creatorName + " created; " + clientName + " posted"
				page := runClient(t, client, channelURL.String(), text, "post", "--from", clientName, "--last", strconv.Itoa(last)).ok(t)
				if page.ID == nil || *page.ID != int64(last+1) {
					t.Fatalf("%s post: %+v", clientName, page)
				}
				last++
			}
		})
	}
}

func TestCreatorSourcesStayNarrow(t *testing.T) {
	for _, name := range []string{"create.py", "create.mjs", "create.go"} {
		source, err := os.ReadFile(filepath.Join("static", name))
		if err != nil {
			t.Fatal(err)
		}
		for _, required := range []string{"mayfly id", "mayfly auth", "auth_hash", "/new"} {
			if !bytes.Contains(source, []byte(required)) {
				t.Errorf("%s lacks %q", name, required)
			}
		}
		if name == "create.go" && !bytes.Contains(source, []byte("TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{}")) {
			t.Error("create.go must explicitly disable HTTP/2 protocol handlers")
		}
		for _, forbidden := range []string{"AES", "client.py", "client.mjs", "client.go", "subprocess", "child_process", "os/exec"} {
			if bytes.Contains(source, []byte(forbidden)) {
				t.Errorf("%s unexpectedly contains %q", name, forbidden)
			}
		}
	}
	// TestCreatorPrograms compares each generated URL's K-derived ID and auth
	// hash with Derive; TestVectors supplies the fixed derivation fixtures.
}

func TestCreatorRestart(t *testing.T) {
	for _, name := range []string{"Python", "Node", "Go"} {
		t.Run(name, func(t *testing.T) {
			creator := downloadedCreator(t, name)
			s, ts := newTestServer(t)
			rec := &recorder{target: ts.URL}
			proxy := httptest.NewServer(http.HandlerFunc(rec.serve))
			t.Cleanup(proxy.Close)
			close(s.stopping)
			got := runCreator(t, creator, proxy.URL)
			want := "create: HTTP 503: Server temporarily unavailable; try again shortly.\n"
			if name == "Go" {
				want += "exit status 1\n"
			}
			if got.code != 1 || got.stdout != "" || got.stderr != want {
				t.Fatalf("restart must not fabricate a URL: %+v", got)
			}
			if reqs := rec.since(0); len(reqs) != 1 || reqs[0].Method != "POST" || reqs[0].Path != "/new" || reqs[0].Status != 503 {
				t.Fatalf("restart must not retry: %+v", reqs)
			}
		})
	}
}

func TestCreatorIncompleteResponses(t *testing.T) {
	for _, name := range []string{"Python", "Node", "Go"} {
		t.Run(name, func(t *testing.T) {
			creator := downloadedCreator(t, name)
			for _, status := range []int{0, http.StatusSeeOther, http.StatusServiceUnavailable} {
				t.Run(strconv.Itoa(status), func(t *testing.T) {
					var calls atomic.Int64
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						calls.Add(1)
						io.Copy(io.Discard, r.Body)
						if status == 0 {
							conn, _, err := w.(http.Hijacker).Hijack()
							if err != nil {
								t.Error(err)
								return
							}
							conn.Close()
							return
						}
						w.Header().Set("Content-Length", "100")
						w.WriteHeader(status)
						fmt.Fprint(w, `{"error":"restarting"}`)
					}))
					t.Cleanup(server.Close)
					got := runCreator(t, creator, server.URL)
					lines := 1
					if name == "Go" {
						lines++
						if !strings.HasSuffix(got.stderr, "exit status 1\n") {
							t.Fatalf("missing go run diagnostic: %+v", got)
						}
					}
					if calls.Load() != 1 || got.code != 1 || got.stdout != "" || !strings.HasPrefix(got.stderr, "create: ") || strings.Count(got.stderr, "\n") != lines {
						t.Fatalf("incomplete response must fail without URL or retry: requests %d, %+v", calls.Load(), got)
					}
				})
			}
		})
	}
}
