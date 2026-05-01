# Supabase-backed scoped glossaries plan

## Goal

Extend `pi-glossary` so glossary terms can come from:

1. local files (current behavior)
2. an optional private Supabase backend

Add first-class **scopes** so Pi can load one or more glossaries depending on user choice and current directory.

## Decisions locked in

- Supabase support is **optional**
- Start with **private** Supabase access, not public
- Project files can both:
  - define local scoped entries
  - enable scopes automatically
- Conflict rule:
  - **project local entries override everything else**
  - warn on conflicting definitions across active non-project sources
- Scope names are arbitrary strings; recommended convention is directory-like strings such as:
  - `team/core`
  - `client/acme`
  - `project/payments`
- Supabase uses a single table: `glossary_entry`
- Need a setup command: `/glossary init supabase`

---

## Product model

### Core concepts

#### 1. Scope membership
An entry belongs to one or more scopes.

Example:

```json
{
  "term": "chargeback",
  "definition": "A disputed card transaction.",
  "scopes": ["domain/payments", "client/acme"]
}
```

#### 2. Scope activation
A scope is active because it was enabled by one of these sources:

1. implicit `default`
2. user-level config
3. project-level config inferred from local glossary files
4. explicit command enablement

Only entries in active scopes are eligible for matching and injection.

---

## Local file format

Keep supporting:

- `~/.pi/agent/glossary.json`
- `~/.pi/agent/glossary.jsonl`
- `.pi/glossary.json`
- `.pi/glossary.jsonl`

### Record types

Support two record types in local files.

#### A. Glossary entry record

```json
{
  "term": "EPER",
  "definition": "Explore, plan, execute, review.",
  "aliases": ["explore-plan-execute-review"],
  "scopes": ["team/core"],
  "enabled": true
}
```

Notes:
- `scopes` is optional
- missing `scopes` means `["default"]`
- local files may define entries for multiple scopes

#### B. Scope reference record

Used to auto-enable scopes for the current directory.

```json
{
  "type": "scope-ref",
  "scope": "team/core"
}
```

JSONL example:

```jsonl
{"type":"scope-ref","scope":"team/core"}
{"type":"scope-ref","scope":"project/payments"}
{"term":"chargeback","definition":"A disputed card transaction.","scopes":["project/payments"]}
```

### Behavior

- project file `scope-ref` records auto-enable those scopes when Pi starts in that directory
- global file `scope-ref` records auto-enable those scopes for all sessions
- local entry records are still loaded from files and filtered by active scopes

---

## Supabase model

### Table

Single table: `glossary_entry`

Recommended columns:

- `id uuid primary key default gen_random_uuid()`
- `scope text not null`
- `term text not null`
- `definition text not null`
- `aliases jsonb not null default '[]'::jsonb`
- `pattern text null`
- `flags text null`
- `enabled boolean not null default true`
- `source text null`
- `owner_user_id uuid not null`
- `visibility text not null default 'private'`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### Constraints and indexes

- check `scope <> ''`
- check `term <> ''`
- check `definition <> ''`
- check `visibility in ('private')` for v1, or omit `visibility` entirely
- unique index on `(owner_user_id, scope, term)`
- index on `(owner_user_id, scope)`
- optional GIN index on `aliases`

### Why `owner_user_id`

Since we are starting private-first and using one table, ownership must live on each row.

That gives us:
- simple RLS
- no extra scopes table
- `/glossary init supabase` can create the entire setup with one table + policies

---

## Auth and access model

### Recommended approach

Use:
- Supabase project URL
- Supabase anon key
- Supabase Auth session for the user

Do **not** use:
- service role keys in Pi
- public unauthenticated reads

### Storage expectation

Pi will need to store enough connection/auth configuration locally, likely under a user config file. Exact storage mechanism can be decided during implementation.

### Expected v1 UX

