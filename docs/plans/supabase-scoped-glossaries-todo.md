# Supabase-backed scoped glossaries TODO

## Phase 1: local scopes foundation

- [x] Add `scopes?: string[]` to the glossary entry model
- [x] Default missing `scopes` to `['default']`
- [x] Add support for `scope-ref` records in local glossary files
- [x] Validate `scope-ref` records
- [x] Update JSON and JSONL parsing to support mixed record types
- [x] Compute active scopes from:
  - [x] implicit `default`
  - [x] global `scope-ref` records
  - [x] project `scope-ref` records
  - [x] persisted user-enabled scopes
- [x] Filter local entries by active scopes
- [x] Preserve existing matcher behavior for active entries only
- [x] Add precedence handling for local sources
- [x] Add conflict detection for non-project sources
- [x] Warn once on load/reload when non-project conflicts exist
- [x] Add `/glossary scopes`
- [x] Add `/glossary scope enable <scope>`
- [x] Add `/glossary scope disable <scope>`
- [x] Persist user-enabled scopes in local config
- [x] Show scope activation source in `/glossary scopes`
- [x] Keep backward compatibility for existing unscoped glossaries
- [x] Update README with scoped local glossary examples

## Phase 2: private Supabase connector

- [x] Add local config model for Supabase connection settings
- [x] Decide local storage format/path for connector config (`~/.pi/agent/glossary.config.json`)
- [x] Add Supabase client initialization (native fetch against REST API)
- [x] Add authenticated access flow for private use (Bearer token + anon key headers)
- [x] Load remote entries from `glossary_entry` for active scopes only
- [x] Merge remote entries with local entries using precedence:
  - [x] project local
  - [x] Supabase
  - [x] global local
- [x] Warn on conflicting non-project definitions
- [x] Keep Supabase failures non-fatal when local entries exist
- [x] Add `/glossary supabase status`
- [x] Expose remote load/auth failures clearly in status output
- [x] Update README with private Supabase setup guidance

## Phase 3: Supabase initialization workflow

- [x] Add `/glossary init supabase`
- [x] Prompt for Supabase URL
- [x] Prompt for Supabase anon key
- [x] Validate connectivity
- [x] Create `glossary_entry` table if missing (displays provisioning SQL; user runs it in SQL editor)
- [x] Add required constraints
- [x] Add required indexes
- [x] Enable RLS
- [x] Add RLS policies for:
  - [x] select own rows
  - [x] insert own rows
  - [x] update own rows
  - [x] delete own rows
- [x] Persist connector config locally
- [x] Validate the configured connection after setup
- [x] Print next steps for authentication and usage
- [x] Document generated SQL / provisioning behavior

## Phase 4: remote glossary management follow-ups

- [ ] Decide whether to add `/glossary scope create <scope>` in first release or follow-up
- [ ] If added, define what "create scope" means with a single-table model
- [ ] Consider remote entry create/update/delete commands
- [ ] Consider import/sync from local glossary files into Supabase

## Cross-cutting work

- [x] Keep session-level loaded-term deduplication unchanged
- [x] Ensure `/glossary reload` refreshes scopes and remote entries
- [x] Ensure load errors remain actionable
- [x] Ensure warnings are summarized, not noisy
- [ ] Add tests for:
  - [ ] backward compatibility
  - [ ] scope activation
  - [ ] precedence
  - [ ] conflict warnings
  - [ ] Supabase auth failure handling
  - [ ] Supabase outage fallback
  - [ ] active-scope-only matching
