package srv

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func requirePython(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is required for client interop tests")
	}
	if err := exec.Command("python3", "-c", "import cryptography").Run(); err != nil {
		t.Skip("the Python cryptography package is required for client interop tests")
	}
}

// savedClient downloads the client the way the instructions tell an agent to:
// once, from the running server, into a file that every later call reuses.
func savedClient(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	return savedClientSource(t, ts, "client.py", clientPy)
}

func savedClientSource(t *testing.T, ts *httptest.Server, name string, source []byte) string {
	t.Helper()
	resp, body := do(t, "GET", ts.URL+"/static/"+name, "", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("GET /static/%s: %d", name, resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Fatalf("%s content type %q", name, ct)
	}
	if body != string(source) {
		t.Fatalf("served %s differs from the embedded source", name)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// clientRun records the process's actual exit and streams, including go run's
// driver diagnostic on nonzero exits (not just the child's JSON output).
type clientRun struct {
	code   int
	stdout string
	stderr string
}

func runClient(t *testing.T, client clientProgram, url, stdin string, args ...string) clientRun {
	t.Helper()
	argv := append(append([]string(nil), client.argv[1:]...), url)
	cmd := exec.Command(client.argv[0], append(argv, args...)...)
	cmd.Dir = client.dir
	cmd.Env = append(os.Environ(), client.env...)
	cmd.Stdin = strings.NewReader(stdin)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		// Not the client's own exit: report it through the result so callers
		// on other goroutines can fail on the test's own goroutine.
		return clientRun{-1, out.String(), fmt.Sprintf("could not run the client: %v\n%s", err, errb.String())}
	}
	return clientRun{code, out.String(), errb.String()}
}

// clientReply is the JSON output shared by the standalone clients.
// It replaces encrypted events with decrypted messages.
type clientReply struct {
	Error      string    `json:"error"`
	Hint       string    `json:"hint"`
	HTTPStatus int       `json:"http_status"`
	Posted     *bool     `json:"posted"`
	ID         *int64    `json:"id"`
	Last       int64     `json:"last"`
	More       bool      `json:"more"`
	Messages   []Message `json:"messages"`
}

// decode parses one client reply and reports which keys it actually carried,
// so a null posted ("we do not know") is distinguishable from no posted at all.
func decode(t *testing.T, raw string) (clientReply, map[string]json.RawMessage) {
	t.Helper()
	var rp clientReply
	if err := json.Unmarshal([]byte(raw), &rp); err != nil {
		t.Fatalf("client output is not JSON: %v\n%s", err, raw)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &keys); err != nil {
		t.Fatal(err)
	}
	if strings.Count(strings.TrimSpace(raw), "\n") != 0 {
		t.Fatalf("client should print exactly one JSON object: %q", raw)
	}
	return rp, keys
}

func (c clientRun) ok(t *testing.T) clientReply {
	t.Helper()
	if c.code != 0 || c.stderr != "" {
		t.Fatalf("client failed: exit %d\nstdout: %s\nstderr: %s", c.code, c.stdout, c.stderr)
	}
	rp, _ := decode(t, c.stdout)
	return rp
}

// recorder proxies the client's requests to the real server so the test can
// see every request the client makes, and can drop a response mid-flight.
type recorder struct {
	target string
	mu     sync.Mutex
	reqs   []recorded
	drop   bool
}

type recorded struct {
	Method string
	Path   string
	Query  string
	Body   string
	Status int
}

func (rec *recorder) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	req, err := http.NewRequest(r.Method, rec.target+r.URL.RequestURI(), bytes.NewReader(body))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	req.Header = r.Header.Clone()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	rec.mu.Lock()
	rec.reqs = append(rec.reqs, recorded{r.Method, r.URL.Path, r.URL.RawQuery, string(body), resp.StatusCode})
	drop := rec.drop
	rec.mu.Unlock()
	if drop {
		// The write reached the server; the answer never reaches the client.
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
		return
	}
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	w.Write(out)
}

func (rec *recorder) since(n int) []recorded {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return append([]recorded(nil), rec.reqs[n:]...)
}

func (rec *recorder) count() int {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return len(rec.reqs)
}

func (rec *recorder) setDrop(v bool) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	rec.drop = v
}

// TestClientSource checks that a saved client is the complete download.
func TestClientSource(t *testing.T) {
	_, ts := newTestServer(t)
	savedClient(t, ts)
}

// TestClientCrypto runs the shipped client's own functions against the shared
// vectors: derivation, AAD binding, padding, and the placeholder ladder for
// events it cannot open or cannot believe.
func TestClientCrypto(t *testing.T) {
	requirePython(t)
	_, ts := newTestServer(t)
	client := savedClient(t, ts)
	vectors, err := filepath.Abs("static/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	script := readFile(t, "testdata/client_crypto.py")
	out, err := exec.Command("python3", "-c", script, filepath.Dir(client), vectors).CombinedOutput()
	if err != nil || !strings.HasPrefix(string(out), "ok") {
		t.Fatalf("client crypto: %v\n%s", err, out)
	}
}
