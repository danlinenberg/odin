/**
 * Odin's service on a remote host. Sessions there call Odin at
 * 127.0.0.1:$ODIN_PORT exactly as they do on the laptop; this answers.
 *
 * - `action=service` (Slack, Notion, ClickUp, Jira, GitHub API calls) is
 *   answered here, with the tokens the user chose to keep on the host. So
 *   connector calls work with the laptop closed.
 * - Everything else (board actions, hooks, file reads) goes on to Odin on the
 *   laptop through the session helper's tunnel, and says plainly when the
 *   laptop is asleep.
 *
 * It runs as its own `odin` user, which alone can read the tokens (0600), so
 * a session can use a connector but never read or copy its token.
 *
 * Python 3 standard library only: every common Linux image has it, so the
 * host needs nothing installed.
 */

/** Where sessions on the host reach Odin. */
export const HOST_SERVICE_PORT = 47187;
/** Where the session helper's tunnel reaches Odin on the laptop. */
export const LAPTOP_TUNNEL_PORT = 47189;
export const HOST_TOKENS_FILE = "/var/lib/odin/tokens.json";

export const HOST_SERVICE_PY = `import json, os, sys, urllib.request, urllib.parse, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKENS = "${HOST_TOKENS_FILE}"
TUNNEL = "http://127.0.0.1:${LAPTOP_TUNNEL_PORT}"


def tokens():
    try:
        with open(TOKENS) as f:
            return json.load(f)
    except Exception:
        return {}


def service_base(name, t):
    if name == "slack" and t.get("slack"):
        return "https://slack.com/api/", {"Authorization": "Bearer " + t["slack"]}
    if name == "notion" and t.get("notion"):
        return "https://api.notion.com/v1/", {"Authorization": "Bearer " + t["notion"], "Notion-Version": "2022-06-28"}
    if name == "clickup" and t.get("clickup"):
        return "https://api.clickup.com/api/v2/", {"Authorization": t["clickup"]}
    if name == "github" and t.get("github"):
        return "https://api.github.com/", {"Authorization": "Bearer " + t["github"]}
    if name == "jira" and t.get("jira") and t.get("jiraBase"):
        return t["jiraBase"].rstrip("/") + "/", {"Authorization": "Bearer " + t["jira"]}
    return None, None


def call_service(form):
    name = form.get("service", "")
    base, headers = service_base(name, tokens())
    if not base:
        return 200, name + " isn't on this host. Turn it on in Odin: Settings > Sessions > Remote host > Connectors on the host.\\n"
    url = urllib.parse.urljoin(base, form.get("path", "").lstrip("/"))
    if urllib.parse.urlsplit(url).netloc != urllib.parse.urlsplit(base).netloc:
        return 200, "path must be relative to " + base + "\\n"
    body = form.get("body") or None
    headers = dict(headers, Accept="application/json", **({"Content-Type": "application/json; charset=utf-8"} if body else {}))
    req = urllib.request.Request(url, data=body.encode() if body else None, headers=headers, method=(form.get("method") or "GET").upper())
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            status, text = res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode("utf-8", "replace")
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

    def handle_any(self):
        if self.headers.get("Origin"):
            return self.reply(403, "Not from a browser.\\n")
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if self.path == "/health":
            return self.reply(200, '{"status":"ok","host":true}', "application/json")
        if self.command == "POST" and self.path.split("?")[0] == "/odin":
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


ThreadingHTTPServer(("127.0.0.1", ${HOST_SERVICE_PORT}), Handler).serve_forever()
`;

/**
 * Root's part of setup: the `odin` user, the service and its systemd unit.
 * Skipped without systemd; sessions then reach the laptop directly.
 */
export const hostServiceInstallScript = [
	"if command -v systemctl >/dev/null; then",
	"  id odin >/dev/null 2>&1 || useradd --system --home-dir /var/lib/odin --create-home --shell /usr/sbin/nologin odin",
	"  install -d -m 700 -o odin -g odin /var/lib/odin",
	"  install -d -m 755 /usr/local/lib/odin",
	`  printf %s '${Buffer.from(HOST_SERVICE_PY).toString("base64")}' | base64 -d > /usr/local/lib/odin/host-service.py`,
	"  printf '%s\\n' '[Unit]' 'Description=Odin host service' 'After=network-online.target' '[Service]' 'User=odin' 'ExecStart=/usr/bin/python3 /usr/local/lib/odin/host-service.py' 'Restart=always' 'RestartSec=2' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/odin-host.service",
	"  systemctl daemon-reload && systemctl enable odin-host >/dev/null 2>&1 && systemctl restart odin-host",
	"fi",
].join("\n");

/** The connectors a user can keep on the host. Gmail never goes there. */
export const HOST_CONNECTORS = [
	"slack",
	"notion",
	"clickup",
	"jira",
	"github",
] as const;
export type HostConnector = (typeof HOST_CONNECTORS)[number];
