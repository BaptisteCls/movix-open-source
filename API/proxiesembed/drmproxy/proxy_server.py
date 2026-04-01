"""
Proxy server that wraps widefrog services to extract and play
m3u8/mpd manifests directly in the browser.

Usage:
    python proxy_server.py [--port PORT] [--host HOST]

Then open http://localhost:5000 in your browser.
"""

import base64
import builtins
import json
import os
import re
import sys
import traceback
from urllib.parse import urlencode, urlparse, urljoin, quote, unquote, parse_qs, urlunparse

from flask import Flask, request, Response, render_template_string, jsonify, redirect
import requests as http_requests

from utils.constants.macros import CONFIG_FILE, DEFAULT_DEBUG_MODE
from utils.structs import BaseElement
from utils.tools.args import get_config
from utils.tools.cdm import init_cdm, close_cdm
from utils.tools.common import get_base_url
from utils.tools.service import get_service, get_all_services

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)

# Cache extracted data so we don't re-extract on every segment request
_manifest_cache: dict = {}  # url -> {manifest_url, manifest_type, keys, headers, additional}

# Default headers used when proxying requests
_PROXY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": None,
    "Referer": None,
}


# ---------------------------------------------------------------------------
#  Initialise widefrog config (once)
# ---------------------------------------------------------------------------
def _init_widefrog():
    """Perform the same first-time setup as widefrog.py."""
    if hasattr(builtins, "CONFIG"):
        return
    args = []
    builtins.CONFIG = get_config(args)
    builtins.CONFIG["QUERY"] = {
        "MIN": {"COLLECTION": None, "ELEMENT": None},
        "MAX": {"COLLECTION": None, "ELEMENT": None},
    }
    builtins.CONFIG["DEBUG_MODE"] = DEFAULT_DEBUG_MODE
    builtins.SERVICES = get_all_services()
    # Override to skip downloads
    builtins.CONFIG["DOWNLOAD_COMMANDS"]["WAIT_BEFORE_DOWNLOADING"] = None


# ---------------------------------------------------------------------------
#  Extraction helpers
# ---------------------------------------------------------------------------
def _extract_manifest(content_url: str) -> dict:
    """Use the widefrog service layer to get manifest + keys for *content_url*."""
    if content_url in _manifest_cache:
        return _manifest_cache[content_url]

    _init_widefrog()

    service = get_service(content_url)
    if service is None:
        raise ValueError(f"No service found for URL: {content_url}")

    service_instance = service
    source_element = BaseElement(url=content_url)

    # --- get_video_data returns (manifest, pssh, additional) ---
    manifest, pssh, additional = service_instance.get_video_data(source_element)

    # Normalise manifest to list of (url, name)
    if not isinstance(manifest, list):
        manifest = [(manifest, None)]
    if len(manifest) == 0:
        manifest = [(None, None)]

    # Normalise pssh
    if not isinstance(pssh, list):
        pssh = [pssh]

    # Determine manifest type
    manifest_url = None
    for m_url, m_name in manifest:
        if m_url:
            manifest_url = m_url
            break

    if manifest_url is None:
        raise ValueError("No manifest URL could be extracted")

    manifest_type = "unknown"
    if ".m3u8" in manifest_url.split("?")[0].lower() or "m3u8" in manifest_url.lower():
        manifest_type = "hls"
    elif ".mpd" in manifest_url.split("?")[0].lower() or "mpd" in manifest_url.lower():
        manifest_type = "dash"
    elif ".ism" in manifest_url.split("?")[0].lower():
        manifest_type = "smooth"
    else:
        # Try to sniff from content
        try:
            resp = http_requests.get(manifest_url, timeout=10)
            ct = resp.headers.get("Content-Type", "").lower()
            body = resp.text[:500].lower()
            if "#extm3u" in body:
                manifest_type = "hls"
            elif "<mpd" in body or "dash" in body:
                manifest_type = "dash"
        except:
            pass

    # Get decryption keys (for informational purposes / ClearKey)
    is_hls_aes = additional.get("AES", None) is not None if isinstance(additional, dict) else False
    keys = []
    if not is_hls_aes:
        for p in pssh:
            if p is None:
                continue
            try:
                cdm, cdm_session_id, challenge = init_cdm(p)
                if cdm is None:
                    continue
                keys += close_cdm(
                    cdm, cdm_session_id,
                    service_instance.get_keys(challenge, additional.get(p, additional) if isinstance(additional, dict) else additional)
                )
            except Exception:
                pass
        keys = list(set(keys))

    result = {
        "manifest_url": manifest_url,
        "all_manifests": [(m, n) for m, n in manifest if m],
        "manifest_type": manifest_type,
        "keys": keys,
        "is_hls_aes": is_hls_aes,
        "aes_info": additional.get("AES", None) if isinstance(additional, dict) else None,
        "additional": additional if isinstance(additional, dict) else {},
        "title": source_element.element or "video",
    }
    _manifest_cache[content_url] = result
    return result


