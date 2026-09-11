package srv

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEventsAuth(t *testing.T) {
	_, ts := newTestServer(t)
	a, other := newSeededChannel(t, ts, "Alpha"), newSeededChannel(t, ts, "Zulu")
	for name, h := range map[string]map[string]string{
		"none": nil, "garbage": bearerHdr("bogus"), "URL key": bearerHdr(a.k), "other auth": bearerHdr(other.ks.Auth), "query only": nil,
	} {
		u := a.url("/events?since=-1")
		if name == "query only" {
			u += "&token=" + a.ks.Auth
		}
		if resp, _ := do(t, "GET", u, "", h); resp.StatusCode != 401 {
			t.Errorf("%s: %d", name, resp.StatusCode)
		}
	}
	if resp, _ := do(t, "GET", a.url("/events"), "", bearerHdr(a.ks.Auth)); resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	if resp, _ := do(t, "GET", ts.URL+"/c/"+strings.Repeat("A", 22)+"/events", "", bearerHdr(a.ks.Auth)); resp.StatusCode != 404 {
		t.Fatal(resp.StatusCode)
	}
}

func TestCAS(t *testing.T) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	b := a.as("Bravo")
	if resp, _ := a.request(t, "POST", "", &Inner{From: a.name, Text: "hi"}); resp.StatusCode != 400 {
		t.Fatal(resp.StatusCode)
	}
	if rp := a.read(t, -1); rp.Last != 0 || len(rp.Messages) != 1 || rp.Messages[0].From != "Fixture" {
		t.Fatalf("fixture: %+v", rp)
	}
	if code, rp := a.post(t, -1, "stale"); code != 409 || rp.Last != 0 {
		t.Fatalf("stale: %d %+v", code, rp)
	}
	if code, rp := a.post(t, 0, "hello from a"); code != 200 || rp.Posted == nil || !*rp.Posted || *rp.ID != 1 || len(rp.Messages) != 0 {
		t.Fatalf("post: %d %+v", code, rp)
	}
	code, conflict := b.post(t, 0, "hello from b")
	if code != 409 || conflict.Posted == nil || *conflict.Posted || conflict.Last != 1 || len(conflict.Messages) != 1 || conflict.Messages[0].Text != "hello from a" || conflict.RejectedText != "" {
		t.Fatalf("conflict: %d %+v", code, conflict)
	}
	if code, _ := b.post(t, 5, "ahead"); code != 409 {
		t.Fatal(code)
	}
	if code, _ := b.post(t, 1, "reconsidered\nline2"); code != 200 {
		t.Fatal(code)
	}
	if got := a.read(t, 1); got.Last != 2 || len(got.Messages) != 1 || got.Messages[0].Text != "reconsidered\nline2" || got.Messages[0].From != "Bravo" || got.Messages[0].Src != "127.0.0.1" {
		t.Fatalf("read: %+v", got)
	}
}

func TestConcurrentCAS(t *testing.T) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for i := 0; i < 8; i++ {
		wg.Go(func() {
			c := a.as(nato[i])
			text := []string{"me first", "/react 0 B", "/unreact 0 B", "/title Topic"}[i/2]
			resp, _ := c.request(t, "POST", "&last=0", &Inner{From: c.name, Text: text})
			if resp.StatusCode == 200 {
				mu.Lock()
				wins++
				mu.Unlock()
			} else if resp.StatusCode != 409 {
				t.Errorf("unexpected %d", resp.StatusCode)
			}
		})
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("wins = %d, want 1", wins)
	}
	if rp := a.read(t, -1); rp.Last != 1 || len(rp.Messages) != 2 || rp.Messages[1].Text == "(undecryptable message)" {
		t.Fatalf("concurrent appends consumed extra sequences or misplaced a blob: %+v", rp)
	}
}

