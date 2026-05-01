# pi-glossary

A [pi](https://github.com/nichochar/pi-coding-agent) extension that lazy-loads glossary definitions into the system prompt when the user's prompt mentions matching terms.

## Why

This lets you keep a shared project vocabulary in one place without bloating every turn's prompt. Definitions are only injected when the current prompt references a matching glossary handle.

More about it in [this blog post](https://ronie.medium.com/agent-glossary-teaching-agents-our-shared-language-93bae9674b02)

## How It Works

1. On session start, the extension loads `~/.pi/agent/glossary.json` or `~/.pi/agent/glossary.jsonl`, and `.pi/glossary.json` or `.pi/glossary.jsonl` from the current project.
2. Project entries override global entries when they use the same `term`.
3. Before an agent starts, it scans the user's prompt for matching glossary terms, aliases, or explicit regex patterns.
4. If terms match, only terms not already loaded in the current session are injected into the system prompt.
5. Loaded glossary handles stay visible for the rest of the session in the footer status as `Glossary: term, term`.

## What It Does

- Loads glossary entries from project-scoped `.pi/glossary.json` or `.pi/glossary.jsonl`
- Matches canonical terms and optional aliases out of the box
- Supports custom regex triggers per entry
- Supports scopes to organize entries and control which are active per session or directory
- Validates glossary entries and shows actionable errors
- Reloads glossary configuration without restarting pi
- Shows loaded glossary handles in the footer status for the whole session
- Avoids re-injecting glossary entries that were already loaded earlier in the session

## Installation

```bash
pi install git:github.com/ruliana/pi-glossary
```

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

## Scopes

Scopes let you group entries and control which ones are active per session or directory.

### Assigning scopes to entries

Add a `scopes` field to any entry:

```json
[
  {
    "term": "chargeback",
    "definition": "A disputed card transaction reversed by the issuing bank.",
    "scopes": ["domain/payments", "client/acme"]
  },
  {
    "term": "EPER",
    "definition": "Explore, plan, execute, review.",
    "scopes": ["team/core"]
  }
]
```

Entries without a `scopes` field belong to the implicit `default` scope and are always active.

### Auto-enabling scopes from a project file

Add `scope-ref` records to a project glossary file to automatically enable scopes whenever Pi starts in that directory:

```jsonl
{"type":"scope-ref","scope":"team/core"}
{"type":"scope-ref","scope":"project/payments"}
{"term":"chargeback","definition":"A disputed card transaction.","scopes":["project/payments"]}
```

Global glossary files can also contain `scope-ref` records to enable scopes for all sessions.

### Scope activation sources

A scope can be active because of:

- `implicit` — the `default` scope, always active
- `global` — a `scope-ref` in `~/.pi/agent/glossary.json` or `.jsonl`
- `project` — a `scope-ref` in `.pi/glossary.json` or `.pi/glossary.jsonl`
- `user` — explicitly enabled via `/glossary scope enable`

Run `/glossary scopes` to see all active scopes and their sources.

## User Config

The extension stores user-level scope preferences in `~/.pi/agent/glossary.config.json`:

```json
{
  "enabledScopes": ["team/core", "project/payments"]
}
```

This file is managed automatically by the scope commands. You can edit it directly if needed.

## Glossary Entry Fields

| Field | Required | Description |
|-------|----------|-------------|
| `term` | Yes | Canonical glossary handle |
| `definition` | Yes | Definition injected when the entry matches |
| `aliases` | No | Additional plain-text aliases |
| `pattern` | No | Explicit regex trigger; overrides the default matcher |
| `flags` | No | Regex flags, defaults to `iu` |
| `enabled` | No | Set to `false` to disable an entry |
| `source` | No | Descriptive provenance string included in injected context |
| `scopes` | No | Scopes this entry belongs to; defaults to `["default"]` |

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

Only entries whose scopes overlap with the active scopes are eligible for matching.

## Commands

| Command | Description |
|---------|-------------|
| `/glossary` | Show whether the glossary is loaded |
| `/glossary reload` | Reload all glossary files and reset the session |
| `/glossary scopes` | List active scopes and their activation sources |
| `/glossary scope enable <scope>` | Enable a scope and persist it in user config |
| `/glossary scope disable <scope>` | Disable a scope and remove it from user config |

## Notes

- The extension is user-scoped, and glossary data can be global (`~/.pi/agent/glossary.json` or `~/.pi/agent/glossary.jsonl`) or project-scoped (`.pi/glossary.json` or `.pi/glossary.jsonl`).
- Nothing is injected when the prompt does not mention a glossary handle.
- Once a term is loaded in a session, mentioning it again does not inject it again.
- If you edit the extension itself, run `/reload`.
- If you edit any glossary file (`glossary.json` or `glossary.jsonl`), run `/glossary reload`.
- Project `scope-ref` records take effect immediately on the next session start or `/glossary reload`.

## License

MIT
