import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Component, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type GlossaryEntry = {
	term: string;
	definition: string;
	aliases?: string[];
	pattern?: string;
	flags?: string;
	enabled?: boolean;
	source?: string;
};

type CompiledEntry = GlossaryEntry & {
	matcher: RegExp;
};

const GLOSSARY_HEADING = "## Glossary";
const GLOSSARY_PREAMBLE = "The user's prompt referenced explicit project glossary handles. Treat the following definitions as authoritative for the rest of this session. Reuse them exactly as project-local language, and do not ask the user to restate them unless the definitions conflict or are ambiguous.";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termToPattern(term: string): string {
	return escapeRegExp(term.trim()).replace(/\s+/g, "\\s+");
}

/** Highlight all case-insensitive occurrences of query in text using highlightFn. */
function highlightMatches(text: string, query: string, highlightFn: (s: string) => string): string {
	if (!query) return text;
	const lower = text.toLowerCase();
	const queryLower = query.toLowerCase();
	let result = "";
	let pos = 0;
	while (pos < text.length) {
		const idx = lower.indexOf(queryLower, pos);
		if (idx === -1) {
			result += text.slice(pos);
			break;
		}
		result += text.slice(pos, idx);
		result += highlightFn(text.slice(idx, idx + query.length));
		pos = idx + query.length;
	}
	return result;
}

/**
 * Highlight glossary term matches in an ANSI-encoded terminal line.
 * Skips ANSI escape sequences when searching so cursor/color codes don't break matching.
 */
function highlightTermsInAnsiLine(
	line: string,
	matchers: RegExp[],
	highlightFn: (s: string) => string,
): string {
	// Build map: plain-text character index → ANSI-string index
	const posMap: number[] = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			i++;
			// Skip parameter bytes, then consume the final byte (letter)
			while (i < line.length && (line.charCodeAt(i) < 0x40 || line.charCodeAt(i) > 0x7e)) i++;
			i++;
		} else {
			posMap.push(i);
			i++;
		}
	}
	const plain = posMap.map((idx) => line[idx]).join("");

	const ranges: Array<{ start: number; end: number }> = [];
	for (const matcher of matchers) {
		matcher.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = matcher.exec(plain)) !== null) {
			if (m[0].length === 0) { matcher.lastIndex++; continue; }
			ranges.push({ start: m.index, end: m.index + m[0].length });
		}
	}
	if (ranges.length === 0) return line;

	ranges.sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
		else merged.push({ ...r });
	}

	let result = "";
	let lastAnsi = 0;
	for (const { start, end } of merged) {
		if (start >= posMap.length) continue;
		const ansiStart = posMap[start]!;
		const ansiEnd = end < posMap.length ? posMap[end]! : line.length;
		result += line.slice(lastAnsi, ansiStart);
		result += highlightFn(line.slice(ansiStart, ansiEnd));
		lastAnsi = ansiEnd;
	}
	return result + line.slice(lastAnsi);
}

/**
 * Wrap an editor with overridden methods using a Proxy-based decorator.
 * Override functions close over `inner` (no `this` gymnastics).
 * Property writes (e.g. host's `editor.onChange = bashModeDetector`) forward to `inner`.
 */
function withDecorations<T extends object>(inner: T, overrides: Partial<T>): T {
	return new Proxy(inner, {
		get(target, prop) {
			if (prop in overrides) return (overrides as any)[prop];
			const v = Reflect.get(target, prop, target);
			return typeof v === "function" ? v.bind(target) : v;
		},
		set(target, prop, value) {
			return Reflect.set(target, prop, value, target);
		},
		has(target, prop) {
			return prop in overrides || prop in target;
		},
	});
}

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

function matchesText(matcher: RegExp, text: string): boolean {
	matcher.lastIndex = 0;
	const matched = matcher.test(text);
	matcher.lastIndex = 0;
	return matched;
}

function formatEntry(entry: CompiledEntry): string {
	return `### \`${entry.term}\`\n${entry.definition.trim()}`.trim();
}

function extractRefs(definition: string): string[] {
	return [...definition.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!.trim());
}

/**
 * Expand `{{shell command}}` placeholders in a definition by running each unique command
 * in the given working directory. Each distinct command runs at most once; failures
 * produce an inline `[error: ...]` marker rather than throwing.
 */
