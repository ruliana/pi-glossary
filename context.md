# Code Context: pi-glossary Extension

## Files Retrieved

1. **`glossary.json`** (lines 1-10) - Default global glossary containing one example entry for "pi-glossary" itself
2. **`index.ts`** (lines 1-750) - Main extension code with core matching, tracking, and UI logic
3. **`package.json`** (lines 1-44) - Project metadata and extension registration
4. **`scripts/install-default-glossary.js`** (lines 1-56) - Installation script that copies default glossary to home directory
5. **`README.md`** (lines 1-160) - Documentation on usage, matching behavior, and configuration

---

## Key Code

### Default Glossary (glossary.json)
```json
[
  {
    "term": "pi-glossary",
    "definition": "pi-glossary is a Pi extension that lazy-loads glossary definitions into the agent context when user prompts mention matching terms. It reads global glossary entries from ~/.pi/agent/glossary.json and project-specific entries from .pi/glossary.json."
  }
]
```
**Location:** `/Users/ronie/.pi/agent/extensions/pi-glossary/glossary.json`

This default glossary is copied to `~/.pi/agent/glossary.json` during installation by the postinstall script.

---

### Session Term Tracking Setup (index.ts, lines 459-467)
```typescript
let loadedTermsForSession = new Set<string>();

const appendLoadedTerms = (terms: string[]) => {
	for (const term of terms) {
		loadedTermsForSession.add(term);
	}
};
```
**What it does:** 
- Maintains a session-scoped Set to track which glossary terms have been injected
- `appendLoadedTerms()` adds new terms to track them for the rest of the session
- Prevents re-injection of already-loaded definitions

---

### Prompt Matching Logic (index.ts, lines 707-741)
```typescript
pi.on("before_agent_start", async (event, ctx) => {
	if (entries.length === 0) {
		return;
	}

	const prompt = event.prompt?.trim();
	if (!prompt) {
		return;
	}

	// Step 1: Find ALL entries that match the current prompt
	const matched = entries.filter((entry) => entry.matcher.test(prompt));
	
	// Step 2: Filter to only NEWLY matched (not yet loaded in session)
	const newlyMatched = matched.filter((entry) => !loadedTermsForSession.has(entry.term));

	if (newlyMatched.length === 0) {
		return;
	}

	// Step 3: Track newly matched terms for rest of session
	appendLoadedTerms(newlyMatched.map((entry) => entry.term));
	updateGlossaryWidget(ctx);

	// Step 4: Inject only newly matched definitions into system prompt
	const injectedGlossary = newlyMatched.map(formatEntry).join("\n\n");

	const hasRefs = newlyMatched.some((entry) => extractRefs(entry.definition).length > 0);
	const refHint = hasRefs
		? "\n\nSome definitions above contain `[[term-name]]` cross-references to related glossary terms. Use the `glossary_lookup` tool to retrieve a referenced term's definition if it is relevant to the current task."
		: "";

	return {
		systemPrompt: `${event.systemPrompt}\n\n## Glossary\nThe user's prompt referenced explicit project glossary handles. Treat the following definitions as authoritative for this turn. Reuse them exactly as project-local language, and do not ask the user to restate them unless the definitions conflict or are ambiguous.\n\n${injectedGlossary}${refHint}`,
	};
});
```
**Key behavior:**
- Finds **all** matching terms in the prompt (not stopping after first)
- Filters results to only **newly matched** terms using `loadedTermsForSession` Set
- Injects only new definitions, avoiding duplication
- Updates status widget to show loaded terms
- Appends cross-reference hint if any definition contains `[[term-name]]` references

---

### Matcher Compilation (index.ts, lines 169-179)
```typescript
function buildMatcher(entry: GlossaryEntry): RegExp {
	if (entry.pattern) {
		return new RegExp(entry.pattern, entry.flags ?? "iu");
	}

	const variants = [entry.term, ...(entry.aliases ?? [])]
		.map((value) => value.trim())
		.filter(Boolean)
		.map(termToPattern);

	return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${variants.join("|")})(?![\\p{L}\\p{N}_])`, entry.flags ?? "iu");
}
```
**What it does:**
- If custom `pattern` exists, uses it directly with flags (defaults to `iu` = case-insensitive + Unicode)
- Otherwise builds boundary-aware regex from `term` and `aliases`
- Uses negative lookbehind/lookahead to avoid matching partial words

---

