import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type GlossaryEntry = {
	term: string;
	definition: string;
	aliases?: string[];
	pattern?: string;
	flags?: string;
	enabled?: boolean;
	source?: string;
};

type GlossaryFile = {
	entries?: GlossaryEntry[];
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

export default function lazyGlossaryExtension(pi: ExtensionAPI) {
	let entries: CompiledEntry[] = [];
	let loadError: string | undefined;
	let matchedTermsForUi: string[] = [];

	const loadGlossary = (cwd: string) => {
		entries = [];
		loadError = undefined;

		const jsonFile = path.join(cwd, ".pi", "glossary.json");
		if (!fs.existsSync(jsonFile)) {
			return { found: false, count: 0, path: jsonFile };
		}

		try {
			const raw = fs.readFileSync(jsonFile, "utf8");
			const parsed = JSON.parse(raw) as GlossaryFile;
			const sourceEntries = Array.isArray(parsed.entries) ? parsed.entries : [];

			entries = sourceEntries
				.filter((entry) => entry && entry.enabled !== false)
				.map((entry, index) => {
					const validatedEntry = validateGlossaryEntry(entry, index);
					try {
						return {
							...validatedEntry,
							source: validatedEntry.source ?? path.relative(cwd, jsonFile),
							matcher: buildMatcher(validatedEntry),
						};
					} catch (error) {
						throw new Error(
							`Invalid glossary ${describeGlossaryEntry(validatedEntry, index)}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				});

			return { found: true, count: entries.length, path: jsonFile };
		} catch (error) {
			loadError = error instanceof Error ? error.message : String(error);
			return { found: true, count: 0, path: jsonFile, error: loadError };
		}
	};

	const updateGlossaryWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			return;
		}
		if (matchedTermsForUi.length === 0) {
			ctx.ui.setWidget("lazy-glossary", undefined);
			ctx.ui.setStatus("lazy-glossary", undefined);
			return;
		}
		ctx.ui.setWidget("lazy-glossary", [
			"Lazy glossary",
			...matchedTermsForUi.map((term) => `- ${term}`),
		]);
		ctx.ui.setStatus("lazy-glossary", `Glossary: ${matchedTermsForUi.join(", ")}`);
	};

	pi.registerCommand("glossary", {
		description: "Show or reload the lazy glossary configuration",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed && trimmed !== "reload") {
				ctx.ui.notify("Usage: /glossary or /glossary reload", "warning");
				return;
			}
			if (trimmed === "reload") {
				const result = loadGlossary(ctx.cwd);
				matchedTermsForUi = [];
				updateGlossaryWidget(ctx);
				if (result.error) {
					ctx.ui.notify(`Glossary reload failed: ${result.error}`, "error");
					return;
				}
				ctx.ui.notify(
					result.found
						? `Glossary reloaded: ${result.count} entr${result.count === 1 ? "y" : "ies"}`
						: "No .pi/glossary.json file found",
					"info",
				);
				return;
			}

			if (loadError) {
				ctx.ui.notify(`Glossary load error: ${loadError}`, "error");
				return;
			}

			if (entries.length === 0) {
				ctx.ui.notify("No glossary entries loaded from .pi/glossary.json", "info");
				return;
			}

			ctx.ui.notify(`Glossary ready: ${entries.length} entries loaded`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		matchedTermsForUi = [];
		updateGlossaryWidget(ctx);
		const result = loadGlossary(ctx.cwd);
		if (result.error) {
			ctx.ui.notify(`Glossary load failed: ${result.error}`, "error");
			return;
		}
		if (result.found && result.count > 0) {
			ctx.ui.notify(`Lazy glossary loaded: ${result.count} entr${result.count === 1 ? "y" : "ies"}`, "info");
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		matchedTermsForUi = [];
		updateGlossaryWidget(ctx);

		if (entries.length === 0) {
			return;
		}

		const prompt = event.prompt?.trim();
		if (!prompt) {
			return;
		}

		const matched = entries.filter((entry) => entry.matcher.test(prompt));

		if (matched.length === 0) {
			return;
		}

		matchedTermsForUi = matched.map((entry) => entry.term);
		updateGlossaryWidget(ctx);

		const injectedGlossary = matched.map(formatEntry).join("\n\n");

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Lazy-Loaded Agent Glossary\nThe user's prompt referenced explicit project glossary handles. Treat the following definitions as authoritative for this turn. Reuse them exactly as project-local language, and do not ask the user to restate them unless the definitions conflict or are ambiguous.\n\n${injectedGlossary}`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		matchedTermsForUi = [];
		updateGlossaryWidget(ctx);
	});
}
