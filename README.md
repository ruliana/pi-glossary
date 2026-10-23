# pi-glossary

A [pi](https://github.com/nichochar/pi-coding-agent) extension that lazy-loads glossary definitions into the agent context when the user's prompt mentions matching terms.

## Why

This lets you keep a shared project vocabulary in one place without bloating every turn's prompt. Definitions are only injected when the current prompt references a matching glossary handle.

More about it in [this blog post](https://ronie.medium.com/agent-glossary-teaching-agents-our-shared-language-93bae9674b02)

## How It Works

1. On session start, the extension loads `~/.pi/agent/glossary.json` or `~/.pi/agent/glossary.jsonl`, and `.pi/glossary.json` or `.pi/glossary.jsonl` from the current project.
2. Either file may contain `{"include": "path_or_url"}` entries to inline entries from another local file or URL at that position (see [Include Directives](#include-directives)).
3. Project entries override global entries when they use the same `term`. Within a file, **earlier entries (top) take priority** over later ones.
4. Before an agent starts, it scans the user's prompt for all matching glossary terms, aliases, or explicit regex patterns.
5. If one or more terms match, only terms not already loaded in the current session are appended as a user-level context message (custom type `glossary`) immediately after the user's message, before the agent starts. The first injected message includes guidance for interpreting glossary definitions; later injected messages include only the `## Glossary` heading and new term definitions.
6. Loaded glossary handles stay visible for the rest of the session in the footer status as `Glossary: term, term`.

## What It Does

- Loads glossary entries from project-scoped `.pi/glossary.json` or `.pi/glossary.jsonl`
- Supports `{"include": "path_or_url"}` entries to pull in remote or local glossaries inline
- Matches canonical terms and optional aliases out of the box
- Supports custom regex triggers per entry
- Expands `{{shell command}}` placeholders in definitions at injection time
- Validates glossary entries and shows actionable errors
- Reloads glossary configuration without restarting pi
- Shows loaded glossary handles in the footer status for the whole session
- Avoids re-appending glossary entries that were already loaded earlier in the session

## Installation

```bash
pi install git:github.com/ruliana/pi-glossary
```

On first install, pi-glossary creates a default global glossary at `~/.pi/agent/glossary.json` if neither `~/.pi/agent/glossary.json` nor `~/.pi/agent/glossary.jsonl` already exists.

To remove:

```bash
pi remove git:github.com/ruliana/pi-glossary
```

After installing or updating the extension, run:

```text
/reload
```

## Project Configuration

Create `~/.pi/agent/glossary.json` or `~/.pi/agent/glossary.jsonl` for global terms and/or `.pi/glossary.json` or `.pi/glossary.jsonl` inside a project for project-specific terms.

JSON arrays continue to work:

```json
[
  {
    "term": "explore-plan-execute-review",
    "aliases": ["EPER"],
    "definition": "Spawn a team of subagents to explore, plan, execute, and review a task end to end."
  },
  {
    "term": "finance-safe",
    "pattern": "(?:^|[^\\w])finance-safe(?:$|[^\\w])",
    "definition": "Use the conservative workflow: explicit assumptions, no destructive actions, and a reviewer pass before execution."
  }
]
```

JSON Lines is also supported, with one entry per line:

```jsonl
{"term":"explore-plan-execute-review","aliases":["EPER"],"definition":"Spawn a team of subagents to explore, plan, execute, and review a task end to end."}
{"term":"finance-safe","pattern":"(?:^|[^\\w])finance-safe(?:$|[^\\w])","definition":"Use the conservative workflow: explicit assumptions, no destructive actions, and a reviewer pass before execution."}
```

When the same `term` exists in both scopes, the project entry wins.

If both `.json` and `.jsonl` exist in the same scope, the extension raises an error and asks you to keep only one.

## Include Directives

Any position in a glossary file can be an include directive instead of a regular entry:

```json
{ "include": "path/to/other.json" }
{ "include": "https://raw.githubusercontent.com/org/repo/main/glossary.json" }
{ "include": "https://gist.githubusercontent.com/user/id/raw/glossary.jsonl" }
```

Includes work in both JSON arrays and JSONL files. The referenced source is expanded in-place: entries from the included file appear at the position of the `include` directive, as if you had copy-pasted them there.

**Priority follows list order — top wins.** Entries that appear earlier in the file have higher priority. This means you control what wins by where you put things:

```json
[
  { "term": "deploy", "definition": "project-specific, wins over anything below" },
  { "include": "https://example.com/team-glossary.json" }
]
```

In this example, the local `deploy` entry is listed first and wins over any `deploy` from the URL.

**Supported sources:**

| Source | Example |
|--------|---------|
| Local path (relative) | `"include": "../shared/glossary.json"` |
| Local path (absolute) | `"include": "/home/user/.config/glossary.json"` |
| Local path (no extension) | `"include": "extras"` — resolves to `extras.json` or `extras.jsonl` |
| GitHub file (browser URL) | `"include": "https://github.com/org/repo/blob/main/glossary.json"` |
| GitHub file (raw URL) | `"include": "https://raw.githubusercontent.com/org/repo/main/glossary.json"` |
| GitHub Gist (browser Raw button) | `"include": "https://gist.github.com/user/id/raw/hash/glossary.jsonl"` |
| GitHub Gist (raw URL) | `"include": "https://gist.githubusercontent.com/user/id/raw/hash/glossary.jsonl"` |
| Plain URL | `"include": "https://example.com/glossary.json"` |

Browser-visible GitHub URLs (the `/blob/` variant and the gist Raw button URL) are automatically converted to their downloadable equivalents, so you can paste them directly without editing.

**Rules:**
- Circular includes (A includes B which includes A) are detected and skipped with a warning.
- A failed include (file not found, network error, parse error) is reported as a warning and skipped — other entries still load.
- Included files may themselves contain `include` directives (recursive).
- GitHub URLs (raw files, gists) are fetched with authentication: `GITHUB_TOKEN` env var is tried first; if absent, the `gh` CLI's stored credentials are used (`gh auth token`). Private gists work as long as either is available. The token is sent only over `https`, only when the URL's host is exactly `github.com`, `api.github.com`, `raw.githubusercontent.com` or `gist.githubusercontent.com`, and only for includes written in the global glossary (or a local file it includes). Includes in a project glossary or inside a remote glossary are fetched without it, so a repository or a remote file cannot read your private GitHub content.
- Entries from a URL include never run [shell command templates](#shell-command-templates).
- Definitions from a URL include are injected with a note that the user did not write them and that they are reference only, not instructions.
- A remote entry whose `pattern` or `flags` do not compile is skipped with a warning; the same error in your own files is a load error.
- Remote fetches time out after 10 seconds, and a response over 1 MB is rejected; either one is reported as a failed include.
- Terminal control characters and escape sequences are removed from glossary text and from shell template output.

> [!WARNING]
> **Only include URLs you control.** URL includes are meant for sharing your own glossary between installations, such as a gist or a repository you maintain. Whatever a remote glossary says goes into the agent's context every time one of its terms comes up, and its `pattern` regexes run on every keystroke and prompt. A source someone else can edit can steer the agent, inject a definition into every prompt (a pattern like `(?:)` matches everything), or freeze pi with a regex that backtracks forever. Remote entries are labelled as not written by you and never run shell commands, but that only limits the damage. Prefer `https` URLs: over `http` anyone on the network path can rewrite the file.

## Glossary Entry Fields

| Field | Required | Description |
|-------|----------|-------------|
| `term` | Yes | Canonical glossary handle |
| `definition` | Yes | Definition injected when the entry matches. Supports `{{shell command}}` template placeholders (see below). |
| `aliases` | No | Additional plain-text aliases used for matching; not included in injected context |
| `pattern` | No | Explicit regex trigger; overrides the default matcher |
| `flags` | No | Regex flags, defaults to `iu` |
| `enabled` | No | Set to `false` to disable an entry |

## Shell Command Templates

Definition strings can embed shell commands using `{{command}}` placeholders. Each placeholder is replaced with the command's stdout (trimmed) right before the definition is injected into the agent context or returned by `glossary_lookup`.

```json
{
  "term": "current branch",
  "definition": "The current branch in {{pwd}} is {{git branch --show-current}}."
}
```

When this term is matched, the agent receives something like:

```
The current branch in /home/user/myproject is feat/new-login.
```

**Rules:**
- Commands run in the session's working directory (`ctx.cwd`).
- Each distinct command in a definition runs at most once per injection.
- If a command exits with an error or times out (5 s limit), the placeholder is replaced with `[error: <message>]` rather than stopping the injection.
- The `/glossary` browse overlay shows the raw template text (unexpanded), since expansion happens at agent-start time.
- Templates run only for entries from your own glossary files and the local files they include. Entries that come from a URL include (directly or through anything it includes) are never expanded: each placeholder becomes `[shell template disabled: remote glossary source]`. There is no way to turn this on.

## Validation

Each enabled entry must have:

- a non-empty `term`
- a non-empty `definition`
- a valid regex `pattern` if `pattern` is provided

If validation fails, `/glossary` and `/glossary reload` show an actionable error that identifies the bad entry.

## Matching Behavior

If `pattern` is omitted, the extension builds a case-insensitive, boundary-aware matcher from `term` plus `aliases`.

That means these work well out of the box:

- single terms like `tophat`
- dashed handles like `explore-plan-execute-review`
- multi-word phrases like `railway topic`

Use `pattern` when you want total control over matching.

When multiple entries match the same prompt, all matching entries are considered. Entries already loaded earlier in the session are skipped so they are not injected again.

## Commands

| Command | Description |
|---------|-------------|
| `/glossary` | Show whether the glossary is loaded |
| `/glossary reload` | Reload `~/.pi/agent/glossary.json` or `~/.pi/agent/glossary.jsonl`, and `.pi/glossary.json` or `.pi/glossary.jsonl`, without restarting pi |

Any other form, such as `/glossary something`, shows a usage hint instead of doing a partial lookup.

## Notes

- The extension is user-scoped, and glossary data can be global (`~/.pi/agent/glossary.json` or `~/.pi/agent/glossary.jsonl`) or project-scoped (`.pi/glossary.json` or `.pi/glossary.jsonl`).
- Nothing is injected when the prompt does not mention a glossary handle.
- Once a term is loaded in a session, mentioning it again does not inject it again.
- If you edit the extension itself, run `/reload`.
- If you edit any glossary file (`glossary.json` or `glossary.jsonl`), run `/glossary reload`.

## License

MIT