# ---------------------------------------------------------------------------
#  URL rewriting helpers
# ---------------------------------------------------------------------------
def _proxy_url(target_url: str, route: str = "/proxy/resource") -> str:
    """Build a proxy URL pointing to our server."""
    return f"{route}?url={quote(target_url, safe='')}"


def _resolve_url(base_url: str, relative: str) -> str:
    """Resolve a possibly-relative URL against a base."""
    if relative.startswith("http://") or relative.startswith("https://"):
        return relative
    return urljoin(base_url, relative)


def _rewrite_m3u8(content: str, base_url: str) -> str:
    """Rewrite all URLs in an HLS manifest so they go through our proxy."""
    lines = content.split("\n")
    result = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue

        # Rewrite URI="..." in tags like #EXT-X-KEY, #EXT-X-MAP, etc.
        if stripped.startswith("#"):
            def _rewrite_uri(m):
                uri = m.group(1)
                absolute = _resolve_url(base_url, uri)
                return f'URI="{_proxy_url(absolute)}"'
            rewritten = re.sub(r'URI="([^"]*)"', _rewrite_uri, stripped, flags=re.IGNORECASE)
            result.append(rewritten)
        else:
            # This is a URL line (segment or sub-playlist)
            absolute = _resolve_url(base_url, stripped)
            result.append(_proxy_url(absolute))
    return "\n".join(result)


def _make_base_proxy_url(original_base_url: str) -> str:
    """Encode a base URL into a path-based proxy prefix.
    
    Shaka-player resolves relative segment URLs against the manifest URL.
    By injecting a <BaseURL> that uses a path-based route like
    /proxy/b/<encoded_base>/, relative URLs naturally resolve to
    /proxy/b/<encoded_base>/segment.dash  which our handler proxies
    to  original_base + segment.dash.
    """
    b = base64.urlsafe_b64encode(original_base_url.encode()).decode().rstrip("=")
    return f"/proxy/b/{b}/"


def _rewrite_mpd(content: str, base_url: str) -> str:
    """Rewrite URLs in a DASH MPD manifest to go through our proxy.
    
    Strategy:
    - Replace / inject <BaseURL> so that *relative* segment URLs
      resolve through our path-based proxy (/proxy/b/<base64>/).
    - Rewrite any *absolute* URLs in media/initialization attributes
      of SegmentTemplate.
    """
    has_base_url = bool(re.search(r"<BaseURL[^>]*>", content, re.IGNORECASE))

    if has_base_url:
        # Rewrite existing <BaseURL> elements
        def _rewrite_baseurl(m):
            url = m.group(1).strip()
            if url and (url.startswith("http://") or url.startswith("https://")):
                resolved = url if url.endswith("/") else url + "/"
                return f"<BaseURL>{_make_base_proxy_url(resolved)}</BaseURL>"
            elif url:
                absolute = _resolve_url(base_url, url)
                if not absolute.endswith("/"):
                    absolute += "/"
                return f"<BaseURL>{_make_base_proxy_url(absolute)}</BaseURL>"
            return m.group(0)
        content = re.sub(r"<BaseURL>(.*?)</BaseURL>", _rewrite_baseurl, content, flags=re.DOTALL)
    else:
        # No BaseURL exists — inject one right after <MPD ...>
        proxy_base = _make_base_proxy_url(base_url)
        content = re.sub(
            r'(<MPD[^>]*>)',
            rf'\1\n  <BaseURL>{proxy_base}</BaseURL>',
            content,
            count=1,
        )

    # Rewrite absolute URLs in SegmentTemplate media/initialization attributes
    for attr in ["media", "initialization"]:
        def _rewrite_attr(m, attr_name=attr):
            url = m.group(1)
            if url.startswith("http://") or url.startswith("https://"):
                return f'{attr_name}="{_proxy_url(url)}"'
            return m.group(0)
        content = re.sub(
            rf'{attr}="(https?://[^"]*)"',
            _rewrite_attr,
            content,
            flags=re.IGNORECASE,
        )

    return content


