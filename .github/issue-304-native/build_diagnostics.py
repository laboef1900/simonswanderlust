"""Temporary #304 build-failure evidence, never runtime/fixture command output.

Only selected diagnostic lines from the credential-free Docker build are eligible.
Raw streams stay private. This is a disclosure filter, not a general log sanitizer:
never reuse it for commands with credentials, application data or runtime output.
"""
import re
from urllib.parse import urlsplit

MAX_SCAN_CHARS = 256 * 1024
MAX_LINES = 80
MAX_LINE_CHARS = 1200
MAX_EXCERPT_CHARS = 16 * 1024
PUBLIC_HOSTS = frozenset(('snapshot.debian.org', 'registry.npmjs.org', 'nodejs.org', 'dhi.io'))
DIAGNOSTIC = re.compile(
    r'error|fail|fatal|exception|assert|not found|no such file|unable|cannot|could not|'
    r'invalid|expired|not valid|release file|signature|certificate|permission denied|'
    r'unsupported|mismatch|^Dockerfile\.proof:\d+|^#\d+ \[[^\]]+\] RUN ', re.I)
# Apt's useful package/version conflict lines often contain none of the generic
# error words above. Select only dependency relationships and solver decisions,
# not arbitrary neighbouring output; apply the same disclosure checks below.
APT_PACKAGE = r'[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?'
APT_CONFLICT = re.compile(
    r'^(?:#\d+\s+\d+(?:\.\d+)?\s+)?\s*(?:'
    rf'(?:{APT_PACKAGE}\s*:\s*)?(?:PreDepends|Depends|Conflicts|Breaks):\s+|'
    rf'\d+\.\s+{APT_PACKAGE}(?:=\S+)?\s+'
    r'(?:Depends\s+|is (?:not )?selected\b|conflicts with other versions\b))')
SENSITIVE = re.compile(
    r'password|postgres(?:ql)?://|\bauth\w*\b|\btoken\b|\bsecret\w*\b|'
    r'credential|cookie|api[_ -]?key|private[_ -]?key|database_url|'
    r'\b(?:gh[pousr]_|github_pat_|AKIA|ASIA|sk-)|\beyJ[A-Za-z0-9_-]*\.', re.I)
URL = re.compile(r'https?://[^\s<>\"\']+', re.I)
OPAQUE = re.compile(r'[A-Za-z0-9_+/=-]{32,}')


def excerpt(text, fixture_password):
    """Bound both scan and export; reject suspect lines before any truncation."""
    # A partial first line could hide a credential label; discard that line.
    scan_truncated = len(text) > MAX_SCAN_CHARS
    if scan_truncated:
        text = text[-MAX_SCAN_CHARS:]
        text = text.partition('\n')[2]
    selected = []
    withheld = 0
    for line in text.splitlines():
        if not (DIAGNOSTIC.search(line) or APT_CONFLICT.search(line)):
            continue
        if (fixture_password in line or SENSITIVE.search(line)
                or any(ord(c) < 32 or ord(c) > 126 for c in line)):
            withheld += 1
            continue
        unsafe_url = False
        for match in URL.finditer(line):
            try:
                url = urlsplit(match.group())
                if (url.scheme != 'https' or url.hostname not in PUBLIC_HOSTS
                        or url.username is not None or url.password is not None
                        or url.query or url.fragment or url.port not in (None, 443)):
                    unsafe_url = True
            except ValueError:
                unsafe_url = True
        if unsafe_url:
            withheld += 1
            continue
        # Do not export opaque credentials even when they lack a recognizable label.
        line = OPAQUE.sub('[opaque-value-withheld]', line)
        if len(line) > MAX_LINE_CHARS:
            withheld += 1
            continue
        selected.append(line)
    count = len(selected)
    selected = selected[-MAX_LINES:]
    size = 0
    kept = []
    for line in reversed(selected):
        if size + len(line) + 1 > MAX_EXCERPT_CHARS:
            break
        kept.append(line)
        size += len(line) + 1
    return {'lines': list(reversed(kept)), 'withheldLines': withheld,
            'scanTruncated': scan_truncated, 'excerptTruncated': len(kept) < count,
            'selection': 'diagnostic lines only; sensitive, non-ASCII and non-public URL lines withheld'}


def build_failure(stdout, stderr, fixture_password):
    return {'scope': 'temporary credential-free native Docker build only; no runtime output',
            'stdout': excerpt(stdout, fixture_password),
            'stderr': excerpt(stderr, fixture_password)}
