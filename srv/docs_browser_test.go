package srv

import (
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDocumentationBrowser(t *testing.T) {
	chrome := os.Getenv("CHROME_BIN")
	if chrome == "" {
		t.Skip("set CHROME_BIN to a Chrome/Chromium executable for real DOM/network tests")
	}
	fixture := "# Fixture title\n\n**Strong** and *emphasis*, ~~deleted~~ and `code`.\n\n" +
		"## Section heading\n\n[section](#section-heading), [next](next.md#section-heading), [up](../llms.txt), [external](https://example.invalid/path).\n\n" +
		"[bad](javascript:window.DOC_PWN=1) [entity bad](jav&#x61;script:window.DOC_PWN=1)\n\n" +
		"![Markdown alt](/probe/markdown.png)\n\n[![linked alt](/probe/linked.png)](https://example.invalid)\n\n" +
		"<img src='/probe/html.png' onerror='window.DOC_PWN=1'>\n\n" +
		"<iframe src='/probe/frame'></iframe><video poster='/probe/poster'><source src='/probe/movie'></video>\n\n" +
		"<link rel='prefetch' href='/probe/prefetch'><style>@import '/probe/style';</style>\n\n" +
		"</pre><script>window.DOC_PWN=1</script>\n\n" +
		"| Column | Value |\n| --- | --- |\n| table | **cell** |\n\n" +
		"```text\n" + strings.Repeat("wide ", 90) + "\n```\n"
	for _, tc := range []struct {
		name, path, width string
		dark, fallback    bool
	}{
		{"fixture-light-wide", "/docs/fixture.md", "1280", false, false},
		{"fixture-dark-narrow", "/docs/fixture.md", "390", true, false},
		{"fallback-light-narrow", "/docs/fixture.md", "390", false, true},
		{"fallback-dark-wide", "/docs/fixture.md", "1280", true, true},
		{"about-light-wide", "/docs/about.md", "1280", false, false},
		{"about-dark-narrow", "/docs/about.md", "390", true, false},
		{"index-light-narrow", "/llms.txt", "390", false, false},
		{"index-dark-wide", "/llms.txt", "1280", true, false},
		{"docs-index-light-wide", "/docs/llms.txt", "1280", false, false},
		{"docs-index-dark-narrow", "/docs/llms.txt", "390", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newTestServer(t)
			plain := strings.HasSuffix(tc.path, "/llms.txt")
			var plainConfig []byte
			if plain {
				raw, err := docsFS.ReadFile("docs/llms.txt")
				if err != nil {
					t.Fatal(err)
				}
				plainConfig, _ = json.Marshal(map[string]any{"source": string(raw), "dark": tc.dark, "width": tc.width})
			}
			var mu sync.Mutex
			var requests []string
			result := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/test-frame":
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					fmt.Fprintf(w, `<link rel="icon" href="data:,"><iframe style="border:0;width:%spx;height:900px" src="%s"></iframe>`, tc.width, tc.path)
					if plain {
						// Inspect Chrome's native text document from its parent; never append scripts to llms.txt.
						fmt.Fprintf(w, "<script>const DOC_TEST = %s;\n%s</script>", plainConfig, plainDocumentationBrowserChecks)
					}
					return
				case "/test-result":
					b, _ := io.ReadAll(r.Body)
					result <- string(b)
					return
				case tc.path, "/docs/next.md":
					// A second fixture page makes relative-link navigation an actual browser request.
				default:
					mu.Lock()
					requests = append(requests, r.URL.RequestURI())
					mu.Unlock()
					http.NotFound(w, r)
					return
				}
				page := httptest.NewRecorder()
				if strings.HasPrefix(r.URL.Path, "/docs/fixture") || r.URL.Path == "/docs/next.md" {
					marked, purify := markedJS, purifyJS
					if tc.fallback {
						marked, purify = "", ""
					}
					s.render(page, "doc.html", map[string]any{
						"Title": "Fixture", "Source": fixture,
						"MarkedJS": template.JS(marked), "PurifyJS": template.JS(purify),
					})
				} else {
					s.Handler().ServeHTTP(page, r)
				}
				// Keep sanitizer/layout checks independent of CSP and allow this iframe harness.
				// TestBrowserCSP checks the unmodified top-level policy separately.
				page.Header().Del("Content-Security-Policy")
				for key, values := range page.Header() {
					w.Header()[key] = values
				}
				w.WriteHeader(page.Code)
				io.Copy(w, page.Body)
				if plain {
					return
				}
				config, _ := json.Marshal(map[string]any{
					"fallback": tc.fallback, "fixture": strings.Contains(tc.path, "fixture"),
					"source": fixture, "dark": tc.dark, "width": tc.width,
				})
				fmt.Fprintf(w, "<script>const DOC_TEST = %s;\n%s</script>", config, documentationBrowserChecks)
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			startBrowser(t, ctx, browserPage{Chrome: chrome, URL: server.URL + "/test-frame", Dark: tc.dark})
			select {
			case got := <-result:
				if !strings.Contains(got, `"ok":true`) {
					t.Fatal(got)
				}
				t.Log(got)
			case <-ctx.Done():
				t.Fatal("documentation browser timed out")
			}
			mu.Lock()
			defer mu.Unlock()
			if len(requests) != 0 {
				t.Fatalf("document made automatic resource requests: %v", requests)
			}
		})
	}
}

