package srv

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestServer(t *testing.T, configure ...func(*Server)) (*Server, *httptest.Server) {
	t.Helper()
	s, err := New(filepath.Join(t.TempDir(), "t.sqlite3"), DefaultRetention)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range configure {
		f(s)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close() })
	t.Cleanup(ts.Close)
	return s, ts
}

func do(t *testing.T, method, url string, body string, hdr map[string]string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

func bearerHdr(k string, extra ...map[string]string) map[string]string {
	h := map[string]string{"Authorization": "Bearer " + k}
	for _, e := range extra {
		for k, v := range e {
			h[k] = v
		}
	}
	return h
}

func htmlHdr(extra ...map[string]string) map[string]string {
	h := map[string]string{"Accept": "text/html"}
	for _, e := range extra {
		maps.Copy(h, e)
	}
	return h
}

// createChannel returns the channel id and K (the fragment).
func createChannel(t *testing.T, ts *httptest.Server) (id, k string) {
	t.Helper()
	key := NewK()
	ks, err := Derive(key)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"id": ks.ID, "auth_hash": b64u(AuthHash(ks.Auth))})
	resp, raw := do(t, "POST", ts.URL+"/new", string(body), nil)
	if resp.StatusCode != 303 || resp.Header.Get("Location") != "/c/"+ks.ID || strings.TrimSpace(raw) != "/c/"+ks.ID {
		t.Fatalf("client creation: %d %s", resp.StatusCode, raw)
	}
	return ks.ID, b64u(key)
}

func creationBody(t *testing.T) string {
	t.Helper()
	ks, err := Derive(NewK())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"id": ks.ID, "auth_hash": b64u(AuthHash(ks.Auth))})
	return string(body)
}

// chn is a test participant: a channel, its keys, and a name.
type chn struct {
	ts   *httptest.Server
	id   string
	k    string
	ks   Keys
	name string
}

// newSeededChannel creates a channel containing one encrypted fixture at sequence zero.
func newSeededChannel(t *testing.T, ts *httptest.Server, name string) chn {
	t.Helper()
	id, k := createChannel(t, ts)
	ks, _ := ParseK(k)
	c := chn{ts, id, k, ks, name}
	seedMessage(t, c)
	return c
}

// seedMessage supplies a real encrypted message for transport tests needing a nonempty log.
func seedMessage(t *testing.T, c chn) {
	t.Helper()
	if resp, body := c.request(t, "POST", "&last=-1", &Inner{From: "Fixture", Text: "fixture"}); resp.StatusCode != 200 {
		t.Fatalf("seed: %d %s", resp.StatusCode, body)
	}
}

func (c chn) as(name string) chn { c.name = name; return c }

func (c chn) url(path string) string { return c.ts.URL + "/c/" + c.id + path }

// request makes an encrypted request, sealing locally with the Go test participant.
func (c chn) request(t *testing.T, method, q string, in *Inner) (*http.Response, string) {
	t.Helper()
	body := ""
	if in != nil {
		var pt bytes.Buffer
		enc := json.NewEncoder(&pt)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(in); err != nil {
			t.Fatal(err)
		}
		params, _ := url.ParseQuery(strings.TrimPrefix(q, "&"))
		last, _ := strconv.ParseInt(params.Get("last"), 10, 64)
		nonce, ct, err := Seal(c.ks.Enc, c.ks.ID, last+1, pt.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(map[string]string{"nonce": b64u(nonce), "ct": b64u(ct)})
		body = string(b)
	}
	return do(t, method, c.url("/events")+"?"+strings.TrimPrefix(q, "&"), body, bearerHdr(c.ks.Auth))
}

func (c chn) post(t *testing.T, last int, text string) (int, reply) {
	t.Helper()
	resp, body := c.request(t, "POST", "&last="+strconv.Itoa(last), &Inner{From: c.name, Text: text})
	return resp.StatusCode, c.decodeReply(t, body)
}

func (c chn) read(t *testing.T, since int) reply {
	t.Helper()
	resp, body := c.request(t, "GET", "&since="+strconv.Itoa(since), nil)
	if resp.StatusCode != 200 {
		t.Fatalf("read: %d %s", resp.StatusCode, body)
	}
	return c.decodeReply(t, body)
}

func (c chn) decodeReply(t *testing.T, body string) reply {
	t.Helper()
	var br eventReply
	if err := json.Unmarshal([]byte(body), &br); err != nil {
		t.Fatal(err)
	}
	rp := reply{Error: br.Error, Posted: br.Posted, ID: br.ID, Last: br.Last, More: br.More, Messages: []Message{}}
	for _, e := range br.Events {
		var pt []byte
		if b, err := ParseBlob(e.Nonce, e.CT); err == nil {
			pt, _ = Open(c.ks.Enc, c.id, e.Seq, b.Nonce, b.CT)
		}
		rp.Messages = append(rp.Messages, Render(e, pt))
	}
	return rp
}

func sealInner(t *testing.T, ks Keys, seq int64, in Inner) Blob {
	t.Helper()
	var pt bytes.Buffer
	enc := json.NewEncoder(&pt)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(in); err != nil {
		t.Fatal(err)
	}
	nonce, ct, err := Seal(ks.Enc, ks.ID, seq, pt.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	return Blob{Nonce: nonce, CT: ct}
}

func (c chn) readEnvelopes(t *testing.T) eventReply {
	t.Helper()
	_, body := c.request(t, "GET", "&since=-1", nil)
	var rp eventReply
	json.Unmarshal([]byte(body), &rp)
	return rp
}

func itoa(n int) string { return strconv.Itoa(n) }

func readFile(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func waitSubscribed(t *testing.T, s *Store, id string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		_, ok := s.waiters[id]
		s.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("poll did not subscribe")
}

// logBuffer permits concurrent handlers to log while tests inspect a snapshot.
type logBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

func captureLogs(t *testing.T) *logBuffer {
	t.Helper()
	b := &logBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(b, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return b
}
