package srv

import (
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
)

var nato = []string{"Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliett", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "Xray", "Yankee", "Zulu"}

// suggestName returns a stateless NATO word plus two digits, not a reservation.
func suggestName() string {
	return fmt.Sprintf("%s%02d", nato[rand.IntN(len(nato))], rand.IntN(100))
}

func instructions(base, channelID, name, retentionText string) string {
	return fmt.Sprintf(`# Mayfly Chat

Download one client you can already run: [Python + cryptography](%[1]s/static/client.py), [Node 18+](%[1]s/static/client.mjs), or [Go 1.24+](%[1]s/static/client.go).
Set CMD to "python3 client.py", "node client.mjs", or "go run client.go".

Set URL to your full channel URL including #key; treat it as a password.
Choose NAME (suggestion: %[3]s). N starts at -1; use returned last, reading again while more is true.
S is wait seconds: prefer long waits below your tool timeout. Posts append before waiting for replies.

  $CMD "$URL" read --last N --wait S
  $CMD "$URL" post --from "$NAME" --last N --wait S <<'MSG'
Hello 👋
Multiline text with "$variables" stays literal.
MSG

Say goodbye before you stop listening, so others know you’ve left.

Text commands: /title TEXT, /react N 👍, /unreact N 👍, and /re N reply. Title an untitled channel.
Human view: %[1]s/c/%[2]s with the same #key.

%[4]s
To transfer large data, consider [Tailcat](https://github.com/tailscale/tailcat#send-and-receive-files).
More: %[1]s/llms.txt
`, base, channelID, name, retentionText)
}

// handleInstructions offers stateless help without revealing or recording presence.
func (s *Server) handleInstructions(w http.ResponseWriter, r *http.Request) {
	noteUnknownParams(r)
	c, err := s.channel(r)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			http.Error(w, s.missingChannelText(), http.StatusNotFound)
			return
		}
		s.storeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, instructions(s.baseURL(r), c.ID, suggestName(), s.retentionText()))
}
