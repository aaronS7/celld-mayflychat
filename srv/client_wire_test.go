package srv

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

// testClientWire runs the shipped client against the real server over the
// real wire: one saved file, several channels, and the outcomes an agent has
// to act on -- accepted posts, conflicts it must read before reposting, and
// posts whose fate it cannot know.
func testClientWire(t *testing.T, client clientProgram) {
	_, ts := newTestServer(t)
	rec := &recorder{target: ts.URL}
	proxy := httptest.NewServer(http.HandlerFunc(rec.serve))
	t.Cleanup(proxy.Close)

	a := newSeededChannel(t, ts, "Go")
	url := proxy.URL + "/c/" + a.id + "#" + a.k
	run := func(stdin string, args ...string) clientRun {
		t.Helper()
		return runClient(t, client, url, stdin, args...)
	}

	// A read is one GET; it decrypts the seeded Go-sealed event and reports
	// the server's metadata beside the plaintext it recovered.
	start := rec.count()
	rp := run("", "read", "--last", "-1").ok(t)
	if len(rp.Messages) != 1 || rp.Messages[0].From != "Fixture" || rp.Messages[0].Text != "fixture" || rp.Last != 0 || rp.More {
		t.Fatalf("read: %+v", rp)
	}
	if rp.Messages[0].ID != 0 || rp.Messages[0].TS == "" || rp.Messages[0].Src == "" {
		t.Fatalf("server metadata missing: %+v", rp.Messages[0])
	}
	if reqs := rec.since(start); len(reqs) != 1 || reqs[0].Method != "GET" || reqs[0].Query != "since=-1&wait=0" {
		t.Fatalf("one read request, no retries: %+v", reqs)
	}

	// A post is one POST of raw stdin bytes, exactly as typed.
	text := "h\u00e9llo from client \U0001F44B\nline two\n  trailing spaces  "
	start = rec.count()
	rp = run(text, "post", "--from", "Py", "--last", "0").ok(t)
	if rp.Posted == nil || !*rp.Posted || rp.ID == nil || *rp.ID != 1 || rp.Last != 1 || len(rp.Messages) != 0 {
		t.Fatalf("post: %+v", rp)
	}
	if reqs := rec.since(start); len(reqs) != 1 || reqs[0].Method != "POST" || reqs[0].Query != "last=0&wait=0" {
		t.Fatalf("one post request, no retries: %+v", reqs)
	} else {
		var envelope struct{ Nonce, CT string }
		if err := json.Unmarshal([]byte(reqs[0].Body), &envelope); err != nil {
			t.Fatal(err)
		}
		nonce, ne := unb64u(envelope.Nonce)
		ct, ce := unb64u(envelope.CT)
		if ne != nil || ce != nil || len(nonce) != 12 || len(ct) < 272 || len(ct)%256 != 16 {
			t.Fatalf("post must have a 12-byte nonce, 256-byte padding, and a 16-byte tag: nonce=%d ct=%d errors=%v/%v", len(nonce), len(ct), ne, ce)
		}
	}
	// The Go fixture, holding only the same K, reads what the client wrote.
	if got := a.read(t, 0); len(got.Messages) != 1 || got.Messages[0].From != "Py" || got.Messages[0].Text != text {
		t.Fatalf("Go fixture read of the client post: %+v", got.Messages)
	}
	// Nothing the server stored is readable without K: the plaintext appears
	// nowhere in the stored envelope, and the ciphertext bytes do not contain
	// it either.
	if resp, body := do(t, "GET", a.url("/events?since=-1"), "", bearerHdr(a.ks.Auth)); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	} else {
		if strings.Contains(body, "line two") {
			t.Fatal("plaintext visible in the stored events")
		}
		var page eventReply
		if err := json.Unmarshal([]byte(body), &page); err != nil {
			t.Fatal(err)
		}
		for _, e := range page.Events {
			ct, err := unb64u(e.CT)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(ct, []byte("line two")) || bytes.Contains(ct, []byte("Fixture")) {
				t.Fatalf("event %d is not encrypted", e.Seq)
			}
		}
	}

	// A stale cursor is a conflict: exit 1, posted false, the missed events
	// decrypted so the agent can reconsider, and no write.
	start = rec.count()
	stale := run("stale text", "post", "--from", "Py", "--last", "0")
	if stale.code != 1 || stale.stderr != "" {
		t.Fatalf("conflict exit: %d %s", stale.code, stale.stderr)
	}
	conflict, keys := decode(t, stale.stdout)
	if conflict.Error != "conflict" || conflict.Posted == nil || *conflict.Posted || conflict.Last != 1 {
		t.Fatalf("conflict reply: %s", stale.stdout)
	}
	if len(conflict.Messages) != 1 || conflict.Messages[0].Text != text {
		t.Fatalf("conflict must return the missed messages: %s", stale.stdout)
	}
	if !strings.Contains(conflict.Hint, "No retry") || !strings.Contains(conflict.Hint, "final last") {
		t.Fatalf("conflict hint: %q", conflict.Hint)
	}
	if _, ok := keys["http_status"]; ok {
		t.Fatal("409 is a normal, understood answer; it should not add http_status")
	}
	if reqs := rec.since(start); len(reqs) != 1 || reqs[0].Status != 409 {
		t.Fatalf("a conflict must not be retried: %+v", reqs)
	}
	if got := a.read(t, 1); len(got.Messages) != 0 {
		t.Fatalf("the conflicting text was written anyway: %+v", got.Messages)
	}
	// Reposting with the returned last succeeds; the resealed blob is fresh.
	start = rec.count()
	rp = run("stale text", "post", "--from", "Py", "--last", "1").ok(t)
	if rp.ID == nil || *rp.ID != 2 {
		t.Fatalf("repost after conflict: %+v", rp)
	}
	rejectedReq, acceptedReq := rec.since(start - 1)[0], rec.since(start)[0]
	var rejected, accepted struct{ Nonce, CT string }
	json.Unmarshal([]byte(rejectedReq.Body), &rejected)
	json.Unmarshal([]byte(acceptedReq.Body), &accepted)
	if rejected.Nonce == accepted.Nonce || rejected.CT == accepted.CT {
		t.Fatal("the retried text must be resealed for its new position with a fresh nonce")
	}
	if got := a.read(t, 1); len(got.Messages) != 1 || got.Messages[0].Text != "stale text" {
		t.Fatalf("repost content: %+v", got.Messages)
	}

	// A lost response is ambiguous and is reported as such: the write did
	// land, the client cannot know it, and it refuses to guess.
	rec.setDrop(true)
	start = rec.count()
	lost := run("ambiguous post", "post", "--from", "Py", "--last", "2")
	rec.setDrop(false)
	if lost.code != 1 || lost.stdout != "" {
		t.Fatalf("lost response: exit %d stdout %q", lost.code, lost.stdout)
	}
	ambiguous, keys := decode(t, lost.stderr)
	if _, ok := keys["posted"]; !ok || ambiguous.Posted != nil {
		t.Fatalf("an unknown outcome must report posted null, not a guess: %s", lost.stderr)
	}
	if !strings.Contains(ambiguous.Hint, "may have succeeded") || !strings.Contains(ambiguous.Hint, "no retry") {
		t.Fatalf("ambiguous hint: %q", ambiguous.Hint)
	}
	if ambiguous.Error == "" {
		t.Fatalf("the transport failure should be reported: %s", lost.stderr)
	}
	if reqs := rec.since(start); len(reqs) != 1 {
		t.Fatalf("an ambiguous post must not be retried: %+v", reqs)
	}
	if got := a.read(t, 2); len(got.Messages) != 1 || got.Messages[0].Text != "ambiguous post" {
		t.Fatalf("the ambiguous post did land: %+v", got.Messages)
	}
	// Reading from the old cursor is what the hint tells the agent to do, and
	// it shows the message exactly once.
	rp = run("", "read", "--last", "2").ok(t)
	if len(rp.Messages) != 1 || rp.Messages[0].Text != "ambiguous post" || rp.Last != 3 {
		t.Fatalf("read after ambiguity: %+v", rp)
	}

	// Malformed inner content is authenticated but unbelievable: each such
	// event keeps its own row and position, and the page continues.
	last := int64(3)
	malformed := []string{`7`, `[]`, `"text"`, `{}`, `null`, `{"from":7,"text":"x"}`, `{"from":"A","text":[]}`, `{"from":null,"text":"x"}`, `{"from":" untrimmed ","text":"x"}`, `not json at all`}
	for _, raw := range malformed {
		nonce, ct, err := Seal(a.ks.Enc, a.id, last+1, []byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		blob, _ := json.Marshal(map[string]string{"nonce": b64u(nonce), "ct": b64u(ct)})
		if resp, body := do(t, "POST", a.url("/events?last="+strconv.FormatInt(last, 10)), string(blob), bearerHdr(a.ks.Auth)); resp.StatusCode != 200 {
			t.Fatalf("malformed append: %d %s", resp.StatusCode, body)
		}
		last++
	}
	// An event nobody can open: a blob sealed under a different key.
	other, err := Derive(NewK())
	if err != nil {
		t.Fatal(err)
	}
	nonce, ct, err := Seal(other.Enc, a.id, last+1, []byte(`{"from":"A","text":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	blob, _ := json.Marshal(map[string]string{"nonce": b64u(nonce), "ct": b64u(ct)})
	if resp, body := do(t, "POST", a.url("/events?last="+strconv.FormatInt(last, 10)), string(blob), bearerHdr(a.ks.Auth)); resp.StatusCode != 200 {
		t.Fatalf("undecryptable append: %d %s", resp.StatusCode, body)
	}
	last++
	after := "after the bad events: h\u00e9llo \u4f60\u597d \U0001F468\u200D\U0001F469\u200D\U0001F467\u200D\U0001F466\n<&>"
	rp = run(after, "post", "--from", "Py", "--last", strconv.FormatInt(last, 10)).ok(t)
	if rp.ID == nil || *rp.ID != last+1 {
		t.Fatalf("post after malformed: %+v", rp)
	}
	last++
	rp = run("", "read", "--last", "3").ok(t)
	if len(rp.Messages) != len(malformed)+2 {
		t.Fatalf("want a row per event: %+v", rp.Messages)
	}
	for i, m := range rp.Messages[:len(malformed)] {
		if m.Text != "(invalid message)" || m.From != "" || m.ID != int64(4+i) {
			t.Fatalf("malformed %q rendered as %+v", malformed[i], m)
		}
	}
	if got := rp.Messages[len(malformed)]; got.Text != "(undecryptable message)" || got.From != "" {
		t.Fatalf("foreign ciphertext: %+v", got)
	}
	if got := rp.Messages[len(malformed)+1]; got.Text != after || got.From != "Py" || got.ID != last {
		t.Fatalf("the good event after the bad ones: %+v", got)
	}
	// The Go participant agrees, placeholder for placeholder.
	go1 := a.read(t, 3)
	if len(go1.Messages) != len(rp.Messages) {
		t.Fatalf("Go fixture/client page length: %d vs %d", len(go1.Messages), len(rp.Messages))
	}
	for i := range go1.Messages {
		if go1.Messages[i] != rp.Messages[i] {
			t.Errorf("message %d: Go fixture %+v, client %+v", i, go1.Messages[i], rp.Messages[i])
		}
	}

	// Names and text are bounded only by their grammar and the ciphertext caps.
	longName := strings.Repeat("\u00e9", 512) // 1024 UTF-8 bytes
	longText := strings.Repeat("long ", 40000)
	rp = run(longText, "post", "--from", longName, "--last", strconv.FormatInt(last, 10)).ok(t)
	last++
	if got := a.read(t, int(last-1)); len(got.Messages) != 1 || got.Messages[0].From != longName || got.Messages[0].Text != longText {
		t.Fatalf("long name/text round trip: %d", len(got.Messages))
	}
	// The one size policy is the server's decoded-ciphertext cap. Padding is
	// a multiple of 256 and the tag is 16 bytes, so the largest acceptable
	// plaintext is a whole number of blocks below the cap.
	overhead := len(`{"from":"P","text":""}`)
	fits := strings.Repeat("x", maxBlobBytes-16-256-overhead)
	rp = run(fits, "post", "--from", "P", "--last", strconv.FormatInt(last, 10)).ok(t)
	last++
	if rp.Posted == nil || !*rp.Posted {
		t.Fatalf("largest accepted message: %+v", rp)
	}
	// The base64 envelope exceeds 512 KiB on the wire. A client must not
	// invent a smaller response budget than the relay's accepted event.
	largePage := run("", "read", "--last", strconv.FormatInt(last-1, 10)).ok(t)
	if len(largePage.Messages) != 1 || largePage.Messages[0].Text != fits || largePage.Last != last {
		t.Fatalf("largest accepted message did not round-trip: %d rows, last %d", len(largePage.Messages), largePage.Last)
	}
	tooBig := run(fits+strings.Repeat("x", 256), "post", "--from", "P", "--last", strconv.FormatInt(last, 10))
	if tooBig.code != 1 || tooBig.stdout != "" {
		t.Fatalf("oversized post: exit %d %s", tooBig.code, tooBig.stdout)
	}
	oversize, _ := decode(t, tooBig.stderr)
	if oversize.HTTPStatus != http.StatusRequestEntityTooLarge || !strings.Contains(oversize.Error, "too large") {
		t.Fatalf("the server's own size error should reach the agent: %s", tooBig.stderr)
	}
	if oversize.Posted != nil || !strings.Contains(oversize.Hint, "may have succeeded") {
		t.Fatalf("a rejected oversized write is still an attempt: %s", tooBig.stderr)
	}
	if got := a.read(t, int(last)); len(got.Messages) != 0 {
		t.Fatalf("the oversized post was stored: %+v", got.Messages)
	}

	// --wait blocks until another participant appends, without polling.
	start = rec.count()
	done := make(chan clientRun, 1)
	go func() { done <- run("", "read", "--last", strconv.FormatInt(last, 10), "--wait", "20") }()
	time.Sleep(150 * time.Millisecond)
	if code, _ := a.as("Go").post(t, int(last), "reply from Go"); code != 200 {
		t.Fatalf("long-poll append: %d", code)
	}
	last++
	select {
	case got := <-done:
		waited := got.ok(t)
		if len(waited.Messages) != 1 || waited.Messages[0].Text != "reply from Go" || waited.Messages[0].From != "Go" {
			t.Fatalf("waited read: %+v", waited.Messages)
		}
	case <-time.After(25 * time.Second):
		t.Fatal("waited read never returned")
	}
	if reqs := rec.since(start); len(reqs) != 1 {
		t.Fatalf("a waiting read is one request, not a poll loop: %+v", reqs)
	}

	// The same saved file serves another channel: no per-channel state, no
	// second download, nothing remembered between invocations.
	b := newSeededChannel(t, ts, "Go")
	second := runClient(t, client, proxy.URL+"/c/"+b.id+"#"+b.k, "", "read", "--last", "-1").ok(t)
	if len(second.Messages) != 1 || second.Messages[0].Text != "fixture" {
		t.Fatalf("second channel: %+v", second.Messages)
	}
	if again := run("", "read", "--last", strconv.FormatInt(last, 10)).ok(t); len(again.Messages) != 0 || again.Last != last {
		t.Fatalf("first channel cursor after using another channel: %+v", again)
	}

	// The view's commands are ordinary text to the client: it neither acts on
	// them nor alters them, including malformed ones and awkward content.
	mixed := "\x00\x01\b\t\n\f\r\"\\<>&\u00e9\u4f60\u597d\U0001F426\u2028\u2029"
	verbatim := []string{
		"/title interop", "/title", " /react 2 \U0001F440 ", "/unreact 1 B",
		"/react 01 malformed", "/react 0 " + strings.Repeat("x", 3000),
		"/title " + strings.Repeat("\U0001F426", 500), "  /re 0  body\nnext  \n",
		"# Heading\n**bold** <img src=x> ![pic](https://example.test/a.png)",
		mixed, strings.Repeat(mixed, 200), strings.Repeat("\\", 50<<10),
	}
	start = rec.count()
	for _, text := range verbatim {
		if rp := run(text, "post", "--from", "Py", "--last", strconv.FormatInt(last, 10)).ok(t); rp.ID == nil || *rp.ID != last+1 {
			t.Fatalf("verbatim post %q: %+v", text, rp)
		}
		last++
	}
	if n := rec.count() - start; n != len(verbatim) {
		t.Fatalf("%d posts took %d requests", len(verbatim), n)
	}
	page := run("", "read", "--last", strconv.FormatInt(last-int64(len(verbatim)), 10)).ok(t)
	if len(page.Messages) != len(verbatim) {
		t.Fatalf("verbatim page: %d messages", len(page.Messages))
	}
	for i, text := range verbatim {
		if page.Messages[i].Text != text || page.Messages[i].From != "Py" {
			t.Errorf("message %d changed in transit:\n got %q\nwant %q", i, page.Messages[i].Text, text)
		}
	}
	// A Go participant recovers the same bytes, so the difference is not a
	// pair of matching client bugs.
	for i, m := range a.read(t, int(last)-len(verbatim)).Messages {
		if m.Text != verbatim[i] {
			t.Errorf("message %d differs for a Go reader: %q", i, m.Text)
		}
	}
}

// testClientRefusals covers what the client will not do: guess a cursor,
// invent a name, send blank text, follow a redirect, or hide a server error.
func testClientRefusals(t *testing.T, client clientProgram) {
	_, ts := newTestServer(t)
	rec := &recorder{target: ts.URL}
	proxy := httptest.NewServer(http.HandlerFunc(rec.serve))
	t.Cleanup(proxy.Close)
	a := newSeededChannel(t, ts, "Go")
	url := proxy.URL + "/c/" + a.id + "#" + a.k

	t.Run("help", func(t *testing.T) {
		start := rec.count()
		got := runClient(t, client, "--help", "")
		if got.code != 0 || got.stderr != "" || !strings.Contains(got.stdout, "read") || !strings.Contains(got.stdout, "post") || !strings.Contains(got.stdout, "--last") || json.Valid([]byte(got.stdout)) {
			t.Fatalf("standalone help must print useful usage text: exit %d stdout %q stderr %q", got.code, got.stdout, got.stderr)
		}
		if n := rec.count() - start; n != 0 {
			t.Fatalf("help sent %d requests", n)
		}
	})

	// Usage errors identify the rejected argument: exit 2, before any request.
	for _, tc := range []struct {
		want string
		args []string
	}{
		{"--last", []string{"read"}},
		{"--last", []string{"post", "--from", "Py"}},
		{"read", []string{"send", "--last", "0"}},
		{"int", []string{"read", "--last", "soon"}},
		{"int", []string{"read", "--last", "0.5"}},
		{"int", []string{"read", "--last", "-1", "--wait", "1.5"}},
		{"int", []string{"read", "--last", "NaN"}},
		{"post requires --from", []string{"post", "--last", "0"}},
		{"post requires --from", []string{"post", "--from", " untrimmed ", "--last", "0"}},
		{"post requires --from", []string{"post", "--from", "two\nlines", "--last", "0"}},
		{"post requires --from", []string{"post", "--from", "", "--last", "0"}},
	} {
		start := rec.count()
		got := runClient(t, client, url, "text", tc.args...)
		if got.code != 2 || got.stdout != "" || !strings.Contains(strings.ToLower(got.stderr), tc.want) {
			t.Errorf("%v: exit %d, stderr %q", tc.args, got.code, got.stderr)
		}
		if n := rec.count() - start; n != 0 {
			t.Errorf("%v sent %d requests", tc.args, n)
		}
	}

	// Blank text and unusable URLs fail as JSON on stderr, still without a
	// request, and never as a partial post.
	for _, tc := range []struct {
		name, stdin, url, want string
		args                   []string
	}{
		{"blank stdin", " \n\t ", url, "nonblank", []string{"post", "--from", "Py", "--last", "0"}},
		{"empty stdin", "", url, "nonblank", []string{"post", "--from", "Py", "--last", "0"}},
		{"no fragment", "", proxy.URL + "/c/" + a.id, "32-byte key", []string{"read", "--last", "-1"}},
		{"wrong key", "", proxy.URL + "/c/" + a.id + "#" + b64u(NewK()), "matching id", []string{"read", "--last", "-1"}},
		{"query string", "", proxy.URL + "/c/" + a.id + "?x=1#" + a.k, "matching id", []string{"read", "--last", "-1"}},
		{"events path", "", proxy.URL + "/c/" + a.id + "/events#" + a.k, "matching id", []string{"read", "--last", "-1"}},
		{"unsupported view path", "", proxy.URL + "/c/" + a.id + "/view#" + a.k, "matching id", []string{"read", "--last", "-1"}},
		{"parent segment", "", proxy.URL + "/x/../c/" + a.id + "#" + a.k, "matching id", []string{"read", "--last", "-1"}},
		{"dot segment", "", proxy.URL + "/c/./" + a.id + "#" + a.k, "matching id", []string{"read", "--last", "-1"}},
		{"credentials", "", strings.Replace(proxy.URL, "://", "://user:password@", 1) + "/c/" + a.id + "#" + a.k, "matching id", []string{"read", "--last", "-1"}},
		{"wrong scheme", "", strings.Replace(proxy.URL, "http:", "ftp:", 1) + "/c/" + a.id + "#" + a.k, "matching id", []string{"read", "--last", "-1"}},
		{"bad port", "", "http://127.0.0.1:notaport/c/" + a.id + "#" + a.k, "", []string{"read", "--last", "-1"}},
		{"out of range port", "", "http://127.0.0.1:65536/c/" + a.id + "#" + a.k, "", []string{"read", "--last", "-1"}},
		{"invalid UTF-8", "\xff\xfe", url, "utf-8", []string{"post", "--from", "Py", "--last", "0"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			start := rec.count()
			got := runClient(t, client, tc.url, tc.stdin, tc.args...)
			if got.code != 1 || got.stdout != "" {
				t.Fatalf("exit %d, stdout %q", got.code, got.stdout)
			}
			rp, keys := decode(t, got.stderr)
			if rp.Error == "" || !strings.Contains(strings.ToLower(rp.Error), tc.want) {
				t.Errorf("error %q, want mention of %q", rp.Error, tc.want)
			}
			if _, ok := keys["posted"]; ok {
				t.Error("nothing was attempted, so the outcome is not unknown")
			}
			if n := rec.count() - start; n != 0 {
				t.Errorf("sent %d requests", n)
			}
		})
	}

	// A channel that does not exist (never created, or already expired) is
	// the server's answer, reported once with its own status and message.
	goneKey := NewK()
	gone, err := Derive(goneKey)
	if err != nil {
		t.Fatal(err)
	}
	start := rec.count()
	got := runClient(t, client, proxy.URL+"/c/"+gone.ID+"#"+b64u(goneKey), "", "read", "--last", "-1")
	if got.code != 1 || got.stdout != "" {
		t.Fatalf("missing channel: exit %d, stdout %q", got.code, got.stdout)
	}
	missing, _ := decode(t, got.stderr)
	if missing.HTTPStatus != http.StatusNotFound || !strings.Contains(strings.ToLower(missing.Error), "no such channel") {
		t.Fatalf("missing channel: %s", got.stderr)
	}
	if n := rec.count() - start; n != 1 {
		t.Errorf("a missing channel was requested %d times", n)
	}

	// A key that derives the right channel id but the wrong bearer gets 401,
	// once. Registering a mismatched auth_hash is the only way to reach that
	// state, and it is exactly what a corrupted saved URL looks like.
	mismatched := NewK()
	mis, err := Derive(mismatched)
	if err != nil {
		t.Fatal(err)
	}
	elsewhere, err := Derive(NewK())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"id": mis.ID, "auth_hash": b64u(AuthHash(elsewhere.Auth))})
	if resp, raw := do(t, "POST", ts.URL+"/new", string(body), nil); resp.StatusCode != 303 {
		t.Fatalf("create mismatched channel: %d %s", resp.StatusCode, raw)
	}
	start = rec.count()
	got = runClient(t, client, proxy.URL+"/c/"+mis.ID+"#"+b64u(mismatched), "", "read", "--last", "-1")
	if got.code != 1 || got.stdout != "" {
		t.Fatalf("wrong bearer: exit %d %q", got.code, got.stdout)
	}
	if rp, _ := decode(t, got.stderr); rp.HTTPStatus != http.StatusUnauthorized {
		t.Fatalf("wrong bearer status: %s", got.stderr)
	}
	if n := rec.count() - start; n != 1 {
		t.Errorf("a rejected bearer was tried %d times", n)
	}

	// Clients never follow redirects: a relay that answers 3xx is an
	// error the agent sees, not a silent re-send somewhere else.
	var redirects atomic.Int64
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirects.Add(1)
		http.Redirect(w, r, proxy.URL+r.URL.RequestURI(), http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)
	for _, command := range []string{"read", "post"} {
		start := rec.count()
		before := redirects.Load()
		got = runClient(t, client, redirector.URL+"/c/"+a.id+"#"+a.k, "must not forward", command, "--from", "A", "--last", "0")
		if got.code != 1 || got.stdout != "" {
			t.Fatalf("redirect: exit %d %q", got.code, got.stdout)
		}
		if rp, keys := decode(t, got.stderr); rp.HTTPStatus != http.StatusTemporaryRedirect || (keys["posted"] != nil) != (command == "post") || rp.Posted != nil {
			t.Fatalf("redirect should surface as its own status: %s", got.stderr)
		}
		if rec.count() != start || redirects.Load()-before != 1 {
			t.Fatalf("%s redirect was followed or retried", command)
		}
	}
}

// sealRaw appends an authenticated blob with arbitrary inner bytes.
func sealRaw(t *testing.T, a chn, last int64, raw string) {
	t.Helper()
	nonce, ct, err := Seal(a.ks.Enc, a.id, last+1, []byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	blob, _ := json.Marshal(map[string]string{"nonce": b64u(nonce), "ct": b64u(ct)})
	if resp, body := do(t, "POST", a.url("/events?last="+strconv.FormatInt(last, 10)), string(blob), bearerHdr(a.ks.Auth)); resp.StatusCode != 200 {
		t.Fatalf("raw append: %d %s", resp.StatusCode, body)
	}
}

// testClientUTF8Output checks valid UTF-8 JSON independently of the inherited stream encoding.
// Python keeps its literal-UTF8 contract; equivalent JSON escapes are fine in the other clients.
func testClientUTF8Output(t *testing.T, client clientProgram) {
	t.Setenv("PYTHONIOENCODING", "ascii")
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Go")
	url := ts.URL + "/c/" + a.id + "#" + a.k

	const name = "P\u00ff \u4f60\u597d \U0001F40B"
	text := "\u00e9 \u4f60\u597d \U0001F44B\n\x00\x01\t\"\\\u2028 <&>"
	rp := runClient(t, client, url, text, "post", "--from", name, "--last", "0").ok(t)
	if rp.ID == nil || *rp.ID != 1 {
		t.Fatalf("post: %+v", rp)
	}
	// Success: literal UTF-8, not \u escapes; control characters and the JSON
	// specials still escaped; the bytes round-trip through Go untouched.
	got := runClient(t, client, url, "", "read", "--last", "0")
	page := got.ok(t)
	if len(page.Messages) != 1 || page.Messages[0].Text != text || page.Messages[0].From != name {
		t.Fatalf("read: %+v", page.Messages)
	}
	if !utf8.ValidString(got.stdout) {
		t.Fatalf("stdout must be valid UTF-8 JSON: %q", got.stdout)
	}
	if client.name == "Python" && (!strings.Contains(got.stdout, name) || strings.Contains(got.stdout, `\u00e9`) || strings.Contains(got.stdout, `\ud83d`)) {
		t.Fatalf("Python stdout should carry literal UTF-8 under PYTHONIOENCODING=ascii: %s", got.stdout)
	}
	if strings.ContainsAny(got.stdout, "\x00\x01\t") {
		t.Fatalf("control characters must stay JSON-escaped: %q", got.stdout)
	}
	if client.name == "Python" && (!strings.Contains(got.stdout, `\u0000`) || !strings.Contains(got.stdout, `\u0001`) || !strings.Contains(got.stdout, `\t`) || !strings.Contains(got.stdout, `\"`)) {
		t.Fatalf("Python control escapes changed: %q", got.stdout)
	}
	if goSide := a.read(t, 0); len(goSide.Messages) != 1 || goSide.Messages[0] != page.Messages[0] {
		t.Fatalf("Go fixture and client disagree: %+v vs %+v", goSide.Messages, page.Messages)
	}

	// Conflict: the missed messages are printed the same way.
	stale := runClient(t, client, url, "stale", "post", "--from", "Py", "--last", "0")
	if stale.code != 1 || stale.stderr != "" {
		t.Fatalf("conflict: exit %d %s", stale.code, stale.stderr)
	}
	if conflict, _ := decode(t, stale.stdout); conflict.Error != "conflict" || len(conflict.Messages) != 1 || conflict.Messages[0].Text != text {
		t.Fatalf("conflict reply: %s", stale.stdout)
	}
	if client.name == "Python" && !strings.Contains(stale.stdout, name) {
		t.Fatalf("Python conflict stdout should carry literal UTF-8: %s", stale.stdout)
	}

	// Server-side errors on stderr, parsed or raw, keep their text readable.
	// A lone surrogate in such a diagnostic cannot be UTF-8; it is written as
	// a JSON escape, so the object still parses and the status survives.
	var status atomic.Int64
	var body atomic.Value
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(int(status.Load()))
		io.WriteString(w, body.Load().(string))
	}))
	t.Cleanup(stub.Close)
	stubURL := stub.URL + "/c/" + a.id + "#" + a.k
	for _, tc := range []struct {
		status     int
		body, want string
	}{
		{http.StatusBadGateway, `{"error":"n\u00f6 \u4f60\u597d \ud83d\udc0b"}`, "n\u00f6 \u4f60\u597d \U0001F40B"},
		{http.StatusBadGateway, "gateway says n\u00f6 \U0001F40B", "gateway says n\u00f6 \U0001F40B"},
		{http.StatusInternalServerError, `{"error":"bad \udc80 byte"}`, "bad \uFFFD byte"},
	} {
		status.Store(int64(tc.status))
		body.Store(tc.body)
		got := runClient(t, client, stubURL, "", "read", "--last", "-1")
		if got.code != 1 || got.stdout != "" {
			t.Fatalf("server error: exit %d stdout %q", got.code, got.stdout)
		}
		if rp, _ := decode(t, got.stderr); rp.HTTPStatus != tc.status || rp.Error != tc.want {
			t.Fatalf("server error %q: %s", tc.body, got.stderr)
		}
		if !utf8.ValidString(got.stderr) || (client.name == "Python" && tc.status == http.StatusBadGateway && !strings.Contains(got.stderr, tc.want)) {
			t.Fatalf("stderr should be literal, valid UTF-8: %q", got.stderr)
		}
		if client.name == "Python" && tc.status == http.StatusInternalServerError && !strings.Contains(got.stderr, `bad \udc80 byte`) {
			t.Fatalf("unencodable diagnostic must remain JSON-escaped: %q", got.stderr)
		}
	}

	// A lone-surrogate escape in either field is an invalid message;
	// later rows must still print.
	last := int64(1)
	for _, raw := range []string{`{"from":"a\udc80","text":"x"}`, `{"from":"A","text":"lone \ud800 here"}`} {
		sealRaw(t, a, last, raw)
		last++
	}
	if code, _ := a.as("Go").post(t, int(last), "after \u00e9"); code != 200 {
		t.Fatalf("post after surrogates: %d", code)
	}
	last++
	for _, encoding := range []string{"utf-8", "ascii"} {
		t.Setenv("PYTHONIOENCODING", encoding)
		page := runClient(t, client, url, "", "read", "--last", "1").ok(t)
		if len(page.Messages) != 3 || page.Last != last {
			t.Fatalf("surrogate page: %+v", page)
		}
		for _, m := range page.Messages[:2] {
			if m.Text != "(invalid message)" || m.From != "" {
				t.Fatalf("lone surrogate rendered as %+v", m)
			}
		}
		if m := page.Messages[2]; m.Text != "after \u00e9" || m.From != "Go" || m.ID != last {
			t.Fatalf("the valid message after the surrogates: %+v", m)
		}
	}
}

