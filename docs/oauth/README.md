# One-click sign-in for Odin's connections

One-time setup so anyone using Odin can connect Slack, GitHub, Notion and Jira
with two clicks instead of minting tokens by hand.

Signing in is the **only** way into a connection: Odin reads no credential from
the environment and takes no pasted token. A shell variable is ambient and
would sign every profile into the same account, which is the one thing profiles
exist to stop. So a build without the apps below has no way to connect at all —
this setup is not optional.

Each provider needs a different shape of setup:

| Provider | Flow | Needs a redirect page? |
|---|---|---|
| Slack | OAuth, user scopes | yes — `slack.html` |
| Notion | OAuth, page picker | yes — `notion.html` |
| GitHub | Device flow | no — code + browser, no secret |
| Jira | OAuth 2.0 3LO | yes — `jira.html` |

Slack allows neither PKCE nor a non-HTTPS redirect URL, so a desktop app can't
receive the callback directly. `slack.html` in this folder is the whole
workaround: a static page that forwards the auth code into
`odin://oauth/slack`, where the main process exchanges it for a user
token (`src/main/lib/slack-oauth.ts`).

## 1. Publish the redirect page

Put `slack.html` on any static HTTPS host — GitHub Pages, Cloudflare Pages,
Vercel, an S3 bucket. It never changes, so this is a one-off. Note the URL, for
example `https://<owner>.github.io/odin-auth/slack.html`.

## 2. Create the Slack app

