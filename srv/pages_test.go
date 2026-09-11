package srv

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestAcceptsHTML(t *testing.T) {
	for _, tc := range []struct {
		name   string
		accept []string
		want   bool
	}{
		{"missing", nil, false},
		{"wildcard", []string{"*/*"}, false},
		{"text wildcard", []string{"text/*"}, false},
		{"plain", []string{"text/plain"}, false},
		{"html", []string{"text/html"}, true},
		{"browser", []string{"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8"}, true},
		{"zero", []string{"text/html;q=0"}, false},
		{"zero with wildcard", []string{"text/html;q=0, */*;q=1"}, false},
		{"zero with text wildcard", []string{"text/html;q=0, text/*;q=1"}, false},
		{"plain preferred", []string{"text/html;q=0.5, text/plain"}, false},
		{"html preferred", []string{"text/html, text/plain;q=0.5"}, true},
		{"tie", []string{"text/plain, text/html"}, true},
		{"specific exclusion", []string{"text/plain;q=0, */*;q=1, text/html;q=0.5"}, true},
		{"split lines", []string{"text/plain;q=0.5", "text/html"}, true},
		{"case and parameters", []string{" TEXT/HTML; charset=utf-8; Q=0.9, text/plain;q=0.2"}, true},
		{"invalid quality", []string{"text/html;q=bogus"}, false},
		{"nan quality", []string{"text/html;q=NaN"}, false},
		{"negative quality", []string{"text/html;q=-0.1"}, false},
		{"out of range", []string{"text/html;q=1.1"}, false},
		{"invalid entry", []string{"text/html;broken"}, false},
		{"too many entries", []string{strings.Repeat("text/html,", 64) + "text/html"}, false},
		{"oversized", []string{"text/html; extra=" + strings.Repeat("x", 8192)}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := acceptsHTML(http.Header{"Accept": tc.accept}); got != tc.want {
				t.Errorf("acceptsHTML(%q) = %v, want %v", tc.accept, got, tc.want)
			}
		})
	}
}

func TestCanonicalChannelRepresentations(t *testing.T) {
	s, ts := newTestServer(t)
	id, _ := createChannel(t, ts)
	before, err := s.Store.Channel(id)
	if err != nil {
		t.Fatal(err)
	}
	s.Now = func() time.Time { return before.LastActivity.Add(time.Hour) }
	rendered, view := do(t, "GET", ts.URL+"/c/"+id, "", htmlHdr())
	if rendered.StatusCode != http.StatusOK || !strings.HasPrefix(rendered.Header.Get("Content-Type"), "text/html") || !strings.Contains(view, `id="agenturl"`) {
		t.Fatal("canonical HTML is not the human view")
	}
	if unsupported, _ := do(t, "GET", ts.URL+"/c/"+id+"/view", "", htmlHdr()); unsupported.StatusCode != http.StatusNotFound {
		t.Fatal("unsupported /view route is served")
	}
	for _, tc := range []struct {
		accept string
		html   bool
	}{
		{"", false}, {"*/*", false}, {"text/plain", false}, {"text/html", true},
		{"text/html;q=0, */*;q=1", false}, {"text/html;q=0.1, text/plain", false},
	} {
		for _, ua := range []string{"curl/8.0", "Mozilla/5.0"} {
			t.Run(tc.accept+"/"+ua, func(t *testing.T) {
				resp, body := do(t, "GET", ts.URL+"/c/"+id, "", map[string]string{"Accept": tc.accept, "User-Agent": ua})
				if resp.StatusCode != http.StatusOK || resp.Header.Get("Vary") != "Accept" || resp.Header.Get("Cache-Control") != "no-store" {
					t.Fatalf("canonical response: %d %v", resp.StatusCode, resp.Header)
				}
				if tc.html {
					if withoutNonces(body) != withoutNonces(view) || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
						t.Fatal("canonical HTML is not the channel view")
					}
					return
				}
				if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain") || !strings.Contains(body, `read --last N --wait S`) || strings.Contains(body, "/c/"+id+"/view") {
					t.Fatalf("canonical raw instructions: %s", body)
				}
			})
		}
	}
	after, err := s.Store.Channel(id)
	if err != nil || !after.LastActivity.Equal(before.LastActivity) {
		t.Fatalf("representations refreshed activity: %+v %v", after, err)
	}
	for _, accept := range []string{"text/html", "text/html;q=0", "*/*"} {
		resp, body := do(t, "GET", ts.URL+"/c/missing", "", map[string]string{"Accept": accept})
		wantType := "text/plain"
		if accept == "text/html" {
			wantType = "text/html"
		}
		if resp.StatusCode != http.StatusNotFound || resp.Header.Get("Vary") != "Accept" || !strings.HasPrefix(resp.Header.Get("Content-Type"), wantType) || !strings.Contains(body, "No such channel") {
			t.Errorf("missing channel (%s): %d %v", accept, resp.StatusCode, resp.Header)
		}
	}
}

func TestShortRetentionCopy(t *testing.T) {
	for _, tc := range []struct {
		retention time.Duration
		want      string
	}{
		{0, "Channels are not automatically deleted."},
		{DefaultRetention, "Channels are deleted after 24h of inactivity."},
		{90 * time.Minute, "Channels are deleted after 1h30m of inactivity."},
		{1500 * time.Millisecond, "Channels are deleted after 1.5s of inactivity."},
	} {
		s := &Server{Retention: tc.retention}
		if got := s.retentionText(); got != tc.want {
			t.Errorf("retention %s = %q, want %q", tc.retention, got, tc.want)
		}
	}
}
