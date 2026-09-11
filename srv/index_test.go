package srv

import (
	"maps"
	"regexp"
	"strings"
	"testing"
)

var newButtonRE = regexp.MustCompile(`<a\b[^>]*\bid="newbtn"[^>]*>`)

// indexButtonDisabled reports whether the native creation link is initially busy or disabled.
// It fails if the link is missing or has the wrong destination.
func indexButtonDisabled(t *testing.T, html string) bool {
	t.Helper()
	link := newButtonRE.FindString(html)
	if link == "" || !strings.Contains(link, `href="/#new"`) {
		t.Fatal("landing page has no #newbtn link to /#new")
	}
	return regexp.MustCompile(`\sdisabled(=|\s|>)|\saria-(disabled|busy)="true"`).MatchString(link)
}

const indexBudget = 20 << 10 // crypto template plus the click handler

func TestIndexPublic(t *testing.T) {
	s, ts := newTestServer(t)
	channel := newSeededChannel(t, ts, "Fixture")
	resp, html := do(t, "GET", ts.URL+"/", "", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("GET /: %d", resp.StatusCode)
	}
	for h, want := range map[string]string{
		"Content-Type":           "text/html; charset=utf-8",
		"Cache-Control":          "no-store",
		"X-Robots-Tag":           "noindex, nofollow",
		"Referrer-Policy":        "no-referrer",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := resp.Header.Get(h); got != want {
			t.Errorf("%s: %q want %q", h, got, want)
		}
	}
	if len(html) > indexBudget {
		t.Errorf("landing page is %d bytes, budget %d: is a chat or vendor bundle leaking in?", len(html), indexBudget)
	}
	if !regexp.MustCompile(`<p\b[^>]*\bid="status"[^>]*\brole="status"`).MatchString(html) {
		t.Error("no live #status region for the creation outcome")
	}
	if !regexp.MustCompile(`<svg\b[^>]*\baria-hidden="true"`).MatchString(html) {
		t.Error("decorative SVG is not hidden from assistive tech")
	}
	if strings.Contains(html, s.retentionText()) {
		t.Error("landing page shows the configured lifetime")
	}
	if indexButtonDisabled(t, html) {
		t.Error("public creation button is disabled")
	}
	for _, crypto := range []string{"<script", "VECTORS", "newChannel", "HKDF", "deriveBits"} {
		if !strings.Contains(html, crypto) {
			t.Errorf("public creation lacks %q", crypto)
		}
	}
	if !strings.Contains(html, "getElementById('newbtn')") && !strings.Contains(html, `getElementById("newbtn")`) {
		t.Error("page does not wire the button")
	}
	// Self-contained: inline decorative SVG and system fonts only.
	if !strings.Contains(html, "<svg") {
		t.Error("no inline decorative SVG")
	}
	// A data: icon is fine; anything the browser would fetch is not.
	if strings.Contains(strings.ReplaceAll(html, `<link rel="icon" href="data:`, ""), "<link") {
		t.Error("landing page has a fetched <link>")
	}
	for _, external := range []string{"<img", "<iframe", "@import", "@font-face", "url(http", "url(//", "url(/", `url("`, "url('", "<script src", `<script type="module" src`, "fonts.googleapis", "marked", "DOMPurify", "h1.title[contenteditable]"} {
		if strings.Contains(html, external) {
			t.Errorf("landing page pulls in %q", external)
		}
	}
	if strings.Contains(html, channel.id) || strings.Contains(html, channel.k) {
		t.Error("landing page exposes an existing channel")
	}
	for _, want := range []string{`<title>Mayfly Chat</title>`, `<h1 id="brand">`, `Mayfly Chat</a>`, `href="https://github.com/josharian/mayfly/blob/main/srv/docs/hosting.md"`, `>llms.txt</a>`, `<footer class="site">`, `prefers-color-scheme:dark`} {
		if !strings.Contains(html, want) {
			t.Errorf("landing page lacks %q", want)
		}
	}
	if !strings.Contains(html, `href="/docs/security.md"`) || !strings.Contains(html, `href="/llms.txt"`) || !strings.Contains(html, `href="/docs/about.md"`) {
		t.Error("the page should point at the usage and security documents and /llms.txt")
	}

}

// TestIndexGetHasNoSideEffects checks that public page loads neither create nor renew channels.
func TestIndexGetHasNoSideEffects(t *testing.T) {
	s, ts := newTestServer(t)
	channel := newSeededChannel(t, ts, "Fixture")
	beforeChannel, err := s.Store.Channel(channel.id)
	if err != nil {
		t.Fatal(err)
	}
	count := func() int {
		var n int
		if err := s.Store.db.QueryRow(`SELECT count(*) FROM channels`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := count()
	s.quota.mu.Lock()
	beforeBuckets := maps.Clone(s.quota.buckets)
	s.quota.mu.Unlock()
	for range 3 {
		if resp, _ := do(t, "GET", ts.URL+"/", "", nil); resp.StatusCode != 200 {
			t.Fatal(resp.StatusCode)
		}
	}
	if resp, _ := do(t, "GET", ts.URL+"/?id=x&auth_hash=y", "", nil); resp.StatusCode != 200 {
		t.Fatal("query parameters on the landing page", resp.StatusCode)
	}
	if count() != before {
		t.Fatal("GET / changed the channel table")
	}
	afterChannel, err := s.Store.Channel(channel.id)
	if err != nil || !afterChannel.LastActivity.Equal(beforeChannel.LastActivity) {
		t.Fatal("GET / changed channel activity", err)
	}
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	if len(beforeBuckets) != 1 || !maps.Equal(beforeBuckets, s.quota.buckets) {
		t.Fatal("GET / counted towards a creation quota")
	}
}
