package srv

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestAnonymousCreation(t *testing.T) {
	_, ts := newTestServer(t)
	resp, body := do(t, "GET", ts.URL+"/", "", nil)
	if resp.StatusCode != 200 || resp.Header.Get("Location") != "" || indexButtonDisabled(t, body) || !strings.Contains(body, "newChannel") {
		t.Fatalf("public index: %d", resp.StatusCode)
	}
	if resp, _ := do(t, "POST", ts.URL+"/new", creationBody(t), nil); resp.StatusCode != 303 {
		t.Errorf("public creation: %d", resp.StatusCode)
	}
	if resp, _ := do(t, "GET", ts.URL+"/c/NOPE", "", nil); resp.StatusCode != 404 {
		t.Errorf("bad channel: %d", resp.StatusCode)
	}
}

func TestClientSideCreate(t *testing.T) {
	s, ts := newTestServer(t)
	k := NewK()
	ks, _ := Derive(k)
	mk := func(id, ah string) string {
		b, _ := json.Marshal(map[string]any{"id": id, "auth_hash": ah})
		return string(b)
	}
	good := mk(ks.ID, b64u(AuthHash(ks.Auth)))
	jsonHdr := map[string]string{"Content-Type": "application/json"}

	resp, body := do(t, "POST", ts.URL+"/new", good, jsonHdr)
	if resp.StatusCode != 303 || resp.Header.Get("Location") != "/c/"+ks.ID || strings.TrimSpace(body) != "/c/"+ks.ID {
		t.Fatalf("create: %d %q %q", resp.StatusCode, resp.Header.Get("Location"), body)
	}
	// Duplicate id: 409.
	if resp, _ := do(t, "POST", ts.URL+"/new", good, jsonHdr); resp.StatusCode != 409 {
		t.Errorf("duplicate: %d", resp.StatusCode)
	}
	// Bad shapes: 400.
	other, _ := Derive(NewK())
	for name, b := range map[string]string{
		"not json":       "{",
		"short id":       mk("abc", b64u(AuthHash(ks.Auth))),
		"padded id":      mk(other.ID+"==", b64u(AuthHash(other.Auth))),
		"short hash":     mk(other.ID, "AAAA"),
		"hex hash":       mk(other.ID, strings.Repeat("ab", 32)),
		"missing fields": `{"id":"` + other.ID + `"}`,
	} {
		if resp, body := do(t, "POST", ts.URL+"/new", b, jsonHdr); resp.StatusCode != 400 && resp.StatusCode != 413 {
			t.Errorf("%s: %d %s", name, resp.StatusCode, body)
		}
	}
	var n int
	s.Store.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&n)
	if n != 1 {
		t.Fatalf("bad shapes created channels: %d", n)
	}

	// Client encryption works; creation itself stores no blob.
	c := chn{ts, ks.ID, b64u(k), ks, "Alpha"}
	br := c.readEnvelopes(t)
	if len(br.Events) != 0 || br.Last != -1 {
		t.Fatalf("seq 0: %+v", br)
	}
	if code, _ := c.post(t, -1, "via local client"); code != 200 {
		t.Fatalf("local post: %d", code)
	}
	rp := c.read(t, -1)
	if len(rp.Messages) != 1 || rp.Messages[0].ID != 0 || rp.Messages[0].Text != "via local client" {
		t.Fatalf("local read: %+v", rp.Messages)
	}
	if resp, _ := c.request(t, "POST", "&last=0", &Inner{From: "Alpha", Text: "via encrypted transport"}); resp.StatusCode != 200 {
		t.Fatalf("event post: %d", resp.StatusCode)
	}
	// The relay stores only the hash supplied by the client.
	var ah []byte
	s.Store.db.QueryRow(`SELECT auth_hash FROM channels WHERE id=?`, ks.ID).Scan(&ah)
	if !bytes.Equal(ah, AuthHash(ks.Auth)) {
		t.Error("auth_hash differs from the client value")
	}
	// All channels created from this observed IP share the bucket.
	for i := 1; i < creationBurst; i++ {
		if resp, _ := do(t, "POST", ts.URL+"/new", creationBody(t), nil); resp.StatusCode != 303 {
			t.Fatal(resp.StatusCode)
		}
	}
	o, _ := Derive(NewK())
	if resp, _ := do(t, "POST", ts.URL+"/new", mk(o.ID, b64u(AuthHash(o.Auth))), jsonHdr); resp.StatusCode != 429 {
		t.Errorf("quota over json path: %d", resp.StatusCode)
	}
}
