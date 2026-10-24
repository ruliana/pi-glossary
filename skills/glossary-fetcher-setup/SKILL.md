---
name: glossary-fetcher-setup
description: Set up how pi-glossary fetches a private or login-protected glossary include (a private gist, a repo, a host behind SSO or Google IAP) by mapping URL regexes to a local command in ~/.pi/agent/glossary-fetchers.json. Use when an include fails with a login page, 401/403/404, or the user wants to fetch a URL include with gh, gcloud, or their own script.
---

# Set up a glossary fetcher

A URL include like `{ "include": "https://..." }` is normally fetched with a plain HTTP GET. A **fetcher** tells pi-glossary to run a local program instead for the URLs a regex accepts, and to read the glossary from that program's stdout. Use it for content a plain GET can't reach: private gists (`gh`), hosts behind SSO or Google IAP (a script that gets a token), or a source you want to clean up before it reaches the agent (a sanitizer).

Fetchers live only in `~/.pi/agent/glossary-fetchers.json`. A project's `.pi/` folder and remote glossaries cannot add or change one, so only the machine's owner decides which programs run. Keep it that way: never suggest putting fetcher config in a project or reading it from a URL.

## Steps

1. **Find the failing include.** Run `/glossary reload` and read the warning, or look at the `include` entries in `~/.pi/agent/glossary.json` and `.pi/glossary.json`. Note the exact URL string as written, and which file it is in (global, project, or inside another remote glossary).
2. **Pick the tool.** Prefer an existing, well-known CLI that already holds the user's credentials:
   - Private gist: `gh gist view <id> --raw --filename <file>`, or `gh api` for a repo file.
   - Private GitHub repo file: `gh api -H "Accept: application/vnd.github.raw" /repos/<owner>/<repo>/contents/<path>?ref=<ref>`.
   - Anything that needs a custom login, a token exchange, or cleanup: write a small script with the **glossary-fetcher-build** skill.
   Run the command by hand first and check that it prints the glossary JSON (or JSONL) and nothing else.
3. **Write a safe URL regex** (rules below). Capture only the parts the command needs, with named groups.
4. **Add the fetcher** to `~/.pi/agent/glossary-fetchers.json` (create it as a JSON array if it does not exist; read it first and keep existing entries).
5. **Reload and check.** Run `/glossary reload`. The include should load with no warning, and a term from it should show up in `/glossary`. If it fails, the warning names the fetcher and the first line of its stderr.

## Config format

```json
[
  {
    "name": "my gists",
    "match": "^https://gist\\.github\\.com/ruliana/(?<id>[0-9a-f]{20,32})$",
    "command": ["gh", "gist", "view", "{id}", "--raw", "--filename", "glossary.json"]
  },
  {
    "name": "team glossary behind IAP",
    "match": "^https://glossary\\.example\\.com/(?<file>[a-z0-9][a-z0-9-]{0,63})\\.json$",
    "command": ["~/bin/iap-glossary-fetch", "{url}"],
    "scopes": ["global", "project"],
    "timeoutMs": 20000
  }
]
```

