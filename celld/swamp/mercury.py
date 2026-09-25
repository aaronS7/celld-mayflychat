"""Validate the single vault entry used to configure Mercury Worker bindings."""
import json
import re
from urllib.parse import urlsplit

VAULT = "mayfly-mercury"
SECRET = "MERCURY_CONFIG"
DEFAULT_MODEL = "mercury-2.5"


def settings(base_url, api_key, model=DEFAULT_MODEL):
    if not all(isinstance(value, str) for value in [base_url, api_key, model]):
        raise ValueError("Mercury settings must be strings.")
    base_url, api_key, model = base_url.strip(), api_key.strip(), model.strip()
    try:
        url = urlsplit(base_url)
        valid = (url.scheme == "https" and url.hostname and url.username is None
                 and url.password is None and not url.query and not url.fragment
                 and not any(ord(c) <= 32 or ord(c) == 127 for c in base_url)
                 and (url.port is None or 0 < url.port < 65536))
    except ValueError:
        valid = False
    if not valid or "?" in base_url or "#" in base_url or "\\" in base_url:
        raise ValueError("Use an HTTPS base URL without credentials, a query or a fragment.")
    if url.path.rstrip("/").endswith("/chat/completions"):
        raise ValueError("Use the base URL, including /v1 where needed, without /chat/completions.")
    if not api_key or len(api_key) > 8192 or any(ord(c) < 33 or ord(c) > 126 for c in api_key):
        raise ValueError("The API key must be a nonblank token without spaces or control characters.")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}", model):
        raise ValueError("Use a model identifier of at most 160 characters, without spaces.")
    return {"MERCURY_BASE_URL": base_url.rstrip("/"), "MERCURY_API_KEY": api_key, "MERCURY_MODEL": model}


def decode(raw):
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise ValueError("The Mercury vault entry is missing or invalid. Run configure.py first.") from None
    if not isinstance(value, dict) or set(value) != {"MERCURY_BASE_URL", "MERCURY_API_KEY", "MERCURY_MODEL"}:
        raise ValueError("The Mercury vault entry has unexpected fields. Run configure.py again.")
    return settings(value["MERCURY_BASE_URL"], value["MERCURY_API_KEY"], value["MERCURY_MODEL"])