1. user runs `/glossary init supabase`
2. command helps create schema/policies and store connection settings
3. user authenticates to Supabase
4. extension can read/write only rows owned by that user via RLS

If team sharing is needed later, we can expand the RLS model, but v1 should optimize for private ownership.

---

## Scope activation model

### Active scopes should come from

- implicit `default`
- global local `scope-ref` records
- project local `scope-ref` records
- user-enabled scopes stored in local config

### Important distinction

Supabase stores entries.

Pi stores which scopes are enabled for this user/environment.

That keeps activation local and predictable.

---

## Merge and precedence rules

When assembling the active glossary:

1. load global local entries
2. load project local entries
3. load Supabase entries for active scopes
4. filter all entries by active scopes
5. merge by `term`

### Effective precedence

1. project local entry
2. Supabase entry
3. global local entry

### Conflict handling

- if project local overrides another source: no warning needed by default
- if two non-project active sources disagree on the same `term`, warn the user during load/reload
- warning should include:
  - term
  - winning source
  - shadowed source(s)

---

## Commands

## Existing

- `/glossary`
- `/glossary reload`

## New

### Scope commands

- `/glossary scopes`
  - list active scopes
  - show source of activation (`implicit`, `global`, `project`, `user`)
  - show whether Supabase is configured

- `/glossary scope enable <scope>`
  - persist enabled scope in local user config
  - reload glossary

- `/glossary scope disable <scope>`
  - remove enabled scope from local user config
  - reload glossary

### Supabase commands

- `/glossary init supabase`
  - initialize schema and policies
  - store connection settings
  - guide user through auth requirements

- `/glossary supabase status`
  - show whether Supabase is configured/authenticated
  - show connection target

### Optional but useful soon after

- `/glossary scope create <scope>`
  - create a first placeholder entry or validate scope naming by inserting into that scope
  - since there is no scope table, scope creation is logical rather than structural

Note: with a single-table model, a scope exists when at least one row uses that `scope` value.

---

## `/glossary init supabase` plan

This command should:

1. ask for or read:
   - Supabase URL
   - anon key
2. validate connectivity
3. ensure required SQL extensions/features are available
4. create `glossary_entry` table if missing
5. create indexes if missing
6. create/update RLS policies
7. enable RLS
8. store local connector configuration
9. print next steps for authentication and usage

### RLS policy target for v1

Authenticated users can:
- select rows where `owner_user_id = auth.uid()`
- insert rows where `owner_user_id = auth.uid()`
- update rows where `owner_user_id = auth.uid()`
- delete rows where `owner_user_id = auth.uid()`

This is enough for private personal glossaries.

---

## Extension architecture changes

## Current shape

Today the extension:
- loads local files on session start
- compiles matchers
- injects matched entries before agent start

## Planned shape

Split responsibilities into small internal modules or sections:

### 1. Parsing layer
Responsible for:
- reading JSON / JSONL
- distinguishing entry records from `scope-ref` records
- validation

### 2. Scope activation layer
Responsible for:
- computing active scopes from implicit + local config + local files
- reporting activation source

### 3. Source loading layer
Responsible for:
- loading global local entries
- loading project local entries
- optionally loading Supabase entries

### 4. Merge layer
Responsible for:
- applying precedence
- detecting/warning on conflicts
- producing final compiled glossary entries

### 5. Command layer
Responsible for:
- scope listing and toggling
- Supabase init/status
- reload/status output

This should keep `before_agent_start` mostly unchanged.

---

## Configuration plan

We should introduce a local config file for connector state and user-enabled scopes.

Suggested path:

- `~/.pi/agent/glossary.config.json`

Suggested contents:

```json
{
  "enabledScopes": ["team/core", "project/payments"],
  "supabase": {
    "url": "https://xyz.supabase.co",
    "anonKey": "...",
    "enabled": true
  }
}
```

Notes:
- project auto-enabled scopes still come from `.pi/glossary.json` / `.jsonl`
- this config is for user-level persistence, especially connector config and explicit scope toggles

