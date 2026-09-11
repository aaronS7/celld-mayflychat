package srv

import (
	"bytes"
	"encoding/json"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestDiskIsBlind checks ciphertext and hashed credentials in stored rows.
func TestDiskIsBlind(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	a.post(t, 0, "the secret word is xyzzy")
	a.request(t, "POST", "&last=1", &Inner{From: "Alpha", Text: "/title plugh"})
	rows, err := s.Store.db.Query(`SELECT c.id, c.auth_hash, e.src, e.nonce, e.ct FROM channels c JOIN events e ON e.channel_id=c.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var id, src string
		var ah, nonce, ct []byte
		if err := rows.Scan(&id, &ah, &src, &nonce, &ct); err != nil {
			t.Fatal(err)
		}
		n++
		all := id + src + string(ah) + string(nonce) + string(ct)
		for _, bad := range []string{"xyzzy", "plugh", "Alpha", a.k, a.ks.Auth} {
			if strings.Contains(all, bad) {
				t.Errorf("disk contains %q", bad)
			}
		}
		if !bytes.Equal(ah, AuthHash(a.ks.Auth)) {
			t.Error("auth_hash is not sha256(auth)")
		}
		if len(ct)%256 != 16 { // padded plaintext + GCM tag
			t.Errorf("ct length %d not a padding bucket", len(ct))
		}
	}
	if n != 3 {
		t.Errorf("events: %d", n)
	}
}

// TestEncryptedRoundTrip exercises local participant crypto against the opaque relay.
func TestEncryptedRoundTrip(t *testing.T) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	b := a.as("Bravo")

	// Post, then read and decrypt locally.
	if code, _ := a.post(t, 0, "first local post"); code != 200 {
		t.Fatal(code)
	}
	if code, rp := a.post(t, 1, "second"); code != 200 || *rp.ID != 2 {
		t.Fatal(code)
	}
	_, body := b.request(t, "GET", "&since=-1", nil)
	var br eventReply
	json.Unmarshal([]byte(body), &br)
	if br.Last != 2 || len(br.Events) != 3 {
		t.Fatalf("event read: %s", body)
	}
	var opened []Inner
	for _, e := range br.Events {
		blob, err := ParseBlob(e.Nonce, e.CT)
		if err != nil {
			t.Fatal(err)
		}
		pt, err := Open(a.ks.Enc, a.id, e.Seq, blob.Nonce, blob.CT)
		if err != nil {
			t.Fatalf("open seq %d: %v", e.Seq, err)
		}
		var in Inner
		if err := json.Unmarshal(pt, &in); err != nil {
			t.Fatal(err)
		}
		opened = append(opened, in)
	}
	if opened[0].From != "Fixture" || opened[0].Text != "fixture" || opened[1].Text != "first local post" || opened[1].From != "Alpha" || opened[2].Text != "second" {
		t.Fatalf("opened: %+v", opened)
	}
	if strings.Contains(body, "first local post") || strings.Contains(body, "Alpha") {
		t.Error("event response leaked plaintext")
	}

	// Sealed writes use CAS; the test participant decrypts locally.
	resp, body := b.request(t, "POST", "&last=2", &Inner{From: "Bravo", Text: "second participant"})
	if resp.StatusCode != 200 || !strings.HasPrefix(body, `{"posted":true,"id":3,"last":3,`) {
		t.Fatalf("event post: %d %s", resp.StatusCode, body)
	}
	// Stale write: 409 with events, no echo.
	resp, body = b.request(t, "POST", "&last=2", &Inner{From: "Bravo", Text: "stale"})
	json.Unmarshal([]byte(body), &br)
	if resp.StatusCode != 409 || br.Error != "conflict" || br.Last != 3 || len(br.Events) != 1 || br.Events[0].Seq != 3 || strings.Contains(body, "rejected") {
		t.Fatalf("event 409: %d %s", resp.StatusCode, body)
	}
	// Reactions use the same CAS as messages.
	if resp, _ := b.request(t, "POST", "&last=3", &Inner{From: "Bravo", Text: "/react 3 👀"}); resp.StatusCode != 200 {
		t.Fatalf("reaction post: %d", resp.StatusCode)
	}
	rp := a.read(t, 2)
	if len(rp.Messages) != 2 || rp.Messages[0].Text != "second participant" || rp.Messages[0].From != "Bravo" || rp.Messages[1].Text != `/react 3 👀` {
		t.Fatalf("local read of encrypted writes: %+v", rp.Messages)
	}
	// A blob for another channel (different AAD) is stored but renders as undecryptable.
	other := newSeededChannel(t, ts, "Mallory")
	pt, _ := json.Marshal(Inner{From: "Mallory", Text: "moved"})
	nonce, ct, _ := Seal(other.ks.Enc, other.id, 5, pt)
	blob, _ := json.Marshal(map[string]string{"nonce": b64u(nonce), "ct": b64u(ct)})
	if resp, _ := do(t, "POST", a.url("/events?last=4"), string(blob), bearerHdr(a.ks.Auth)); resp.StatusCode != 200 {
		t.Fatalf("foreign blob: %d", resp.StatusCode)
	}
	rp = a.read(t, 4)
	if len(rp.Messages) != 1 || rp.Messages[0].Text != "(undecryptable message)" {
		t.Fatalf("foreign blob render: %+v", rp.Messages)
	}
	// Bad blobs.
	for _, bad := range []string{`{}`, `not json`, `{"nonce":"AAAA","ct":"AAAA"}`, `{"nonce":"` + b64u(nonce) + `","ct":"AA"}`} {
		if resp, _ := do(t, "POST", a.url("/events?last=5"), bad, bearerHdr(a.ks.Auth)); resp.StatusCode != 400 {
			t.Errorf("bad blob %q: %d", bad, resp.StatusCode)
		}
	}
}

// TestRawCommands checks that the relay preserves command text and has no command routes.
// Titles, reactions, and replies are view conventions; a channel title never appears in a URL.
func TestRawCommands(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	texts := []string{" /title Release review \n", "/title", "/react 0 approved", "/react 0 approved", "/unreact 0 approved", "/react 999 future", "/react 0 " + strings.Repeat("x", 2000), "/title " + strings.Repeat("🐦", 1000), "/title two\nlines", "/react 00 bad", "  /re 0  indented\nsecond line  \n", "# Heading\n**bold** & <script>alert(1)</script>\n![pic](https://example.test/a.png)", "/re 0 **reply**\n```html\n<img src=x>\n```"}
	for i, text := range texts {
		if code, rp := a.post(t, i, text); code != 200 || *rp.ID != int64(i+1) {
			t.Fatalf("append %d: %d %+v", i, code, rp)
		}
	}
	pg := a.read(t, 0)
	for i, m := range pg.Messages {
		if m.Text != texts[i] {
			t.Fatalf("raw text changed: %q", m.Text)
		}
	}
	for _, path := range []string{"/react", "/title", "/re"} {
		if resp, _ := do(t, "POST", a.url(path+"?last=10"), "x", bearerHdr(a.ks.Auth)); resp.StatusCode != 404 {
			t.Fatal(resp.StatusCode)
		}
	}
	if resp, _ := do(t, "GET", a.url("/view/a-title"), "", nil); resp.StatusCode != 404 {
		t.Fatal("unsupported channel path")
	}
	before, _ := s.Store.Channel(a.id)
	if _, err := s.Store.Reap(before.LastActivity.Add(23*time.Hour), DefaultRetention); err != nil {
		t.Fatal(err)
	}
	if code, _ := a.post(t, len(texts), "/title"); code != 200 {
		t.Fatal(code)
	}
	_, raw := do(t, "GET", a.url("/events"), "", bearerHdr(a.ks.Auth))
	for _, field := range []string{`"present":`, `"kind":`, `"reaction":`, `"to":`, `"token":`, `"created":`} {
		if strings.Contains(raw, field) {
			t.Errorf("plaintext presentation field %s in %s", field, raw)
		}
	}
}

// TestNoRuntimeParticipantCrypto keeps the relay a blind transport. The only
// Go implementation of the participant crypto is the test participant in
// participant_test.go, which the runtime cannot reference without failing to
// build; what the compiler cannot catch is a fresh copy, so no runtime file
// may import a cipher at all.
func TestNoRuntimeParticipantCrypto(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(token.NewFileSet(), file, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range f.Imports {
			// crypto/rand supplies browser CSP nonces, not participant keys.
			if imp.Path.Value == `"crypto/aes"` || imp.Path.Value == `"crypto/cipher"` || imp.Path.Value == `"crypto/hkdf"` || imp.Path.Value == `"crypto/hmac"` {
				t.Errorf("runtime crypto import in %s: %s", file, imp.Path.Value)
			}
		}
	}
}

func TestRelabeledEvent(t *testing.T) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	original := a.readEnvelopes(t).Events[0]
	blob, err := json.Marshal(map[string]string{"nonce": original.Nonce, "ct": original.CT})
	if err != nil {
		t.Fatal(err)
	}
	// The blind relay stores opaque blobs; readers authenticate their positions.
	resp, body := do(t, "POST", a.url("/events?last=0"), string(blob), bearerHdr(a.ks.Auth))
	if resp.StatusCode != 200 {
		t.Fatalf("append: %d %s", resp.StatusCode, body)
	}
	rp := a.read(t, -1)
	if rp.Last != 1 || len(rp.Messages) != 2 || rp.Messages[0].Text != "fixture" || rp.Messages[1].Text != "(undecryptable message)" {
		t.Fatalf("relabeled event: %+v", rp)
	}
}

func TestLongSelfAssertedName(t *testing.T) {
	for _, name := range []string{strings.Repeat("a", 45) + "@example.com", strings.Repeat("é", 600) + "@example.com"} {
		t.Run(itoa(len(name)), func(t *testing.T) {
			_, ts := newTestServer(t)
			id, k := createChannel(t, ts)
			ks, _ := ParseK(k)
			a := chn{ts, id, k, ks, name}
			if pg := a.read(t, -1); pg.Last != -1 || len(pg.Messages) != 0 {
				t.Fatal("new not empty")
			}
			if code, _ := a.post(t, -1, "hello"); code != 200 {
				t.Fatal(code)
			}
			if got := a.read(t, -1).Messages[0].From; got != name {
				t.Fatalf("self-asserted sender: %q", got)
			}
		})
	}
}

func TestEnvelopeValidContent(t *testing.T) {
	_, ts := newTestServer(t)
	name := strings.Repeat(`\"`, 600)
	mixed := "\x00\x01\b\t\n\f\r\"\\<>&é你好🐦\u2028\u2029"
	texts := []string{strings.Repeat(`\`, 100<<10), strings.Repeat("\x00", 70<<10), strings.Repeat(mixed, 70000/len(mixed))}
	for i, text := range texts {
		t.Run(itoa(i), func(t *testing.T) {
			a := newSeededChannel(t, ts, name)
			if code, _ := a.post(t, 0, text); code != 200 {
				t.Fatal(code)
			}
			got := a.read(t, 0).Messages
			if len(got) != 1 || got[0].Text != text || got[0].From != name {
				t.Fatal("content changed")
			}
		})
	}
}

func TestOpaqueEnvelopeBoundary(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	for _, size := range []int{maxBlobBytes + 1, maxBlobBytes} {
		blob := Blob{Nonce: make([]byte, 12), CT: make([]byte, size)}
		body, _ := json.Marshal(map[string]string{"nonce": b64u(blob.Nonce), "ct": b64u(blob.CT)})
		resp, _ := do(t, "POST", a.url("/events?last=0"), string(body), bearerHdr(a.ks.Auth))
		want := 200
		if size > maxBlobBytes {
			want = 413
		}
		if resp.StatusCode != want {
			t.Fatalf("%d bytes: %d", size, resp.StatusCode)
		}
		if size > maxBlobBytes {
			if _, _, err := s.Store.Append(a.id, 0, blob, "test", time.Now()); err != ErrTooBig {
				t.Fatalf("store bound: %v", err)
			}
		}
	}
	pg, err := s.Store.Events(a.id, 0)
	if err != nil || len(pg.Events) != 1 {
		t.Fatal("opaque event missing")
	}
	ct, err := unb64u(pg.Events[0].CT)
	if err != nil || len(ct) != maxBlobBytes {
		t.Fatal("opaque event changed")
	}
}

// TestUnsupportedEndpoints checks that paths outside the API are 404s that
// neither echo the request nor touch the channel, and that the server never
// fills in a key or hash the client failed to supply.
func TestUnsupportedEndpoints(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	before, _ := s.Store.Channel(a.id)
	for _, path := range []string{"/messages", "/join", "/title"} {
		for _, method := range []string{"GET", "POST", "PUT"} {
			for _, key := range []string{"", a.k, a.ks.Auth} {
				resp, body := do(t, method, a.url(path)+"?last=0", "body-sentinel", bearerHdr(key))
				if resp.StatusCode != 404 || strings.Contains(body, "body-sentinel") || strings.Contains(body, a.k) {
					t.Fatalf("unsupported %s %s: %d %s", method, path, resp.StatusCode, body)
				}
			}
		}
	}
	for _, path := range []string{"/channels", "/c", "/list"} {
		if resp, _ := do(t, "GET", ts.URL+path, "", nil); resp.StatusCode != 404 {
			t.Fatalf("unexpected route %s: %d", path, resp.StatusCode)
		}
	}
	for _, body := range []string{"", " \n\t", "null", `{"key":"` + a.k + `"}`} {
		resp, raw := do(t, "POST", ts.URL+"/new", body, nil)
		if resp.StatusCode != 400 || resp.Header.Get("Location") != "" || strings.Contains(raw, a.k) {
			t.Fatalf("creation without client-derived values: %d %s", resp.StatusCode, raw)
		}
	}
	after, _ := s.Store.Channel(a.id)
	if before.LastActivity != after.LastActivity || a.readEnvelopes(t).Last != 0 {
		t.Fatal("unsupported requests changed channel")
	}
	var n int
	if err := s.Store.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("invalid creates changed storage: %d %v", n, err)
	}
}
