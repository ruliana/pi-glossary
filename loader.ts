import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GlossaryEntry } from "./types.ts";

// ─── Core types ────────────────────────────────────────────────────────────────

/** Raw bytes + metadata returned by a GlossarySource. */
export type RawContent = {
	/** The raw text content. */
	text: string;
	/** Canonical, resolved location (absolute path or normalized URL) — used as the cycle-detection key and for parser selection. */
	location: string;
	/** Human-readable label shown in error messages and the UI. */
	label: string;
};

/** An include directive that may appear inside a glossary file. */
export type GlossaryInclude = { include: string };

export type LoadOptions = {
	cwd?: string;
	visited?: Set<string>;
	warnings?: string[];
};

export type LoadResult = {
	found: boolean;
	entries: GlossaryEntry[];
	/** Human-readable label for the loaded location. */
	label: string;
};

// ─── Plugin interfaces ─────────────────────────────────────────────────────────

/**
 * A source plugin knows how to fetch raw text from a class of locations
 * (e.g. local filesystem, HTTP URLs).
 */
export interface GlossarySource {
	readonly name: string;
	/** Return true when this source can handle the given location string. */
	canHandle(location: string): boolean;
	/**
	 * Normalize the location to a canonical form used as the cycle-detection key.
	 * Handles relative-to-absolute path resolution and URL normalization (e.g.
	 * converting GitHub browser URLs to raw download URLs).
	 */
	normalize(location: string, cwd: string): string;
	/** Fetch the raw text content from the (already normalized) location. */
	read(location: string): Promise<RawContent>;
}

/**
 * A parser plugin knows how to convert raw text into a flat list of glossary
 * items (entries and include directives). Parser selection is based on the
 * resolved location string returned inside RawContent, so a Gist URL ending
 * in `.jsonl` is automatically routed to the JSONL parser.
 */
export interface GlossaryParser {
	readonly name: string;
	/** Return true when this parser can handle the given (resolved) location. */
	canHandle(location: string): boolean;
	/** Parse raw content into a list of entries and/or include directives. */
	parse(content: RawContent): Array<GlossaryEntry | GlossaryInclude>;
}

// ─── Registry / coordinator ────────────────────────────────────────────────────

/**
 * Coordinates source and parser plugins to load glossary entries from any
 * supported location, recursively resolving include directives.
 *
 * Registration order matters: the LAST registered plugin whose `canHandle()`
 * returns true wins, so built-ins are registered first and user plugins added
 * later take precedence.
 */
export class GlossaryLoader {
	private sources: GlossarySource[] = [];
	private parsers: GlossaryParser[] = [];

	registerSource(source: GlossarySource): this {
		this.sources.push(source);
		return this;
	}

	registerParser(parser: GlossaryParser): this {
		this.parsers.push(parser);
		return this;
	}

	private findSource(location: string): GlossarySource {
		for (let i = this.sources.length - 1; i >= 0; i--) {
			if (this.sources[i]!.canHandle(location)) return this.sources[i]!;
		}
		throw new Error(`No source plugin can handle location: ${location}`);
	}

	private findParser(location: string): GlossaryParser {
		for (let i = this.parsers.length - 1; i >= 0; i--) {
			if (this.parsers[i]!.canHandle(location)) return this.parsers[i]!;
		}
		throw new Error(`No parser plugin can handle location: ${location}`);
	}

	async load(location: string, options: LoadOptions = {}): Promise<LoadResult> {
		const cwd = options.cwd ?? process.cwd();
		const visited = options.visited ?? new Set<string>();
		const warnings = options.warnings ?? [];

		const source = this.findSource(location);
		const canonical = source.normalize(location, cwd);

		if (visited.has(canonical)) {
			warnings.push(`Skipping circular include: ${location}`);
			return { found: false, entries: [], label: location };
		}

		let content: RawContent;
		try {
			content = await source.read(canonical);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { found: false, entries: [], label: canonical };
			}
			throw error;
		}

