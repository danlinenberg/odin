/**
 * Odin's service on a remote host. Sessions there call Odin at
 * 127.0.0.1:$ODIN_PORT exactly as they do on the laptop; this answers.
 *
 * - `action=service` (Slack, Notion, ClickUp, Jira, GitHub API calls) is
 *   answered here, with the tokens the user chose to keep on the host. So
 *   connector calls work with the laptop closed.
 * - `GET /token?service=github` is the GitHub token a session's git and gh
 *   sign in with, read at each use (session.ts), so it never goes stale: the
 *   host's own sign-in for the account, refreshed here before it expires or
 *   when GitHub refuses it, else the laptop's latest copy.
 * - Everything else (board actions, hooks, file reads) goes on to Odin on the
 *   laptop through the session helper's tunnel, and says plainly when the
 *   laptop is asleep.
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
}

/** argv: the host user it serves, their tokens file, its port (the tunnel's is next). */
export const HOST_SERVICE_PY = `import json, os, pwd, re, sys, threading, time, urllib.request, urllib.parse, urllib.error
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
LOGIN = re.compile(r"[A-Za-z0-9-]{1,39}")
github_lock = threading.Lock()


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
    """Whole, then into place: a reader never sees half a file."""
    with open(path + ".new", "w") as f:
        json.dump(data, f)
    os.replace(path + ".new", path)


def tokens():
    t = read_json(TOKENS)
    return t if isinstance(t, dict) else {}


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


def service_base(name, t):
    if name == "slack" and t.get("slack"):
        return "https://slack.com/api/", {"Authorization": "Bearer " + t["slack"]}
    if name == "notion" and t.get("notion"):
        return "https://api.notion.com/v1/", {"Authorization": "Bearer " + t["notion"], "Notion-Version": "2022-06-28"}
    if name == "clickup" and t.get("clickup"):
        return "https://api.clickup.com/api/v2/", {"Authorization": t["clickup"]}
    if name == "github" and t.get("githubConnector"):
        token = github_token(pick_login("", ""))
        if token:
            return "https://api.github.com/", {"Authorization": "Bearer " + token}
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
    except Exception as e:
        return 200, "Failed: " + str(e) + "\\n"
    return 200, "HTTP " + str(status) + "\\n" + text + "\\n"


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
        token = github_token(pick_login(login, owner), rejected or None)
        if not token:
            return self.reply(404, "No GitHub token for this account on the host. Odin: Settings > Sessions > Remote host > GitHub accounts on the host.\\n")
        return self.reply(200, token)

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
        if self.command == "POST" and path == "/odin":
            form = {k: v[-1] for k, v in urllib.parse.parse_qs(raw.decode("utf-8", "replace")).items()}
            if form.get("action") == "service":
                return self.reply(*call_service(form))
        req = urllib.request.Request(TUNNEL + self.path, data=raw or None, method=self.command, headers={k: v for k, v in self.headers.items() if k.lower() in ("content-type", "accept")})
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
		`  systemctl daemon-reload && systemctl enable ${unit} >/dev/null 2>&1 && systemctl restart ${unit}`,
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
