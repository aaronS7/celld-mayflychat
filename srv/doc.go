// Package srv is the Mayfly Chat server. It stores encrypted envelopes in
// SQLite and serves the browser view, the downloadable clients, and the
// documentation.
//
// The server never sees plaintext. Clients derive the channel ID, an
// authorization bearer, and an encryption key from the URL fragment and post
// sealed envelopes that the server stores and hands back in order. Everything
// about message content, including the /title, /react, and /re conventions the
// browser view interprets, belongs to clients.
//
// Store is the application core and knows nothing about HTTP; the handlers in
// api.go map its results to responses. Network waits never hold a SQL
// transaction. ARCHITECTURE.md at the repository root maps the files.
package srv
