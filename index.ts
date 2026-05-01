import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Types ─────────────────────────────────────────────────────────────────────

type GlossaryEntry = {
	term: string;
	definition: string;
	aliases?: string[];
	pattern?: string;
	flags?: string;
	enabled?: boolean;
	source?: string;
	scopes?: string[];
};

type ScopeRef = {
	type: "scope-ref";
	scope: string;
};

type GlossaryRecord = GlossaryEntry | ScopeRef;

type ScopeActivationSource = "implicit" | "global" | "project" | "user";

type ScopeInfo = {
	scope: string;
	sources: ScopeActivationSource[];
};

type GlossaryConfig = {
	enabledScopes?: string[];
};

type CompiledEntry = GlossaryEntry & {
	matcher: RegExp;
};

type FileLoadResult = {
	found: boolean;
	entries: GlossaryEntry[];
	scopeRefs: ScopeRef[];
	path: string;
	label?: string;
};

type ConflictWarning = {
	term: string;
	winner: string;
	shadowed: string[];
};

// ── Parsing layer ─────────────────────────────────────────────────────────────

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

function describeGlossaryEntry(entry: Partial<GlossaryEntry>, index: number): string {
	const term = typeof entry.term === "string" ? entry.term.trim() : "";
	return term ? `entry ${index + 1} (term: ${term})` : `entry ${index + 1}`;
}

function isScopeRef(record: unknown): record is ScopeRef {
	return record !== null && typeof record === "object" && (record as Record<string, unknown>).type === "scope-ref";
}

