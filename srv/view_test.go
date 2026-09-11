package srv

import (
	"net/http"
	"regexp"
	"strings"
	"testing"
)

func TestView(t *testing.T) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	resp, anonymous := do(t, "GET", a.url(""), "", htmlHdr())
	if resp.StatusCode != 200 {
		t.Fatalf("anonymous view: %d", resp.StatusCode)
	}
	for _, want := range []string{`<form id="compose">`, `id="name"`, `id="namebtn"`, `<b id="posting-name">human</b>`, `id="newbtn"`, `id="delbtn"`, `id="editbtn"`, `id="agenturl"`, `id="copybtn"`} {
		if !strings.Contains(anonymous, want) {
			t.Errorf("anonymous view lacks %q", want)
		}
	}
	if regexp.MustCompile(`<h1\b[^>]*\bid="title"[^>]*\bcontenteditable`).MatchString(anonymous) {
		t.Error("title editing is enabled by the script only after the key is verified")
	}
	if !regexp.MustCompile(`<button\b[^>]*\bid="editbtn"[^>]*aria-label="[^"]+"`).MatchString(anonymous) {
		t.Error("the title edit control needs an accessible name")
	}
	if regexp.MustCompile(`<form\b[^>]*\bid="compose"[^>]*\bhidden(?:[\s=>])`).MatchString(anonymous) {
		t.Error("composer must be available immediately with the default name")
	}
	resp, _ = do(t, "GET", ts.URL+"/c/NOPE", "", htmlHdr())
	if resp.StatusCode != 404 {
		t.Errorf("gone view: %d", resp.StatusCode)
	}
}

// TestViewKeyStaysLocal checks the one rule the whole design rests on: the
// key is in the fragment, and the server never sees it in a request or in
// anything it serves back.
func TestViewKeyStaysLocal(t *testing.T) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Go")
	for _, hdr := range []map[string]string{nil, htmlHdr()} {
		_, body := do(t, "GET", a.url(""), "", hdr)
		if strings.Contains(body, a.k) {
			t.Fatalf("%v contains the channel key", hdr)
		}
	}
	// Nothing the served markup points at carries key material. The script
	// builds one local anchor from KEY, which is the fragment itself.
	_, html := do(t, "GET", a.url(""), "", htmlHdr())
	markup := regexp.MustCompile(`(?s)<script[^>]*>.*?</script>`).ReplaceAllString(html, "")
	for _, bad := range regexp.MustCompile(`(?:href|src|action)="([^"]*)"`).FindAllStringSubmatch(markup, -1) {
		if strings.Contains(bad[1], "KEY") || strings.Contains(bad[1], "key=") || strings.Contains(bad[1], a.k) {
			t.Errorf("URL carries key material: %q", bad[1])
		}
	}
	// Every request the script makes is built from the channel id and the
	// derived bearer, never from KEY in a path or query.
	script := inlineScript(t, html, "app")
	for _, fetch := range regexp.MustCompile("fetch\\(`?([^`,)]*)").FindAllStringSubmatch(script, -1) {
		if strings.Contains(fetch[1], "KEY") {
			t.Errorf("fetch target carries the key: %q", fetch[1])
		}
	}
	// Agents get their instructions at the channel URL, not inside the human view.
	if strings.Contains(markup, "/static/client.") || strings.Contains(markup, "read --last") {
		t.Error("the view embeds the agent client recipe")
	}
}

// TestBrowserNamesAreLocal checks that the composer starts as page-local
// "human" with an inline rename control and no fixed or persisted identity.
func TestBrowserNamesAreLocal(t *testing.T) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Go")
	_, html := do(t, "GET", a.url(""), "", htmlHdr())
	for _, want := range []string{`<b id="posting-name">human</b>`, `<button id="namebtn" class="icon"`, `<input id="name" hidden`, `<form id="compose">`} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %s", want)
		}
	}
	if regexp.MustCompile(`<form\b[^>]*\bid="compose"[^>]*\bhidden`).MatchString(html) {
		t.Error("the composer must be available immediately")
	}
	for _, unwanted := range []string{"localStorage", "sessionStorage"} {
		if strings.Contains(html, unwanted) {
			t.Errorf("the view carries a fixed or persisted identity: %s", unwanted)
		}
	}
}

// TestPageLinksResolve checks that human-page links resolve to supported routes.
func TestPageLinksResolve(t *testing.T) {
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Go")
	seen := map[string]bool{}
	for _, page := range []string{ts.URL + "/", a.url(""), ts.URL + "/c/" + strings.Repeat("A", 22)} {
		_, html := do(t, "GET", page, "", htmlHdr())
		for _, want := range []string{`<a class="brand" href="/">`, `<footer class="site">`, `href="https://github.com/josharian/mayfly/blob/main/srv/docs/hosting.md"`, `href="/docs/about.md"`, `href="/llms.txt"`} {
			if !strings.Contains(html, want) {
				t.Errorf("%s lacks the shared shell piece %q", page, want)
			}
		}
		links := regexp.MustCompile(`href="(/[^"]*)"`).FindAllStringSubmatch(html, -1)
		if len(links) == 0 {
			t.Fatalf("%s has no links", page)
		}
		for _, link := range links {
			if seen[link[1]] {
				continue
			}
			seen[link[1]] = true
			if resp, body := do(t, "GET", ts.URL+link[1], "", nil); resp.StatusCode != http.StatusOK {
				t.Errorf("%s links to %s: %d %s", page, link[1], resp.StatusCode, body)
			}
		}
	}
	if !seen["/docs/security.md"] {
		t.Error("the human pages should point at the security and privacy document")
	}
}