---

## Matching behavior

No major change to matching logic is required.

Pipeline becomes:

1. compute final active glossary entries
2. compile regex matchers for those entries
3. on prompt, match terms as today
4. inject only newly matched terms for the session

Session-level deduplication should remain unchanged.

---

## Warnings and failure behavior

### Local load failures
Current behavior should remain:
- invalid local file blocks glossary load and shows actionable error

### Supabase failures
Because Supabase is optional:
- local glossary loading should still work if Supabase is unavailable
- UI should warn clearly that remote entries were skipped
- reload/status should expose connector failure separately from local parse failure

### Conflict warnings
Should be non-fatal.

---

## Phased implementation plan

## Phase 1: local scopes foundation

1. add `scopes?: string[]` to glossary entries
2. add support for `scope-ref` records
3. compute active scopes from implicit/global/project/user config
4. filter local entries by active scopes
5. add `/glossary scopes`
6. add `/glossary scope enable <scope>`
7. add `/glossary scope disable <scope>`
8. add conflict warnings and precedence handling
9. update README with scoped local glossary examples

### Exit criteria
- existing users without scopes continue to work unchanged
- project directories can auto-enable scopes
- scoped local entries are loaded correctly

## Phase 2: private Supabase connector

1. add Supabase config handling
2. add authenticated client setup
3. load remote entries for active scopes
4. merge remote entries with local entries using precedence rules
5. add `/glossary supabase status`
6. make remote failures non-fatal when local data exists
7. update README with setup and troubleshooting

### Exit criteria
- user can connect to a private Supabase project
- only user-owned rows are visible via RLS
- active scopes load remote entries

## Phase 3: Supabase initialization workflow

1. add `/glossary init supabase`
2. create table/indexes/RLS policies
3. store connector config locally
4. validate resulting connection
5. document auth/setup flow end to end

### Exit criteria
- fresh user can provision a Supabase backend from Pi
- schema and policies match extension expectations

## Phase 4: write operations for remote glossary management

Possible follow-up:
- create/update/delete remote glossary entries
- logical scope creation command
- import local glossary into Supabase

Not required for the first implementation unless explicitly requested.

---

## Testing plan

### Backward compatibility

- local glossary without `scopes` still works
- JSON and JSONL both still work
- ambiguous `.json` + `.jsonl` still errors

### Scope activation

- implicit `default` works
- global `scope-ref` enables scopes
- project `scope-ref` enables scopes
- manual enable/disable persists

### Precedence

- project overrides Supabase
- Supabase overrides global
- non-project conflicts warn

### Supabase

- unauthenticated access fails clearly
- authenticated user only sees own rows
- connector outage does not break local glossaries

### Matching

- only entries in active scopes can match
- already-loaded term session dedupe still works

---

## Risks and mitigations

### 1. Supabase auth UX may be the hardest part
Mitigation:
- keep schema simple
- private single-user RLS first
- separate connector status from glossary load status

### 2. One-table scope model means no standalone scope metadata
Tradeoff accepted.
Mitigation:
- treat scope as a logical grouping string
- delay scope descriptions/metadata until later if needed

### 3. Conflict warnings could get noisy
Mitigation:
- warn only once per reload/session start
- summarize conflicts instead of spamming per turn

### 4. Project auto-enable and user config may combine unexpectedly
Mitigation:
- `/glossary scopes` should show exact activation sources

---

## Suggested implementation order

1. local scope data model and parsing
2. scope activation and commands
3. conflict detection and precedence
4. Supabase connector read path
5. Supabase status command
6. `/glossary init supabase`
7. docs and examples

---

## Success criteria

The feature is successful when:

- existing glossary users are not broken
- a directory can automatically activate one or more scopes
- the extension can combine local and private Supabase glossary entries
- project-local definitions win predictably
- users can initialize and connect a private Supabase backend without manual schema work