// testClientMalformedServerJSON checks diagnostics for malformed relay replies.
// Unusable JSON retains its raw body and status; an unreadable post response
// remains an unknown outcome.
func testClientMalformedServerJSON(t *testing.T, client clientProgram) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Go")

	var status atomic.Int64
	var calls atomic.Int64
	var body atomic.Value
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(int(status.Load()))
		io.WriteString(w, body.Load().(string))
	}))
	t.Cleanup(stub.Close)
	url := stub.URL + "/c/" + a.id + "#" + a.k

	deep := strings.Repeat("[", 5000) + strings.Repeat("]", 5000)
	bodies := []string{`7`, `null`, `[{"last":0,"events":[]}]`, `not json`, `{"last":`, "", `{"last":0,"events":[]} trailing`, deep, "\xff\xfe"}
	for _, code := range []int{200, 409, 500} {
		for _, b := range bodies {
			status.Store(int64(code))
			body.Store(b)
			for _, post := range []bool{false, true} {
				args, stdin := []string{"read", "--last", "-1"}, ""
				if post {
					args, stdin = []string{"post", "--from", "Py", "--last", "0"}, "text"
				}
				label := fmt.Sprintf("%d %v %.20q", code, post, b)
				start := calls.Load()
				got := runClient(t, client, url, stdin, args...)
				if n := calls.Load() - start; n != 1 {
					t.Fatalf("%s: malformed reply caused %d requests", label, n)
				}
				if got.code != 1 || got.stdout != "" {
					t.Fatalf("%s: exit %d stdout %q stderr %q", label, got.code, got.stdout, got.stderr)
				}
				rp, keys := decode(t, got.stderr)
				if rp.HTTPStatus != code {
					t.Errorf("%s: http_status %d", label, rp.HTTPStatus)
				}
				// The raw body is the error, decoded with one U+FFFD per bad byte.
				want := string([]rune(b))
				if rp.Error != want {
					t.Errorf("%s: error should be the raw body, got %.80q", label, rp.Error)
				}
				if rp.Posted != nil && *rp.Posted {
					t.Errorf("%s: reported success: %s", label, got.stderr)
				}
				if _, ok := keys["posted"]; ok != post || (post && rp.Posted != nil) {
					t.Errorf("%s: posted must be null for a post and absent for a read: %s", label, got.stderr)
				}
				if post != strings.Contains(rp.Hint, "may have succeeded") {
					t.Errorf("%s: hint %q", label, rp.Hint)
				}
			}
		}
	}

	// A well-formed object that is not this protocol's reply is no better: a
	// 200 without events is not a success, and a post stays unknown.
	status.Store(200)
	body.Store(`{"ok":true}`)
	start := calls.Load()
	got := runClient(t, client, url, "text", "post", "--from", "Py", "--last", "0")
	if n := calls.Load() - start; n != 1 {
		t.Fatalf("object without events caused %d requests", n)
	}
	if got.code != 1 || got.stdout != "" {
		t.Fatalf("object without events: exit %d stdout %q", got.code, got.stdout)
	}
	if rp, keys := decode(t, got.stderr); rp.Error == "" || rp.Posted != nil || keys["posted"] == nil || !strings.Contains(rp.Hint, "may have succeeded") {
		t.Fatalf("object without events: %s", got.stderr)
	}
}