func TestPostWaitAndConflict(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	done := make(chan string, 1)
	go func() {
		_, body := a.request(t, "POST", "&last=0&wait=10", &Inner{From: a.name, Text: "question?"})
		done <- body
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		pg, err := s.Store.Events(a.id, 0)
		if err != nil {
			t.Fatal(err)
		}
		if pg.Last == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("post not appended before wait")
		}
		time.Sleep(time.Millisecond)
	}
	a.as("Bravo").post(t, 1, "answer!")
	select {
	case body := <-done:
		rp := a.decodeReply(t, body)
		if rp.Posted == nil || !*rp.Posted || *rp.ID != 1 || rp.Last != 2 || len(rp.Messages) != 1 || rp.Messages[0].Text != "answer!" {
			t.Fatal(body)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("post wait did not wake")
	}
	resp, body := a.request(t, "POST", "&last=1", &Inner{From: a.name, Text: "stale secret"})
	rp := a.decodeReply(t, body)
	if resp.StatusCode != 409 || rp.Posted == nil || *rp.Posted || rp.Last != 2 || strings.Contains(body, "stale secret") || strings.Contains(body, "rejected") {
		t.Fatal(body)
	}
}

func TestMalformedContent(t *testing.T) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	for i, raw := range []string{`7`, `[]`, `null`, `{}`, `{"from":null,"text":"x"}`, `{"from":"A","text":[]}`} {
		nonce, ct, _ := Seal(a.ks.Enc, a.id, int64(i+1), []byte(raw))
		blob, _ := json.Marshal(map[string]string{"nonce": b64u(nonce), "ct": b64u(ct)})
		resp, _ := do(t, "POST", a.url("/events?last="+itoa(i)), string(blob), bearerHdr(a.ks.Auth))
		if resp.StatusCode != 200 {
			t.Fatal(resp.StatusCode)
		}
	}
	for _, m := range a.read(t, 0).Messages {
		if m.Text != "(invalid message)" {
			t.Fatalf("malformed: %+v", m)
		}
	}
}

func TestMandatoryAppendCAS(t *testing.T) {
	for _, kind := range []string{"message", "react", "unreact", "title"} {
		t.Run(kind, func(t *testing.T) {
			_, ts := newTestServer(t)
			a := newSeededChannel(t, ts, "Alpha")
			text := map[string]string{"message": "hello", "react": "/react 0 B", "unreact": "/unreact 0 B", "title": "/title Topic"}[kind]
			in := Inner{From: "Alpha", Text: text}
			appendEvent := func(last string, want int, top int64) {
				t.Helper()
				resp, body := a.request(t, "POST", last, &in)
				if resp.StatusCode != want {
					t.Fatalf("last %q: %d, want %d: %s", last, resp.StatusCode, want, body)
				}
				if want == 409 {
					var rp struct {
						Error  string
						Posted *bool
						Last   int64
					}
					if err := json.Unmarshal([]byte(body), &rp); err != nil || rp.Error != "conflict" || rp.Posted == nil || *rp.Posted || rp.Last != top {
						t.Fatalf("conflict reply: %s (%v)", body, err)
					}
				}
				rp := a.read(t, -1)
				if rp.Last != top || len(rp.Messages) != int(top)+1 {
					t.Fatalf("last %q consumed a sequence: %+v", last, rp)
				}
				for i, m := range rp.Messages {
					if m.ID != int64(i) || (i == 0 && m.Text != "fixture") || (i > 0 && m.Text != text) {
						t.Fatalf("event not dense/decryptable: %+v", m)
					}
				}
			}
			appendEvent("", 400, 0)
			appendEvent("&last=0", 200, 1)
			for _, missing := range []string{"", "&last=", "&last=nope", "&last=-2"} {
				appendEvent(missing, 400, 1)
			}
			appendEvent("&last=0", 409, 1)
			appendEvent("&last=2", 409, 1)
			appendEvent("&last=1", 200, 2)
			evs := a.readEnvelopes(t).Events
			if evs[1].Nonce == evs[2].Nonce || evs[1].CT == evs[2].CT {
				t.Fatal("retry reused nonce/ciphertext")
			}
			for _, ev := range evs {
				b, err := ParseBlob(ev.Nonce, ev.CT)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := Open(a.ks.Enc, a.id, ev.Seq+1, b.Nonce, b.CT); err == nil {
					t.Fatalf("seq %d decrypts at wrong position", ev.Seq)
				}
			}
		})
	}
}

