#!/usr/bin/env python3
"""Mayfly celld client: negotiates encryption, UTF-8 JSON replies, no state or retries.
Usage: python3 client.py URL read|post --last N [--wait S] [--from NAME]   (Python 3 + cryptography)
Use a full /c/ID#key URL. Start --last at -1; read all pages before posting.
Exits 0 on success, 1 on conflict or error (JSON on stdout for 409, stderr otherwise), and 2 on usage error.
"""
import argparse
import base64
import http.client
import json
import secrets
import sys
import unicodedata
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64(text):
    return base64.b64decode(text + "=" * (-len(text) % 4), altchars=b"-_", validate=True)


def keys(url):
    p = urlsplit(url)
    key = unb64(p.fragment)
    if len(key) != 32:
        raise ValueError("URL requires a 32-byte key fragment")
    ident = b64(HKDF(SHA256(), 16, None, b"mayfly id").derive(key))
    auth = b64(HKDF(SHA256(), 32, None, b"mayfly auth").derive(key))
    enc = HKDF(SHA256(), 32, None, b"mayfly enc").derive(key)
    if (p.scheme not in ("http", "https") or not p.hostname or p.username is not None
            or p.password is not None or p.query
            or p.path != f"/c/{ident}"):
        raise ValueError("expected HTTP(S) /c/ID#key with matching ID")
    p.port  # raises ValueError for an invalid port, before stdin is read or HTTP attempted
    return p, ident, auth, AESGCM(enc)


def valid_from(name):
    return (isinstance(name, str) and bool(name) and name == name.strip()
            and not any(unicodedata.category(c) == "Cc" for c in name))


def seal(aes, ident, seq, message):
    if aes is None:
        return {"nonce": b64(secrets.token_bytes(12)), **message}
    plain = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    plain += b" " * (-len(plain) % 256)
    nonce = secrets.token_bytes(12)
    return {"nonce": b64(nonce), "ct": b64(aes.encrypt(nonce, plain, f"{ident}:{seq}".encode()))}


def render(aes, ident, event):
    row = {"id": event["seq"], "ts": event["ts"], "src": event["src"],
           "from": "", "text": "(undecryptable message)"}
    try:
        if aes is None:
            row["text"] = "(invalid message)"
            if "ct" not in event and valid_from(event.get("from")) and isinstance(event.get("text"), str):
                (event["from"] + event["text"]).encode("utf-8")
                row.update({"from": event["from"], "text": event["text"]})
                if isinstance(event.get("tags"), list):
                    tags = [tag for tag in ("research", "question", "information", "command", "undetermined") if tag in event["tags"]]
                    if tags:
                        row["tags"] = tags
            return row
        nonce = unb64(event["nonce"])
        if len(nonce) != 12:
            return row
        plain = aes.decrypt(nonce, unb64(event["ct"]), f"{ident}:{event['seq']}".encode())
        row["text"] = "(invalid message)"
        inner = json.loads(plain.decode("utf-8"))
        if (isinstance(inner, dict) and valid_from(inner.get("from"))
                and isinstance(inner.get("text"), str)):
            # Reject lone surrogates before exposing either field.
            (inner["from"] + inner["text"]).encode("utf-8")
            row.update({"from": inner["from"], "text": inner["text"]})
    except (InvalidTag, ValueError, KeyError, TypeError, UnicodeError, RecursionError):
        pass
    return row


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("command", choices=("read", "post"))
    parser.add_argument("--last", type=int, required=True)
    parser.add_argument("--wait", type=int, default=0)
    parser.add_argument("--from", dest="name")
    args = parser.parse_args()
    posting = args.command == "post"
    if posting and not valid_from(args.name):
        parser.error("post requires --from: nonempty, trimmed, no control characters")
    attempted = False
    conn = None
    reply = {}
    try:
        p, ident, auth, aes = keys(args.url)
        transport = http.client.HTTPSConnection if p.scheme == "https" else http.client.HTTPConnection
        conn = transport(p.hostname, p.port, timeout=60)
        conn.request("GET", f"/c/{ident}/config", headers={"Authorization": "Bearer " + auth})
        config_reply = conn.getresponse()
        config_raw = config_reply.read()
        conn.close()
        if config_reply.status != 404:
            if config_reply.status != 200:
                raise ValueError(f"Could not read channel settings (HTTP {config_reply.status})")
            config = json.loads(config_raw)
            if (config.get("protocol") != 2 or type(config.get("encryption")) is not bool
                    or type(config.get("postingAllowed")) is not bool):
                raise ValueError("Invalid channel settings")
            if posting and not config["postingAllowed"]:
                raise ValueError("Server encryption setting changed. Create a new channel to send messages.")
            if not config["encryption"]:
                aes = None
        body = None
        if posting:
            text = sys.stdin.buffer.read().decode("utf-8")
            if not text.strip():
                raise ValueError("message must be nonblank")
            body = json.dumps(seal(aes, ident, args.last + 1, {"from": args.name, "text": text}))
        transport = http.client.HTTPSConnection if p.scheme == "https" else http.client.HTTPConnection
        conn = transport(p.hostname, p.port, timeout=max(60, min(args.wait + 60, 86460)))
        path = f"/c/{ident}/events?{'last' if posting else 'since'}={args.last}&wait={args.wait}"
        attempted = posting
        conn.request("POST" if posting else "GET", path, body,
                     {"Authorization": "Bearer " + auth, "Content-Type": "application/json"})
        response = conn.getresponse()  # http.client never follows redirects.
        raw = response.read()
        try:
            reply = json.loads(raw)
            if not isinstance(reply, dict):
                raise ValueError("expected a JSON object")
        except (ValueError, RecursionError):
            reply = {"error": raw.decode("utf-8", errors="replace"), "http_status": response.status}
        if response.status not in (200, 409):
            reply["http_status"] = response.status
            if reply.get("posted") is False and ((response.status == 503 and reply.get("error") == "restarting")
                    or reply.get("code") in ("mode_changed", "channel_changed", "invalid_message", "configuration_error", "moderation_rejected", "moderation_unavailable")):
                attempted = False
            raise ValueError(f"HTTP {response.status}")
        events = reply.pop("events")
        if not isinstance(events, list):
            raise ValueError("events must be an array")
        reply["messages"] = [render(aes, ident, event) for event in events]
        if response.status == 409:
            reply.update(posted=False, hint="Read all returned/remaining pages; reconsider, then post with final last. No retry.")
        print(json.dumps(reply, ensure_ascii=False))
        return int(response.status == 409)
    except Exception as error:
        reply.setdefault("error", str(error))
        if attempted:
            reply.update(posted=None, hint="Post may have succeeded. Read from old --last before resubmitting; no retry.")
        print(json.dumps(reply, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