function validateScopeRef(record: ScopeRef, index: number): ScopeRef {
	if (typeof record.scope !== "string" || record.scope.trim().length === 0) {
		throw new Error(`Invalid scope-ref at position ${index + 1}: missing or empty scope`);
	}
	return { type: "scope-ref", scope: record.scope.trim() };
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

	if (entry.scopes !== undefined && !Array.isArray(entry.scopes)) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: scopes must be an array of strings`);
	}

	if (Array.isArray(entry.scopes) && entry.scopes.some((scope) => typeof scope !== "string")) {
		throw new Error(`Invalid glossary ${describeGlossaryEntry(entry, index)}: scopes must contain only strings`);
	}

	return {
		...entry,
		term: entry.term.trim(),
		definition: entry.definition.trim(),
		aliases: entry.aliases?.map((alias) => alias.trim()).filter(Boolean),
		scopes: entry.scopes?.map((scope) => scope.trim()).filter(Boolean),
	};
}

function parseGlossaryFile(raw: string, glossaryFile: string): GlossaryRecord[] {
	if (glossaryFile.endsWith(".jsonl")) {
		return raw
			.split(/\r?\n/)
			.map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
			.filter(({ line }) => line.length > 0)
			.map(({ line, lineNumber }) => {
				try {
					return JSON.parse(line) as GlossaryRecord;
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
	return parsed as GlossaryRecord[];
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

// ── Config layer ──────────────────────────────────────────────────────────────

const configPath = path.join(os.homedir(), ".pi", "agent", "glossary.config.json");

function loadConfig(): GlossaryConfig {
	if (!fs.existsSync(configPath)) {
		return {};
	}
	try {
		const raw = fs.readFileSync(configPath, "utf8");
		return JSON.parse(raw) as GlossaryConfig;
	} catch {
		return {};
	}
}

function saveConfig(config: GlossaryConfig): void {
	const dir = path.dirname(configPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
}

// ── Source loading layer ──────────────────────────────────────────────────────

function loadGlossaryFile(glossaryFile: string, cwd: string): FileLoadResult {
	if (!fs.existsSync(glossaryFile)) {
		return { found: false, entries: [], scopeRefs: [], path: glossaryFile };
	}

	const raw = fs.readFileSync(glossaryFile, "utf8");
	const records = parseGlossaryFile(raw, glossaryFile);

	const sourceLabel = glossaryFile.startsWith(os.homedir())
		? glossaryFile.replace(os.homedir(), "~")
		: path.relative(cwd, glossaryFile);

	const scopeRefs: ScopeRef[] = [];
	const entries: GlossaryEntry[] = [];

	records
		.filter((record) => record && typeof record === "object")
		.forEach((record, index) => {
			if (isScopeRef(record)) {
				scopeRefs.push(validateScopeRef(record, index));
				return;
			}
			const entry = record as GlossaryEntry;
			if (entry.enabled === false) return;
			const validated = validateGlossaryEntry(entry, index);
			entries.push({
				...validated,
				source: validated.source ?? sourceLabel,
			});
		});

	return { found: true, entries, scopeRefs, path: glossaryFile, label: sourceLabel };
}

// ── Scope activation layer ────────────────────────────────────────────────────

function computeActiveScopes(
	globalScopeRefs: ScopeRef[],
	projectScopeRefs: ScopeRef[],
	userConfig: GlossaryConfig,
): ScopeInfo[] {
	const scopeMap = new Map<string, ScopeActivationSource[]>();

	const addScope = (scope: string, source: ScopeActivationSource) => {
		if (!scopeMap.has(scope)) scopeMap.set(scope, []);
		const sources = scopeMap.get(scope)!;
		if (!sources.includes(source)) sources.push(source);
	};

	addScope("default", "implicit");
	for (const ref of globalScopeRefs) addScope(ref.scope, "global");
	for (const ref of projectScopeRefs) addScope(ref.scope, "project");
	for (const scope of userConfig.enabledScopes ?? []) addScope(scope, "user");

	return Array.from(scopeMap.entries()).map(([scope, sources]) => ({ scope, sources }));
}

function entryMatchesActiveScopes(entry: GlossaryEntry, activeScopes: Set<string>): boolean {
	const scopes = entry.scopes?.length ? entry.scopes : ["default"];
	return scopes.some((s) => activeScopes.has(s));
}

// ── Merge layer ───────────────────────────────────────────────────────────────

function mergeEntries(
	globalEntries: GlossaryEntry[],
	projectEntries: GlossaryEntry[],
): { merged: Map<string, GlossaryEntry>; conflicts: ConflictWarning[] } {
	const merged = new Map<string, GlossaryEntry>();
	const conflicts: ConflictWarning[] = [];

	// Global first (lowest priority among non-project sources)
	for (const entry of globalEntries) {
		merged.set(entry.term, entry);
	}

	// Conflict detection between non-project sources happens here.
	// Phase 1 has only one non-project source (global), so no conflicts are possible yet.
	// Phase 2 will add Supabase entries before this block.

	// Project overrides everything; no warning needed
	for (const entry of projectEntries) {
		merged.set(entry.term, entry);
	}

	return { merged, conflicts };
}

// ── Utility ───────────────────────────────────────────────────────────────────

function summarizeGlossarySources(files: string[]): string {
	if (files.length === 0) return "";
	if (files.length === 1) return ` from ${files[0]}`;
	return ` from ${files.join(" and ")}`;
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function lazyGlossaryExtension(pi: ExtensionAPI) {
	let entries: CompiledEntry[] = [];
	let loadError: string | undefined;
	let loadedTermsForSession = new Set<string>();
	let activeScopes: ScopeInfo[] = [{ scope: "default", sources: ["implicit"] }];

	const appendLoadedTerms = (terms: string[]) => {
		for (const term of terms) {
			loadedTermsForSession.add(term);
		}
	};

	const loadGlossary = (cwd: string) => {
		entries = [];
		loadError = undefined;

		try {
			const config = loadConfig();
			const globalFile = resolveGlossaryFile(path.join(os.homedir(), ".pi", "agent", "glossary"));
			const projectFile = resolveGlossaryFile(path.join(cwd, ".pi", "glossary"));
			const globalResult = loadGlossaryFile(globalFile, cwd);
			const projectResult = loadGlossaryFile(projectFile, cwd);

			activeScopes = computeActiveScopes(globalResult.scopeRefs, projectResult.scopeRefs, config);
			const activeScopeSet = new Set(activeScopes.map((s) => s.scope));

			const filteredGlobal = globalResult.entries.filter((e) => entryMatchesActiveScopes(e, activeScopeSet));
			const filteredProject = projectResult.entries.filter((e) => entryMatchesActiveScopes(e, activeScopeSet));

			const { merged, conflicts } = mergeEntries(filteredGlobal, filteredProject);

			entries = Array.from(merged.values()).map((entry, index) => {
				try {
					return { ...entry, matcher: buildMatcher(entry) };
				} catch (error) {
					throw new Error(
						`Invalid glossary ${describeGlossaryEntry(entry, index)}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			});

			const foundFiles = [globalResult, projectResult]
				.filter((result) => result.found)
				.map((result) => result.label ?? result.path);

			return { found: foundFiles.length > 0, count: entries.length, files: foundFiles, conflicts };
		} catch (error) {
			loadError = error instanceof Error ? error.message : String(error);
			return { found: false, count: 0, files: [] as string[], conflicts: [] as ConflictWarning[], error: loadError };
		}
	};

	const updateGlossaryWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const loadedTerms = [...loadedTermsForSession];
		if (loadedTerms.length === 0) {
			ctx.ui.setWidget("lazy-glossary", undefined);
			ctx.ui.setStatus("lazy-glossary", undefined);
			return;
		}
		ctx.ui.setWidget("lazy-glossary", undefined);
		ctx.ui.setStatus("lazy-glossary", `Glossary: ${loadedTerms.join(", ")}`);
	};

	pi.registerCommand("glossary", {
		description: "Show, reload, or manage glossary scopes",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			const subcommand = parts[0] ?? "";

			if (!subcommand || subcommand === "reload") {
				if (subcommand === "reload") {
					loadedTermsForSession = new Set<string>();
					updateGlossaryWidget(ctx);
					const result = loadGlossary(ctx.cwd);
					if (result.error) {
						ctx.ui.notify(`Glossary reload failed: ${result.error}`, "error");
						return;
					}
					for (const conflict of result.conflicts) {
						ctx.ui.notify(
							`Glossary conflict: "${conflict.term}" from ${conflict.winner} shadows ${conflict.shadowed.join(", ")}`,
							"warning",
						);
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
				ctx.ui.notify(`Glossary ready: ${entries.length} entries loaded`, "info");
				return;
			}

			if (subcommand === "scopes") {
				if (parts.length > 1) {
					ctx.ui.notify("Usage: /glossary scopes", "warning");
					return;
				}
				const lines = activeScopes.map((s) => `  ${s.scope} (${s.sources.join(", ")})`);
				ctx.ui.notify(`Active scopes:\n${lines.join("\n")}`, "info");
				return;
			}

			if (subcommand === "scope") {
				const action = parts[1] ?? "";
				const scopeName = parts.slice(2).join(" ");

				if (action === "enable") {
					if (!scopeName) {
						ctx.ui.notify("Usage: /glossary scope enable <scope>", "warning");
						return;
					}
					const config = loadConfig();
					const enabled = config.enabledScopes ?? [];
					if (!enabled.includes(scopeName)) {
						config.enabledScopes = [...enabled, scopeName];
						saveConfig(config);
					}
					loadedTermsForSession = new Set<string>();
					updateGlossaryWidget(ctx);
					const result = loadGlossary(ctx.cwd);
					if (result.error) {
						ctx.ui.notify(`Glossary reload failed: ${result.error}`, "error");
						return;
					}
					ctx.ui.notify(
						`Scope "${scopeName}" enabled. Glossary reloaded: ${result.count} entr${result.count === 1 ? "y" : "ies"}.`,
						"info",
					);
					return;
				}

				if (action === "disable") {
					if (!scopeName) {
						ctx.ui.notify("Usage: /glossary scope disable <scope>", "warning");
						return;
					}
					const config = loadConfig();
					config.enabledScopes = (config.enabledScopes ?? []).filter((s) => s !== scopeName);
					saveConfig(config);
					loadedTermsForSession = new Set<string>();
					updateGlossaryWidget(ctx);
					const result = loadGlossary(ctx.cwd);
					if (result.error) {
						ctx.ui.notify(`Glossary reload failed: ${result.error}`, "error");
						return;
					}
					ctx.ui.notify(
						`Scope "${scopeName}" disabled. Glossary reloaded: ${result.count} entr${result.count === 1 ? "y" : "ies"}.`,
						"info",
					);
					return;
				}

				ctx.ui.notify(
					"Usage: /glossary scope enable <scope> | /glossary scope disable <scope>",
					"warning",
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /glossary [reload] | /glossary scopes | /glossary scope enable <scope> | /glossary scope disable <scope>",
				"warning",
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
		for (const conflict of result.conflicts) {
			ctx.ui.notify(
				`Glossary conflict: "${conflict.term}" from ${conflict.winner} shadows ${conflict.shadowed.join(", ")}`,
				"warning",
			);
		}
		if (result.found && result.count > 0) {
			ctx.ui.notify(
				`Glossary loaded: ${result.count} entr${result.count === 1 ? "y" : "ies"}${summarizeGlossarySources(result.files)}`,
				"info",
			);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (entries.length === 0) return;

		const prompt = event.prompt?.trim();
		if (!prompt) return;

		const matched = entries.filter((entry) => entry.matcher.test(prompt));
		const newlyMatched = matched.filter((entry) => !loadedTermsForSession.has(entry.term));

		if (newlyMatched.length === 0) return;

		appendLoadedTerms(newlyMatched.map((entry) => entry.term));
		updateGlossaryWidget(ctx);

		const injectedGlossary = newlyMatched.map(formatEntry).join("\n\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Lazy-Loaded Agent Glossary\nThe user's prompt referenced explicit project glossary handles. Treat the following definitions as authoritative for this turn. Reuse them exactly as project-local language, and do not ask the user to restate them unless the definitions conflict or are ambiguous.\n\n${injectedGlossary}`,
		};
	});
}
