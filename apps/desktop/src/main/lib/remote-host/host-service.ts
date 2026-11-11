/**
 * Odin's service on a remote host. Sessions there call Odin at
 * 127.0.0.1:$ODIN_PORT exactly as they do on the laptop; this answers.
 *
 * - `action=service` (Slack, Notion, ClickUp, Jira, GitHub API calls) is
 *   answered here, with the tokens the user chose to keep on the host. So
 *   connector calls work with the laptop closed.
 * - `POST /tokens`, `POST /github-pair?login=`, `POST /jira-pair` and `POST /notion-pair` are how the user's own
 *   Odin sends them: over that user's login, never root's, so a host user
 *   needs no sudo. Answered to the owning Linux user alone; the service
 *   writes the files itself, mode 0600.
 * - `GET /token?service=github` is the GitHub token a session's git and gh
 *   sign in with, read at each use (session.ts), so it never goes stale: the
 *   host's own sign-in for the account, refreshed here before it expires or
 *   when GitHub refuses it, else the laptop's latest copy.
 * - Everything else (board actions, hooks, file reads) goes on to Odin on the
 *   laptop through the session helper's tunnel, with the user's tunnel secret:
 *   the tunnel's port is open to every user on the host, and Odin on the
 *   laptop answers only requests that carry it. Says plainly when the laptop
 *   is asleep.
 *
 * One per host user: each Odin user has a Linux user of their own on the
 * host, and their own service, port and tokens. The service runs as the
 * `odin` user, which alone can read the tokens (0600), so a session can use
 * a connector but never read or copy its token. It answers only the Linux
 * user it belongs to, so one user's sessions can't use another's connectors.
 *
 * Python 3 standard library only: every common Linux image has it, so the
 * host needs nothing installed.
 */

/**
 * Each host user's ports, from their uid: the service's, and the one the
 * session helper's tunnel to Odin on the laptop binds. Uids are unique, so
 * two users' ports never meet. HOST_PORT_SH is the same sum in the shell.
 */
export const hostPorts = (uid: number) => {
	const service = 40_000 + (uid % 10_000) * 2;
	return { service, tunnel: service + 1 };
};
/** The service port of the user `id -u ARG` names (none: the current user). */
const hostPortSh = (user = "") =>
	`$((40000 + $(id -u${user && ` ${user}`}) % 10000 * 2))`;
export const HOST_PORT_SH = hostPortSh();

/** Where the service keeps a host user's tokens. */
export const hostTokensFile = (user: string) =>
	`/var/lib/odin/${user}/tokens.json`;

/** Where the service keeps the host's own GitHub sign-ins, one file per login. */
export const hostGithubDir = (user: string) => `/var/lib/odin/${user}/github`;

/** A GitHub login as the service's file name for it; throws on anything else. */
export function hostGithubLoginFile(login: string): string {
	if (!/^[A-Za-z0-9-]{1,39}$/.test(login))
		throw new Error(`Not a GitHub login: ${login}`);
	return `${login.toLowerCase()}.json`;
}

/**
 * What this computer writes as a host user's tokens file. Connector tokens by
 * name, as the service's `action=service` calls spend them, and GitHub for
 * sessions there too: a session's git and gh ask the service for the current
 * token at each use (session.ts), and get the host's own sign-in when the
 * account has one, else this computer's copy from here.
 */
export interface HostTokensFile {
	slack?: string;
	notion?: string;
	clickup?: string;
	jira?: string;
	jiraBase?: string;
	/** The default GitHub account's token, this computer's copy. */
	github?: string;
	/** Its login (lower case), when known. */
	githubLogin?: string;
	/** This computer's token for every account allowed on the host, by login (lower case). */
	githubAccounts?: Record<string, string>;
	/** Sessions may call the GitHub API through the service (the GitHub connector). */
	githubConnector?: boolean;
	/** What the service sends on every request it passes to this computer's Odin (listenForTunnel). */
	tunnel?: string;
}

