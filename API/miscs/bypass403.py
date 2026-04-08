import logging
import time
import os
import requests
from flask import Flask, request, Response, jsonify
from urllib.parse import unquote, urlparse, parse_qs, urlencode, urlunparse
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

# Disable extensive logging
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

app = Flask(__name__)

# --- Configuration ---
PORT = 25568
# SOCKS5 Proxy definition
PROXY_SOCKS = os.environ.get("BYPASS403_SOCKS5_PROXY_URL", "").strip()

# --- In-Memory Cache (Simple & Light) ---
# Stores: { url: {'content': bytes, 'ts': timestamp, 'headers': list, 'status': int} }
CACHE = {}
CACHE_TTL = 600       # 10 minutes cache
MAX_CACHE_ITEMS = 200 # Keep memory low
MAX_BODY_SIZE = 1 * 1024 * 1024 # Only cache responses < 1MB

def get_cached(url):
    """Retrieve item from cache if valid."""
    if url in CACHE:
        item = CACHE[url]
        if time.time() - item['ts'] < CACHE_TTL:
            return item
        else:
            del CACHE[url] # Expired
    return None

def set_cached(url, content, headers, status):
    """Add item to cache, evicting old ones if full."""
    if len(CACHE) >= MAX_CACHE_ITEMS:
        # Remove a random item (first available key)
        CACHE.pop(next(iter(CACHE)), None)
    
    CACHE[url] = {
        'content': content,
        'ts': time.time(),
        'headers': headers,
        'status': status
    }

# --- HTTP Session ---
session = requests.Session()
# High pool size for concurrency
adapter = requests.adapters.HTTPAdapter(pool_connections=200, pool_maxsize=200)
session.mount('http://', adapter)
session.mount('https://', adapter)

@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS, HEAD"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response

@app.route("/health")
def health():
    return jsonify({"status": "ok", "cache_size": len(CACHE)})

@app.route("/proxy/<path:target>", methods=["GET", "POST", "HEAD", "OPTIONS"])
def proxy(target):
    # 1. Reconstruct Target URL
    query_string = request.query_string.decode('utf-8') if request.query_string else ""
    target_url = f"{target}?{query_string}" if query_string else target

    try:
        target_url = unquote(target_url)
    except:
        pass

    if not target_url.startswith("http"):
        target_url = f"https://{target_url}"

    # 2. Check Cache (Only for GET and likely static content)
    if request.method == "GET":
        cached = get_cached(target_url)
        if cached:
            return Response(cached['content'], status=cached['status'], headers=cached['headers'])

    # 3. Detect & Handle Proxy Params
    use_proxy = False
    parsed = urlparse(target_url)
    domain_lower = parsed.netloc.lower()

    # logic to enable proxy for specific sites or if requested
    if "coflix" in domain_lower:
        use_proxy = True
    
    # Check query params for 'proxy=true'
    params = parse_qs(parsed.query)
    if 'proxy' in params and params['proxy'][0].lower() == 'true':
        use_proxy = True

    # Remove strict 'proxy' param from upstream url if it exists
    if 'proxy' in params:
        del params['proxy']
        new_query = urlencode(params, doseq=True)
        target_url = urlunparse((
            parsed.scheme, parsed.netloc, parsed.path, parsed.params,
            new_query, parsed.fragment
        ))

    # 4. Prepare Headers
    # Forward most headers but clean duplicates/hop-by-hop
    req_headers = {k: v for k, v in request.headers.items() if k.lower() not in ['host', 'content-length', 'content-encoding']}
    
    req_headers["Accept-Encoding"] = "identity" # Avoid auto-gzip by requests
    req_headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    # Domain specific headers
    if "coflix" in domain_lower:
        req_headers["Origin"] = "https://movix.embedseek.com"
        req_headers["Referer"] = "https://movix.embedseek.com/"
    elif "cinetacos" in domain_lower:
        req_headers["Origin"] = "https://cinepulse.to"
        req_headers["Referer"] = "https://cinepulse.to/"
    elif "fsvid" in domain_lower:
        req_headers["Referer"] = "https://fs-miroir6.lol/"
    elif "top-stream" in domain_lower:
        req_headers["Origin"] = "https://top-stream.plus"
        req_headers["Referer"] = "https://top-stream.plus/"

    # 5. Execute Request
    try:
        proxies = {'http': PROXY_SOCKS, 'https': PROXY_SOCKS} if use_proxy and PROXY_SOCKS else None
        
        resp = session.request(
            method=request.method,
            url=target_url,
            headers=req_headers,
            data=request.get_data(),
            cookies=request.cookies,
            timeout=20,      # Fast timeout
            verify=False,    # Ignore SSL errors for speed/compat
            proxies=proxies
        )

        # 6. Buffer & Cache Response
        excluded_headers = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
        resp_headers = [(k, v) for k, v in resp.headers.items() if k.lower() not in excluded_headers]
        body = resp.content
        resp.close()

        should_cache = (
            request.method == "GET" and
            resp.status_code == 200 and
            len(body) <= MAX_BODY_SIZE
        )

        if should_cache:
            set_cached(target_url, body, resp_headers, resp.status_code)

        return Response(body, status=resp.status_code, headers=resp_headers)

    except Exception as e:
        # Quiet error handling
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    import urllib3
    urllib3.disable_warnings()
    # Threaded for concurrency
    app.run(host="0.0.0.0", port=PORT, threaded=True, debug=False)