# ---------------------------------------------------------------------------
#  API Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    """Home page with URL input form."""
    return render_template_string(HOME_PAGE_HTML)


@app.route("/api/extract", methods=["GET", "POST"])
def api_extract():
    """Extract manifest info from a content URL (JSON API)."""
    if request.method == "POST":
        content_url = request.json.get("url", "").strip()
    else:
        content_url = request.args.get("url", "").strip()

    if not content_url:
        return jsonify({"error": "Missing 'url' parameter"}), 400

    try:
        info = _extract_manifest(content_url)
        return jsonify({
            "manifest_url": info["manifest_url"],
            "proxied_manifest_url": _proxy_url(info["manifest_url"], "/proxy/manifest"),
            "manifest_type": info["manifest_type"],
            "keys": info["keys"],
            "is_hls_aes": info["is_hls_aes"],
            "title": info["title"],
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/play")
def play():
    """Player page — extracts manifest and renders an HTML5 video player."""
    content_url = request.args.get("url", "").strip()
    if not content_url:
        return redirect("/")

    try:
        info = _extract_manifest(content_url)
    except Exception as e:
        traceback.print_exc()
        return render_template_string(ERROR_PAGE_HTML, error=str(e), url=content_url), 500

    proxied_manifest = request.host_url.rstrip("/") + _proxy_url(info["manifest_url"], "/proxy/manifest")

    return render_template_string(
        PLAYER_PAGE_HTML,
        manifest_url=proxied_manifest,
        original_manifest_url=info["manifest_url"],
        manifest_type=info["manifest_type"],
        keys=info["keys"],
        title=info["title"],
        content_url=content_url,
        is_hls_aes=info["is_hls_aes"],
    )


@app.route("/proxy/manifest")
def proxy_manifest():
    """Fetch a manifest, rewrite its URLs, and return it."""
    target_url = request.args.get("url", "")
    if not target_url:
        return "Missing url parameter", 400

    target_url = unquote(target_url)
    headers = {k: v for k, v in _PROXY_HEADERS.items() if v is not None}
    headers["User-Agent"] = builtins.CONFIG.get("USER_AGENT", headers["User-Agent"]) if hasattr(builtins, "CONFIG") else headers["User-Agent"]

    try:
        resp = http_requests.get(target_url, headers=headers, timeout=30)
    except Exception as e:
        return f"Failed to fetch manifest: {e}", 502

    content_type = resp.headers.get("Content-Type", "")
    body = resp.text

    # Determine base URL for relative resolution
    base_url = target_url.rsplit("/", 1)[0] + "/"

    # Detect type and rewrite
    if "#EXTM3U" in body or "m3u8" in target_url.lower() or "mpegurl" in content_type.lower():
        body = _rewrite_m3u8(body, base_url)
        content_type = "application/vnd.apple.mpegurl"
    elif "<MPD" in body or "mpd" in target_url.lower() or "dash" in content_type.lower():
        body = _rewrite_mpd(body, base_url)
        content_type = "application/dash+xml"

    return Response(
        body,
        content_type=content_type,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Cache-Control": "no-cache",
        },
    )


@app.route("/proxy/resource")
def proxy_resource():
    """Generic proxy for segments, keys, init data, sub-playlists, etc."""
    target_url = request.args.get("url", "")
    if not target_url:
        return "Missing url parameter", 400

    target_url = unquote(target_url)
    headers = {k: v for k, v in _PROXY_HEADERS.items() if v is not None}
    headers["User-Agent"] = builtins.CONFIG.get("USER_AGENT", headers["User-Agent"]) if hasattr(builtins, "CONFIG") else headers["User-Agent"]

    # Forward range headers for segment requests
    if "Range" in request.headers:
        headers["Range"] = request.headers["Range"]

    try:
        resp = http_requests.get(target_url, headers=headers, timeout=60, stream=True)
    except Exception as e:
        return f"Failed to fetch resource: {e}", 502

    content_type = resp.headers.get("Content-Type", "application/octet-stream")
    resp_body = resp.content

    # If this is a sub-playlist (m3u8 inside m3u8), rewrite it too
    is_m3u8 = (
        "mpegurl" in content_type.lower()
        or target_url.lower().split("?")[0].endswith(".m3u8")
    )
    try:
        if is_m3u8 or (resp_body[:7] == b"#EXTM3U"):
            text = resp_body.decode("utf-8", errors="replace")
            base_url = target_url.rsplit("/", 1)[0] + "/"
            text = _rewrite_m3u8(text, base_url)
            resp_body = text.encode("utf-8")
            content_type = "application/vnd.apple.mpegurl"
    except:
        pass

    # If this is a DASH sub-manifest
    is_mpd = "dash" in content_type.lower() or target_url.lower().split("?")[0].endswith(".mpd")
    try:
        if is_mpd:
            text = resp_body.decode("utf-8", errors="replace")
            if "<MPD" in text:
                base_url = target_url.rsplit("/", 1)[0] + "/"
                text = _rewrite_mpd(text, base_url)
                resp_body = text.encode("utf-8")
                content_type = "application/dash+xml"
    except:
        pass

    resp_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }
    if "Content-Range" in resp.headers:
        resp_headers["Content-Range"] = resp.headers["Content-Range"]

    return Response(
        resp_body,
        status=resp.status_code,
        content_type=content_type,
        headers=resp_headers,
    )


