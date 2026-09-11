package srv

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

type clientProgram struct {
	name string
	argv []string
	dir  string
	env  []string
}

var offlineGoEnv = []string{"GO111MODULE=off", "GOWORK=off", "GOPROXY=off", "GOTOOLCHAIN=local", "GOENV=off", "GOFLAGS="}

func downloadedProgram(t *testing.T, ts *httptest.Server, name string, build bool) clientProgram {
	t.Helper()
	var source []byte
	var filename, runtime string
	switch name {
	case "Python":
		requirePython(t)
		filename, runtime, source = "client.py", "python3", clientPy
	case "Node":
		requireNode(t)
		filename, runtime, source = "client.mjs", "node", clientNode
	case "Go":
		filename, runtime, source = "client.go", "go", clientGo
	default:
		t.Fatalf("unknown client %q", name)
	}
	if _, err := exec.LookPath(runtime); err != nil {
		t.Fatalf("%s required for client tests: %v", runtime, err)
	}
	saved := savedClientSource(t, ts, filename, source)
	program := clientProgram{name: name, argv: []string{runtime, saved}, dir: filepath.Dir(saved)}
	if name != "Go" {
		return program
	}
	if !strings.HasPrefix(string(source), "//go:build ignore\n") {
		t.Fatal("standalone Go source must be excluded from package builds")
	}
	program.env = offlineGoEnv
	program.argv = []string{"go", "run", saved}
	if build {
		// One private build for the bulk suite, never an installed package.
		// Both this build and real go run use the exact downloaded source.
		binary := filepath.Join(program.dir, "client-test")
		cmd := exec.Command("go", "build", "-o", binary, saved)
		cmd.Dir, cmd.Env = program.dir, append(os.Environ(), offlineGoEnv...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build downloaded Go client: %v\n%s", err, out)
		}
		program.argv = []string{binary}
	}
	return program
}

// TestClientPrograms runs the same real-wire contract against all shipped clients.
func TestClientPrograms(t *testing.T) {
	_, ts := newTestServer(t)
	for _, name := range []string{"Python", "Node", "Go"} {
		t.Run(name, func(t *testing.T) {
			client := downloadedProgram(t, ts, name, true)
			for _, tc := range []struct {
				name string
				run  func(*testing.T, clientProgram)
			}{
				{"Wire", testClientWire},
				{"Refusals", testClientRefusals},
				{"RestartReplies", testClientRestartReplies},
				{"RestartHandlers", testClientRestartHandlers},
				{"UTF8Output", testClientUTF8Output},
				{"MalformedServerJSON", testClientMalformedServerJSON},
				{"MalformedEvents", testClientMalformedEvents},
				{"Vectors", testClientVectors},
				{"InnerFields", testClientInnerFields},
				{"NumericArguments", testClientNumericArguments},
			} {
				t.Run(tc.name, func(t *testing.T) { tc.run(t, client) })
			}
		})
	}
}

// TestClientColdLaunch exercises the user-facing interpreters outside any project.
func TestClientColdLaunch(t *testing.T) {
	_, ts := newTestServer(t)
	for _, name := range []string{"Node", "Go"} {
		t.Run(name, func(t *testing.T) {
			client := downloadedProgram(t, ts, name, false)
			client.dir = t.TempDir() // No package.json, go.mod, workspace, or install.
			rec := &recorder{target: ts.URL}
			proxy := httptest.NewServer(http.HandlerFunc(rec.serve))
			t.Cleanup(proxy.Close)
			a := newSeededChannel(t, ts, "Go")
			url := proxy.URL + "/c/" + a.id + "#" + a.k
			page := runClient(t, client, url, "", "read", "--last", "-1").ok(t)
			if page.Last != 0 || len(page.Messages) != 1 || page.Messages[0].Text != "fixture" {
				t.Fatalf("cold read: %+v", page)
			}
			stale := runClient(t, client, url, "must not land", "post", "--from", "Cold", "--last", "-1")
			wantStderr := ""
			if name == "Go" {
				wantStderr = "exit status 1\n"
			}
			if stale.code != 1 || stale.stderr != wantStderr {
				t.Fatalf("cold conflict: exit %d, stdout %q, stderr %q", stale.code, stale.stdout, stale.stderr)
			}
			if reply, _ := decode(t, stale.stdout); reply.Error != "conflict" || reply.Posted == nil || *reply.Posted || len(reply.Messages) != 1 {
				t.Fatalf("cold conflict reply: %s", stale.stdout)
			}
			start := rec.count()
			bad := runClient(t, client, url, "", "read")
			wantCode := 2
			if name == "Go" {
				wantCode = 1 // go run preserves stderr but maps child exit 2 to 1.
				if !strings.HasSuffix(bad.stderr, "exit status 2\n") {
					t.Fatalf("go run must expose its driver's usage diagnostic: %q", bad.stderr)
				}
			}
			if bad.code != wantCode || bad.stdout != "" || !strings.Contains(bad.stderr, "--last") || rec.count() != start {
				t.Fatalf("cold usage: exit %d, stdout %q, stderr %q, requests %d", bad.code, bad.stdout, bad.stderr, rec.count()-start)
			}
			if reqs := rec.since(0); len(reqs) != 2 || reqs[0].Method != "GET" || reqs[1].Status != 409 {
				t.Fatalf("cold launch requests (no retry): %+v", reqs)
			}
			if got := a.read(t, 0); len(got.Messages) != 0 {
				t.Fatalf("cold stale post was stored: %+v", got.Messages)
			}
		})
	}
}

