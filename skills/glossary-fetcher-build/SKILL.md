---
name: glossary-fetcher-build
description: Build a safe local program for pi-glossary to fetch, or fetch and sanitize, a private glossary include (SSO or Google IAP hosts, internal APIs, or a source to filter before it reaches the agent). Use when no existing CLI fits a glossary fetcher, or the user wants to clean up a remote glossary.
---

# Build a safe glossary fetcher

A fetcher is a program that pi-glossary runs for URL includes matched in `~/.pi/agent/glossary-fetchers.json` (set that up with the **glossary-fetcher-setup** skill). It gets the URL (or parts of it) as arguments and prints a glossary on stdout. Write one when no existing CLI does the job: a host behind SSO or Google IAP, an internal API, or a source whose content you want to filter before the agent sees it.

The program runs with the user's credentials on a URL taken from a glossary file. Build it as if the URL were hostile.

## Contract

- **Input**: arguments only, as listed in the fetcher's `command`. No stdin.
- **Output**: the glossary on stdout, as a JSON array or JSONL, at most 1 MB. Nothing else on stdout: logs and errors go to stderr.
- **Exit code**: 0 on success. Anything else fails the include; the first line of stderr is shown to the user, so make it short and useful ("not signed in: run gcloud auth login").
- **Time**: finish within the fetcher's `timeoutMs` (default 10 s).
- Runs from the home directory, without a shell, with the user's environment.

## Rules

1. **Validate the URL again inside the program**, with the same strict pattern as the config (exact `https` scheme, exact host, narrow path). The config regex can be loosened later by mistake; the program is the last guard before the credentials. Exit non-zero on anything else.
2. **Never pass the URL through a shell**: no `eval`, no `sh -c "curl $url"`, no backticks, no `os.system`. In shell scripts, always quote: `"$url"`. Prefer Python or Node with an argument list (`subprocess.run([...])`, `execFile`).
3. **Put `--` before positional URL arguments** to other tools (`curl -- "$url"`, `gh ... -- "$id"`) where the tool supports it, so a value can never become an option.
4. **Send credentials only to the validated host.** Disable redirects or check where they land: `curl` without `-L`, or `--max-redirs 0`. A redirect to another host must not carry the token.
5. **Never print a token**, not on stdout (it would end up in the agent's context) and not on stderr (it is shown to the user).
6. **Bound everything**: a request timeout shorter than the fetcher's, and a size cap (`curl --max-filesize 1048576`).
7. **Fail closed**: if the response is HTML (a login page), not JSON, or the status is not 2xx, exit non-zero instead of printing it.
8. **Keep it small and readable**, in a file the user owns (`~/bin/…`, mode `0700`), so they can review it.

## Sanitizing

A fetcher can also clean what it fetched before the agent sees it. Entries from a fetcher are still treated as remote (marked as not written by the user, no `{{shell}}` templates), but a sanitizer can remove what is risky:

- Keep only known fields: `term`, `definition`, `aliases`. Drop `pattern` and `flags` (a bad regex can match every prompt or freeze the editor) and drop `include` (it would make pi-glossary fetch further URLs the source chose).
- Cap lengths: term ≤ 100 characters, each alias ≤ 100, definition ≤ 4000, at most a few hundred entries.
- Drop `{{` from definitions if you don't want even the disabled placeholder text.

pi-glossary already strips terminal control characters from everything it loads.

With `jq`:

```bash
jq -c '[ .[]
  | select(type == "object" and (.term|type) == "string" and (.definition|type) == "string")
  | {term: .term[0:100], definition: .definition[0:4000],
     aliases: ((.aliases // []) | map(select(type == "string") | .[0:100]))}
] | .[0:500]'
```

## Example: Google IAP host (bash)

Fetches `https://glossary.example.com/<name>.json` behind Identity-Aware Proxy with the user's `gcloud` login, then sanitizes. Replace the host and the IAP OAuth client id.

```bash
#!/usr/bin/env bash
# ~/bin/iap-glossary-fetch URL
set -euo pipefail

url="${1:-}"
# Same rule as the fetcher's "match": exact host, one plain file name, .json.
if [[ ! "$url" =~ ^https://glossary\.example\.com/[a-z0-9][a-z0-9-]{0,63}\.json$ ]]; then
  echo "refusing URL: $url" >&2
  exit 2
fi

audience="1234567890-abc.apps.googleusercontent.com"   # IAP OAuth client id
if ! token="$(gcloud auth print-identity-token --audiences="$audience" 2>/dev/null)"; then
  echo "no IAP token: run gcloud auth login" >&2
  exit 3
fi

body="$(curl --silent --show-error --fail --proto '=https' --max-redirs 0 \
  --max-time 8 --max-filesize 1048576 \
  -H "Authorization: Bearer ${token}" -- "$url")" || { echo "fetch failed for $url" >&2; exit 4; }

# Not JSON (a login page, an error page): fail instead of passing it on.
printf '%s' "$body" | jq -c '[ .[]
  | select(type == "object" and (.term|type) == "string" and (.definition|type) == "string")
  | {term: .term[0:100], definition: .definition[0:4000],
     aliases: ((.aliases // []) | map(select(type == "string") | .[0:100]))}
] | .[0:500]' || { echo "response is not a glossary" >&2; exit 5; }
```

Config for it:

```json
{
  "name": "team glossary (IAP)",
  "match": "^https://glossary\\.example\\.com/(?<name>[a-z0-9][a-z0-9-]{0,63})\\.json$",
  "command": ["~/bin/iap-glossary-fetch", "{url}"],
  "timeoutMs": 15000
}
```

Some IAP setups accept the user's access token instead (`gcloud auth print-access-token`), or need a service account (`--impersonate-service-account`). Check with the user which one their host uses.

## Example: private gist with `gh` (no script)

`gh` already holds the credentials, so no script is needed. Pass only the validated id:

```json
{
  "name": "my gists",
  "match": "^https://gist\\.github\\.com/ruliana/(?<id>[0-9a-f]{20,32})$",
  "command": ["gh", "gist", "view", "{id}", "--raw", "--filename", "glossary.json"]
}
```

## Testing

1. `chmod 700` the script and run it by hand with a good URL: it prints only JSON.
2. Run it with bad URLs (other host, `http://`, `..`, a query string, a value starting with `-`): each exits non-zero and prints nothing on stdout.
3. Sign out or break the token: it exits non-zero with a clear first stderr line.
4. Add the fetcher to `~/.pi/agent/glossary-fetchers.json`, run `/glossary reload`, and check that the terms show up in `/glossary`.