| Field | Required | Meaning |
|-------|----------|---------|
| `match` | Yes | Regex tested against the whole include URL, exactly as written in the glossary file (case-sensitive). The first fetcher that matches wins. |
| `command` | Yes | Program and arguments. Run directly, **never through a shell**, from the home directory. The program must be a name on `PATH`, an absolute path, or start with `~/`. |
| `name` | No | Shown in warnings. |
| `scopes` | No | Where the include must be written for this fetcher to run: `"global"` (your `~/.pi/agent/glossary.json` and local files it includes), `"project"` (a repo's `.pi/glossary.json`), `"remote"` (an include inside a fetched glossary). Default `["global"]`. A matching include outside these scopes fails with a warning instead of being fetched. |
| `timeoutMs` | No | Default 10000, at most 60000. |
| `format` | No | `"json"` or `"jsonl"`. Default: `jsonl` when the URL ends in `.jsonl`, else `json`. |

**Placeholders** in `command` arguments: `{url}` (the URL as written), `{1}`, `{2}`… (numbered groups), `{name}` (named groups). Other braces are left as they are. If no argument has a placeholder, the URL is appended as the last argument. A filled-in argument that would start with `-` is refused, so a URL cannot turn into an option.

Output rules: stdout is the glossary (at most 1 MB). A non-zero exit, a timeout, or bad JSON fails only that include, with a warning. Entries from a fetcher are still treated as remote: they never run `{{shell}}` templates and are marked as not written by the user.

## Choosing scopes

- Keep the default `["global"]` unless the user asks otherwise. Then only includes the user wrote in their own glossary use their credentials.
- Add `"project"` only when the user trusts the repos they open to point at this host. Any repo they open could then make the fetcher run on any URL the regex accepts, with their credentials, and put the result in the agent's context. A tight regex is what keeps that small.
- Add `"remote"` rarely: it lets a fetched glossary choose URLs for the fetcher.

## Safe URL regexes

The URL is text from a glossary file, and in project or remote scope someone else wrote it. The regex is the guard that decides which of those strings reach your program and its credentials. pi-glossary already wraps the regex as `^(?:...)$`, so it must match the whole URL, but write it as if it didn't.

1. **Anchor both ends**: start with `^https://` and end with `$`. Write the anchors even though they are added for you; it keeps the regex correct if it is copied elsewhere.
2. **Require `https://`.** Never `https?`: over `http` the response can be rewritten on the way.
3. **Spell out the exact host, with dots escaped**: `glossary\.example\.com`. An unescaped `.` matches any character (`glossaryXexample.com`).
4. **End the host with `/`** right after it. Without it, `^https://example\.com` also matches `https://example.com.evil.net/` and `https://example.com@evil.net/`.
5. **No wildcards in the host.** Avoid `.*\.example\.com`, `[^/]*example\.com`, or `\w+\.`; list each allowed host instead, in a group like `(?:a|b)\.example\.com`.
6. **Narrow character classes for each path part**: `[a-z0-9][a-z0-9-]{0,63}`, `[0-9a-f]{20,32}`. Never `.*` or `.+`, which let in `..`, `?`, `#`, `@`, `%2F`, spaces and quotes.
7. **Pin the path shape**: a fixed prefix (`/glossaries/`), a fixed suffix (`\.json`), and a fixed number of segments. Don't allow `/` inside a captured part unless the command needs it.
8. **Capture what the command needs, nothing more**, with named groups, and pass `{id}` instead of `{url}` when the program only needs the id. A captured part must not be able to start with `-`: start the class with a letter or digit.
9. **Keep it simple**: no nested quantifiers like `(a+)+` or `(\w+\/?)*`, which can backtrack for a very long time on a crafted URL.
10. **Avoid query strings and fragments**: end with `$` right after the path, so `?…` and `#…` are rejected.

Check every regex against URLs that must match and ones that must not before saving it, for example with `node -e`:

```bash
node -e '
const re = new RegExp("^(?:" + process.argv[1] + ")$", "u");
for (const u of process.argv.slice(2)) console.log(re.test(u) ? "MATCH " : "no    ", u);
' '^https://glossary\.example\.com/(?<file>[a-z0-9][a-z0-9-]{0,63})\.json$' \
  https://glossary.example.com/team.json \
  https://glossary.example.com.evil.net/team.json \
  https://glossary.example.com@evil.net/team.json \
  https://evil.net/?https://glossary.example.com/team.json \
  https://glossary.example.com/../secret.json \
  https://glossary.example.com/team.json?x=1 \
  http://glossary.example.com/team.json
```

Only the first line should say `MATCH`.

## Don'ts

- Don't use `sh -c`, `bash -c`, or any shell as the program with the URL in its arguments. The fetcher runs without a shell on purpose; a shell wrapper brings back command injection through the URL. Write a script file instead (see **glossary-fetcher-build**).
- Don't put tokens or passwords in `command`. Let the tool read them from its own credential store or the environment.
- Don't write a fetcher whose regex matches every URL (`.*`, `https://.*`).