func testClientVectors(t *testing.T, client clientProgram) {
	for i, v := range loadVectors(t) {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			var calls atomic.Int64
			stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.URL.Path != "/c/"+v.ID+"/events" || r.Header.Get("Authorization") != "Bearer "+v.Auth {
					t.Errorf("vector request: %s %s, auth %q", r.Method, r.URL, r.Header.Get("Authorization"))
				}
				// The same envelope opens at its vector position, not the next one.
				events := []map[string]any{}
				for _, seq := range []int64{v.Seq, v.Seq + 1} {
					events = append(events, map[string]any{"seq": seq, "ts": "2026-01-01T00:00:00Z", "src": "198.51.100.7", "nonce": v.Nonce, "ct": v.CT})
				}
				json.NewEncoder(w).Encode(map[string]any{"last": v.Seq + 1, "more": false, "events": events})
			}))
			t.Cleanup(stub.Close)
			page := runClient(t, client, stub.URL+"/c/"+v.ID+"#"+v.K, "", "read", "--last", "-1").ok(t)
			if calls.Load() != 1 || len(page.Messages) != 2 || page.Last != v.Seq+1 {
				t.Fatalf("vector page: %+v, requests %d", page, calls.Load())
			}
			want := Message{ID: v.Seq, TS: "2026-01-01T00:00:00Z", Src: "198.51.100.7", Text: "(invalid message)"}
			if v.Plaintext != "" {
				var inner struct{ From, Text string }
				if err := json.Unmarshal([]byte(v.Plaintext), &inner); err != nil {
					t.Fatal(err)
				}
				want.From, want.Text = inner.From, inner.Text
			}
			if page.Messages[0] != want {
				t.Fatalf("vector plaintext: got %+v, want %+v", page.Messages[0], want)
			}
			if m := page.Messages[1]; m.ID != v.Seq+1 || m.Text != "(undecryptable message)" || m.From != "" {
				t.Fatalf("vector opened at wrong position: %+v", m)
			}
		})
	}
}