@app.route("/proxy/b/<base_b64>/<path:subpath>")
def proxy_base_resource(base_b64, subpath):
    """Path-based proxy: resolves *subpath* relative to the decoded base URL.
    
    This is used by DASH manifests where <BaseURL> is set to
    /proxy/b/<encoded_base>/ so that relative segment URLs like
    "segment-video=400000.dash" naturally resolve here.
    """
    # Decode the base URL
    padding = 4 - len(base_b64) % 4
    if padding != 4:
        base_b64 += "=" * padding
    try:
        decoded_base = base64.urlsafe_b64decode(base_b64).decode()
    except Exception:
        return "Invalid base encoding", 400

    target_url = decoded_base + subpath

    # Preserve query string from the original request
    if request.query_string:
        target_url += "?" + request.query_string.decode()

    headers = {k: v for k, v in _PROXY_HEADERS.items() if v is not None}
    if hasattr(builtins, "CONFIG"):
        headers["User-Agent"] = builtins.CONFIG.get("USER_AGENT", headers["User-Agent"])

    if "Range" in request.headers:
        headers["Range"] = request.headers["Range"]

    try:
        resp = http_requests.get(target_url, headers=headers, timeout=60, stream=True)
    except Exception as e:
        return f"Failed to fetch: {e}", 502

    content_type = resp.headers.get("Content-Type", "application/octet-stream")
    resp_body = resp.content

    # If the response is a sub-manifest (m3u8 or mpd), rewrite it
    try:
        if b"#EXTM3U" in resp_body[:20]:
            text = resp_body.decode("utf-8", errors="replace")
            text_base = target_url.rsplit("/", 1)[0] + "/"
            text = _rewrite_m3u8(text, text_base)
            resp_body = text.encode("utf-8")
            content_type = "application/vnd.apple.mpegurl"
        elif b"<MPD" in resp_body[:500]:
            text = resp_body.decode("utf-8", errors="replace")
            text_base = target_url.rsplit("/", 1)[0] + "/"
            text = _rewrite_mpd(text, text_base)
            resp_body = text.encode("utf-8")
            content_type = "application/dash+xml"
    except Exception:
        pass

    resp_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }
    if "Content-Range" in resp.headers:
        resp_headers["Content-Range"] = resp.headers["Content-Range"]

    return Response(
        resp_body,
        status=resp.status_code,
        content_type=content_type,
        headers=resp_headers,
    )