/** argv: the host user it serves, their tokens file, its port (the tunnel's is next). */
export const HOST_SERVICE_PY = `import base64, json, os, pwd, re, sys, threading, time, urllib.request, urllib.parse, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OWNER = pwd.getpwnam(sys.argv[1]).pw_uid
TOKENS = sys.argv[2]
PORT = int(sys.argv[3])
TUNNEL = "http://127.0.0.1:" + str(PORT + 1)
# The host's own GitHub sign-ins: one file per login, beside the tokens file,
# holding the access token, the refresh token and the expiry. This service is
# their only user, so the rotating refresh token never races another holder.
GITHUB_DIR = os.path.join(os.path.dirname(TOKENS), "github")
GITHUB_TOKEN_URL = os.environ.get("ODIN_GITHUB_TOKEN_URL") or "https://github.com/login/oauth/access_token"
# Refresh this far before expiry, so a push that started in time never ages out.
GITHUB_MARGIN = 30 * 60
# GitHub revokes tokens server-side with no expiry and no notice. A token is
# checked here before it is handed out, at most once per CHECK_EVERY.
GITHUB_USER_URL = os.environ.get("ODIN_GITHUB_USER_URL") or "https://api.github.com/user"
CHECK_EVERY = 5 * 60
checked = {}
LOGIN = re.compile(r"[A-Za-z0-9-]{1,39}")
github_lock = threading.Lock()
# The host's own Jira sign-in (Atlassian 3LO), beside the tokens file: the access token, the rotating
# refresh token, the expiry, the OAuth app and the site. Refreshed here, so Jira works with the laptop shut.
JIRA_FILE = os.path.join(os.path.dirname(TOKENS), "jira.json")
JIRA_TOKEN_URL = os.environ.get("ODIN_JIRA_TOKEN_URL") or "https://auth.atlassian.com/oauth/token"
JIRA_API = os.environ.get("ODIN_JIRA_API") or "https://api.atlassian.com/ex/jira/"
JIRA_MARGIN = 5 * 60
jira_lock = threading.Lock()
# The host's own Notion sign-in, the same way: Notion's access tokens expire, so the host refreshes its own.
NOTION_FILE = os.path.join(os.path.dirname(TOKENS), "notion.json")
NOTION_TOKEN_URL = os.environ.get("ODIN_NOTION_TOKEN_URL") or "https://api.notion.com/v1/oauth/token"
NOTION_API = os.environ.get("ODIN_NOTION_API") or "https://api.notion.com/v1/"
notion_lock = threading.Lock()


def peer_uid(peer_port):
    """The uid behind a local connection to PORT, from /proc/net/tcp; None off Linux."""
    want = ("0100007F:%04X" % peer_port, "0100007F:%04X" % PORT)
    try:
        with open("/proc/net/tcp") as f:
            for line in f.readlines()[1:]:
                cols = line.split()
                if (cols[1], cols[2]) == want:
                    return int(cols[7])
    except OSError:
        return None
    return -1


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def write_json(path, data):
    """Whole, then into place: a reader never sees half a file. Mode 0600: tokens are this service's alone."""
    fd = os.open(path + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.chmod(path + ".new", 0o600)
    os.replace(path + ".new", path)


def tokens():
    t = read_json(TOKENS)
    return t if isinstance(t, dict) else {}


# Odin on the laptop sends fresh tokens every half hour while it is awake. A
# copy older than that means it slept through a send: ask it through the
# tunnel instead, at most once a minute. No refresh token is kept on the host.
STALE_AFTER = 35 * 60
pull_lock = threading.Lock()
last_pull = {False: 0.0, True: 0.0}


def fresh_from_laptop(force=False):
    """Replaces a stale tokens file (any, with force) with the laptop's current one, when the laptop answers."""
    try:
        if not force and time.time() - os.path.getmtime(TOKENS) < STALE_AFTER:
            return
    except OSError:
        return
    with pull_lock:
        if time.time() - last_pull[force] < 60:
            return
        last_pull[force] = time.time()
    secret = tokens().get("tunnel")
    if not secret:
        return
    req = urllib.request.Request(TUNNEL + "/remote-host/tokens", headers={"X-Odin-Tunnel": secret})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            got = json.loads(res.read().decode("utf-8", "replace"))
    except Exception:
        return
    if isinstance(got, dict) and got.get("tunnel"):
        write_json(TOKENS, got)


def pair_path(login):
    return os.path.join(GITHUB_DIR, login + ".json")


def github_logins():
    """The logins this host holds a GitHub token for, and the default one: the host's own sign-ins and the laptop's copies."""
    t = tokens()
    have = set(k.lower() for k in (t.get("githubAccounts") or {}))
    try:
        have.update(f[:-5] for f in os.listdir(GITHUB_DIR) if f.endswith(".json"))
    except OSError:
        pass
    return have, (t.get("githubLogin") or "").lower()


def pick_login(login, owner):
    """The account a request gets: the repo owner's when the host has it, else the one asked for, else the default."""
    have, default = github_logins()
    for candidate in (owner.lower(), login.lower(), default):
        if candidate and candidate in have:
            return candidate
    return default or (sorted(have)[0] if have else "")


def refresh_pair(login, pair):
    """One refresh-token exchange for a host sign-in: the rotated pair, saved, or None when GitHub refused."""
    form = {"client_id": pair.get("client_id") or "", "grant_type": "refresh_token", "refresh_token": pair.get("refresh_token") or ""}
    req = urllib.request.Request(GITHUB_TOKEN_URL, data=urllib.parse.urlencode(form).encode(), headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            got = json.loads(res.read().decode("utf-8", "replace"))
    except Exception:
        return None
    if not isinstance(got, dict) or not got.get("access_token"):
        return None
    fresh = dict(pair, access_token=got["access_token"], refresh_token=got.get("refresh_token") or pair.get("refresh_token"))
    if got.get("expires_in"):
        fresh["expires_at"] = time.time() + float(got["expires_in"])
    try:
        write_json(pair_path(login), fresh)
    except OSError:
        pass
    return fresh


def github_token(login, rejected=None):
    """The current access token for a login: the host's own sign-in, refreshed under the lock when it is
    within GITHUB_MARGIN of expiry or when \`rejected\` is the token GitHub just refused (so a 401 refreshes
    once, not on every retry); else the laptop's copy."""
    now = time.time()
    with github_lock:
        pair = read_json(pair_path(login)) if login else None
        if isinstance(pair, dict) and pair.get("access_token"):
            token = pair["access_token"]
            expires = pair.get("expires_at")
            stale = token == rejected or (expires is not None and float(expires) - now < GITHUB_MARGIN)
            if stale and pair.get("refresh_token"):
                fresh = refresh_pair(login, pair)
                if fresh:
                    return fresh["access_token"]
            if token != rejected and (expires is None or float(expires) > now):
                return token
    t = tokens()
    copies = {k.lower(): v for k, v in (t.get("githubAccounts") or {}).items()}
    if copies.get(login):
        return copies[login]
    if not login or login == (t.get("githubLogin") or "").lower():
        return t.get("github")
    return None


def github_refuses(token):
    """True when GitHub answers 401 for the token; a network failure counts as fine. Cached per token."""
    now = time.time()
    seen = checked.get(token)
    if seen and now - seen[0] < CHECK_EVERY:
        return seen[1]
    req = urllib.request.Request(GITHUB_USER_URL, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10):
            refused = False
    except urllib.error.HTTPError as e:
        refused = e.code == 401
    except Exception:
        refused = False
    for k in [k for k, v in checked.items() if now - v[0] >= CHECK_EVERY]:
        checked.pop(k, None)
    checked[token] = (now, refused)
    return refused


SLACK_API = os.environ.get("ODIN_SLACK_API") or "https://slack.com/api/"


def jira_own():
    """The host's own Jira sign-in as (base, access token), refreshed under the lock when it is within
    JIRA_MARGIN of expiry; None when there is none or Atlassian refused the refresh."""
    with jira_lock:
        pair = read_json(JIRA_FILE)
        if not isinstance(pair, dict) or not pair.get("access_token") or not pair.get("cloud_id"):
            return None
        if float(pair.get("expires_at") or 0) - time.time() < JIRA_MARGIN:
            body = {"grant_type": "refresh_token", "client_id": pair.get("client_id") or "", "client_secret": pair.get("client_secret") or "", "refresh_token": pair.get("refresh_token") or ""}
            req = urllib.request.Request(JIRA_TOKEN_URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Accept": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30) as res:
                    got = json.loads(res.read().decode("utf-8", "replace"))
            except Exception:
                got = None
            if not isinstance(got, dict) or not got.get("access_token"):
                return None
            pair = dict(pair, access_token=got["access_token"], refresh_token=got.get("refresh_token") or pair.get("refresh_token"), expires_at=time.time() + float(got.get("expires_in") or 3600))
            try:
                write_json(JIRA_FILE, pair)
            except OSError:
                pass
        return JIRA_API + pair["cloud_id"] + "/", pair["access_token"]


def notion_own(rejected=None):
    """The host's own Notion access token; None when there is none. With rejected (the token Notion
    just refused), the refresh token is spent once for a new pair, under the lock."""
    with notion_lock:
        pair = read_json(NOTION_FILE)
        if not isinstance(pair, dict) or not pair.get("access_token"):
            return None
        due = pair.get("expires_at") and float(pair["expires_at"]) - time.time() < JIRA_MARGIN
        if (rejected and rejected == pair["access_token"]) or due:
            auth = base64.b64encode(((pair.get("client_id") or "") + ":" + (pair.get("client_secret") or "")).encode()).decode()
            body = {"grant_type": "refresh_token", "refresh_token": pair.get("refresh_token") or ""}
            req = urllib.request.Request(NOTION_TOKEN_URL, data=json.dumps(body).encode(), headers={"Authorization": "Basic " + auth, "Content-Type": "application/json", "Notion-Version": "2022-06-28"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30) as res:
                    got = json.loads(res.read().decode("utf-8", "replace"))
            except Exception:
                got = None
            if not isinstance(got, dict) or not got.get("access_token"):
                return None
            pair = dict(pair, access_token=got["access_token"], refresh_token=got.get("refresh_token") or pair.get("refresh_token"))
            pair["expires_at"] = time.time() + float(got["expires_in"]) if got.get("expires_in") else None
            try:
                write_json(NOTION_FILE, pair)
            except OSError:
                pass
        return pair["access_token"]


def service_base(name, t):
    if name == "slack" and t.get("slack"):
        return SLACK_API, {"Authorization": "Bearer " + t["slack"]}
    # The file is there only while the Notion connector is on (put_tokens drops it otherwise).
    notion = (notion_own() or t.get("notion")) if name == "notion" else None
    if notion:
        return NOTION_API, {"Authorization": "Bearer " + notion, "Notion-Version": "2022-06-28"}
    if name == "clickup" and t.get("clickup"):
        return "https://api.clickup.com/api/v2/", {"Authorization": t["clickup"]}
    if name == "github" and t.get("githubConnector"):
        token = github_token(pick_login("", ""))
        if token:
            return "https://api.github.com/", {"Authorization": "Bearer " + token}
    # The file is there only while the Jira connector is on (put_tokens drops it otherwise).
    own = jira_own() if name == "jira" else None
    if own:
        return own[0], {"Authorization": "Bearer " + own[1]}
    if name == "jira" and t.get("jira") and t.get("jiraBase"):
        return t["jiraBase"].rstrip("/") + "/", {"Authorization": "Bearer " + t["jira"]}
    return None, None


def send(url, headers, body, method):
    req = urllib.request.Request(url, data=body.encode() if body else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def call_service(form):
    fresh_from_laptop()
    name = form.get("service", "")
    base, headers = service_base(name, tokens())
    if not base:
        return 200, name + " isn't on this host. Turn it on in Odin: Settings > Remote > Connectors on the host.\\n"
    url = urllib.parse.urljoin(base, form.get("path", "").lstrip("/"))
    if urllib.parse.urlsplit(url).netloc != urllib.parse.urlsplit(base).netloc:
        return 200, "path must be relative to " + base + "\\n"
    body = form.get("body") or None
    method = (form.get("method") or "GET").upper()
    headers = dict(headers, Accept="application/json", **({"Content-Type": "application/json; charset=utf-8"} if body else {}))
    try:
        status, text = send(url, headers, body, method)
        if name == "github" and status == 401:
            # GitHub refused the token: the host's own sign-in refreshes once, and the call goes again.
            token = github_token(pick_login("", ""), rejected=headers["Authorization"][7:])
            if token and "Bearer " + token != headers["Authorization"]:
                status, text = send(url, dict(headers, Authorization="Bearer " + token), body, method)
        if name == "notion" and status == 401:
            # Notion refused the host's own token: it refreshes once, and the call goes again.
            token = notion_own(rejected=headers["Authorization"][7:])
            if token:
                status, text = send(url, dict(headers, Authorization="Bearer " + token), body, method)
    except Exception as e:
        return 200, "Failed: " + str(e) + "\\n"
    return 200, "HTTP " + str(status) + "\\n" + text + "\\n"


def laptop_up():
    """Odin on the laptop answers its tunnel within a few seconds. Asleep, the tunnel hangs instead."""
    req = urllib.request.Request(TUNNEL + "/health", headers={"X-Odin-Tunnel": tokens().get("tunnel") or ""})
    try:
        with urllib.request.urlopen(req, timeout=5):
            return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


SLACK_LINK = re.compile(r"/archives/([\\w-]+)/p(\\d{10})(\\d{6})")


def slack_get(method, params, token):
    """One Slack Web API read: (the answer, None), or (None, why)."""
    url = SLACK_API + method + "?" + urllib.parse.urlencode(params)
    status, text = send(url, {"Authorization": "Bearer " + token}, None, "GET")
    if status == 429:
        return None, "Slack is rate-limiting " + method + ", try again in a minute"
    try:
        got = json.loads(text)
    except Exception:
        return None, "Slack " + method + ": HTTP " + str(status)
    if not got.get("ok"):
        return None, "Slack " + method + ": " + str(got.get("error"))
    return got, None


def read_slack(link, token):
    """A Slack thread as plain lines, read on the host while the laptop sleeps: what /read on the laptop
    gives, without its voice learning. The thread's messages, or the linked one alone when Slack holds
    conversations.replies back (an app outside its Marketplace gets one call a minute)."""
    m = SLACK_LINK.search(link)
    if not m:
        return 502, "Odin couldn't read that link on the host: not a Slack message link.\\n"
    channel, ts = m.group(1), m.group(2) + "." + m.group(3)
    parent = {k: v[-1] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(link).query).items()}.get("thread_ts") or ts
    me, _ = slack_get("auth.test", {}, token)
    me = (me or {}).get("user_id")
    thread, why = slack_get("conversations.replies", {"channel": channel, "ts": parent, "limit": "200"}, token)
    messages = (thread or {}).get("messages") or []
    note = ""
    if not messages:
        one, why2 = slack_get("reactions.get", {"channel": channel, "timestamp": ts, "full": "true"}, token)
        if not one or not one.get("message"):
            return 502, "Odin on the laptop is asleep, and the host couldn't read the thread: " + (why or why2 or "no messages") + ".\\n"
        messages = [one["message"]]
        note = "(Only the linked message: " + (why or "the thread wasn't readable") + ".)\\n"
    names = {}

    def name(user):
        if not user:
            return "someone"
        if user == me:
            return "ME"
        if user not in names:
            info, _ = slack_get("users.info", {"user": user}, token)
            profile = ((info or {}).get("user") or {}).get("profile") or {}
            names[user] = profile.get("real_name") or profile.get("display_name") or user
        return names[user]

    lines = ["(Read on the host: Odin on the laptop is asleep.)"]
    for msg in messages:
        text = re.sub(r"\\s+", " ", msg.get("text") or "")
        text = re.sub(r"<@(U\\w+)>", lambda u: "@" + name(u.group(1)), text)
        mark = " [LINKED]" if msg.get("ts") == ts else ""
        lines.append(name(msg.get("user")) + mark + ": " + text)
        for f in msg.get("files") or []:
            if f.get("url_private"):
                lines.append("  [file " + (f.get("name") or "") + "] (a download needs the laptop awake) " + f["url_private"])
    return 200, note + "\\n".join(lines) + "\\n"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, text, kind="text/plain; charset=utf-8"):
        data = text.encode() if isinstance(text, str) else text
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def token(self, query, raw, uid):
        """GET /token?service=github[&login=][&owner=]: the current token for the session user's account,
        answered to that user alone. A POST carries the token GitHub just refused."""
        if uid != OWNER and not (uid is None and sys.platform != "linux"):
            return self.reply(403, "This is another user's Odin.\\n")
        q = {k: v[-1] for k, v in urllib.parse.parse_qs(query).items()}
        if q.get("service") != "github":
            return self.reply(404, "Only service=github has a token here.\\n")
        login, owner = q.get("login", ""), q.get("owner", "")
        if (login and not LOGIN.fullmatch(login)) or (owner and not LOGIN.fullmatch(owner)):
            return self.reply(400, "Not a GitHub login.\\n")
        rejected = raw.decode("utf-8", "replace").strip() if self.command == "POST" else ""
        fresh_from_laptop()
        token = github_token(pick_login(login, owner), rejected or None)
        if token and (token == rejected or github_refuses(token)):
            # Dead: the laptop's current copy (it checks its own and falls back to gh's), and the host's
            # own sign-in refreshed once more.
            fresh_from_laptop(force=True)
            token = github_token(pick_login(login, owner), token) or token
        if not token:
            return self.reply(404, "No GitHub token for this account on the host. Odin: Settings > Sessions > Remote host > GitHub accounts on the host.\\n")
        return self.reply(200, token)

    def owner_only(self, uid):
        """Writes come from the user this service belongs to, never another (None: off Linux, tests)."""
        return uid == OWNER or (uid is None and sys.platform != "linux")

    def put_tokens(self, raw, uid):
        """POST /tokens: {"tokens": {...}, "githubKeep": [logins]} from the user's own Odin. The tokens
        file is replaced whole; the host's own GitHub sign-ins for logins not kept are dropped."""
        if not self.owner_only(uid):
            return self.reply(403, "This is another user's Odin.\\n")
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = None
        if not isinstance(body, dict) or not isinstance(body.get("tokens"), dict):
            return self.reply(400, "Expected {\\"tokens\\": {...}}.\\n")
        keep = set(k.lower() for k in (body.get("githubKeep") or []) if isinstance(k, str))
        for keep_key, path, lock in (("jiraKeep", JIRA_FILE, jira_lock), ("notionKeep", NOTION_FILE, notion_lock)):
            if not body.get(keep_key):
                with lock:
                    try:
                        os.remove(path)
                    except OSError:
                        pass
        with github_lock:
            write_json(TOKENS, body["tokens"])
            try:
                for f in os.listdir(GITHUB_DIR):
                    if f.endswith(".json") and f[:-5] not in keep:
                        os.remove(os.path.join(GITHUB_DIR, f))
            except OSError:
                pass
        return self.reply(200, "ok\\n")

    def put_github_pair(self, query, raw, uid):
        """POST /github-pair?login=: the host's own GitHub sign-in for that login, from the device flow."""
        if not self.owner_only(uid):
            return self.reply(403, "This is another user's Odin.\\n")
        login = {k: v[-1] for k, v in urllib.parse.parse_qs(query).items()}.get("login", "")
        if not LOGIN.fullmatch(login):
            return self.reply(400, "Not a GitHub login.\\n")
        try:
            pair = json.loads(raw.decode("utf-8"))
        except Exception:
            pair = None
        if not isinstance(pair, dict) or not pair.get("access_token"):
            return self.reply(400, "Expected a sign-in with an access_token.\\n")
        with github_lock:
            os.makedirs(GITHUB_DIR, mode=0o700, exist_ok=True)
            write_json(pair_path(login.lower()), pair)
        return self.reply(200, "ok\\n")

    def put_own_pair(self, raw, uid, path, lock, needs):
        """POST /jira-pair or /notion-pair: the host's own sign-in, from a consent flow run for the host."""
        if not self.owner_only(uid):
            return self.reply(403, "This is another user's Odin.\\n")
        try:
            pair = json.loads(raw.decode("utf-8"))
        except Exception:
            pair = None
        if not isinstance(pair, dict) or not all(pair.get(k) for k in needs):
            return self.reply(400, "Expected a sign-in with " + ", ".join(needs) + ".\\n")
        with lock:
            write_json(path, pair)
        return self.reply(200, "ok\\n")

    def handle_any(self):
        if self.headers.get("Origin"):
            return self.reply(403, "Not from a browser.\\n")
        uid = peer_uid(self.client_address[1])
        if uid not in (None, OWNER):
            return self.reply(403, "This is another user's Odin.\\n")
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        path, _, query = self.path.partition("?")
        if path == "/health":
            return self.reply(200, '{"status":"ok","host":true}', "application/json")
        if path == "/token" and self.command in ("GET", "POST"):
            return self.token(query, raw, uid)
        if path == "/tokens" and self.command == "POST":
            return self.put_tokens(raw, uid)
        if path == "/github-pair" and self.command == "POST":
            return self.put_github_pair(query, raw, uid)
        if path == "/jira-pair" and self.command == "POST":
            return self.put_own_pair(raw, uid, JIRA_FILE, jira_lock, ("access_token", "refresh_token", "cloud_id"))
        if path == "/notion-pair" and self.command == "POST":
            return self.put_own_pair(raw, uid, NOTION_FILE, notion_lock, ("access_token", "refresh_token"))
        if self.command == "POST" and path == "/odin":
            form = {k: v[-1] for k, v in urllib.parse.parse_qs(raw.decode("utf-8", "replace")).items()}
            if form.get("action") == "service":
                return self.reply(*call_service(form))
        if self.command == "GET" and path == "/read":
            # A Slack link reads on the host while the laptop sleeps, rather than hanging on the tunnel.
            link = {k: v[-1] for k, v in urllib.parse.parse_qs(query).items()}.get("url", "")
            token = tokens().get("slack")
            if token and SLACK_LINK.search(link) and not laptop_up():
                return self.reply(*read_slack(link, token))
        headers ={k: v for k, v in self.headers.items() if k.lower() in ("content-type", "accept")}
        headers["X-Odin-Tunnel"] = tokens().get("tunnel") or ""
        req = urllib.request.Request(TUNNEL + self.path, data=raw or None, method=self.command, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return self.reply(res.status, res.read(), res.headers.get("Content-Type", "text/plain"))
        except urllib.error.HTTPError as e:
            return self.reply(e.code, e.read(), e.headers.get("Content-Type", "text/plain"))
        except Exception:
            return self.reply(503, "Odin on the laptop can't be reached now - it is asleep, closed or offline. Connector calls (action=service) still work on this host.\\n")

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`;