async function expandTemplate(definition: string, cwd: string): Promise<string> {
	if (!definition.includes("{{")) return definition;
	const matches = [...definition.matchAll(/\{\{(.+?)\}\}/g)];
	if (matches.length === 0) return definition;

	const results = new Map<string, string>();
	for (const match of matches) {
		const command = match[1]!.trim();
		if (results.has(command)) continue;
		let output: string;
		try {
			output = execSync(command, { cwd, encoding: "utf8", timeout: 5000 }).trim();
		} catch (error) {
			const msg = error instanceof Error ? error.message.split("\n")[0] : String(error);
			output = `[error: ${msg}]`;
		}
		results.set(command, output);
	}

	return definition.replace(/\{\{(.+?)\}\}/g, (_, cmd: string) => results.get(cmd.trim()) ?? "");
}

/**
 * Two-panel overlay component for browsing glossary terms.
 * Left panel: searchable list of terms (38% width)
 * Right panel: definition view with aliases, source, and wrapped text (62% width)
 */
class GlossaryOverlay implements Component {
	private query: string = "";
	private filtered: CompiledEntry[] = [];
	private selectedIndex: number = 0;
	private cachedLines: string[] | undefined = undefined;
	private cachedWidth: number | undefined = undefined;

	constructor(
		private readonly entries: CompiledEntry[],
		private readonly theme: any,
		private readonly tui: any,
		private readonly done: () => void,
	) {
		this.filtered = [...entries];
	}

