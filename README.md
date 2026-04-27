# pi-glossary

User-scoped pi extension that lazy-loads glossary definitions into the system prompt when a user mentions matching terms.

## Why

This implements the idea from the blog draft: keep a large shared vocabulary available, but only inject the definitions that are actually referenced in the current prompt.

## Files

- `~/.pi/agent/extensions/pi-glossary/index.ts` — user-scoped extension entrypoint
- `.pi/glossary.json` — project-scoped glossary configuration for the current repo

## Glossary format

### JSON format

```json
{
  "entries": [
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
}
```

### Supported fields

- `term` — canonical glossary handle
- `definition` — injected when the handle matches the prompt
- `aliases` — optional plain-text aliases
- `pattern` — optional explicit regex trigger; overrides the default matcher
- `flags` — optional regex flags, default `iu`
- `enabled` — optional boolean, set to `false` to disable an entry
- `source` — optional descriptive provenance string included in the injected context

### Validation

Each enabled entry must have:
- a non-empty `term`
- a non-empty `definition`
- a valid regex `pattern` if `pattern` is provided

If validation fails, `/glossary` and `/glossary reload` will show an actionable error that identifies the bad entry.

## Matching behavior

If `pattern` is omitted, the extension builds a case-insensitive boundary-aware matcher from `term` plus `aliases`.

That means these work well out of the box:
- single terms like `tophat`
- dashed handles like `explore-plan-execute-review`
- multi-word phrases like `railway topic`

Use `pattern` when you want total control.

## Commands

- `/glossary` — show whether the glossary is loaded
- `/glossary reload` — reload `.pi/glossary.json` without restarting pi

Any other form, such as `/glossary something`, shows a usage hint instead of doing a partial lookup.

## Notes

- This extension is installed globally for your user, but reads glossary entries from the current project's `.pi/glossary.json`.
- This extension injects matching definitions into the per-turn system prompt.
- When terms match, the extension also shows the matched glossary handles in the UI as a widget and footer status for that run.
- Nothing is loaded when a prompt does not mention a glossary handle.
- If you edit the extension itself, run `/reload`.
- If you edit `.pi/glossary.json`, run `/glossary reload`.
