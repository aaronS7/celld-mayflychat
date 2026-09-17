//go:build ignore

// Mayfly celld client: negotiates encryption, UTF-8 JSON replies, no state or retries.
//
//	go run client.go URL read|post --last N [--wait S] [--from NAME]   (Go 1.24+, standard library only)
//
// Use a full /c/ID#key URL. Start --last at -1; read all pages before posting.
// Exits 0 on success, 1 on conflict or error (JSON on stdout for 409, stderr
// otherwise), and 2 on usage error. The go run driver adds "exit status N" to
// stderr on nonzero exits and itself exits 1.
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const conflictHint = "Read all returned/remaining pages; reconsider, then post with final last. No retry."
const unknownHint = "Post may have succeeded. Read from old --last before resubmitting; no retry."
const usage = "go run client.go URL read|post --last N [--wait S] [--from NAME]"

type options struct {
	url, command, name string
	last, wait         *big.Int
}

func arguments(args []string) (options, error) {
	var o options
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h") {
		fmt.Fprintln(os.Stdout, usage)
		return o, flag.ErrHelp
	}
	if len(args) < 2 {
		return o, errors.New(usage)
	}
	o.url, o.command = args[0], args[1]
	if o.command != "read" && o.command != "post" {
		return o, errors.New("command must be read or post")
	}
	flags := flag.NewFlagSet("client.go", flag.ContinueOnError)
	flags.Usage = func() { fmt.Fprintln(flags.Output(), usage) }
	last := flags.String("last", "", "required: last event read (-1 to start)")
	wait := flags.String("wait", "0", "wait seconds")
	flags.StringVar(&o.name, "from", "", "sender name for post")
	if err := flags.Parse(args[2:]); err != nil {
		return o, err
	}
	if flags.NArg() != 0 {
		return o, errors.New("unexpected arguments; " + usage)
	}
	if *last == "" {
		return o, errors.New("--last is required")
	}
	// Exact decimal; the server, not the client, decides the range.
	o.last, _ = new(big.Int).SetString(*last, 10)
	o.wait, _ = new(big.Int).SetString(*wait, 10)
	if o.last == nil || o.wait == nil {
		return o, errors.New("--last and --wait require decimal integers")
	}
	if o.command == "post" && !validFrom(o.name) {
		return o, errors.New("post requires --from: nonempty, trimmed, no control characters")
	}
	return o, nil
}

func validFrom(name string) bool {
	return name != "" && utf8.ValidString(name) && name == strings.TrimSpace(name) &&
		strings.IndexFunc(name, unicode.IsControl) < 0
}

func unb64(s string) ([]byte, error) {
	if strings.ContainsAny(s, "\r\n") {
		return nil, errors.New("invalid base64")
	}
	s = strings.NewReplacer("-", "+", "_", "/").Replace(s)
	return base64.StdEncoding.DecodeString(s + strings.Repeat("=", (4-len(s)%4)%4))
}

func keys(rawURL string) (*url.URL, string, string, cipher.AEAD, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, "", "", nil, errors.New("invalid channel URL")
	}
	key, err := unb64(u.EscapedFragment())
	if err != nil || len(key) != 32 {
		return nil, "", "", nil, errors.New("URL requires a 32-byte key fragment")
	}
	idKey, err := hkdf.Key(sha256.New, key, nil, "mayfly id", 16)
	if err != nil {
		return nil, "", "", nil, err
	}
	authKey, err := hkdf.Key(sha256.New, key, nil, "mayfly auth", 32)
	if err != nil {
		return nil, "", "", nil, err
	}
	enc, err := hkdf.Key(sha256.New, key, nil, "mayfly enc", 32)
	if err != nil {
		return nil, "", "", nil, err
	}
	id := base64.RawURLEncoding.EncodeToString(idKey)
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" ||
		u.EscapedPath() != "/c/"+id {
		return nil, "", "", nil, errors.New("expected HTTP(S) /c/ID#key with matching ID")
	}
	if port := u.Port(); port != "" {
		if _, err := strconv.ParseUint(port, 10, 16); err != nil {
			return nil, "", "", nil, errors.New("invalid URL port")
		}
	}
	block, err := aes.NewCipher(enc)
	if err != nil {
		return nil, "", "", nil, err
	}
	gcm, err := cipher.NewGCM(block)
	return u, id, base64.RawURLEncoding.EncodeToString(authKey), gcm, err
}

// jsonBytes encodes the JSON-compatible values constructed by this client.
func jsonBytes(value any) json.RawMessage {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	// Values are client-built scalars/containers or validated raw server JSON.
	_ = encoder.Encode(value)
	return bytes.TrimSpace(out.Bytes())
}

