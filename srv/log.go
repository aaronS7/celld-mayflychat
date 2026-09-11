package srv

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"time"
)

// Request logs describe operations, not request contents. Route patterns are
// fixed by the mux; paths, query names/values, headers, and response bodies
// stay out. Handlers add numeric and boolean annotations with note.

type ctxKey struct{}

type reqInfo struct {
	attrs []any
}

// note adds key/value annotations to the current request's log line.
func note(r *http.Request, kv ...any) {
	if ri, ok := r.Context().Value(ctxKey{}).(*reqInfo); ok {
		for i := 0; i+1 < len(kv); i += 2 {
			// Annotations carry metrics and booleans, never arbitrary strings.
			switch kv[i+1].(type) {
			case bool, int, int64, float64:
				ri.attrs = append(ri.attrs, kv[i], kv[i+1])
			}
		}
	}
}

// noteUnknownParams counts query parameters outside allowed in the request
// log. It does not reject them; the count is a hint that a client is confused.
func noteUnknownParams(r *http.Request, allowed ...string) {
	unknown := 0
	for k := range r.URL.Query() {
		if !slices.Contains(allowed, k) {
			unknown++
		}
	}
	if unknown > 0 {
		note(r, "unknown_params", unknown)
	}
}

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status != 0 {
		return
	}
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// shortID returns a bounded correlation label only for canonical channel IDs.
func shortID(id string) string {
	if len(id) != 22 {
		return ""
	}
	b, err := unb64u(id)
	if err != nil || len(b) != idLen || b64u(b) != id {
		return ""
	}
	return id[:6]
}

// logRequests logs one line per request. patterns is the set of registered
// mux patterns; anything else logs as "unmatched", because CONNECT redirects
// can put a request-derived path in r.Pattern.
func logRequests(patterns map[string]bool, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ri := &reqInfo{}
		r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, ri))
		sw := &statusWriter{ResponseWriter: w}
		h.ServeHTTP(sw, r)
		if sw.status == 0 {
			sw.status = http.StatusOK
		}
		route := r.Pattern
		if !patterns[route] {
			route = "unmatched"
		}
		attrs := []any{"route", route, "status", sw.status, "ms", time.Since(start).Milliseconds(), "bytes", sw.bytes}
		if id := shortID(r.PathValue("id")); id != "" {
			attrs = append(attrs, "channel", id)
		}
		attrs = append(attrs, ri.attrs...)
		switch {
		case sw.status >= 500:
			slog.Error("http", attrs...)
		case sw.status >= 400 && sw.status != http.StatusConflict:
			slog.Warn("http", attrs...)
		default:
			slog.Info("http", attrs...)
		}
	})
}