	/** Filter entries by query string (searches term, aliases, definition). */
	private updateFilter(): void {
		if (this.query === "") {
			this.filtered = [...this.entries];
		} else {
			const q = this.query.toLowerCase();
			this.filtered = this.entries.filter(
				(e) =>
					e.term.toLowerCase().includes(q) ||
					e.aliases?.some((a) => a.toLowerCase().includes(q)) ||
					e.definition.toLowerCase().includes(q),
			);
		}
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filtered.length - 1),
		);
	}

	/** Build left panel lines: term list with selection highlight. */
	private buildLeftPanel(width: number): string[] {
		const lines: string[] = [];

		if (this.filtered.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("muted", "  (no matches)"), width));
			return lines;
		}

		for (let i = 0; i < this.filtered.length; i++) {
			const entry = this.filtered[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? "▶ " : "  ";
			const highlight = (s: string) => this.theme.fg("warning", this.theme.bold(s));
			const termText = isSelected
				? this.theme.fg("warning", this.theme.bold(
					this.query ? highlightMatches(entry.term, this.query, (s) => `\x1b[4m${s}\x1b[24m`) : entry.term,
				  ))
				: this.query
				? highlightMatches(entry.term, this.query, highlight)
				: entry.term;
			const line = truncateToWidth(prefix + termText, width);
			const fullLine = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
			lines.push(
				isSelected && this.theme.bg
					? this.theme.bg("selectedBg", fullLine)
					: fullLine,
			);
		}

		return lines;
	}

	/** Build right panel lines: term heading, aliases, source, and definition. */
	private buildRightPanel(width: number): string[] {
		const lines: string[] = [];

		const entry = this.filtered[this.selectedIndex];
		if (!entry) {
			lines.push(this.theme.fg("muted", " Select a term to view its definition."));
			return lines;
		}

		// Heading
		lines.push(truncateToWidth(" " + this.theme.fg("accent", this.theme.bold(entry.term)), width));
		lines.push("");

		// Aliases
		if (entry.aliases && entry.aliases.length > 0) {
			const aliasText = this.theme.fg("muted", " Aliases: ") + entry.aliases.join(", ");
			lines.push(...wrapTextWithAnsi(aliasText, width));
			lines.push("");
		}

		// Source
		if (entry.source) {
			const sourceText = this.theme.fg("muted", " Source: ") + this.theme.fg("dim", entry.source);
			lines.push(truncateToWidth(sourceText, width));
			lines.push("");
		}

		// Definition
		const highlight = (s: string) => this.theme.fg("warning", this.theme.bold(s));
		const defText = this.query
			? highlightMatches(entry.definition.trim(), this.query, highlight)
			: entry.definition.trim();
		lines.push(...wrapTextWithAnsi(" " + defText, width));

		return lines;
	}

	/** Render overlay: borders + search row + fixed-height content rows side by side. */
	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Each row is: │ + leftWidth + │ + rightWidth + │ = leftWidth + rightWidth + 3
		// So content columns available = width - 3, split 38/62
		const innerWidth = width - 3; // subtract 3 border chars (left │, center │, right │)
		const leftWidth = Math.max(10, Math.floor(innerWidth * 0.38));
		const rightWidth = Math.max(10, innerWidth - leftWidth);

		// Render enough rows; the overlay system clips to maxHeight: "75%" automatically.
		const CONTENT_ROWS = Math.max(this.entries.length, 20);

		const fg = (c: string, t: string) => this.theme.fg(c, t);
		const lines: string[] = [];

		// Top border
		lines.push(fg("border", "┌" + "─".repeat(leftWidth) + "┬" + "─".repeat(rightWidth) + "┐"));

		// Search row
		const searchRaw = " Search: " + this.query + (this.query.length === 0 ? fg("muted", "█") : "█");
		const searchLine = truncateToWidth(searchRaw, leftWidth);
		const searchPadded = searchLine + " ".repeat(Math.max(0, leftWidth - visibleWidth(searchLine)));

		const hint = fg("muted", " ↑↓ navigate • esc/enter close");
		const hintLine = truncateToWidth(hint, rightWidth);
		const hintPadded = hintLine + " ".repeat(Math.max(0, rightWidth - visibleWidth(hintLine)));

		lines.push(fg("border", "│") + searchPadded + fg("border", "│") + hintPadded + fg("border", "│"));

		// Mid separator
		lines.push(fg("border", "├" + "─".repeat(leftWidth) + "┼" + "─".repeat(rightWidth) + "┤"));

		// Content: zip left + right panel lines, padded to CONTENT_ROWS
		const leftLines = this.buildLeftPanel(leftWidth);
		const rightLines = this.buildRightPanel(rightWidth);

		for (let i = 0; i < CONTENT_ROWS; i++) {
			const lRaw = leftLines[i] ?? "";
			const rRaw = rightLines[i] ?? "";
			const lPad = lRaw + " ".repeat(Math.max(0, leftWidth - visibleWidth(lRaw)));
			const rPad = rRaw + " ".repeat(Math.max(0, rightWidth - visibleWidth(rRaw)));
			lines.push(fg("border", "│") + lPad + fg("border", "│") + rPad + fg("border", "│"));
		}

		// Bottom border
		lines.push(fg("border", "└" + "─".repeat(leftWidth) + "┴" + "─".repeat(rightWidth) + "┘"));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	/** Handle keyboard input: close, navigate, search. */
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
			this.done();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.filtered.length - 1, this.selectedIndex + 1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.backspace)) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.updateFilter();
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// Printable character → append to search query
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.query += data;
			this.updateFilter();
			this.invalidate();
			this.tui.requestRender();
		}
	}

	/** Clear render cache so next render() recomputes. */
	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}
}

function describeGlossaryEntry(entry: Partial<GlossaryEntry>, index: number): string {
	const term = typeof entry.term === "string" ? entry.term.trim() : "";
	return term ? `entry ${index + 1} (term: ${term})` : `entry ${index + 1}`;
}

function validateGlossaryEntry(entry: GlossaryEntry, index: number): GlossaryEntry {
	if (typeof entry.term !== "string" || entry.term.trim().length === 0) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: missing or empty term`);
	}

	if (typeof entry.definition !== "string" || entry.definition.trim().length === 0) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: missing or empty definition`);
	}

	if (entry.aliases !== undefined && !Array.isArray(entry.aliases)) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: aliases must be an array of strings`);
	}

	if (Array.isArray(entry.aliases) && entry.aliases.some((alias) => typeof alias !== "string")) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: aliases must contain only strings`);
	}

	if (entry.pattern !== undefined && typeof entry.pattern !== "string") {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: pattern must be a string`);
	}

	if (entry.flags !== undefined && typeof entry.flags !== "string") {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: flags must be a string`);
	}

	return {
		...entry,
		term: entry.term.trim(),
		definition: entry.definition.trim(),
		aliases: entry.aliases?.map((alias) => alias.trim()).filter(Boolean),
	};
}

