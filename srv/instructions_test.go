package srv

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

func TestInstructions(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	before, _ := s.Store.Channel(a.id)
	namePattern := regexp.MustCompile(`^(` + strings.Join(nato, "|") + `)[0-9]{2}$`)
	suggestionPattern := regexp.MustCompile(`Choose NAME \(suggestion: ([^)]+)\)\.`)
	for range 3 {
		resp, body := do(t, "GET", a.url(""), "", nil)
		if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain") {
			t.Fatal(resp.StatusCode)
		}
		suggestion := suggestionPattern.FindStringSubmatch(body)
		if len(suggestion) != 2 || !namePattern.MatchString(suggestion[1]) {
			t.Fatalf("invalid instruction suggestion: %q", suggestion)
		}
		for _, want := range []string{"/static/client.py", "/static/client.mjs", "/static/client.go", "cryptography", "full channel URL including #key", "password", "read --last N --wait S", `post --from "$NAME" --last N --wait S <<'MSG'`, "while more is true", "tool timeout", "/title TEXT", "/react N", "/unreact N", "/re N", "24h", "tailcat#send-and-receive-files", "/llms.txt"} {
			if !strings.Contains(body, want) {
				t.Errorf("instructions missing %q", want)
			}
		}
		for _, bad := range []string{a.k, a.ks.Auth, "Authorization:", "pip install", "npm install", "go install"} {
			if strings.Contains(body, bad) {
				t.Errorf("instructions contain %q", bad)
			}
		}
	}
	after, _ := s.Store.Channel(a.id)
	if !before.LastActivity.Equal(after.LastActivity) || len(a.readEnvelopes(t).Events) != 1 {
		t.Fatal("instructions changed channel")
	}
	for range 1000 {
		if name := suggestName(); !namePattern.MatchString(name) {
			t.Fatalf("invalid suggestion: %q", name)
		}
	}
	resp, body := do(t, "GET", ts.URL+"/static/client.py", "", nil)
	if resp.StatusCode != 200 || !strings.HasPrefix(body, "#!/usr/bin/env python3") || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("client.py: %d", resp.StatusCode)
	}
}

func TestInstructionsOriginPolicy(t *testing.T) {
	for _, trust := range []bool{false, true} {
		t.Run(fmt.Sprintf("trust=%v", trust), func(t *testing.T) {
			_, ts := newTestServer(t, func(s *Server) { s.TrustProxy = trust })
			id, _ := createChannel(t, ts)
			headers := map[string]string{"X-Forwarded-Proto": "https", "X-Forwarded-Host": "public.example.test"}
			origin := ts.URL
			if trust {
				origin = "https://public.example.test"
			}
			resp, plain := do(t, "GET", ts.URL+"/c/"+id, "", headers)
			if resp.StatusCode != 200 {
				t.Fatalf("instructions: %d", resp.StatusCode)
			}
			for _, path := range []string{"/static/client.py", "/static/client.mjs", "/static/client.go", "/c/" + id, "/llms.txt"} {
				if !strings.Contains(plain, origin+path) {
					t.Errorf("plain instructions lack %q", origin+path)
				}
			}
			if !trust && strings.Contains(plain, "public.example.test") {
				t.Fatal("untrusted forwarded host entered instructions")
			}
			_, view := do(t, "GET", ts.URL+"/c/"+id, "", htmlHdr(headers))
			if strings.Contains(view, `id="instr"`) || strings.Contains(view, "https://public.example.test/static/client.py") {
				t.Fatal("the human view must not embed the agent instructions")
			}
			app := inlineScript(t, view, "app")
			if strings.Contains(app, "public.example.test") || !strings.Contains(app, "location.origin + '/c/' + CID + '#' + KEY") {
				t.Fatal("browser sharing must derive its origin locally, not from proxy headers")
			}
		})
	}
}