@app.after_request
def add_cors(response):
    """Add CORS headers to all responses."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response


# ---------------------------------------------------------------------------
#  HTML Templates
# ---------------------------------------------------------------------------
HOME_PAGE_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WideFrog Proxy Player</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f0f0f;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .container {
    max-width: 700px;
    width: 90%;
    text-align: center;
  }
  h1 {
    font-size: 2.4rem;
    margin-bottom: .3em;
    background: linear-gradient(135deg, #4ade80, #22d3ee);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .subtitle { color: #888; margin-bottom: 2em; font-size: .95rem; }
  form {
    display: flex;
    gap: .5em;
    margin-bottom: 1.5em;
  }
  input[type="text"] {
    flex: 1;
    padding: .75em 1em;
    border-radius: 8px;
    border: 1px solid #333;
    background: #1a1a1a;
    color: #fff;
    font-size: 1rem;
    outline: none;
    transition: border .2s;
  }
  input[type="text"]:focus { border-color: #4ade80; }
  button {
    padding: .75em 1.5em;
    border-radius: 8px;
    border: none;
    background: linear-gradient(135deg, #4ade80, #22d3ee);
    color: #000;
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
    transition: opacity .2s;
  }
  button:hover { opacity: .85; }
  .info { color: #666; font-size: .85rem; line-height: 1.6; }
  .info code { background: #222; padding: 2px 6px; border-radius: 4px; color: #4ade80; }
  #loading {
    display: none;
    margin: 1em 0;
    color: #4ade80;
  }
  .spinner {
    display: inline-block;
    width: 18px; height: 18px;
    border: 2px solid #4ade80;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin .6s linear infinite;
    vertical-align: middle;
    margin-right: .5em;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="container">
  <h1>WideFrog Proxy</h1>
  <p class="subtitle">Paste a video URL from a supported service to play it in your browser.</p>
  <form id="playForm" action="/play" method="get">
    <input type="text" name="url" placeholder="https://www.france.tv/..." autocomplete="off" required>
    <button type="submit">Play</button>
  </form>
  <div id="loading"><span class="spinner"></span> Extracting manifest&hellip; this may take a moment.</div>
  <div class="info">
    <p>You can also use the API directly:</p>
    <p><code>GET /api/extract?url=CONTENT_URL</code></p>
    <p><code>GET /proxy/manifest?url=MANIFEST_URL</code></p>
  </div>
</div>
<script>
  document.getElementById('playForm').addEventListener('submit', function() {
    document.getElementById('loading').style.display = 'block';
  });
</script>
</body>
</html>
"""