func TestEmptyReadHead(t *testing.T) {
	s, ts := newTestServer(t)
	id, k := createChannel(t, ts)
	ks, _ := ParseK(k)
	a := chn{ts, id, k, ks, "Alpha"}
	for head := -1; head <= 0; head++ {
		for _, since := range []int{head, 999} {
			pg, err := s.Store.Events(a.id, int64(since))
			if err != nil || pg.Last != int64(head) || len(pg.Events) != 0 || pg.More {
				t.Fatalf("empty page since=%d: %+v (%v)", since, pg, err)
			}
			resp, body := do(t, "GET", a.url("/events?since="+itoa(since)), "", bearerHdr(a.ks.Auth))
			var rp struct {
				Last   int
				More   bool
				Events []json.RawMessage
			}
			if err := json.Unmarshal([]byte(body), &rp); err != nil || resp.StatusCode != 200 || rp.Last != head || rp.More || len(rp.Events) != 0 {
				t.Fatalf("empty read since=%d: %d %s (%v)", since, resp.StatusCode, body, err)
			}
		}
		if head == -1 {
			a.post(t, head, "hello")
		}
	}
}

func TestEmptyChannelCASAndMissing(t *testing.T) {
	s, ts := newTestServer(t)
	k := NewK()
	ks, _ := Derive(k)
	if err := s.Store.CreateChannel(ks.ID, AuthHash(ks.Auth), time.Now()); err != nil {
		t.Fatal(err)
	}
	a := chn{ts, ks.ID, b64u(k), ks, "Alpha"}
	pg, err := s.Store.Events(a.id, -1)
	if err != nil || pg.Last != -1 || len(pg.Events) != 0 {
		t.Fatalf("empty: %+v %v", pg, err)
	}
	c0, _ := s.Store.Channel(a.id)
	if resp, body := do(t, "GET", a.url(""), "", nil); resp.StatusCode != 200 || strings.Contains(body, "token=") {
		t.Fatalf("join: %d %s", resp.StatusCode, body)
	}
	c1, _ := s.Store.Channel(a.id)
	if c1.LastActivity != c0.LastActivity {
		t.Fatal("instructions changed empty channel")
	}
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, from := range []string{"same-name", "same-name"} {
		wg.Go(func() {
			resp, _ := a.request(t, "POST", "&last=-1", &Inner{From: from, Text: "/title first"})
			codes <- resp.StatusCode
		})
	}
	wg.Wait()
	close(codes)
	wins, conflicts := 0, 0
	for code := range codes {
		switch code {
		case 200:
			wins++
		case 409:
			conflicts++
		default:
			t.Fatal(code)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("empty CAS: %d/%d", wins, conflicts)
	}
	if got := a.read(t, -1); got.Last != 0 || len(got.Messages) != 1 || got.Messages[0].ID != 0 || got.Messages[0].Text != "/title first" {
		t.Fatalf("first real message: %+v", got)
	}
	missing := "missing-channel"
	if _, err := s.Store.Events(missing, -1); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if _, err := s.Store.WaitEvents(missing, -1, time.Hour, nil, nil); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if _, _, err := s.Store.Append(missing, -1, Blob{Nonce: make([]byte, 12), CT: make([]byte, 16)}, "src", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	s.Store.mu.Lock()
	_, leaked := s.Store.waiters[missing]
	s.Store.mu.Unlock()
	if leaked {
		t.Fatal("missing-channel waiter leak")
	}
}

func TestParseWaitBounds(t *testing.T) {
	for _, seconds := range []int{0, 1, int(maxWait / time.Second), int(maxWait/time.Second) + 1, int(^uint(0) >> 1)} {
		got, err := parseWait(url.Values{"wait": {strconv.Itoa(seconds)}})
		want := time.Duration(min(seconds, int(maxWait/time.Second))) * time.Second
		if err != nil || got != want {
			t.Fatalf("wait=%d: %v (%v), want %v", seconds, got, err, want)
		}
	}
	if got, err := parseWait(url.Values{}); err != nil || got != 0 {
		t.Fatalf("default wait: %v (%v)", got, err)
	}
	for _, value := range []string{"-1", "nope", "999999999999999999999999999999"} {
		if _, err := parseWait(url.Values{"wait": {value}}); err == nil {
			t.Fatalf("invalid wait accepted: %q", value)
		}
	}
}

func TestAppendFailureIsAtomic(t *testing.T) {
	for _, tc := range []struct{ name, setup, cleanup string }{
		{"activity update", `CREATE TRIGGER fail_activity BEFORE UPDATE OF last_activity ON channels BEGIN SELECT RAISE(ABORT, 'test activity failure'); END`, `DROP TRIGGER fail_activity`},
		{"commit", `CREATE TABLE append_failure (id TEXT REFERENCES channels(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TRIGGER fail_append_commit AFTER UPDATE OF last_activity ON channels BEGIN INSERT INTO append_failure VALUES ('missing'); END`, `DROP TRIGGER fail_append_commit; DROP TABLE append_failure`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Unix(1789000000, 0)
			s, ts := newTestServer(t, func(s *Server) { s.Now = func() time.Time { return now } })
			id, k := createChannel(t, ts)
			ks, err := ParseK(k)
			if err != nil {
				t.Fatal(err)
			}
			before := now.Add(-time.Hour)
			if _, err := s.Store.db.Exec(`UPDATE channels SET last_activity=? WHERE id=?`, before.Unix(), id); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Store.db.Exec(tc.setup); err != nil {
				t.Fatal(err)
			}
			notified := s.Store.notifyCh(id)
			a := chn{ts: ts, id: id, k: k, ks: ks, name: "Fixture"}
			if resp, body := a.request(t, "POST", "&last=-1", &Inner{From: a.name, Text: "must roll back"}); resp.StatusCode != http.StatusInternalServerError {
				t.Fatalf("failed append: %d %s", resp.StatusCode, body)
			}
			page, err := s.Store.Events(id, -1)
			if err != nil || page.Last != -1 || len(page.Events) != 0 {
				t.Fatalf("failed append persisted an event: %+v %v", page, err)
			}
			channel, err := s.Store.Channel(id)
			if err != nil || !channel.LastActivity.Equal(before) {
				t.Fatalf("failed append refreshed activity: %+v %v", channel, err)
			}
			select {
			case <-notified:
				t.Fatal("failed append notified readers before commit")
			default:
			}
			if _, err := s.Store.db.Exec(tc.cleanup); err != nil {
				t.Fatal(err)
			}
			if resp, body := a.request(t, "POST", "&last=-1", &Inner{From: a.name, Text: "committed"}); resp.StatusCode != http.StatusOK {
				t.Fatalf("next append: %d %s", resp.StatusCode, body)
			}
			page, err = s.Store.Events(id, -1)
			if err != nil || page.Last != 0 || len(page.Events) != 1 || page.Events[0].Seq != 0 {
				t.Fatalf("rollback consumed a sequence: %+v %v", page, err)
			}
			channel, err = s.Store.Channel(id)
			if err != nil || !channel.LastActivity.Equal(now) {
				t.Fatalf("successful append missed activity update: %+v %v", channel, err)
			}
			select {
			case <-notified:
			default:
				t.Fatal("committed append did not notify readers")
			}
		})
	}
}
