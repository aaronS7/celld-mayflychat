package srv

import (
	"html"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestDocumentation checks links, API coverage, and the reusable client recipe.
func TestDocumentation(t *testing.T) {
	var text strings.Builder
	entries, err := docsFS.ReadDir("docs")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		body, err := docsFS.ReadFile("docs/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		text.Write(body)
		text.WriteByte('\n')
	}
	all := text.String()
	source, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	patterns := regexp.MustCompile(`handle\("(?:[A-Z]+ )?([^" ]+)"`).FindAllStringSubmatch(string(source), -1)
	if len(patterns) < 8 {
		t.Fatalf("expected route declarations, found %d", len(patterns))
	}
	for _, pattern := range patterns {
		if strings.Contains(pattern[1], "{rest...}") {
			continue
		}
		route := strings.NewReplacer("{id}", "<id>", "{$}", "", "{page}", "").Replace(pattern[1])
		if !strings.Contains(all, route) {
			t.Errorf("undocumented route: %s", route)
		}
	}
	for _, route := range []string{"DELETE /c/<id>", "/static/create.py", "/static/create.mjs", "/static/create.go"} {
		if !strings.Contains(all, route) {
			t.Errorf("undocumented route: %s", route)
		}
	}
	main, err := os.ReadFile("../cmd/mayfly/main.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, flag := range regexp.MustCompile(`flag\.\w+\("([a-z-]+)"`).FindAllStringSubmatch(string(main), -1) {
		if !strings.Contains(all, "`-"+flag[1]+"`") {
			t.Errorf("undocumented flag: %s", flag[1])
		}
	}
	_, ts := newTestServer(t)
	if response, _ := do(t, "GET", ts.URL+"/docs/missing.md", "", nil); response.StatusCode != http.StatusNotFound {
		t.Errorf("missing documentation: %d", response.StatusCode)
	}
	clients, err := docsFS.ReadFile("docs/clients.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, recipe := range []string{`$CMD "$URL" read --last N`, `$CMD "$URL" post --from "$NAME" --last N`} {
		if !strings.Contains(string(clients), recipe) {
			t.Errorf("client recipe missing: %s", recipe)
		}
	}
	if !strings.Contains(all, "go build ./cmd/mayfly") {
		t.Error("documentation lacks the standalone Go build command")
	}
	hosting, err := docsFS.ReadFile("docs/hosting.md")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(hosting), "# Run your own\n\n*Written by an agent.*\n") {
		t.Error("hosting page lacks its agent-written disclosure")
	}
}

// TestDocumentationLinks checks the same document links in the checkout and on the relay.
func TestDocumentationLinks(t *testing.T) {
	_, ts := newTestServer(t)
	pages := map[string]string{
		"../README.md":       "",
		"../ARCHITECTURE.md": "",
		"../CONTRIBUTING.md": "",
	}
	entries, err := docsFS.ReadDir("docs")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		pages["docs/"+entry.Name()] = "/docs/" + entry.Name()
	}
	pages["docs/llms.txt"] = "/llms.txt"
	links := regexp.MustCompile(`\]\(([^\s)]+)\)`)
	for file, route := range pages {
		t.Run(file, func(t *testing.T) {
			body, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			base, err := url.Parse(ts.URL + route)
			if err != nil {
				t.Fatal(err)
			}
			if route != "" {
				response, served := do(t, "GET", base.String(), "", nil)
				if response.StatusCode != http.StatusOK || served != string(body) {
					t.Fatalf("%s does not serve the checked-in document: %d", route, response.StatusCode)
				}
			}
			for _, match := range links.FindAllStringSubmatch(string(body), -1) {
				target, err := url.Parse(match[1])
				if err != nil {
					t.Errorf("invalid link %q: %v", match[1], err)
					continue
				}
				if target.IsAbs() || target.Host != "" {
					continue // External services are not dependencies of the local test suite.
				}
				// The root-served web index has a different source directory;
				// other documents use links that work in both locations.
				if route != "/llms.txt" && target.Path != "" {
					if strings.HasPrefix(target.Path, "/") {
						t.Errorf("%q is server-root-relative, not repository-relative", match[1])
						continue
					}
					if _, err := os.Stat(filepath.Join(filepath.Dir(file), target.Path)); err != nil {
						t.Errorf("repository link %q: %v", match[1], err)
					}
				}
				if route == "" {
					continue
				}
				response, _ := do(t, "GET", base.ResolveReference(target).String(), "", nil)
				if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/plain") {
					t.Errorf("web document link %q: %d (%s)", match[1], response.StatusCode, response.Header.Get("Content-Type"))
				}
			}
		})
	}
}