/**
 * Root's part of setup, for one host user: the `odin` user, the service and
 * its systemd unit. Skipped without systemd; sessions then reach the laptop
 * directly. Replaces the one service all users shared before.
 */
export function hostServiceInstallScript(user: string): string {
	if (!/^[a-z_][a-z0-9_-]*$/.test(user))
		throw new Error(`Not a Linux user name: ${user}`);
	const unit = `odin-host-${user}`;
	return [
		"if command -v systemctl >/dev/null; then",
		"  id odin >/dev/null 2>&1 || useradd --system --home-dir /var/lib/odin --create-home --shell /usr/sbin/nologin odin",
		`  install -d -m 700 -o odin -g odin /var/lib/odin /var/lib/odin/${user} ${hostGithubDir(user)}`,
		"  install -d -m 755 /usr/local/lib/odin",
		`  printf %s '${Buffer.from(HOST_SERVICE_PY).toString("base64")}' | base64 -d > /usr/local/lib/odin/host-service.py`,
		"  if [ -f /etc/systemd/system/odin-host.service ]; then systemctl disable --now odin-host >/dev/null 2>&1; rm -f /etc/systemd/system/odin-host.service /var/lib/odin/tokens.json; fi",
		`  printf '%s\\n' '[Unit]' 'Description=Odin host service for ${user}' 'After=network-online.target' '[Service]' 'User=odin' "ExecStart=/usr/bin/python3 /usr/local/lib/odin/host-service.py ${user} ${hostTokensFile(user)} ${hostPortSh(user)}" 'Restart=always' 'RestartSec=2' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/${unit}.service`,
		// Every user's service runs the one script: all of them restart onto a new one,
		// or theirs would keep the old one - which, for one, sent no tunnel secret.
		`  systemctl daemon-reload && systemctl enable ${unit} >/dev/null 2>&1 && systemctl restart ${unit} 'odin-host-*.service'`,
		"fi",
	].join("\n");
}

/** The connectors a user can keep on the host. Gmail never goes there. */
export const HOST_CONNECTORS = [
	"slack",
	"notion",
	"clickup",
	"jira",
	"github",
] as const;
export type HostConnector = (typeof HOST_CONNECTORS)[number];