### Glossary File Loading (index.ts, lines 496-543)
```typescript
const loadGlossary = (cwd: string) => {
	entries = [];
	termMap = new Map();
	loadError = undefined;

	try {
		const globalFile = resolveGlossaryFile(path.join(os.homedir(), ".pi", "agent", "glossary"));
		const projectFile = resolveGlossaryFile(path.join(cwd, ".pi", "glossary"));
		const globalResult = loadGlossaryFile(globalFile, cwd);
		const projectResult = loadGlossaryFile(projectFile, cwd);
		
		// Merge entries: project overrides global if same term
		const mergedEntries = new Map<string, GlossaryEntry>();
		for (const entry of globalResult.entries) {
			mergedEntries.set(entry.term, entry);
		}
		for (const entry of projectResult.entries) {
			mergedEntries.set(entry.term, entry);
		}

		// Compile matchers for merged entries
		entries = Array.from(mergedEntries.values()).map((entry, index) => {
			try {
				return {
					...entry,
					matcher: buildMatcher(entry),
				};
			} catch (error) {
				throw new Error(...);
			}
		});

		// Build lookup map for cross-references
		termMap = new Map(entries.map((e) => [e.term.toLowerCase(), e]));
		// ...
	} catch (error) {
		loadError = error instanceof Error ? error.message : String(error);
		return { found: false, count: 0, files: [] as string[], error: loadError };
	}
};
```
**What it does:**
- Loads global glossary from `~/.pi/agent/glossary.json` or `.jsonl`
- Loads project glossary from `.pi/glossary.json` or `.jsonl`
- Merges entries with project entries overriding global ones by term name
- Compiles RegExp matchers for each entry
- Builds `termMap` for fast cross-reference lookups

---

### Cross-Reference Tool (index.ts, lines 602-633)
```typescript
pi.registerTool({
	name: "glossary_lookup",
	label: "Glossary lookup",
	description:
		"Look up a glossary term by name and get its definition. " +
		"Use this when a loaded definition contains a [[term-name]] cross-reference that is relevant to the current task.",
	parameters: Type.Object({
		term: Type.String({ description: "The term name to look up (case-insensitive)" }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const key = params.term.trim().toLowerCase();
		const entry = termMap.get(key);

		if (!entry) {
			return {
				content: [{ type: "text" as const, text: `Glossary term not found: "${params.term}"` }],
			};
		}

		if (!loadedTermsForSession.has(entry.term)) {
			appendLoadedTerms([entry.term]);
			updateGlossaryWidget(ctx);
		}

		return {
			content: [{ type: "text" as const, text: formatEntry(entry) }],
		};
	},
});
```
**What it does:**
- Allows agent to look up cross-referenced terms via `[[term-name]]` syntax
- Uses `termMap` for O(1) lookup by term name
- Tracks newly-looked-up terms in `loadedTermsForSession`
- Updates status widget when new terms are loaded

---

### Session Initialization (index.ts, lines 637-689)
```typescript
pi.on("session_start", async (_event, ctx) => {
	loadedTermsForSession = new Set<string>();  // Reset for new session
	updateGlossaryWidget(ctx);
	const result = loadGlossary(ctx.cwd);
	// ... validation and notification logic ...

	if (!ctx.hasUI) return;

	const fullTheme = ctx.ui.theme;
	const prevFactory = ctx.ui.getEditorComponent();

	// Decorate editor to highlight matching terms
	ctx.ui.setEditorComponent((tui, theme, kb) => {
		const inner = prevFactory ? prevFactory(tui, theme, kb) : new CustomEditor(tui, theme, kb);

		let activeMatchers: RegExp[] = [];
		const updateMatchers = (text: string) => {
			activeMatchers = entries
				.filter((e) => e.matcher.test(text))
				.map((e) => new RegExp(e.matcher.source, e.matcher.flags.replace("g", "") + "g"));
		};

		return withDecorations(inner, {
			handleInput(data: string): void {
				inner.handleInput(data);
				updateMatchers(inner.getText());
			},
			render(width: number): string[] {
				const lines = inner.render(width);
				if (activeMatchers.length === 0) return lines;
				const hl = (s: string) => fullTheme.fg("accent", fullTheme.bold(s));
				return lines.map((line) => {
					// Handles CURSOR_MARKER to avoid breaking when regex matches span cursor
					const markerIdx = line.indexOf(CURSOR_MARKER);
					if (markerIdx === -1) {
						return highlightTermsInAnsiLine(line, activeMatchers, hl);
					}
					const before = line.slice(0, markerIdx);
					const after = line.slice(markerIdx + CURSOR_MARKER.length);
					return (
						highlightTermsInAnsiLine(before, activeMatchers, hl) +
						CURSOR_MARKER +
						highlightTermsInAnsiLine(after, activeMatchers, hl)
					);
				});
			},
			setText(text: string): void {
				inner.setText(text);
				updateMatchers(text);
			},
		});
	});
});
```
**What it does:**
- Resets `loadedTermsForSession` for each new session
- Loads all glossary files
- Wraps the editor to highlight matching glossary terms as user types
- Re-evaluates active matchers on text changes

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    pi-glossary Extension                        │
└─────────────────────────────────────────────────────────────────┘