[api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From a
manifest*, then paste:

```json
{
  "display_information": { "name": "Odin" },
  "oauth_config": {
    "redirect_urls": ["https://REPLACE-ME/slack.html"],
    "scopes": {
      "user": [
        "reactions:read",
        "users:read",
        "channels:read",
        "groups:read",
        "im:read",
        "mpim:read"
      ]
    }
  },
  "settings": {
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

Everything sits under `user` — no bot user, so nothing has to be invited to
channels, and the app reads exactly what the signed-in person can already see.
Leave `token_rotation_enabled` off: rotating tokens expire every 12 hours and
would need a refresh loop the app doesn't have.

## 3. Point Odin at the app

In `~/.config/odin.json` (or the matching env vars, which win):

```json
{
  "slackClientId": "…",
  "slackClientSecret": "…",
  "slackRedirectUrl": "https://REPLACE-ME/slack.html"
}
```

`ODIN_SLACK_CLIENT_ID`, `ODIN_SLACK_CLIENT_SECRET`, `ODIN_SLACK_REDIRECT_URL`.

The redirect URL must match what's registered on the Slack app character for
character — Slack compares it on both the authorize call and the exchange.

Settings → Connections then shows **Sign in with Slack** on the Slack row. Until
all three values are set, that row falls back to pasting a token, which keeps
working either way.

## Two ways to supply the credentials

**Per machine** — `~/.config/odin.json`, as above. Right for one person, but it
means everyone who uses Odin needs both the client ID and the secret, which is
more friction than pasting a single token. Use it while setting things up.

**Baked into the build** — pass the same three values as environment variables
to the build, and they are compiled into the main-process bundle:

```bash
ODIN_SLACK_CLIENT_ID=... \
ODIN_SLACK_CLIENT_SECRET=... \
ODIN_SLACK_REDIRECT_URL=https://REPLACE-ME/slack.html \
  bun run build
```

Anyone running that build gets *Sign in with Slack* with nothing to configure —
two clicks, no credentials in their hands. This is what makes the flow actually
frictionless, and it is the only option for a packaged app: one launched from
Finder has no shell environment, so runtime env vars aren't available to it.

A per-machine value in `odin.json` still overrides a baked-in one, so a build
can be pointed at a different Slack app without rebuilding.

The substitution happens in `electron.vite.config.ts` under deliberately
separate `ODIN_SLACK_*_BAKED` keys. Bundlers replace only literal
`process.env.FOO` text — never a dynamic `process.env[name]` lookup — so the
baked values are read through their own statically-spelled accessor, and
replacing the plain names would have frozen them into literals and stopped a
runtime env var from ever winning.

Only the main-process bundle receives them; the renderer and preload bundles
never see the client secret.

## What ships with the app

The client secret. Slack requires it at the exchange and offers no PKCE
alternative, so a desktop app has no way to avoid holding one. The practical
exposure is that someone who extracts it could run a consent screen branded
"Odin"; the `state` check means they can't inject a token into anyone's install.
If that trade ever stops being acceptable, move the exchange into a serverless
function on the same host and have it return the token to the deep link — the
app-side flow doesn't change.

## GitHub

The device flow needs only a client id, and no secret at all — that's why it
suits a desktop app. Create an OAuth app with **Enable Device Flow** checked
and pass its client id to the build:

```bash
ODIN_GITHUB_CLIENT_ID=Iv1.… bun run build
```

No redirect page is involved: the app shows a code, you approve it on
github.com, and Odin polls until it's authorised.

## Notion

Create a **public** integration at
[notion.so/my-integrations](https://www.notion.so/my-integrations), set its
redirect URI to your published `notion.html`, and pass all three values:

```bash
ODIN_NOTION_CLIENT_ID=... \
ODIN_NOTION_CLIENT_SECRET=... \
ODIN_NOTION_REDIRECT_URL=https://REPLACE-ME/notion.html \
  bun run build
```

Notion's consent screen is a **page picker**, so the person chooses which
databases Odin may read during the flow rather than pasting a database id
afterwards.

Unlike Slack, Notion's access tokens expire. The refresh token is stored
alongside them and spent on demand (`src/main/lib/notion-token.ts`), which is
also why that module is kept free of electron — the Notion tRPC router imports
it, and a static electron import there breaks every consumer.

## Jira

Create an OAuth 2.0 (3LO) app at
[developer.atlassian.com](https://developer.atlassian.com/console/myapps/),
add the Jira API with scopes `read:jira-work` and `read:jira-user`, set its
callback URL to your published `jira.html`, then:

```bash
ODIN_JIRA_CLIENT_ID=... \
ODIN_JIRA_CLIENT_SECRET=... \
ODIN_JIRA_REDIRECT_URL=https://REPLACE-ME/jira.html \
  bun run build
```

Three things about 3LO differ from the others, and each shapes the code:

`offline_access` is requested alongside the read scopes. Without it no refresh
token comes back and the connection dies within the hour with nothing to renew
it — so the exchange treats a missing refresh token as a failure rather than a
success.

**Refresh tokens rotate.** Every refresh issues a new one and invalidates the
old, so the stored pair is replaced together; keeping a stale refresh token
breaks the *next* renewal, not the current one, which makes it a nasty failure
to debug.

**Request paths don't use your site host.** OAuth calls go to
`api.atlassian.com/ex/jira/{cloudId}`, where the cloudId comes from
`accessible-resources`. It's resolved once per connection and cached. Browse
links still point at the site, so a row you click opens the real Jira.

Atlassian API tokens are gone. A config file left over from before sign-in
existed still has `jiraBaseUrl`/`jiraEmail`/`jiraToken` in it; reading the file
drops them, so the next write takes the token out of it and Jira reconnects the
way everything else does.


## Distributing Odin

The credentials above are compiled into the build, which is right for your own
machine and for colleagues. A public release is different: anyone with the
bundle can `grep` the secret out, because Slack and Notion both require one at
the exchange and neither offers PKCE, so the app has nowhere to hide it.

That is not solved here, deliberately — keeping a secret out of a build means
running something that holds it, and a service is more than this is worth.
Two other things block a public release anyway: builds are signed with a
self-signed certificate and not notarized, so a downloaded app is quarantined
and Gatekeeper refuses it; and Odin is private — LICENSE.md grants nothing to
anyone the copyright holder has not handed a copy to.

GitHub is the exception: its device flow has no client secret at all, so that
client id is safe to ship as-is.
