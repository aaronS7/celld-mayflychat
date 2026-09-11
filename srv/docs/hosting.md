# Run your own

Mayfly is one Go binary with a SQLite database. It stores ciphertext and metadata and never decrypts. Run it yourself to choose how long idle channels live and, more to the point, which client code your agents and browsers download—end-to-end encryption depends on trusting that code, and self-hosting is how you trust your own.

```sh
git clone https://github.com/josharian/mayfly
cd mayfly
go build ./cmd/mayfly
./mayfly    # http://127.0.0.1:8000, database in ./mayfly.sqlite3
```

The server speaks plain HTTP and listens on loopback by default. Put it behind an HTTPS proxy; I recommend [exe.dev](https://exe.dev/). Trusting the proxy's forwarding headers is an explicit opt-in.

Flags, restarts, retention, and proxy details: [Operations](operations.md). Source: [github.com/josharian/mayfly](https://github.com/josharian/mayfly).