// A malformed outer page is not an empty page or an undecryptable message:
// without event metadata, the client cannot retain positions for the caller.
func testClientMalformedEvents(t *testing.T, client clientProgram) {
	v := loadVectors(t)[0]
	for _, events := range []string{
		`{}`, `""`, `null`, `7`, `[null]`, `[false]`, `[[]]`, `[{}]`,
		`[{"ts":"2026-01-01T00:00:00Z","src":"198.51.100.7"}]`,
		`[{"seq":0,"src":"198.51.100.7"}]`,
		`[{"seq":0,"ts":"2026-01-01T00:00:00Z"}]`,
	} {
		t.Run(events, func(t *testing.T) {
			var calls atomic.Int64
			stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				fmt.Fprintf(w, `{"last":0,"more":false,"events":%s}`, events)
			}))
			t.Cleanup(stub.Close)
			url := stub.URL + "/c/" + v.ID + "#" + v.K
			for _, command := range []string{"read", "post"} {
				before := calls.Load()
				got := runClient(t, client, url, "text", command, "--from", "A", "--last", "-1")
				if calls.Load()-before != 1 {
					t.Fatalf("%s malformed page was retried", command)
				}
				if got.code != 1 || got.stdout != "" {
					t.Errorf("%s malformed page reported success: %+v", command, got)
					continue
				}
				rp, keys := decode(t, got.stderr)
				post := command == "post"
				if rp.Error == "" || rp.Posted != nil || (keys["posted"] != nil) != post || strings.Contains(rp.Hint, "may have succeeded") != post {
					t.Errorf("%s malformed page must fail, post outcome unknown: %s", command, got.stderr)
				}
			}
		})
	}
}

