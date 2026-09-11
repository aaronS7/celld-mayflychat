package srv

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestRetentionDisplay checks policy text in instructions and missing-channel pages,
// and gives the channel script a usable deadline, including "never".
func TestRetentionDisplay(t *testing.T) {
	requireNode(t)
	for _, tc := range []struct {
		name      string
		retention time.Duration
		want      string
	}{
		{"default", DefaultRetention, "24h of inactivity"},
		{"short", 90 * time.Minute, "1h30m of inactivity"},
		{"disabled", 0, "not automatically deleted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, ts := newTestServer(t, func(s *Server) { s.Retention = tc.retention })
			a := newSeededChannel(t, ts, "Go")
			_, body := do(t, "GET", a.url(""), "", nil)
			if !strings.Contains(body, tc.want) {
				t.Errorf("instructions lack the configured lifetime %q", tc.want)
			}
			_, index := do(t, "GET", ts.URL+"/", "", nil)
			if strings.Contains(index, tc.want) {
				t.Errorf("index shows the configured lifetime %q", tc.want)
			}
			response, gone := do(t, "GET", ts.URL+"/c/"+strings.Repeat("A", 22), "", htmlHdr())
			if response.StatusCode != http.StatusNotFound {
				t.Fatalf("missing-channel status: %d", response.StatusCode)
			}
			if !strings.Contains(gone, `<a id="newbtn" class="button" href="/#new">New channel</a>`) {
				t.Error("missing-channel page lacks its native New channel button")
			}
			if !strings.Contains(gone, tc.want) || !strings.Contains(gone, "No such channel") {
				t.Errorf("the expired-channel page lacks the configured lifetime %q", tc.want)
			}

			_, html := do(t, "GET", a.url(""), "", htmlHdr())
			// The view shows a countdown, not the policy paragraph or an absolute date.
			if strings.Contains(html, tc.want) {
				t.Error("the view repeats the lifetime policy instead of a countdown")
			}
			if !strings.Contains(html, "Expires in <time") {
				t.Error("the view lacks its countdown")
			}
			ms := regexp.MustCompile(`const RETENTION_MS =\s*(\d+)\s*;`).FindStringSubmatch(html)
			if len(ms) != 2 || ms[1] != strconv.FormatInt(tc.retention.Milliseconds(), 10) {
				t.Fatalf("RETENTION_MS: %v", ms)
			}
			expires := regexp.MustCompile(`id="exp" datetime="([^"]*)"`).FindStringSubmatch(html)
			if len(expires) != 2 {
				t.Fatal("no expiry element")
			}
			if tc.retention == 0 {
				if expires[1] != "" {
					t.Fatalf("no expiry means no deadline, got %q", expires[1])
				}
				if !regexp.MustCompile(`<p class="meta" id="expwrap"[^>]*\bhidden\b`).MatchString(html) {
					t.Fatal("the expiry line should be hidden when nothing expires")
				}
				// An empty deadline must not become an "Invalid Date" heading.
				script := regexp.MustCompile(`(?s)let expires = Date.parse\(.*?\);.*?if \(expires > 0\) setInterval\(showExpiry, 60000\);`).FindString(html)
				if script == "" {
					t.Fatal("expiry script missing")
				}
				out := runNode(t, `
const assert = require('node:assert/strict');
const exp = {textContent:'x', dateTime:'x'};
const RETENTION_MS = 0, EXPIRES_AT = '';
let ticking = false; globalThis.setInterval = () => { ticking = true; };
`+script+`

assert(Number.isNaN(expires));
assert.equal(exp.textContent, 'x');
assert.equal(ticking, false);
console.log('ok');`)
				if !strings.HasPrefix(out, "ok") {
					t.Fatalf("disabled expiry: %s", out)
				}
				return
			}
			deadline, err := time.Parse(time.RFC3339, expires[1])
			if err != nil {
				t.Fatalf("expiry %q: %v", expires[1], err)
			}
			if d := time.Until(deadline) - tc.retention; d > time.Minute || d < -time.Minute {
				t.Fatalf("expiry %s is not one retention from the last event", deadline)
			}
		})
	}
}
