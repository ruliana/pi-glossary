# pi-glossary

A [pi](https://github.com/nichochar/pi-coding-agent) extension that lazy-loads glossary definitions into the system prompt when the user's prompt mentions matching terms.

## Why

This lets you keep a shared project vocabulary in one place without bloating every turn's prompt. Definitions are only injected when the current prompt references a matching glossary handle.

More about it in [this blog post](https://ronie.medium.com/agent-glossary-teaching-agents-our-shared-language-93bae9674b02)

## How It Works

1. On session start, the extension loads `~/.pi/agent/glossary.json` and `.pi/glossary.json` from the current project.
2. Project entries override global entries when they use the same `term`.
3. Before an agent starts, it scans the user's prompt for matching glossary terms, aliases, or explicit regex patterns.
4. If terms match, only terms not already loaded in the current session are injected into the system prompt.
5. Loaded glossary handles stay visible for the rest of the session in the UI widget and footer status as `Glossary: term, term`.

## What It Does

- Loads glossary entries from a project-scoped `.pi/glossary.json`
- Matches canonical terms and optional aliases out of the box
- Supports custom regex triggers per entry
- Validates glossary entries and shows actionable errors
- Reloads glossary configuration without restarting pi
- Shows loaded glossary handles in the UI for the whole session
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

Create `~/.pi/agent/glossary.json` for global terms and/or `.pi/glossary.json` inside a project for project-specific terms:

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

When the same `term` exists in both files, the project entry wins.

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

## Commands

| Command | Description |
|---------|-------------|
| `/glossary` | Show whether the glossary is loaded |
| `/glossary reload` | Reload `~/.pi/agent/glossary.json` and `.pi/glossary.json` without restarting pi |

Any other form, such as `/glossary something`, shows a usage hint instead of doing a partial lookup.

## Notes

- The extension is user-scoped, and glossary data can be global (`~/.pi/agent/glossary.json`) or project-scoped (`.pi/glossary.json`).
- Nothing is injected when the prompt does not mention a glossary handle.
- Once a term is loaded in a session, mentioning it again does not inject it again.
- If you edit the extension itself, run `/reload`.
- If you edit either glossary file, run `/glossary reload`.

## License

MIT