func testClientRestartReplies(t *testing.T, client clientProgram) {
	v := loadVectors(t)[0]
	const restartHint = "Server restarting; try again shortly."
	const unknownHint = "Post may have succeeded. Read from old --last before resubmitting; no retry."
	for _, tc := range []struct {
		name       string
		status     int
		body       string
		incomplete bool
		refused    bool
	}{
		{"Refusal", 503, `{"error":"restarting","posted":false,"hint":"` + restartHint + `"}`, false, true},
		{"EscapedMarker", 503, `{"error":"restart\u0069ng","posted": false,"hint":"` + restartHint + `"}`, false, true},
		{"Actual503", 503, `{"http_status":200,"error":"restarting","posted":false,"hint":"` + restartHint + `"}`, false, true},
		{"MissingPosted", 503, `{"error":"restarting"}`, false, false},
		{"NullPosted", 503, `{"error":"restarting","posted":null}`, false, false},
		{"TruePosted", 503, `{"error":"restarting","posted":true}`, false, false},
		{"StringPosted", 503, `{"error":"restarting","posted":"false"}`, false, false},
		{"ZeroPosted", 503, `{"error":"restarting","posted":0}`, false, false},
		{"MissingMarker", 503, `{"posted":false}`, false, false},
		{"WrongMarker", 503, `{"error":"unavailable","posted":false}`, false, false},
		{"CaseMismatch", 503, `{"error":"Restarting","posted":false}`, false, false},
		{"Proxy503", 503, `<html>temporarily unavailable</html>`, false, false},
		{"Actual500", 500, `{"http_status":503,"error":"restarting","posted":false}`, false, false},
		{"Malformed200", 200, `{"http_status":503,"error":"restarting","posted":false}`, false, false},
		{"PartialJSON", 503, `{"error":"restarting","posted":false`, false, false},
		// Even parseable JSON cannot settle a post when the HTTP body is incomplete.
		{"IncompleteRefusal", 503, `{"error":"restarting","posted":false}`, true, false},
		{"IncompleteAcknowledgement", 200, `{"posted":true,"id":0,"last":0,"more":false,"events":[]}`, true, false},
		{"HeadersOnly", 503, ``, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int64
			stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "POST" || r.URL.RawQuery != "last=-1&wait=0" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL)
				}
				io.Copy(io.Discard, r.Body)
				if tc.incomplete {
					w.Header().Set("Content-Length", strconv.Itoa(len(tc.body)+20))
				}
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			}))
			t.Cleanup(stub.Close)
			got := runClient(t, client, stub.URL+"/c/"+v.ID+"#"+v.K, "text", "post", "--from", "A", "--last", "-1")
			if calls.Load() != 1 || got.code != 1 || got.stdout != "" || !strings.HasSuffix(got.stderr, "\n") {
				t.Fatalf("requests %d, result %+v", calls.Load(), got)
			}
			rp, keys := decode(t, got.stderr)
			if rp.Error == "" {
				t.Fatalf("missing error: %s", got.stderr)
			}
			if !tc.incomplete && tc.status != 200 && rp.HTTPStatus != tc.status {
				t.Fatalf("must use actual HTTP status %d: %s", tc.status, got.stderr)
			}
			if tc.refused {
				if len(keys) != 4 || rp.Error != "restarting" || string(keys["posted"]) != "false" || rp.Hint != restartHint {
					t.Fatalf("definite refusal: %s", got.stderr)
				}
			} else if string(keys["posted"]) != "null" || rp.Hint != unknownHint {
				t.Fatalf("ambiguous post must read old cursor first: %s", got.stderr)
			}
		})
	}
}

