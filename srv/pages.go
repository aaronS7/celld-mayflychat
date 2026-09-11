package srv

import (
	"crypto/rand"
	"embed"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
)

//go:embed templates/*.html
var templateFS embed.FS

//go:embed browser/*.js
var browserFS embed.FS

// browserScript includes only embedded application source named by trusted templates.
func browserScript(name string) (template.JS, error) {
	source, err := browserFS.ReadFile("browser/" + name)
	return template.JS(source), err
}

// Only these vendored build-time bytes are trusted JavaScript, never messages.
//
//go:embed static/vendor/marked.umd.js
var markedJS string

//go:embed static/vendor/purify.js
var purifyJS string

// docsFS holds /llms.txt and /docs/*.md: long-lived, embedded, and kept
// true by a test that greps them for every route in the mux.
//
//go:embed docs/llms.txt docs/*.md
var docsFS embed.FS

// emojiList supplies the reaction picker's "emoji<TAB>name" vocabulary.
// It contains Unicode Emoji 16.0's fully-qualified entries without skin-tone variants.
// See static/README.md for provenance and regeneration.
//
//go:embed static/emoji.txt
var emojiList []byte

//go:embed static/client.py
var clientPy []byte

//go:embed static/client.mjs
var clientNode []byte

//go:embed static/client.go
var clientGo []byte

//go:embed static/create.py
var createPy []byte

//go:embed static/create.mjs
var createNode []byte

//go:embed static/create.go
var createGo []byte

// staticSources are the downloadable single-file programs, served verbatim
// under /static/ as plain text whatever the request accepts.
var staticSources = map[string][]byte{
	"client.py": clientPy, "client.mjs": clientNode, "client.go": clientGo,
	"create.py": createPy, "create.mjs": createNode, "create.go": createGo,
}

// servePlainText serves fixed bytes as UTF-8 text. A nonempty cacheControl
// overrides the global no-store for content that is not sensitive.
func servePlainText(body []byte, cacheControl string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if cacheControl != "" {
			w.Header().Set("Cache-Control", cacheControl)
		}
		w.Write(body)
	}
}

// vectorsJSON fixes the crypto construction for every client. The Go tests
// read it from disk, and the view page inlines it so the browser can check
// itself against the same vectors before it touches a real channel.
//
//go:embed static/vectors.json
var vectorsJSON []byte

// acceptsHTML reports whether an explicit text/html preference selects HTML over plain text.
// Missing Accept and wildcards alone keep the raw-text default.
func acceptsHTML(h http.Header) bool {
	const maxAcceptBytes = 8192
	values := h.Values("Accept")
	size := 0
	for _, value := range values {
		size += len(value) + 1
		if size > maxAcceptBytes {
			return false
		}
	}
	parts := strings.Split(strings.Join(values, ","), ",")
	if len(parts) > 64 {
		return false
	}
	htmlQ, plainQ, plainSpecificity := 0.0, 0.0, -1
	for _, part := range parts {
		mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(part))
		if err != nil {
			continue
		}
		q := 1.0
		if raw, ok := params["q"]; ok {
			q, err = strconv.ParseFloat(raw, 64)
			if err != nil || !(q >= 0 && q <= 1) {
				continue
			}
		}
		if mediaType == "text/html" {
			htmlQ = max(htmlQ, q)
			continue
		}
		specificity := -1
		switch mediaType {
		case "text/plain":
			specificity = 2
		case "text/*":
			specificity = 1
		case "*/*":
			specificity = 0
		}
		if specificity > plainSpecificity {
			plainQ, plainSpecificity = q, specificity
		} else if specificity >= 0 && specificity == plainSpecificity {
			plainQ = max(plainQ, q)
		}
	}
	return htmlQ > 0 && htmlQ >= plainQ
}

// serveDoc serves exact embedded bytes, negotiating an HTML shell only for Markdown pages.
func (s *Server) serveDoc(w http.ResponseWriter, r *http.Request, name string) {
	markdown := strings.HasSuffix(name, ".md")
	if markdown {
		w.Header().Add("Vary", "Accept")
	}
	b, err := docsFS.ReadFile("docs/" + name)
	if err != nil {
		http.Error(w, "no such page; the index is /llms.txt", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600") // overrides the global no-store; nothing sensitive here
	if markdown && acceptsHTML(r.Header) {
		s.render(w, "doc.html", map[string]any{
			"Title": strings.TrimSuffix(name, ".md"), "Source": string(b),
			"MarkedJS": template.JS(markedJS), "PurifyJS": template.JS(purifyJS),
		})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(b)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	s.render(w, "index.html", map[string]any{
		"Vectors": template.JS(vectorsJSON),
	})
}

func (s *Server) render(w http.ResponseWriter, name string, data map[string]any) {
	s.renderStatus(w, http.StatusOK, name, data)
}

func (s *Server) renderStatus(w http.ResponseWriter, status int, name string, data map[string]any) {
	var random [32]byte
	rand.Read(random[:])
	nonce := b64u(random[:])
	data["CSPNonce"] = nonce
	w.Header().Set("Content-Security-Policy", contentSecurityPolicy+"; script-src 'nonce-"+nonce+"'; style-src 'nonce-"+nonce+"'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if err := s.tmpl.ExecuteTemplate(w, name, data); err != nil {
		slog.Error("render failed", "template", name)
	}
}

func (s *Server) retentionText() string {
	if s.Retention == 0 {
		return "Channels are not automatically deleted."
	}
	duration := s.Retention.String()
	if s.Retention%time.Hour == 0 {
		duration = strings.TrimSuffix(duration, "0m0s")
	} else if s.Retention%time.Minute == 0 {
		duration = strings.TrimSuffix(duration, "0s")
	}
	return fmt.Sprintf("Channels are deleted after %s of inactivity.", duration)
}

func (s *Server) missingChannelText() string {
	return "No such channel. " + s.retentionText()
}

func (s *Server) handleChannel(w http.ResponseWriter, r *http.Request) {
	w.Header().Add("Vary", "Accept")
	if acceptsHTML(r.Header) {
		s.handleView(w, r)
		return
	}
	s.handleInstructions(w, r)
}

func (s *Server) handleView(w http.ResponseWriter, r *http.Request) {
	c, err := s.channel(r)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			s.renderStatus(w, http.StatusNotFound, "gone.html", map[string]any{"RetentionText": s.retentionText()})
			return
		}
		s.storeErr(w, err)
		return
	}
	expiresAt := ""
	if s.Retention > 0 {
		expiresAt = c.LastActivity.Add(s.Retention).UTC().Format(time.RFC3339)
	}
	s.render(w, "view.html", map[string]any{
		"Channel": c, "Vectors": template.JS(vectorsJSON),
		"MarkedJS": template.JS(markedJS), "PurifyJS": template.JS(purifyJS),
		"RetentionMS": s.Retention.Milliseconds(), "ExpiresAt": expiresAt,
	})
}
