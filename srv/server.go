package srv

import (
	"context"
	"errors"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// Server is one Mayfly Chat server. New returns a usable Server; the exported fields may
// be adjusted before Handler or Serve is called.
type Server struct {
	Store *Store

	// Now supplies the current time for activity stamps and reaping.
	Now func() time.Time

	// Retention is how long an idle channel lives. Zero disables reaping.
	Retention time.Duration

	// TrustProxy enables X-Forwarded-For, X-Forwarded-Proto, and X-Forwarded-Host.
	// The source IP is the last IP in the last X-Forwarded-For field; missing or invalid values use the direct peer.
	// Forwarded scheme and host values override the request's TLS scheme and Host when nonempty.
	// The proxy must overwrite origin headers and append or replace the source IP.
	// Enable only when nothing but that trusted proxy can reach the backend.
	TrustProxy bool

	quota    *creationQuota
	tmpl     *template.Template
	stopping chan struct{}
}

// DefaultRetention is the default idle lifetime of a channel.
const DefaultRetention = 24 * time.Hour

// New opens or initializes the SQLite database at dbPath and returns a
// Server with the given idle retention.
func New(dbPath string, retention time.Duration) (*Server, error) {
	if retention < 0 {
		return nil, errors.New("retention must not be negative")
	}
	sqldb, err := openDB(dbPath)
	if err != nil {
		return nil, err
	}
	if err := initDB(sqldb); err != nil {
		sqldb.Close()
		return nil, err
	}
	tmpl, err := template.New("").Funcs(template.FuncMap{"browser": browserScript}).ParseFS(templateFS, "templates/*.html")
	if err != nil {
		sqldb.Close()
		return nil, err
	}
	return &Server{
		Store: NewStore(sqldb), quota: newCreationQuota(),
		Now: time.Now, tmpl: tmpl, Retention: retention, stopping: make(chan struct{}),
	}, nil
}

// Close releases the database. It does not stop a running Serve.
func (s *Server) Close() error {
	return s.Store.Close()
}

// Handler returns the server's routes wrapped in request logging, security
// headers, and the restart guard.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	// patterns records every registered route so request logs can name it
	// without ever echoing a request-derived path.
	patterns := map[string]bool{}
	handle := func(pattern string, h http.HandlerFunc) {
		patterns[pattern] = true
		mux.Handle(pattern, h)
	}
	handle("GET /{$}", s.handleIndex)
	handle("POST /new", new(http.CrossOriginProtection).Handler(http.HandlerFunc(s.handleNew)).ServeHTTP)
	handle("GET /c/{id}", s.handleChannel)
	handle("DELETE /c/{id}", s.handleDelete)
	handle("GET /c/{id}/events", s.handleGetEvents)
	handle("POST /c/{id}/events", s.handlePostEvent)
	for name, source := range staticSources {
		handle("GET /static/"+name, servePlainText(source, ""))
	}
	handle("GET /emoji.txt", servePlainText(emojiList, "public, max-age=86400"))
	handle("GET /llms.txt", func(w http.ResponseWriter, r *http.Request) {
		s.serveDoc(w, r, "llms.txt")
	})
	handle("GET /docs/{page}", func(w http.ResponseWriter, r *http.Request) {
		s.serveDoc(w, r, r.PathValue("page"))
	})
	handle("/c/{id}/{rest...}", func(w http.ResponseWriter, r *http.Request) {
		// Wrong path or method under a channel: say what exists.
		if _, err := s.channel(r); err != nil {
			s.storeErr(w, err)
			return
		}
		note(r, "bad_route", true)
		jsonErr(w, http.StatusNotFound, "no such endpoint; use GET|POST /c/<id>/events, DELETE /c/<id>; instructions at GET /c/<id>")
	})
	return logRequests(patterns, headers(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.isStopping() {
			writeRestarting(w, r.Method == http.MethodPost)
		} else {
			mux.ServeHTTP(w, r)
		}
		if s.isStopping() {
			// Best effort before request logging; a flush is not a delivery acknowledgment.
			http.NewResponseController(w).Flush()
		}
	})))
}

func (s *Server) isStopping() bool {
	select {
	case <-s.stopping:
		return true
	default:
		return false
	}
}

func writeRestarting(w http.ResponseWriter, rejectedPost bool) {
	reply := map[string]any{"error": "restarting", "hint": "Server restarting; try again shortly."}
	if rejectedPost {
		reply["posted"] = false
	}
	writeJSON(w, http.StatusServiceUnavailable, reply)
}

const contentSecurityPolicy = "default-src 'none'; connect-src 'self'; img-src http: https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

func headers(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		h.ServeHTTP(w, r)
	})
}

const shutdownTimeout = 250 * time.Millisecond

// Serve runs the HTTP server and the reaper until ctx is done.
// Shutdown ends long waits immediately and bounds draining for slow or disconnected peers.
func (s *Server) Serve(ctx context.Context, addr string) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go s.reaper(ctx)
	hs := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	shutdownDone := make(chan struct{})
	go func() {
		<-ctx.Done()
		close(s.stopping)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := hs.Shutdown(shutdownCtx); err != nil {
			hs.Close()
		}
		close(shutdownDone)
	}()
	slog.Info("listening", "addr", addr)
	err = hs.Serve(listener)
	cancel()
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) reaper(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for ctx.Err() == nil {
		n, err := s.Store.Reap(s.Now(), s.Retention)
		if err != nil {
			slog.Error("reap failed") // error text withheld, as for request failures
		} else if n > 0 {
			slog.Info("reaped channels", "n", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