const plainDocumentationBrowserChecks = `
window.addEventListener('load', async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const frame = document.querySelector('iframe');
    const doc = frame.contentDocument;
    assert(doc.contentType === 'text/plain', 'native plain-text document');
    assert(doc.body.textContent === DOC_TEST.source, 'exact embedded index text');
    assert(!doc.querySelector('main,header,footer,article,h1,a,script,link,img,iframe,video,audio,source,object,svg,form'), 'no Mayfly shell, rendered Markdown or resource elements');
    assert(!frame.contentWindow.marked && !frame.contentWindow.DOMPurify, 'no Markdown renderer loaded');
    assert(frame.contentWindow.matchMedia('(prefers-color-scheme: dark)').matches === DOC_TEST.dark, 'color scheme emulation');
    assert(frame.contentWindow.innerWidth === Number(DOC_TEST.width), 'exact document viewport');
    assert(frame.contentWindow.performance.getEntriesByType('resource').length === 0, 'no document subresources');
    await fetch('/test-result', {method:'POST', body:JSON.stringify({ok:true, path:doc.location.pathname, plain:true, dark:DOC_TEST.dark})});
  } catch (err) {
    await fetch('/test-result', {method:'POST', body:JSON.stringify({ok:false, error:String(err), stack:err.stack})});
  }
});
`

const documentationBrowserChecks = `
(async () => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const article = document.getElementById('document');
    assert(article && article.closest('main.shell.docs'), 'shared document shell');
    assert(document.querySelector('main > header a[href="/"]'), 'brand links home');
    const footer = document.querySelector('main > footer');
    assert(footer, 'footer belongs to shell');
    assert([...footer.querySelectorAll('a')].map(a => a.textContent.trim()).join('|') === 'What is this?|Security|Run your own|llms.txt', 'four shared footer links with no Open source link');
    assert(footer.querySelector('a[href="/docs/about.md"]')?.textContent === 'What is this?', 'usage link label and destination');
    assert(footer.querySelectorAll('svg').length === 1 && footer.querySelector('a[href="https://github.com/josharian/mayfly/blob/main/srv/docs/hosting.md"] > svg[aria-hidden="true"]'), 'GitHub icon belongs only to repository hosting link');
    assert(matchMedia('(prefers-color-scheme: dark)').matches === DOC_TEST.dark, 'color scheme emulation');
    assert(innerWidth === Number(DOC_TEST.width), 'exact document viewport');
    assert(!window.DOC_PWN, 'source escaped and scripts inert');
    assert(!article.querySelector('script,img,iframe,video,audio,source,link,style,object,svg,form,input'), 'no active/resource elements');
    assert(document.documentElement.scrollWidth <= innerWidth + 1, 'no page overflow');
    if (DOC_TEST.fallback) {
      assert(document.getElementById('document-source').textContent === DOC_TEST.source, 'readable exact text fallback');
    } else {
      assert(!document.getElementById('document-source'), 'source replaced after sanitization');
      assert(article.querySelector('h1'), 'Markdown heading rendered');
      if (location.pathname === '/docs/about.md') {
        assert(article.querySelector('h1').textContent === 'What is this?', 'about heading');
        assert(article.querySelector('p')?.textContent.includes('agents'), 'about page renders its prose');
      }
      if (DOC_TEST.fixture) {
        assert(article.querySelector('strong')?.textContent === 'Strong', 'strong text');
        assert(article.querySelector('table td strong')?.textContent === 'cell', 'table');
        assert(article.textContent.includes('Markdown alt') && article.textContent.includes('<img'), 'image alt and raw HTML remain text');
        assert(article.querySelector('a[href="#section-heading"]'), 'ordinary section link preserved');
        assert(article.querySelector('#section-heading')?.textContent === 'Section heading', 'heading target exists');
        assert(article.querySelector('a[href="../llms.txt"]')?.href === location.origin + '/llms.txt', 'parent-relative link preserved');
        assert(article.querySelector('a[href="https://example.invalid/path"]'), 'external link preserved without fetch');
        for (const a of article.querySelectorAll('a[href]')) {
          assert(['http:', 'https:'].includes(new URL(a.getAttribute('href'), location.href).protocol), 'only safe navigations');
        }
        if (location.pathname !== '/docs/next.md') {
          article.querySelector('a[href="#section-heading"]').click();
          assert(location.hash === '#section-heading', 'ordinary anchor navigation works');
          article.querySelector('a[href="next.md#section-heading"]').click();
          return;
        }
        assert(location.hash === '#section-heading', 'relative document link navigated with its anchor');
      }
    }
    await fetch('/test-result', {method:'POST', body:JSON.stringify({ok:true, path:location.pathname, dark:DOC_TEST.dark, fallback:DOC_TEST.fallback})});
  } catch (err) {
    await fetch('/test-result', {method:'POST', body:JSON.stringify({ok:false, error:String(err), stack:err.stack})});
  }
})();
`

// withoutCSPForDOMTests allows instrumented iframe harnesses to test DOM behavior
// independently of CSP. Never use it in enforcement or native-navigation tests.
type withoutCSPForDOMTests struct{ http.ResponseWriter }

func (w withoutCSPForDOMTests) WriteHeader(status int) {
	w.Header().Del("Content-Security-Policy")
	w.ResponseWriter.WriteHeader(status)
}

func (w withoutCSPForDOMTests) Write(b []byte) (int, error) {
	w.Header().Del("Content-Security-Policy")
	return w.ResponseWriter.Write(b)
}
