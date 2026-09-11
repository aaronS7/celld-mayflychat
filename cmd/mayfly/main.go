package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/josharian/mayfly/srv"
)

var (
	flagListen     = flag.String("listen", "127.0.0.1:8000", "address to listen on (plain HTTP; terminate TLS externally)")
	flagTrustProxy = flag.Bool("trust-proxy", false, "trust X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host; requires an isolated backend behind a trusted proxy")
	flagDB         = flag.String("db", "mayfly.sqlite3", "SQLite database path; incompatible databases require a fresh path")
	flagRetention  = flag.Duration("retention", srv.DefaultRetention, "idle channel retention; 0 disables automatic expiry; negative durations are invalid")
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	flag.Parse()
	s, err := srv.New(*flagDB, *flagRetention)
	if err != nil {
		return err
	}
	defer s.Close()
	s.TrustProxy = *flagTrustProxy
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return s.Serve(ctx, *flagListen)
}
