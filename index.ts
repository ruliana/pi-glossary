import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";

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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termToPattern(term: string): string {
	return escapeRegExp(term.trim()).replace(/\s+/g, "\\s+");
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

function formatEntry(entry: CompiledEntry): string {
	const aliases = entry.aliases?.length ? `Aliases: ${entry.aliases.join(", ")}\n` : "";
	const source = entry.source ? `Source: ${entry.source}\n` : "";
	return `### \`${entry.term}\`\n${aliases}${source}${entry.definition.trim()}`.trim();
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
			const termText = isSelected
				? this.theme.fg("accent", this.theme.bold(entry.term))
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
		lines.push(...wrapTextWithAnsi(" " + entry.definition.trim(), width));

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

		// Content height: 75% of terminal height minus the 4 fixed rows (top border, search, separator, bottom border)
		const CONTENT_ROWS = Math.max(3, Math.floor((this.tui.height - 4) * 0.75));

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

export default function lazyGlossaryExtension(pi: ExtensionAPI) {
	let entries: CompiledEntry[] = [];
	let loadError: string | undefined;
	let loadedTermsForSession = new Set<string>();

	const appendLoadedTerms = (terms: string[]) => {
		for (const term of terms) {
			loadedTermsForSession.add(term);
		}
	};

	const loadGlossaryFile = (jsonFile: string, cwd: string) => {
		if (!fs.existsSync(jsonFile)) {
			return { found: false, entries: [] as GlossaryEntry[], path: jsonFile };
		}

		const raw = fs.readFileSync(jsonFile, "utf8");
		const parsed = parseGlossaryFile(raw, jsonFile);

		const sourceLabel = jsonFile.startsWith(os.homedir())
			? jsonFile.replace(os.homedir(), "~")
			: path.relative(cwd, jsonFile);

		const validatedEntries = parsed
			.filter((entry) => entry && typeof entry === "object" && (entry as GlossaryEntry).enabled !== false)
			.map((entry, index) => {
				const validatedEntry = validateGlossaryEntry(entry as GlossaryEntry, index);
				return {
					...validatedEntry,
					source: validatedEntry.source ?? sourceLabel,
				};
			});

		return { found: true, entries: validatedEntries, path: jsonFile, label: sourceLabel };
	};

	const loadGlossary = (cwd: string) => {
		entries = [];
		loadError = undefined;

		try {
			const globalFile = resolveGlossaryFile(path.join(os.homedir(), ".pi", "agent", "glossary"));
			const projectFile = resolveGlossaryFile(path.join(cwd, ".pi", "glossary"));
			const globalResult = loadGlossaryFile(globalFile, cwd);
			const projectResult = loadGlossaryFile(projectFile, cwd);
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

			const foundFiles = [globalResult, projectResult]
				.filter((result) => result.found)
				.map((result) => result.label ?? result.path);

			return {
				found: foundFiles.length > 0,
				count: entries.length,
				files: foundFiles,
			};
		} catch (error) {
			loadError = error instanceof Error ? error.message : String(error);
			return { found: false, count: 0, files: [] as string[], error: loadError };
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
				const result = loadGlossary(ctx.cwd);
				if (result.error) {
					ctx.ui.notify(`Glossary reload failed: ${result.error}`, "error");
					return;
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
						maxHeight: "80%",
						anchor: "center",
					},
				},
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		loadedTermsForSession = new Set<string>();
		updateGlossaryWidget(ctx);
		const result = loadGlossary(ctx.cwd);
		if (result.error) {
			ctx.ui.notify(`Glossary load failed: ${result.error}`, "error");
			return;
		}
		if (result.found && result.count > 0) {
			ctx.ui.notify(
				`Glossary loaded: ${result.count} entr${result.count === 1 ? "y" : "ies"}${summarizeGlossarySources(result.files)}`,
				"info",
			);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (entries.length === 0) {
			return;
		}

		const prompt = event.prompt?.trim();
		if (!prompt) {
			return;
		}

		const matched = entries.filter((entry) => entry.matcher.test(prompt));
		const newlyMatched = matched.filter((entry) => !loadedTermsForSession.has(entry.term));

		if (newlyMatched.length === 0) {
			return;
		}

		appendLoadedTerms(newlyMatched.map((entry) => entry.term));
		updateGlossaryWidget(ctx);

		const injectedGlossary = newlyMatched.map(formatEntry).join("\n\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Lazy-Loaded Agent Glossary\nThe user's prompt referenced explicit project glossary handles. Treat the following definitions as authoritative for this turn. Reuse them exactly as project-local language, and do not ask the user to restate them unless the definitions conflict or are ambiguous.\n\n${injectedGlossary}`,
		};
	});

}
