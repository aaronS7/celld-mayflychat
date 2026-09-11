#!/usr/bin/env python3
"""Create a Mayfly Chat channel locally. Requires cryptography.
Usage: python3 create.py HTTP(S)-ORIGIN
Prints one full channel URL on success; no state or retries.
"""
import argparse
import base64
import hashlib
import http.client
import json
import secrets
import sys
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def origin(raw):
    if (not raw or "\\" in raw or any(ord(c) < 32 or ord(c) == 127 for c in raw)
            or "?" in raw or "#" in raw):
        raise ValueError("expected an HTTP(S) origin with no path, query, or fragment")
    p = urlsplit(raw)
    if (p.scheme.lower() not in ("http", "https") or not p.hostname or p.username is not None
            or p.password is not None or p.path not in ("", "/") or p.netloc.endswith(":")):
        raise ValueError("expected an HTTP(S) origin with no path, query, or fragment")
    port = p.port  # raises ValueError for an invalid port, before any connection
    host = p.hostname.lower()
    if ":" in host:
        host = "[" + host + "]"
    scheme = p.scheme.lower()
    if port is not None and port != (80 if scheme == "http" else 443):
        host += ":" + str(port)
    return scheme, p.hostname, port, scheme + "://" + host


def derive(key, label, length):
    return HKDF(SHA256(), length, b"", label).derive(key)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    args = parser.parse_args()
    conn = None
    try:
        scheme, host, port, base = origin(args.origin)
        key = secrets.token_bytes(32)
        ident = b64(derive(key, b"mayfly id", 16))
        auth = b64(derive(key, b"mayfly auth", 32))
        body = json.dumps({"id": ident, "auth_hash": b64(hashlib.sha256(auth.encode()).digest())},
                          separators=(",", ":"))
        transport = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        conn = transport(host, port, timeout=60)
        conn.request("POST", "/new", body, {"Content-Type": "application/json"})
        response = conn.getresponse()  # http.client does not follow redirects.
        response.read()
        if response.status == 503:
            raise ValueError("HTTP 503: Server temporarily unavailable; try again shortly.")
        if response.status != 303:
            raise ValueError(f"HTTP {response.status}")
        print(f"{base}/c/{ident}#{b64(key)}")
        return 0
    except Exception as error:
        print(f"create: {error}", file=sys.stderr)
        return 1
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
