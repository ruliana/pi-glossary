---
name: pi-glossary-crud
description: Manage pi-glossary entries with the built-in /glossary entry commands. Use when the user wants to create, inspect, update, delete, or list glossary entries locally or in Supabase.
---

# pi-glossary CRUD

Use the `/glossary entry ...` commands for glossary maintenance.

## When to use

Use this skill when the user asks to:
- add a glossary term
- update or correct a glossary definition
- delete a glossary entry
- inspect or list glossary entries
- save glossary data locally or in Supabase

## Workflow

1. Check scopes first when needed:
   - `/glossary scopes`
2. Use the glossary entry commands:
   - `/glossary entry create [term]`
   - `/glossary entry get [term]`
   - `/glossary entry update [term]`
   - `/glossary entry delete [term]`
   - `/glossary entry list`
3. The commands default to local storage.
4. If Supabase is configured, the command prompts for local vs Supabase.
5. Always choose or confirm the intended scope.
6. For create/update, fill all relevant fields: term, scope, definition, aliases, pattern, flags, source, and enabled.

## Guidance

- Prefer local storage unless the user explicitly wants the shared Supabase-backed glossary.
- If the user is unsure about scope, run `/glossary scopes` and explain the active scopes.
- Scope is mandatory and important. Do not skip it when creating or updating entries.
- After writing to a non-default scope, remind the user that the scope must be active to load in the current session.
- For remote CRUD, Supabase must be configured with `/glossary init supabase` and the `public.glossary_entry` DDL must already be applied.

## Examples

```text
/glossary entry create chargeback
/glossary entry get chargeback
/glossary entry update chargeback
/glossary entry delete chargeback
/glossary entry list
```

## Notes

- Local CRUD writes to the local glossary file chosen by the extension.
- Supabase CRUD uses the REST API configured in `~/.pi/agent/glossary.config.json`.
- If Supabase is configured, the command itself asks where to save/read.