func testClientInnerFields(t *testing.T, client clientProgram) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Go")
	cases := []struct {
		raw, from, text string
	}{
		{`{"from":"A","text":null}`, "", "(invalid message)"},
		{`{"from":"A","text":false}`, "", "(invalid message)"},
		{`{"from":{},"text":"x"}`, "", "(invalid message)"},
		{`{"from":"A","text":"\ud800"}`, "", "(invalid message)"},
		{`{"from":"A","text":"\udc00"}`, "", "(invalid message)"},
		{`{"from":"A\ud800","text":"x"}`, "", "(invalid message)"},
		{`{"from":"A","text":"\ud800\u0041"}`, "", "(invalid message)"},
		{`{"from":"A","text":"\udc00\ud800"}`, "", "(invalid message)"},
		{`{"from":"A","text":""}`, "A", ""},
		{`{"from":"A","text":"\ud83d\udc0b"}`, "A", "🐋"},
		{`{"from":"A","text":"literal \\ud800"}`, "A", `literal \ud800`},
		{`{"from":"A","text":"\ufeffBOM in text\ufeff"}`, "A", "\ufeffBOM in text\ufeff"},
		{`{"from":"A","text":"extra fields","other":null,"nested":{"text":7}}`, "A", "extra fields"},
		{`{"from":"A","text":"ignored surrogate","extra":"\ud800"}`, "A", "ignored surrogate"},
		{`{"From":"A","text":"wrong case"}`, "", "(invalid message)"},
		{`{"from":"A","Text":"wrong case"}`, "", "(invalid message)"},
		{"{\"from\":\"A\",\"text\":\"bad \xff byte\"}", "", "(invalid message)"},
		{"\ufeff{\"from\":\"A\",\"text\":\"BOM before JSON\"}", "", "(invalid message)"},
	}
	for i, tc := range cases {
		sealRaw(t, a, int64(i), tc.raw)
	}
	url := ts.URL + "/c/" + a.id + "#" + a.k
	page := runClient(t, client, url, "", "read", "--last", "0").ok(t)
	if len(page.Messages) != len(cases) || page.Last != int64(len(cases)) {
		t.Fatalf("inner fields page: %+v", page)
	}
	for i, tc := range cases {
		if m := page.Messages[i]; m.ID != int64(i+1) || m.From != tc.from || m.Text != tc.text {
			t.Errorf("inner %q: got %+v, want from %q text %q", tc.raw, m, tc.from, tc.text)
		}
	}
	// A leading BOM is text, not a stream marker to strip; even BOM alone
	// is nonblank under the Python/protocol whitespace definition.
	for i, text := range []string{"\ufeff", "\ufeff\nBOM preserved\ufeff"} {
		last := len(cases) + i
		runClient(t, client, url, text, "post", "--from", "A", "--last", strconv.Itoa(last)).ok(t)
		if got := a.read(t, last); len(got.Messages) != 1 || got.Messages[0].Text != text {
			t.Fatalf("stdin BOM changed: %+v", got.Messages)
		}
	}
}

func testClientNumericArguments(t *testing.T, client clientProgram) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Go")
	rec := &recorder{target: ts.URL}
	proxy := httptest.NewServer(http.HandlerFunc(rec.serve))
	t.Cleanup(proxy.Close)
	url := proxy.URL + "/c/" + a.id + "#" + a.k
	for _, tc := range []struct {
		last, wait string
		post       bool
		status     int
	}{
		{"-1", "86401", false, 200}, // Returned data avoids waiting; no client cap.
		{"-1", "9223372036854775807", false, 200},
		{"9007199254740993", "0", false, 200}, // Above JS's exact Number range.
		{"9223372036854775807", "0", false, 200},
		{"9007199254740993", "0", true, 409},
		{"9223372036854775807", "0", true, 409},
		{"-2", "0", false, 400},
		{"-2", "0", true, 400},
		{"9223372036854775808", "0", false, 400},
		{"9223372036854775808", "0", true, 400},
		{"999999999999999999999999999999999999", "0", true, 400},
		{"-1", "-1", false, 400},
		{"-1", "9223372036854775808", false, 400},
	} {
		t.Run(fmt.Sprintf("%s/%s/post=%v", tc.last, tc.wait, tc.post), func(t *testing.T) {
			start := rec.count()
			command, cursor := "read", "since"
			if tc.post {
				command, cursor = "post", "last"
			}
			got := runClient(t, client, url, "numeric", command, "--from", "A", "--last", tc.last, "--wait", tc.wait)
			reqs := rec.since(start)
			if len(reqs) != 1 || reqs[0].Query != cursor+"="+tc.last+"&wait="+tc.wait || reqs[0].Status != tc.status {
				t.Fatalf("caller integers must reach the relay exactly once: %+v; client %+v", reqs, got)
			}
			switch tc.status {
			case 200:
				got.ok(t)
			case 409:
				if got.code != 1 || got.stderr != "" {
					t.Fatalf("numeric conflict: %+v", got)
				}
				if rp, _ := decode(t, got.stdout); rp.Posted == nil || *rp.Posted || rp.Error != "conflict" {
					t.Fatalf("numeric conflict: %s", got.stdout)
				}
			default:
				if got.code != 1 || got.stdout != "" {
					t.Fatalf("numeric rejection: %+v", got)
				}
				if rp, keys := decode(t, got.stderr); rp.HTTPStatus != tc.status || rp.Error == "" || (keys["posted"] != nil) != tc.post || rp.Posted != nil {
					t.Fatalf("numeric rejection: %s", got.stderr)
				}
			}
		})
	}
}
