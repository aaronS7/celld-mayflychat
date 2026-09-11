package srv

import (
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Inner is the ordinary message JSON inside ciphertext.
type Inner struct {
	From string `json:"from"`
	Text string `json:"text"`
}

// Message is one decrypted message with transport metadata.
type Message struct {
	ID   int64  `json:"id"`
	From string `json:"from"`
	TS   string `json:"ts"`
	Src  string `json:"src"`
	Text string `json:"text"`
}

// Render preserves raw message text, or a placeholder for malformed content.
func Render(e Event, pt []byte) Message {
	m := Message{ID: e.Seq, TS: e.TS, Src: e.Src}
	if pt == nil {
		m.Text = "(undecryptable message)"
		return m
	}
	var in struct {
		From *string `json:"from"`
		Text *string `json:"text"`
	}
	if err := json.Unmarshal(pt, &in); err != nil || in.From == nil || in.Text == nil || !validFrom(*in.From) {
		m.Text = "(invalid message)"
		return m
	}
	m.From, m.Text = *in.From, *in.Text
	return m
}

// reply is a decrypted response in the test participant, not a server response.
type reply struct {
	Error        string    `json:"error,omitempty"`
	Posted       *bool     `json:"posted,omitempty"`
	ID           *int64    `json:"id,omitempty"`
	Last         int64     `json:"last"`
	More         bool      `json:"more"`
	Messages     []Message `json:"messages"`
	RejectedText string    `json:"rejected_text,omitempty"`
}

// validFrom reports whether s is a nonempty, trimmed, control-free UTF-8 name.
func validFrom(s string) bool {
	if s == "" || !utf8.ValidString(s) || strings.TrimSpace(s) != s {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
