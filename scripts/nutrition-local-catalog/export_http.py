"""HTTPS-only OFF export transport. Exact bucket/object allowlist, no credentials.

Redirects may change the host, never the export object, request method or trust
boundary. TLS uses Python's default verified certificate context. Not a proxy.
"""
import ssl
import time
import urllib.parse
import urllib.request
from catalog import CatalogError, require

EXPORTS = {
    'jsonl': 'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',
    'tsv': 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz',
}
S3_BUCKET_HOSTS = {'openfoodfacts-ds.s3.eu-west-3.amazonaws.com', 'openfoodfacts-ds.s3.amazonaws.com'}
S3_PATH_HOSTS = {'s3.eu-west-3.amazonaws.com', 's3.amazonaws.com'}
IDENTITY = 'openGym-catalog-import/1 (https://github.com/solhren/openGym)'


def validate_export_url(url, kind):
    require(kind in EXPORTS and type(url) is str and len(url) <= 2048 and not any(ord(c) < 33 or ord(c) > 126 for c in url) and '\\' not in url, 'export-unsafe-url')
    parsed = urllib.parse.urlsplit(url)
    try: port = parsed.port
    except ValueError: raise CatalogError('export-unsafe-url') from None
    require(parsed.scheme == 'https' and parsed.username is None and parsed.password is None and port in (None, 443) and not parsed.fragment, 'export-unsafe-url')
    filename = EXPORTS[kind].rsplit('/', 1)[1]
    host = parsed.hostname
    require((host == 'static.openfoodfacts.org' and parsed.path == '/data/' + filename)
            or (host in S3_BUCKET_HOSTS and parsed.path == '/' + filename)
            or (host in S3_PATH_HOSTS and parsed.path == '/openfoodfacts-ds/' + filename), 'export-unapproved-destination')
    # S3 version IDs are public object metadata, not signed credentials. A new
    # official delivery host/signing scheme needs an explicit reviewed allowlist.
    try: query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True) if parsed.query else {}
    except ValueError: raise CatalogError('export-unsafe-query') from None
    require(set(query) <= {'versionId'} and all(len(v) == 1 and 0 < len(v[0]) <= 512 and all(c.isascii() and (c.isalnum() or c in '._~+/=-') for c in v[0]) for v in query.values()), 'export-unsafe-query')
    return parsed


class SafeExportRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, kind, deadline=None):
        self.kind = kind
        self.deadline = deadline or time.monotonic() + 30
        self.chain = []
        self.seen = {EXPORTS[kind]}

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(code in (301,302,303,307,308) and req.get_method() in ('HEAD','GET'), 'export-unsafe-redirect')
        validate_export_url(req.full_url, self.kind)
        validate_export_url(newurl, self.kind)
        require(len(self.chain) < 3 and newurl not in self.seen, 'export-redirect-limit-or-loop')
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, 'export-deadline-exceeded')
        self.seen.add(newurl)
        self.chain.append({'status':code, 'url':newurl})
        # urllib's follow-up uses the previous request's timeout. Preserve HEAD even
        # for 303 and never forward authentication/cookies across origins.
        req.timeout = min(getattr(req,'timeout',15), remaining)
        allowed = {'User-agent','Accept','Accept-encoding','Range','If-range','If-match'}
        forwarded = {k:v for k,v in req.header_items() if k in allowed}
        return urllib.request.Request(newurl, headers=forwarded, method=req.get_method())


def export_opener(kind, deadline=None):
    redirect = SafeExportRedirect(kind, deadline)
    opener = urllib.request.build_opener(redirect, urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    return opener, redirect