func seal(gcm cipher.AEAD, id, seq, name, text string) []byte {
	if gcm == nil {
		nonce := make([]byte, 12)
		rand.Read(nonce)
		return jsonBytes(map[string]string{"nonce": base64.RawURLEncoding.EncodeToString(nonce), "from": name, "text": text})
	}
	plain := jsonBytes(map[string]string{"from": name, "text": text})
	plain = append(plain, bytes.Repeat([]byte(" "), (256-len(plain)%256)%256)...)
	nonce := make([]byte, 12)
	rand.Read(nonce)
	ct := gcm.Seal(nil, nonce, plain, []byte(id+":"+seq))
	return jsonBytes(map[string]string{
		"nonce": base64.RawURLEncoding.EncodeToString(nonce),
		"ct":    base64.RawURLEncoding.EncodeToString(ct),
	})
}

// textField decodes a JSON string. json.Unmarshal silently replaces a lone
// surrogate escape with U+FFFD; Python and Node reject such text, so this
// scans the escapes and rejects it too.
func textField(raw json.RawMessage) (string, bool) {
	var text string
	if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &text) != nil {
		return "", false
	}
	// JSON syntax was checked above. Inspect only this string's escapes;
	// unrelated inner fields may contain escapes we do not interpret.
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		n, _ := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		i += 4
		switch {
		case n >= 0xdc00 && n <= 0xdfff:
			return "", false
		case n >= 0xd800 && n <= 0xdbff:
			if i+6 >= len(raw) || string(raw[i+1:i+3]) != `\u` {
				return "", false
			}
			low, _ := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if low < 0xdc00 || low > 0xdfff {
				return "", false
			}
			i += 6
		}
	}
	return text, true
}

func render(gcm cipher.AEAD, id string, event map[string]json.RawMessage) (map[string]any, error) {
	for _, field := range []string{"seq", "ts", "src"} {
		if _, ok := event[field]; !ok {
			return nil, fmt.Errorf("event missing %s", field)
		}
	}
	row := map[string]any{"id": event["seq"], "ts": event["ts"], "src": event["src"],
		"from": "", "text": "(undecryptable message)"}
	if gcm == nil {
		row["text"] = "(invalid message)"
		name, nameOK := textField(event["from"])
		text, textOK := textField(event["text"])
		if _, encrypted := event["ct"]; !encrypted && nameOK && textOK && validFrom(name) {
			row["from"], row["text"] = name, text
		}
		return row, nil
	}
	nonceString, nonceOK := textField(event["nonce"])
	ctString, ctOK := textField(event["ct"])
	nonce, nonceErr := unb64(nonceString)
	ct, ctErr := unb64(ctString)
	if !nonceOK || !ctOK || nonceErr != nil || ctErr != nil || len(nonce) != 12 {
		return row, nil
	}
	plain, err := gcm.Open(nil, nonce, ct, []byte(id+":"+string(event["seq"])))
	if err != nil {
		return row, nil
	}
	row["text"] = "(invalid message)"
	var inner map[string]json.RawMessage
	if !utf8.Valid(plain) || json.Unmarshal(plain, &inner) != nil {
		return row, nil
	}
	name, nameOK := textField(inner["from"])
	text, textOK := textField(inner["text"])
	if nameOK && textOK && validFrom(name) {
		row["from"], row["text"] = name, text
	}
	return row, nil
}

type response struct {
	reply     map[string]json.RawMessage
	attempted bool
	status    int
}