		visited.add(canonical);

		const parser = this.findParser(content.location);
		const items = parser.parse(content);
		const entries = await this.resolveItems(items, content.label, cwd, visited, warnings);

		return { found: true, entries, label: content.label };
	}

	private async resolveItems(
		items: Array<GlossaryEntry | GlossaryInclude>,
		defaultSource: string,
		cwd: string,
		visited: Set<string>,
		warnings: string[],
	): Promise<GlossaryEntry[]> {
		const result: GlossaryEntry[] = [];
		let entryIndex = 0;

		for (const item of items) {
			if (isIncludeEntry(item)) {
				try {
					const subResult = await this.load(item.include.trim(), { cwd, visited, warnings });
					result.push(...subResult.entries);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					warnings.push(`Failed to include ${item.include}: ${msg}`);
				}
			} else if (item && typeof item === "object" && (item as GlossaryEntry).enabled !== false) {
				const validated = validateGlossaryEntry(item as GlossaryEntry, entryIndex++);
				result.push({ ...validated, source: validated.source ?? defaultSource });
			}
		}

		return result;
	}
}

// ─── Built-in source: local filesystem ────────────────────────────────────────

/**
 * Reads glossary files from the local filesystem.
 * For extension-less paths it auto-detects `.json` vs `.jsonl`; having both
 * is an error. Relative paths are resolved against `cwd`.
 */
export class LocalFileSource implements GlossarySource {
	readonly name = "local";

	canHandle(location: string): boolean {
		return !isUrl(location);
	}

	normalize(location: string, cwd: string): string {
		const abs = path.isAbsolute(location) ? location : path.resolve(cwd, location);
		return this.resolveExtension(abs);
	}

	async read(location: string): Promise<RawContent> {
		if (!fs.existsSync(location)) {
			throw Object.assign(
				new Error(`ENOENT: no such file or directory, open '${location}'`),
				{ code: "ENOENT" },
			);
		}
		const text = fs.readFileSync(location, "utf8");
		const label = location.startsWith(os.homedir())
			? location.replace(os.homedir(), "~")
			: location;
		return { text, location, label };
	}

	private resolveExtension(base: string): string {
		if (base.endsWith(".json") || base.endsWith(".jsonl")) return base;
		const hasJson = fs.existsSync(base + ".json");
		const hasJsonl = fs.existsSync(base + ".jsonl");
		if (hasJson && hasJsonl) {
			throw new Error(
				`Ambiguous glossary configuration: found both ${base}.json and ${base}.jsonl. Keep only one.`,
			);
		}
		if (hasJsonl) return base + ".jsonl";
		return base + ".json";
	}
}

// ─── Built-in source: HTTP/HTTPS ──────────────────────────────────────────────

/**
 * Fetches glossary files over HTTP/HTTPS.
 * GitHub browser URLs are automatically converted to their raw download form,
 * and a GitHub token (from GITHUB_TOKEN env or `gh auth token`) is added when
 * fetching from GitHub hosts.
 */
export class HttpSource implements GlossarySource {
	readonly name = "http";

	canHandle(location: string): boolean {
		return isUrl(location);
	}

	normalize(location: string, _cwd: string): string {
		return normalizeGitHubUrl(location);
	}

	async read(location: string): Promise<RawContent> {
		const headers: Record<string, string> = {};
		if (isGitHubUrl(location)) {
			const token = getGitHubToken();
			if (token) headers["Authorization"] = `Bearer ${token}`;
		}
		const response = await fetch(location, { headers });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		const text = await response.text();
		return { text, location, label: location };
	}
}

// ─── Built-in parser: JSON array ──────────────────────────────────────────────

/** Parses glossary files that contain a JSON array of entries and/or includes. */
export class JsonParser implements GlossaryParser {
	readonly name = "json";