PLAYER_PAGE_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{ title }} — WideFrog Player</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/shaka-player@4.7.11/dist/shaka-player.compiled.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f0f0f;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .top-bar {
    width: 100%;
    padding: .8em 1.5em;
    background: #181818;
    display: flex;
    align-items: center;
    gap: 1em;
    border-bottom: 1px solid #222;
  }
  .top-bar a { color: #4ade80; text-decoration: none; font-weight: 600; font-size: 1.1rem; }
  .top-bar .title { color: #ccc; font-size: .95rem; }
  .player-wrap {
    width: 100%;
    max-width: 1100px;
    margin: 2em auto;
    padding: 0 1em;
  }
  video {
    width: 100%;
    max-height: 70vh;
    background: #000;
    border-radius: 8px;
  }

  /* ---- Controls bar ---- */
  .controls-bar {
    display: flex;
    flex-wrap: wrap;
    gap: .6em;
    margin-top: .8em;
    padding: .8em 1em;
    background: #181818;
    border-radius: 8px;
    align-items: center;
  }
  .ctrl-group {
    display: flex;
    align-items: center;
    gap: .35em;
  }
  .ctrl-group label {
    font-size: .78rem;
    color: #888;
    white-space: nowrap;
  }
  .ctrl-group select {
    background: #1a1a1a;
    color: #e0e0e0;
    border: 1px solid #333;
    border-radius: 6px;
    padding: .35em .6em;
    font-size: .82rem;
    cursor: pointer;
    outline: none;
    min-width: 100px;
  }
  .ctrl-group select:focus { border-color: #4ade80; }
  .ctrl-group select option { background: #1a1a1a; }

  .info-panel {
    margin-top: 1em;
    padding: 1em;
    background: #181818;
    border-radius: 8px;
    font-size: .85rem;
    line-height: 1.8;
    word-break: break-all;
  }
  .info-panel .label { color: #888; }
  .info-panel .value { color: #4ade80; }
  .info-panel .keys { color: #f59e0b; }
  #status {
    margin-top: .5em;
    padding: .5em 1em;
    background: #1a1a1a;
    border-radius: 6px;
    font-size: .8rem;
    color: #888;
  }
  #error-box {
    display: none;
    margin-top: 1em;
    padding: 1em;
    background: #2d1111;
    border: 1px solid #7f1d1d;
    border-radius: 8px;
    color: #fca5a5;
    font-size: .9rem;
  }
</style>
</head>
<body>
<div class="top-bar">
  <a href="/">&larr; WideFrog Proxy</a>
  <span class="title">{{ title }}</span>
</div>

<div class="player-wrap">
  <video id="video" controls autoplay></video>

  <!-- Track selectors -->
  <div class="controls-bar">
    <div class="ctrl-group">
      <label for="sel-quality">Quality</label>
      <select id="sel-quality"><option value="-1">Auto</option></select>
    </div>
    <div class="ctrl-group">
      <label for="sel-audio">Audio</label>
      <select id="sel-audio"><option value="-1">Default</option></select>
    </div>
    <div class="ctrl-group">
      <label for="sel-subs">Subtitles</label>
      <select id="sel-subs"><option value="off">Off</option></select>
    </div>
  </div>

  <div id="error-box"></div>
  <div id="status">Initializing player&hellip;</div>

  <div class="info-panel">
    <div><span class="label">Type:</span> <span class="value">{{ manifest_type | upper }}</span></div>
    <div><span class="label">Original manifest:</span> <span class="value">{{ original_manifest_url[:120] }}{% if original_manifest_url|length > 120 %}&hellip;{% endif %}</span></div>
    <div><span class="label">Proxied manifest:</span> <span class="value">{{ manifest_url[:120] }}{% if manifest_url|length > 120 %}&hellip;{% endif %}</span></div>
    {% if keys %}
    <div><span class="label">Decryption keys:</span>
      {% for k in keys %}
        <div class="keys">&nbsp;&nbsp;{{ k }}</div>
      {% endfor %}
    </div>
    {% endif %}
  </div>
</div>

<script>
(function() {
  const video      = document.getElementById('video');
  const statusEl   = document.getElementById('status');
  const errorBox   = document.getElementById('error-box');
  const selQuality = document.getElementById('sel-quality');
  const selAudio   = document.getElementById('sel-audio');
  const selSubs    = document.getElementById('sel-subs');
  const manifestUrl  = {{ manifest_url | tojson }};
  const manifestType = {{ manifest_type | tojson }};
  const keys         = {{ keys | tojson }};

  function setStatus(msg) { statusEl.textContent = msg; }
  function showError(msg) { errorBox.style.display = 'block'; errorBox.textContent = msg; }

  /* ------------------------------------------------------------------ */
  /*  LANG HELPERS                                                       */
  /* ------------------------------------------------------------------ */
  var LANG_NAMES = {
    fr:'Français', en:'English', de:'Deutsch', es:'Español', it:'Italiano',
    pt:'Português', nl:'Nederlands', ja:'日本語', ko:'한국어', zh:'中文',
    ar:'العربية', ru:'Русский', pl:'Polski', qaa:'Audiodescription',
    qad:'Audiodescription', qsm:'Sous-titres malentendants',
    und:'Undefined'
  };
  function langLabel(code) {
    if (!code) return '';
    var c = code.toLowerCase().split('-')[0];
    return LANG_NAMES[c] || code;
  }

  /* ================================================================== */
  /*  HLS  via hls.js                                                   */
  /* ================================================================== */
  if (manifestType === 'hls') {
    if (Hls.isSupported()) {
      var hls = new Hls({ debug: false, enableWorker: true });
      hls.loadSource(manifestUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, function(ev, data) {
        /* Populate quality selector */
        selQuality.innerHTML = '<option value="-1">Auto</option>';
        data.levels.forEach(function(lv, i) {
          var label = lv.height ? (lv.height + 'p') : ('Level ' + i);
          if (lv.bitrate) label += ' (' + Math.round(lv.bitrate / 1000) + ' kbps)';
          var opt = document.createElement('option');
          opt.value = i; opt.textContent = label;
          selQuality.appendChild(opt);
        });
        /* Populate audio selector */
        if (hls.audioTracks && hls.audioTracks.length > 1) {
          selAudio.innerHTML = '';
          hls.audioTracks.forEach(function(t, i) {
            var opt = document.createElement('option');
            opt.value = i;
            opt.textContent = (t.name || langLabel(t.lang) || 'Track ' + i)
              + (t.lang ? ' [' + t.lang + ']' : '');
            if (t.default) opt.selected = true;
            selAudio.appendChild(opt);
          });
        }
        /* Populate subtitle selector */
        if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
          selSubs.innerHTML = '<option value="off">Off</option>';
          hls.subtitleTracks.forEach(function(t, i) {
            var opt = document.createElement('option');
            opt.value = i;
            opt.textContent = (t.name || langLabel(t.lang) || 'Sub ' + i)
              + (t.lang ? ' [' + t.lang + ']' : '');
            selSubs.appendChild(opt);
          });
        }
        setStatus('Manifest loaded — ' + data.levels.length + ' quality level(s). Playing...');
        video.play().catch(function(){});
      });

      selQuality.addEventListener('change', function() {
        hls.currentLevel = parseInt(this.value);
      });
      selAudio.addEventListener('change', function() {
        var v = parseInt(this.value);
        if (v >= 0) hls.audioTrack = v;
      });
      selSubs.addEventListener('change', function() {
        if (this.value === 'off') {
          hls.subtitleTrack = -1;
          hls.subtitleDisplay = false;
        } else {
          hls.subtitleTrack = parseInt(this.value);
          hls.subtitleDisplay = true;
        }
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, function(ev, data) {
        var lv = hls.levels[data.level];
        if (lv) setStatus('Quality: ' + (lv.height || '?') + 'p  (' + Math.round(lv.bitrate/1000) + ' kbps)');
      });

      hls.on(Hls.Events.ERROR, function(ev, data) {
        console.error('HLS error:', data);
        if (data.fatal) {
          showError('HLS fatal error: ' + data.type + ' / ' + data.details);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(function(){ hls.startLoad(); }, 2000);
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = manifestUrl;
      video.addEventListener('loadedmetadata', function() {
        setStatus('Playing (native HLS — use browser controls for quality)...');
        video.play().catch(function(){});
      });
    } else {
      showError('HLS is not supported in this browser.');
    }
  }

  /* ================================================================== */
  /*  DASH  via shaka-player                                            */
  /* ================================================================== */
  else if (manifestType === 'dash') {
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      showError('DASH/shaka-player is not supported in this browser.');
    } else {
      var player = new shaka.Player();
      player.attach(video);

      /* ClearKey setup */
      if (keys && keys.length > 0) {
        var clearKeys = {};
        keys.forEach(function(k) {
          var p = k.split(':');
          if (p.length === 2) clearKeys[p[0]] = p[1];
        });
        if (Object.keys(clearKeys).length > 0) {
          player.configure({ drm: { clearKeys: clearKeys } });
          setStatus('ClearKey DRM configured with ' + Object.keys(clearKeys).length + ' key(s).');
        }
      }

      player.addEventListener('error', function(event) {
        console.error('Shaka error:', event.detail);
        showError('DASH error: ' + event.detail.message);
      });

      /* --- helper: populate selects after load --- */
      function populateDashControls() {
        var variants = player.getVariantTracks();
        var textTracks = player.getTextTracks();

        /* -------- Quality -------- */
        /* Deduplicate by resolution+bandwidth (variants combine audio+video) */
        var seen = {};
        var qualities = [];
        variants.forEach(function(v) {
          var key = (v.height || 0) + '_' + v.videoBandwidth;
          if (v.height && !seen[key]) {
            seen[key] = true;
            qualities.push(v);
          }
        });
        qualities.sort(function(a, b) { return (a.height || 0) - (b.height || 0); });

        selQuality.innerHTML = '<option value="auto">Auto</option>';
        qualities.forEach(function(q) {
          var bw = q.videoBandwidth || q.bandwidth || 0;
          var label = q.height + 'p'
            + (q.width ? ' (' + q.width + 'x' + q.height + ')' : '')
            + (bw ? ' — ' + Math.round(bw / 1000) + ' kbps' : '');
          var opt = document.createElement('option');
          opt.value = JSON.stringify({ height: q.height, videoBandwidth: q.videoBandwidth });
          opt.textContent = label;
          selQuality.appendChild(opt);
        });

        /* -------- Audio -------- */
        var audioLangs = {};
        var audioList = [];
        variants.forEach(function(v) {
          var key = (v.language || 'und') + '_' + (v.audioId || 0);
          if (!audioLangs[key]) {
            audioLangs[key] = true;
            audioList.push(v);
          }
        });
        if (audioList.length > 1) {
          selAudio.innerHTML = '';
          audioList.forEach(function(a, i) {
            var opt = document.createElement('option');
            opt.value = JSON.stringify({ language: a.language, audioId: a.audioId });
            var name = langLabel(a.language) || a.language || 'Track ' + i;
            if (a.label) name = a.label;
            opt.textContent = name + (a.language ? ' [' + a.language + ']' : '');
            if (a.active) opt.selected = true;
            selAudio.appendChild(opt);
          });
        }

        /* -------- Subtitles -------- */
        if (textTracks.length > 0) {
          selSubs.innerHTML = '<option value="off">Off</option>';
          textTracks.forEach(function(t, i) {
            var opt = document.createElement('option');
            opt.value = i;
            var name = t.label || langLabel(t.language) || t.language || 'Sub ' + i;
            opt.textContent = name + (t.language ? ' [' + t.language + ']' : '');
            selSubs.appendChild(opt);
          });
        }
      }

      /* Quality change */
      selQuality.addEventListener('change', function() {
        if (this.value === 'auto') {
          player.configure({ abr: { enabled: true } });
          setStatus('Quality: Auto (ABR)');
          return;
        }
        var chosen = JSON.parse(this.value);
        player.configure({ abr: { enabled: false } });
        /* Find best matching variant for current audio */
        var variants = player.getVariantTracks();
        var active = variants.find(function(v) { return v.active; });
        var match = variants.find(function(v) {
          return v.height === chosen.height
              && v.videoBandwidth === chosen.videoBandwidth
              && (!active || v.language === active.language);
        });
        if (!match) match = variants.find(function(v) {
          return v.height === chosen.height && v.videoBandwidth === chosen.videoBandwidth;
        });
        if (match) {
          player.selectVariantTrack(match, true);
          setStatus('Quality: ' + match.height + 'p (' + Math.round((match.videoBandwidth||match.bandwidth)/1000) + ' kbps)');
        }
      });

      /* Audio change */
      selAudio.addEventListener('change', function() {
        var chosen = JSON.parse(this.value);
        player.selectAudioLanguage(chosen.language);
        setStatus('Audio: ' + langLabel(chosen.language) + ' [' + chosen.language + ']');
      });

      /* Subtitle change */
      selSubs.addEventListener('change', function() {
        if (this.value === 'off') {
          player.setTextTrackVisibility(false);
          setStatus('Subtitles: Off');
        } else {
          var tracks = player.getTextTracks();
          var idx = parseInt(this.value);
          if (tracks[idx]) {
            player.selectTextTrack(tracks[idx]);
            player.setTextTrackVisibility(true);
            setStatus('Subtitles: ' + (tracks[idx].label || tracks[idx].language));
          }
        }
      });

      /* Load */
      player.load(manifestUrl).then(function() {
        populateDashControls();
        setStatus('Manifest loaded. Playing...');
        video.play().catch(function(){});
      }).catch(function(e) {
        console.error('Shaka load error:', e);
        showError('Failed to load DASH manifest: ' + e.message);
      });

      /* Update quality label when ABR switches */
      player.addEventListener('adaptation', function() {
        var active = player.getVariantTracks().find(function(v){ return v.active; });
        if (active && selQuality.value === 'auto') {
          setStatus('Quality (auto): ' + (active.height||'?') + 'p — ' + Math.round((active.videoBandwidth||active.bandwidth||0)/1000) + ' kbps');
        }
      });
    }
  }

  /* ================================================================== */
  /*  Fallback                                                          */
  /* ================================================================== */
  else {
    setStatus('Unknown manifest type (' + manifestType + '). Trying native playback...');
    video.src = manifestUrl;
    video.addEventListener('loadedmetadata', function() {
      setStatus('Playing (native)...');
      video.play().catch(function(){});
    });
    video.addEventListener('error', function() {
      showError('Failed to play. The manifest type may not be supported in the browser.');
    });
  }
})();
</script>
</body>
</html>
"""

ERROR_PAGE_HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Error — WideFrog Proxy</title>
<style>
  body {
    font-family: -apple-system, sans-serif;
    background: #0f0f0f; color: #e0e0e0;
    display: flex; justify-content: center; align-items: center;
    min-height: 100vh;
  }
  .box {
    max-width: 600px; padding: 2em;
    background: #1a1a1a; border-radius: 12px;
    text-align: center;
  }
  h2 { color: #f87171; margin-bottom: .5em; }
  .url { color: #888; word-break: break-all; margin-bottom: 1em; }
  .error { color: #fca5a5; background: #2d1111; padding: 1em; border-radius: 8px; text-align: left; font-size: .9rem; }
  a { color: #4ade80; }
</style>
</head>
<body>
<div class="box">
  <h2>Extraction Failed</h2>
  <p class="url">{{ url }}</p>
  <div class="error">{{ error }}</div>
  <p style="margin-top:1.5em"><a href="/">&larr; Back</a></p>
</div>
</body>
</html>
"""

# ---------------------------------------------------------------------------
#  Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="WideFrog Proxy Player")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=5000, help="Port to bind (default: 5000)")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode")
    cli_args = parser.parse_args()

    # Pre-init widefrog
    _init_widefrog()

    print(f"\n  WideFrog Proxy Player")
    print(f"  Open http://{cli_args.host}:{cli_args.port} in your browser\n")

    app.run(host=cli_args.host, port=cli_args.port, debug=cli_args.debug, threaded=True)