function summarizeGlossarySources(files: string[]): string {
	if (files.length === 0) {
		return "";
	}
	if (files.length === 1) {
		return ` from ${files[0]}`;
	}
	return ` from ${files.join(" and ")}`;
}

function parseGlossaryFile(raw: string, glossaryFile: string): unknown[] {
	if (glossaryFile.endsWith(".jsonl")) {
		return raw
			.split(/\r?\n/)
			.map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
			.filter(({ line }) => line.length > 0)
			.map(({ line, lineNumber }) => {
				try {
					return JSON.parse(line) as unknown;
				} catch (error) {
					throw new Error(
						`Invalid glossary file ${glossaryFile}: line ${lineNumber} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
					);
				}
			});
	}

	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error(`Invalid glossary file ${glossaryFile}: root value must be an array`);
	}
	return parsed;
}

function resolveGlossaryFile(basePath: string): string {
	const jsonFile = `${basePath}.json`;
	const jsonlFile = `${basePath}.jsonl`;
	const hasJson = fs.existsSync(jsonFile);
	const hasJsonl = fs.existsSync(jsonlFile);

	if (hasJson && hasJsonl) {
		throw new Error(`Ambiguous glossary configuration: found both ${jsonFile} and ${jsonlFile}. Keep only one.`);
	}

	if (hasJsonl) {
		return jsonlFile;
	}

	return jsonFile;
}

type GlossaryInclude = { include: string };

function isIncludeEntry(entry: unknown): entry is GlossaryInclude {
	return entry !== null && typeof entry === "object" && typeof (entry as any).include === "string";
}

function isUrl(source: string): boolean {
	return source.startsWith("http://") || source.startsWith("https://");
}

async function fetchGlossaryUrl(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	return response.text();
}

/**
 * Expand a flat list of raw parsed items (entries + include directives) into a
 * flat list of validated GlossaryEntry objects. Include directives are resolved
 * in-place: their entries appear at the position of the directive, so later items
 * in the list have higher priority when the caller merges by term name.
 *
 * `visited` prevents infinite include cycles. `warnings` collects non-fatal errors.
 * `loadFile` is passed in so this function stays free of circular module-level references.
 */
async function resolveGlossaryItems(
	items: unknown[],
	defaultSource: string,
	cwd: string,
	visited: Set<string>,
	warnings: string[],
	loadFile: (file: string, cwd: string, visited: Set<string>, warnings: string[]) => Promise<{ found: boolean; entries: GlossaryEntry[]; path: string; label?: string }>,
): Promise<GlossaryEntry[]> {
	const result: GlossaryEntry[] = [];
	let entryCount = 0;

	for (const item of items) {
		if (isIncludeEntry(item)) {
			const source = item.include.trim();
			const cycleKey = isUrl(source) ? source : path.resolve(cwd, source);

			if (visited.has(cycleKey)) {
				warnings.push(`Skipping circular include: ${source}`);
				continue;
			}
			visited.add(cycleKey);

			try {
				if (isUrl(source)) {
					const raw = await fetchGlossaryUrl(source);
					const pseudoFile = source.endsWith(".jsonl") ? "remote.jsonl" : "remote.json";
					const nested = parseGlossaryFile(raw, pseudoFile);
					const expanded = await resolveGlossaryItems(nested, source, cwd, visited, warnings, loadFile);
					result.push(...expanded);
				} else {
					const absBase = path.isAbsolute(source) ? source : path.resolve(cwd, source);
					const hasExtension = absBase.endsWith(".json") || absBase.endsWith(".jsonl");
					const resolvedPath = hasExtension ? absBase : resolveGlossaryFile(absBase);
					const fileResult = await loadFile(resolvedPath, cwd, visited, warnings);
					result.push(...fileResult.entries);
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				warnings.push(`Failed to include ${source}: ${msg}`);
			}
		} else if (item && typeof item === "object" && (item as GlossaryEntry).enabled !== false) {
			const validated = validateGlossaryEntry(item as GlossaryEntry, entryCount++);
			result.push({ ...validated, source: validated.source ?? defaultSource });
		}
	}

	return result;
}

async function loadGlossaryFile(
	jsonFile: string,
	cwd: string,
	visited: Set<string>,
	warnings: string[],
): Promise<{ found: boolean; entries: GlossaryEntry[]; path: string; label?: string }> {
	if (!fs.existsSync(jsonFile)) {
		return { found: false, entries: [], path: jsonFile };
	}

	const raw = fs.readFileSync(jsonFile, "utf8");
	const parsed = parseGlossaryFile(raw, jsonFile);

	const sourceLabel = jsonFile.startsWith(os.homedir())
		? jsonFile.replace(os.homedir(), "~")
		: path.relative(cwd, jsonFile);

	const entries = await resolveGlossaryItems(parsed, sourceLabel, cwd, visited, warnings, loadGlossaryFile);

	return { found: true, entries, path: jsonFile, label: sourceLabel };
}

export default function lazyGlossaryExtension(pi: ExtensionAPI) {
	let entries: CompiledEntry[] = [];
	let termMap: Map<string, CompiledEntry> = new Map();
	let loadError: string | undefined;
	let loadedTermsForSession = new Set<string>();
	let hasInjectedGlossaryPreamble = false;

	const appendLoadedTerms = (terms: string[]) => {
		for (const term of terms) {
			loadedTermsForSession.add(term);
		}
	};

	const loadGlossary = async (cwd: string) => {
		entries = [];
		termMap = new Map();
		loadError = undefined;

		try {
			const visited = new Set<string>();
			const warnings: string[] = [];
			const globalFile = resolveGlossaryFile(path.join(os.homedir(), ".pi", "agent", "glossary"));
			const projectFile = resolveGlossaryFile(path.join(cwd, ".pi", "glossary"));
			const globalResult = await loadGlossaryFile(globalFile, cwd, visited, warnings);
			const projectResult = await loadGlossaryFile(projectFile, cwd, visited, warnings);

			// Merge: global first (lowest priority), project last (highest priority).
			// Within each file, includes expand in-place so position determines priority.
			const mergedEntries = new Map<string, GlossaryEntry>();
			for (const entry of globalResult.entries) {
				mergedEntries.set(entry.term, entry);
			}
			for (const entry of projectResult.entries) {
				mergedEntries.set(entry.term, entry);
			}

			entries = Array.from(mergedEntries.values()).map((entry, index) => {
				try {
					return {
						...entry,
						matcher: buildMatcher(entry),
					};
				} catch (error) {
					throw new Error(
						`Invalid glossary ${describeGlossaryEntry(entry, index)}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			});

			termMap = new Map(entries.map((e) => [e.term.toLowerCase(), e]));

			const foundFiles = [globalResult, projectResult]
				.filter((result) => result.found)
				.map((result) => result.label ?? result.path);

			return {
				found: foundFiles.length > 0,
				count: entries.length,
				files: foundFiles,
				warnings,
			};
		} catch (error) {
			loadError = error instanceof Error ? error.message : String(error);
			return { found: false, count: 0, files: [] as string[], error: loadError, warnings: [] as string[] };
		}
	};

	const updateGlossaryWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		const loadedTerms = [...loadedTermsForSession];
		if (loadedTerms.length === 0) {
			ctx.ui.setWidget("lazy-glossary", undefined);
			ctx.ui.setStatus("lazy-glossary", undefined);
			return;
		}
		const label = `Glossary: ${loadedTerms.join(", ")}`;
		ctx.ui.setWidget("lazy-glossary", undefined);
		ctx.ui.setStatus("lazy-glossary", label);
	};

	pi.registerCommand("glossary", {
		description: "Show or reload the glossary configuration",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed && trimmed !== "reload") {
				ctx.ui.notify("Usage: /glossary or /glossary reload", "warning");
				return;
			}
			if (trimmed === "reload") {
				loadedTermsForSession = new Set<string>();
				updateGlossaryWidget(ctx);
				const result = await loadGlossary(ctx.cwd);
				if (result.error) {
					ctx.ui.notify(`Glossary reload failed: ${result.error}`, "error");
					return;
				}
				for (const w of result.warnings) {
					ctx.ui.notify(`Glossary warning: ${w}`, "warning");
				}
				ctx.ui.notify(
					result.found
						? `Glossary reloaded: ${result.count} entr${result.count === 1 ? "y" : "ies"}${summarizeGlossarySources(result.files)}`
						: "No glossary files found",
					"info",
				);
				return;
			}

			if (loadError) {
				ctx.ui.notify(`Glossary load error: ${loadError}`, "error");
				return;
			}

			if (entries.length === 0) {
				ctx.ui.notify("No glossary entries loaded", "info");
				return;
			}

			// No args: open interactive browse overlay
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => new GlossaryOverlay(entries, theme, tui, done),
				{
					overlay: true,
					overlayOptions: {
						width: "90%",
						maxHeight: "75%",
						anchor: "center",
					},
				},
			);
		},
	});

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

			const expandedEntry = {
				...entry,
				definition: await expandTemplate(entry.definition, ctx.cwd),
			};

			return {
				content: [{ type: "text" as const, text: formatEntry(expandedEntry) }],
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		loadedTermsForSession = new Set<string>();
		hasInjectedGlossaryPreamble = false;
		updateGlossaryWidget(ctx);
		const result = await loadGlossary(ctx.cwd);
		if (result.error) {
			ctx.ui.notify(`Glossary load failed: ${result.error}`, "error");
			return;
		}
		for (const w of result.warnings) {
			ctx.ui.notify(`Glossary warning: ${w}`, "warning");
		}
		if (result.found && result.count > 0) {
			ctx.ui.notify(
				`Glossary loaded: ${result.count} entr${result.count === 1 ? "y" : "ies"}${summarizeGlossarySources(result.files)}`,
				"info",
			);
		}

		if (!ctx.hasUI) return;

		const fullTheme = ctx.ui.theme;
		const prevFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const inner = prevFactory
				? prevFactory(tui, theme, kb)
				: new CustomEditor(tui, theme, kb);

			let activeMatchers: RegExp[] = [];
			const updateMatchers = (text: string) => {
				activeMatchers = entries
					.filter((e) => matchesText(e.matcher, text))
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
					const hl = (s: string) => fullTheme.fg("warning", fullTheme.bold(s));
					return lines.map((line) => {
						// CURSOR_MARKER is an APC sequence (`\x1b_pi:c\x07`). The local
						// ANSI parser only handles CSI, so the marker leaks into the
						// plain-text view used for matching. When a regex match (e.g.
						// the `grill` glossary pattern that captures word boundaries)
						// extends past the cursor position, the byte-range slice cuts
						// the marker mid-sequence and the terminal renders `pi:c` as
						// visible text. Split around the marker, highlight each side,
						// then rejoin so the marker stays intact for TUI to strip.
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

	pi.on("before_agent_start", async (event, ctx) => {
		if (entries.length === 0) {
			return;
		}

		const prompt = event.prompt?.trim();
		if (!prompt) {
			return;
		}

		const newlyMatched = entries.filter(
			(entry) => !loadedTermsForSession.has(entry.term) && matchesText(entry.matcher, prompt),
		);

		if (newlyMatched.length === 0) {
			return;
		}

		const newTermNames = newlyMatched.map((entry) => entry.term);

		const expandedEntries = await Promise.all(
			newlyMatched.map(async (entry) => ({
				...entry,
				definition: await expandTemplate(entry.definition, ctx.cwd),
			})),
		);

		appendLoadedTerms(newTermNames);
		updateGlossaryWidget(ctx);

		const injectedGlossary = expandedEntries.map(formatEntry).join("\n\n");

		const hasRefs = expandedEntries.some((entry) => extractRefs(entry.definition).length > 0);
		const refHint = hasRefs
			? "\n\nSome definitions above contain `[[term-name]]` cross-references to related glossary terms. Use the `glossary_lookup` tool to retrieve a referenced term's definition if it is relevant to the current task."
			: "";

		const glossaryHeader = hasInjectedGlossaryPreamble
			? GLOSSARY_HEADING
			: `${GLOSSARY_HEADING}\n${GLOSSARY_PREAMBLE}`;
		const content = `${glossaryHeader}\n\n${injectedGlossary}${refHint}`;
		hasInjectedGlossaryPreamble = true;

		return {
			message: {
				customType: "glossary",
				content,
				display: true,
				details: { terms: newTermNames },
			},
		};
	});

}