1. INITIALIZATION (session_start)
   ├─ Load global ~/.pi/agent/glossary.json(l)
   ├─ Load project .pi/glossary.json(l)
   ├─ Merge entries (project overrides global)
   ├─ Compile matchers for each entry
   ├─ Build termMap for lookups
   ├─ Reset loadedTermsForSession = new Set()
   └─ Decorate editor to highlight matches

2. PROMPT MATCHING (before_agent_start)
   ├─ Test all entries' matchers against prompt
   ├─ Filter matched to only newly-matched (not in loadedTermsForSession)
   ├─ If newlyMatched.length > 0:
   │  ├─ Add terms to loadedTermsForSession
   │  ├─ Format definitions
   │  ├─ Inject into system prompt
   │  └─ Update status widget
   └─ Return (nothing if no new matches)

3. CROSS-REFERENCE LOOKUP (glossary_lookup tool)
   ├─ Agent calls tool with term name
   ├─ Look up in termMap (fast)
   ├─ Track in loadedTermsForSession if not already loaded
   └─ Return formatted definition

4. SESSION TRACKING
   ├─ loadedTermsForSession Set tracks all loaded terms
   ├─ Prevents re-injection of same term
   ├─ Visible in footer status: "Glossary: term1, term2"
   └─ Reset on session_start
```

---

## Start Here

**`index.ts` (main entry point)**

Read in this order:
1. **Lines 707-741** (`before_agent_start` event handler) — Shows the core matching & injection logic
2. **Lines 459-467** (session tracking) — Shows how `loadedTermsForSession` prevents re-injection
3. **Lines 496-543** (`loadGlossary()`) — Shows how glossary files are discovered and merged
4. **Lines 169-179** (`buildMatcher()`) — Shows how terms become RegExp matchers

**Key insight:** The extension **does not** stop after the first match. Instead:
- It tests all entries against the prompt
- It **filters** results to only newly matched terms
- It injects only the new definitions
- It tracks all loaded terms in a session-scoped Set

This design allows the same term to be referenced multiple times without re-injecting, while allowing new terms discovered later in the conversation to be added on demand.

---

## Configuration Locations

- **Default glossary:** `/Users/ronie/.pi/agent/extensions/pi-glossary/glossary.json` (copied to `~/.pi/agent/glossary.json` on install)
- **Global glossary:** `~/.pi/agent/glossary.json` or `~/.pi/agent/glossary.jsonl`
- **Project glossary:** `.pi/glossary.json` or `.pi/glossary.jsonl` (in project root)
- **Both JSON and JSONL supported**, but only one per location
- **Project entries override global entries** if they have the same `term`

---

## Entry Fields

```typescript
type GlossaryEntry = {
	term: string;              // Required: canonical term
	definition: string;        // Required: definition text
	aliases?: string[];        // Optional: alternative names
	pattern?: string;          // Optional: custom regex pattern
	flags?: string;            // Optional: regex flags (defaults "iu")
	enabled?: boolean;         // Optional: set false to disable
	source?: string;           // Optional: provenance label
};
```

---

## Matching Behavior

- **No pattern?** → Auto-generates boundary-aware regex from `term` + `aliases`
- **With pattern?** → Uses custom regex directly
- **Default flags:** `iu` (case-insensitive, Unicode)
- **Word boundaries:** Negative lookbehind/lookahead prevent partial matches
- **Cross-references:** `[[term-name]]` in definitions trigger hint about `glossary_lookup` tool

---

## Commands

- `/glossary` — Show loaded glossary entries for current session
- `/glossary reload` — Reload files without restarting

