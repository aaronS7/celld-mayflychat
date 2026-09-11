package srv

import (
	"encoding/base64"
	"strings"
)

// Wire sizes of the client-derived values the server validates.
const (
	idLen    = 16 // channel ID bytes; 22 base64url characters
	nonceLen = 12 // AES-GCM nonce bytes
)

// b64u encodes unpadded base64url, the encoding used everywhere on the wire.
func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// unb64u decodes base64url, tolerating padding.
func unb64u(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}