func exchange(o options) (response, error) {
	r := response{reply: make(map[string]json.RawMessage)}
	u, id, auth, gcm, err := keys(o.url)
	if err != nil {
		return r, err
	}
	encrypted, allowed, err := channelSettings(u, id, auth)
	if err != nil {
		return r, err
	}
	if o.command == "post" && !allowed {
		return r, errors.New("Server encryption setting changed. Create a new channel to send messages.")
	}
	if !encrypted {
		gcm = nil
	}
	method, cursor := "GET", "since"
	var body io.Reader
	if o.command == "post" {
		text, err := io.ReadAll(os.Stdin)
		if err != nil {
			return r, err
		}
		if !utf8.Valid(text) {
			return r, errors.New("stdin must be valid UTF-8")
		}
		// Python's whitespace definition also includes these four C0 separators.
		nonspace := strings.IndexFunc(string(text), func(c rune) bool {
			return !unicode.IsSpace(c) && (c < 0x1c || c > 0x1f)
		})
		if nonspace < 0 {
			return r, errors.New("message must be nonblank")
		}
		seq := new(big.Int).Add(o.last, big.NewInt(1))
		body = bytes.NewReader(seal(gcm, id, seq.String(), o.name, string(text)))
		method, cursor = "POST", "last"
	}
	endpoint := url.URL{Scheme: u.Scheme, Host: u.Host, Path: "/c/" + id + "/events",
		RawQuery: cursor + "=" + o.last.String() + "&wait=" + o.wait.String()}
	req, err := http.NewRequest(method, endpoint.String(), body)
	if err != nil {
		return r, err
	}
	req.Header.Set("Authorization", "Bearer "+auth)
	req.Header.Set("Content-Type", "application/json")
	seconds := int64(86460)
	if o.wait.Cmp(big.NewInt(86400)) < 0 {
		seconds = 60
		if o.wait.Sign() > 0 {
			seconds += o.wait.Int64()
		}
	}
	// A private HTTP/1 transport has no reused connection to retry, no proxy,
	// no compression negotiation and no HTTP/2 retry path.
	transport := &http.Transport{DisableKeepAlives: true, DisableCompression: true,
		TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{}}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: time.Duration(seconds) * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r.attempted = o.command == "post"
	res, err := client.Do(req)
	if err != nil {
		return r, err
	}
	defer res.Body.Close()
	r.status = res.StatusCode
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return r, err
	}
	// Raw fields preserve server integer precision and unencodable diagnostics.
	var reply map[string]json.RawMessage
	if !utf8.Valid(raw) || json.Unmarshal(raw, &reply) != nil || reply == nil {
		r.reply["error"] = jsonBytes(string(raw))
		r.reply["http_status"] = jsonBytes(r.status)
		return r, errors.New("expected a JSON object")
	}
	r.reply = reply
	if text, ok := textField(reply["error"]); ok {
		reply["error"] = jsonBytes(text)
	}
	if r.status != 200 && r.status != 409 {
		reply["http_status"] = jsonBytes(r.status)
		if string(reply["posted"]) == "false" && ((r.status == 503 && string(reply["error"]) == `"restarting"`) || knownRejection(reply["code"])) {
			r.attempted = false
		}
		return r, fmt.Errorf("HTTP %d", r.status)
	}
	eventsRaw, ok := reply["events"]
	if !ok {
		return r, errors.New("reply missing events")
	}
	delete(reply, "events")
	var events []map[string]json.RawMessage
	if json.Unmarshal(eventsRaw, &events) != nil || events == nil {
		return r, errors.New("events must be an array of objects")
	}
	messages := make([]map[string]any, 0, len(events))
	for _, event := range events {
		row, err := render(gcm, id, event)
		if err != nil {
			return r, err
		}
		messages = append(messages, row)
	}
	reply["messages"] = jsonBytes(messages)
	if r.status == 409 {
		reply["posted"], reply["hint"] = jsonBytes(false), jsonBytes(conflictHint)
	}
	return r, nil
}

func knownRejection(raw json.RawMessage) bool {
	switch string(raw) {
	case `"mode_changed"`, `"channel_changed"`, `"invalid_message"`, `"configuration_error"`, `"moderation_rejected"`, `"moderation_unavailable"`:
		return true
	}
	return false
}

func channelSettings(u *url.URL, id, auth string) (bool, bool, error) {
	endpoint := url.URL{Scheme: u.Scheme, Host: u.Host, Path: "/c/" + id + "/config"}
	req, err := http.NewRequest("GET", endpoint.String(), nil)
	if err != nil {
		return true, false, err
	}
	req.Header.Set("Authorization", "Bearer "+auth)
	transport := &http.Transport{DisableKeepAlives: true, DisableCompression: true,
		TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{}}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return true, false, err
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return true, true, nil
	}
	if res.StatusCode != 200 {
		return true, false, fmt.Errorf("Could not read channel settings (HTTP %d)", res.StatusCode)
	}
	var config struct {
		Protocol       int   `json:"protocol"`
		Encryption     *bool `json:"encryption"`
		PostingAllowed *bool `json:"postingAllowed"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 16384)).Decode(&config) != nil || config.Protocol != 2 || config.Encryption == nil || config.PostingAllowed == nil {
		return true, false, errors.New("Invalid channel settings")
	}
	return *config.Encryption, *config.PostingAllowed, nil
}

func run() int {
	o, err := arguments(os.Args[1:])
	switch {
	case errors.Is(err, flag.ErrHelp):
		return 0
	case err != nil:
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	r, err := exchange(o)
	out, code := os.Stdout, 0
	switch {
	case err != nil:
		if _, ok := r.reply["error"]; !ok {
			r.reply["error"] = jsonBytes(err.Error())
		}
		if r.attempted {
			r.reply["posted"], r.reply["hint"] = jsonBytes(nil), jsonBytes(unknownHint)
		}
		out, code = os.Stderr, 1
	case r.status == 409:
		code = 1
	}
	if _, err := fmt.Fprintln(out, string(jsonBytes(r.reply))); err != nil {
		return 1
	}
	return code
}

func main() { os.Exit(run()) }