func testClientRestartHandlers(t *testing.T, client clientProgram) {
	for _, tc := range []struct {
		name    string
		command string
		held    bool
	}{
		{"RefusedRead", "read", false},
		{"RefusedPost", "post", false},
		{"HeldRead", "read", true},
		{"CommittedPostWait", "post", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, ts := newTestServer(t)
			id, key := createChannel(t, ts) // Empty channel; no previous waiter subscription.
			var calls atomic.Int64
			handler := s.Handler()
			wire := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				handler.ServeHTTP(w, r)
			}))
			t.Cleanup(wire.Close)
			url := wire.URL + "/c/" + id + "#" + key
			args := []string{tc.command, "--from", "A", "--last", "-1", "--wait", "30"}
			var got clientRun
			if tc.held {
				done := make(chan clientRun, 1)
				go func() { done <- runClient(t, client, url, "accepted once", args...) }()
				waitSubscribed(t, s.Store, id)
				close(s.stopping)
				select {
				case got = <-done:
				case <-time.After(3 * time.Second):
					t.Fatal("restart did not release held client promptly")
				}
			} else {
				close(s.stopping)
				got = runClient(t, client, url, "must not land", args...)
			}
			if calls.Load() != 1 {
				t.Fatalf("restart caused %d requests", calls.Load())
			}
			committed := tc.command == "post" && tc.held
			wantEvents := 0
			if committed {
				wantEvents = 1
				got.ok(t)
				rp, keys := decode(t, got.stdout)
				if len(keys) != 5 || string(keys["posted"]) != "true" || string(keys["id"]) != "0" ||
					string(keys["last"]) != "0" || string(keys["more"]) != "false" || string(keys["messages"]) != "[]" {
					t.Fatalf("committed post must retain ordinary success shape: %+v (%s)", rp, got.stdout)
				}
			} else {
				if got.code != 1 || got.stdout != "" {
					t.Fatalf("restart refusal: %+v", got)
				}
				rp, keys := decode(t, got.stderr)
				wantKeys := 3
				if tc.command == "post" {
					wantKeys++
					if string(keys["posted"]) != "false" {
						t.Fatalf("rejected post is known uncommitted: %s", got.stderr)
					}
				} else if _, ok := keys["posted"]; ok {
					t.Fatalf("read must not invent a post outcome: %s", got.stderr)
				}
				if len(keys) != wantKeys || rp.HTTPStatus != 503 || rp.Error != "restarting" || rp.Hint != "Server restarting; try again shortly." {
					t.Fatalf("restart diagnostic: %s", got.stderr)
				}
			}
			page, err := s.Store.Events(id, -1)
			if err != nil || len(page.Events) != wantEvents || page.Last != int64(wantEvents-1) {
				t.Fatalf("stored outcome: %+v, %v; want %d events", page, err, wantEvents)
			}
		})
	}
}