	/** Handles any location that is not explicitly `.jsonl` (acts as the fallback parser). */
	canHandle(location: string): boolean {
		return !location.endsWith(".jsonl");
	}

	parse(content: RawContent): Array<GlossaryEntry | GlossaryInclude> {
		const parsed = JSON.parse(content.text) as unknown;
		if (!Array.isArray(parsed)) {
			throw new Error(`Invalid glossary ${content.label}: root value must be an array`);
		}
		return parsed as Array<GlossaryEntry | GlossaryInclude>;
	}
}

// ─── Built-in parser: JSON Lines ──────────────────────────────────────────────

/** Parses glossary files in JSON Lines format (one JSON object per line). */
export class JsonlParser implements GlossaryParser {
	readonly name = "jsonl";

	canHandle(location: string): boolean {
		return location.endsWith(".jsonl");
	}

	parse(content: RawContent): Array<GlossaryEntry | GlossaryInclude> {
		return content.text
			.split(/\r?\n/)
			.map((line, i) => ({ line: line.trim(), lineNumber: i + 1 }))
			.filter(({ line }) => line.length > 0)
			.map(({ line, lineNumber }) => {
				try {
					return JSON.parse(line) as GlossaryEntry | GlossaryInclude;
				} catch (error) {
					throw new Error(
						`Invalid glossary ${content.label}: line ${lineNumber} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
					);
				}
			});
	}
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Create a GlossaryLoader pre-loaded with all built-in sources and parsers. */
export function createDefaultGlossaryLoader(): GlossaryLoader {
	return new GlossaryLoader()
		.registerSource(new LocalFileSource())
		.registerSource(new HttpSource())
		.registerParser(new JsonParser())
		.registerParser(new JsonlParser());
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isUrl(location: string): boolean {
	return location.startsWith("http://") || location.startsWith("https://");
}

function isGitHubUrl(url: string): boolean {
	return /https?:\/\/(?:raw\.githubusercontent\.com|gist\.githubusercontent\.com|api\.github\.com|github\.com)/.test(url);
}

/**
 * Convert browser-visible GitHub URLs to their raw/downloadable equivalents so
 * users can paste URLs directly from the GitHub UI without hunting for "Raw".
 *
 * Handled patterns:
 *   github.com/USER/REPO/blob/REF/PATH  → raw.githubusercontent.com/USER/REPO/REF/PATH
 *   github.com/USER/REPO/raw/REF/PATH   → raw.githubusercontent.com/USER/REPO/REF/PATH
 *   gist.github.com/USER/ID/raw/…       → gist.githubusercontent.com/USER/ID/raw/…
 */
function normalizeGitHubUrl(url: string): string {
	const blobMatch = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/);
	if (blobMatch) return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}`;

	const rawMatch = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/raw\/(.+)$/);
	if (rawMatch) return `https://raw.githubusercontent.com/${rawMatch[1]}/${rawMatch[2]}`;

	const gistRawMatch = url.match(/^https?:\/\/gist\.github\.com\/(.+\/raw\/.+)$/);
	if (gistRawMatch) return `https://gist.githubusercontent.com/${gistRawMatch[1]}`;

	return url;
}

function getGitHubToken(): string | null {
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	try {
		const token = execSync("gh auth token", { encoding: "utf8", timeout: 5000 }).trim();
		return token || null;
	} catch {
		return null;
	}
}

export function describeGlossaryEntry(entry: Partial<GlossaryEntry>, index: number): string {
	const term = typeof entry.term === "string" ? entry.term.trim() : "";
	return term ? `entry ${index + 1} (term: ${term})` : `entry ${index + 1}`;
}

export function validateGlossaryEntry(entry: GlossaryEntry, index: number): GlossaryEntry {
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

function isIncludeEntry(entry: unknown): entry is GlossaryInclude {
	return entry !== null && typeof entry === "object" && typeof (entry as any).include === "string";
}