func TestDocumentationRepresentations(t *testing.T) {
	_, ts := newTestServer(t)
	entries, err := docsFS.ReadDir("docs")
	if err != nil {
		t.Fatal(err)
	}
	sourceElement := regexp.MustCompile(`(?s)<pre id="document-source">(.*?)</pre>`)
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		path := "/docs/" + entry.Name()
		raw, err := os.ReadFile("docs/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		for _, accept := range []string{"", "*/*", "text/plain", "text/html", "text/html;q=0, */*;q=1"} {
			t.Run(entry.Name()+"/"+accept, func(t *testing.T) {
				response, body := do(t, "GET", ts.URL+path, "", map[string]string{"Accept": accept})
				if response.StatusCode != http.StatusOK || response.Header.Get("Vary") != "Accept" || response.Header.Get("Cache-Control") != "public, max-age=3600" {
					t.Fatalf("document headers: %d %v", response.StatusCode, response.Header)
				}
				if accept != "text/html" {
					if body != string(raw) || response.Header.Get("Content-Type") != "text/plain; charset=utf-8" {
						t.Fatal("raw document differs from checked-in bytes")
					}
					return
				}
				if response.Header.Get("Content-Type") != "text/html; charset=utf-8" {
					t.Fatal("HTML document has wrong content type")
				}
				for _, want := range []string{`<main class="shell docs">`, `<article id="document" class="prose">`, "DOMPurify", "marked"} {
					if !strings.Contains(body, want) {
						t.Errorf("document shell missing %q", want)
					}
				}
				match := sourceElement.FindStringSubmatch(body)
				if len(match) != 2 || html.UnescapeString(match[1]) != string(raw) {
					t.Fatal("HTML source element does not contain the escaped document")
				}
			})
		}
	}
	for _, accept := range []string{"text/html", "text/plain"} {
		response, _ := do(t, "GET", ts.URL+"/docs/missing.md", "", map[string]string{"Accept": accept})
		if response.StatusCode != http.StatusNotFound || response.Header.Get("Vary") != "Accept" || response.Header.Get("Cache-Control") != "no-store" {
			t.Errorf("missing document: %d %v", response.StatusCode, response.Header)
		}
	}
}

func TestLLMSAlwaysPlainText(t *testing.T) {
	_, ts := newTestServer(t)
	raw, err := docsFS.ReadFile("docs/llms.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/llms.txt", "/docs/llms.txt"} {
		for _, accept := range []string{
			"", "*/*", "text/*", "text/plain", "text/html", "application/json",
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
			"text/html;q=0, */*;q=1", "text/html;q=1, text/plain;q=0",
			"text/html;q=0.5, text/plain;q=1",
		} {
			for _, method := range []string{"GET", "HEAD"} {
				t.Run(path+"/"+method+"/"+accept, func(t *testing.T) {
					response, body := do(t, method, ts.URL+path, "", map[string]string{"Accept": accept})
					if response.StatusCode != http.StatusOK {
						t.Fatalf("index status: %d", response.StatusCode)
					}
					for header, want := range map[string]string{
						"Content-Type":           "text/plain; charset=utf-8",
						"Cache-Control":          "public, max-age=3600",
						"Vary":                   "",
						"Referrer-Policy":        "no-referrer",
						"X-Robots-Tag":           "noindex, nofollow",
						"X-Content-Type-Options": "nosniff",
					} {
						if got := response.Header.Get(header); got != want {
							t.Errorf("%s = %q, want %q", header, got, want)
						}
					}
					want := string(raw)
					if method == "HEAD" {
						want = ""
					}
					if body != want {
						t.Fatal("index response differs from exact embedded bytes (or empty HEAD body)")
					}
				})
			}
		}
	}
}

func TestSourceDownloadsAlwaysRaw(t *testing.T) {
	logs := captureLogs(t)
	_, ts := newTestServer(t)
	for _, name := range []string{"client.py", "client.mjs", "client.go", "create.py", "create.mjs", "create.go"} {
		raw, err := os.ReadFile("static/" + name)
		if err != nil {
			t.Fatal(err)
		}
		for _, accept := range []string{"", "*/*", "text/plain", "text/html", "text/html;q=0"} {
			t.Run(name+"/"+accept, func(t *testing.T) {
				response, body := do(t, "GET", ts.URL+"/static/"+name, "", map[string]string{"Accept": accept})
				if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/plain; charset=utf-8" || response.Header.Get("Vary") != "" || body != string(raw) {
					t.Fatalf("source contract changed: %d %v", response.StatusCode, response.Header)
				}
			})
		}
		if !strings.Contains(logs.String(), `route="GET /static/`+name+`"`) {
			t.Errorf("missing fixed source route label for %s", name)
		}
	}
}

func TestDocumentsDoNotReflectChannelData(t *testing.T) {
	logs := captureLogs(t)
	_, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "document-private-sender")
	if code, _ := a.post(t, 0, "/title document-private-title"); code != http.StatusOK {
		t.Fatal("post fixture:", code)
	}
	for _, path := range []string{"/llms.txt", "/docs/about.md"} {
		response, body := do(t, "GET", ts.URL+path+"?key="+a.k+"&channel="+a.id, "", bearerHdr(a.ks.Auth, htmlHdr()))
		if response.StatusCode != http.StatusOK {
			t.Fatal("document:", response.StatusCode)
		}
		for _, secret := range []string{a.id, a.k, a.ks.Auth, "document-private-sender", "document-private-title"} {
			if strings.Contains(body, secret) || strings.Contains(logs.String(), secret) {
				t.Errorf("document response/log contains %q", secret)
			}
		}
	}
}
