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

type SupabaseConfig = {
	url: string;
	publishableKey?: string;
	anonKey?: string;
	enabled?: boolean;
};

type GlossaryConfig = {
	enabledScopes?: string[];
	supabase?: SupabaseConfig;
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

type SupabaseRow = {
	id?: string;
	scope: string;
	term: string;
	definition: string;
	aliases: string[] | null;
	pattern?: string | null;
	flags?: string | null;
	enabled?: boolean | null;
	source?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
};

type RemoteLoadResult = {
	entries: GlossaryEntry[];
	error?: string;
	skipped: boolean;
};

type GlossaryStore = "local" | "supabase";

type LocalGlossaryTarget = {
	path: string;
	label: string;
};

type EntryDraft = {
	id?: string;
	term: string;
	definition: string;
	aliases?: string[];
	pattern?: string;
	flags?: string;
	enabled?: boolean;
	source?: string;
	scope: string;
	createdAt?: string;
	updatedAt?: string;
};

type SupabaseMutationResult<T = unknown> = {
	ok: boolean;
	status: number;
	data?: T;
	error?: string;
};

const SUPABASE_SCHEMA = "public";
const SUPABASE_TABLE = "glossary_entry";
const SUPABASE_TABLE_FQN = `${SUPABASE_SCHEMA}.${SUPABASE_TABLE}`;
const SUPABASE_SELECT = "id,scope,term,definition,aliases,pattern,flags,enabled,source,created_at,updated_at";

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

function getSupabaseApiKey(supabase: SupabaseConfig): string | undefined {
	return supabase.publishableKey?.trim() || supabase.anonKey?.trim();
}

function normalizeSupabaseProjectUrl(projectUrl: string): string {
	return projectUrl.trim().replace(/\/+$/, "").replace(/\/rest\/v1(?:\/.*)?$/i, "");
}

function looksLikeSecretKey(apiKey: string): boolean {
	return apiKey.startsWith("sb_secret_");
}

function buildSupabaseHeaders(apiKey: string): Record<string, string> {
	return {
		apikey: apiKey,
		"Content-Type": "application/json",
		"Accept-Profile": SUPABASE_SCHEMA,
		"Content-Profile": SUPABASE_SCHEMA,
	};
}

function buildSupabaseTableUrl(projectUrl: string, query?: string): string {
	const baseUrl = normalizeSupabaseProjectUrl(projectUrl);
	return `${baseUrl}/rest/v1/${SUPABASE_TABLE}${query ? `?${query}` : ""}`;
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

async function loadRemoteEntries(supabase: SupabaseConfig, activeScopes: Set<string>): Promise<RemoteLoadResult> {
	if (!supabase.enabled) {
		return { entries: [], skipped: true };
	}

	const apiKey = getSupabaseApiKey(supabase);
	if (!apiKey) {
		return { entries: [], error: "no publishable key configured", skipped: false };
	}

	const params = new URLSearchParams();
	params.set("select", SUPABASE_SELECT);
	params.set("scope", buildSupabaseInFilter(Array.from(activeScopes)));
	params.set("enabled", "eq.true");

	const url = buildSupabaseTableUrl(supabase.url, params.toString());

	try {
		const response = await fetch(url, {
			headers: buildSupabaseHeaders(apiKey),
		});

		if (!response.ok) {
			const text = await response.text();
			return { entries: [], error: `HTTP ${response.status}: ${text}`, skipped: false };
		}

		const rows = (await response.json()) as SupabaseRow[];

		const entries: GlossaryEntry[] = rows.map((row) => ({
			term: row.term,
			definition: row.definition,
			aliases: row.aliases ?? [],
			pattern: row.pattern ?? undefined,
			flags: row.flags ?? undefined,
			source: row.source ?? `supabase:${row.scope}`,
			scopes: [row.scope],
		}));

		return { entries, skipped: false };
	} catch (error) {
		return { entries: [], error: error instanceof Error ? error.message : String(error), skipped: false };
	}
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
	supabaseEntries: GlossaryEntry[],
	projectEntries: GlossaryEntry[],
): { merged: Map<string, GlossaryEntry>; conflicts: ConflictWarning[] } {
	const merged = new Map<string, GlossaryEntry>();
	const conflicts: ConflictWarning[] = [];

	// Global first (lowest priority among non-project sources)
	for (const entry of globalEntries) {
		merged.set(entry.term, entry);
	}

	// Supabase overrides global; conflict detected when both define the same term
	for (const entry of supabaseEntries) {
		const existing = merged.get(entry.term);
		if (existing) {
			conflicts.push({
				term: entry.term,
				winner: entry.source ?? "supabase",
				shadowed: [existing.source ?? "global"],
			});
		}
		merged.set(entry.term, entry);
	}

	// Project overrides everything; no warning needed
	for (const entry of projectEntries) {
		merged.set(entry.term, entry);
	}

	return { merged, conflicts };
}

// ── Provisioning layer ────────────────────────────────────────────────────────

const PROVISIONING_SQL = `-- pi-glossary reads and writes public.glossary_entry via the Supabase REST API.
-- WARNING: with a publishable key and no user JWT, writes run as the anon role.
-- The grants and policies below allow create/update/delete through the REST API.
create table if not exists public.glossary_entry (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  term text not null,
  definition text not null,
  aliases jsonb not null default '[]'::jsonb,
  pattern text null,
  flags text null,
  enabled boolean not null default true,
  source text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint glossary_entry_scope_nonempty check (btrim(scope) <> ''),
  constraint glossary_entry_term_nonempty check (btrim(term) <> ''),
  constraint glossary_entry_definition_nonempty check (btrim(definition) <> ''),
  constraint glossary_entry_aliases_is_array check (jsonb_typeof(aliases) = 'array')
);

create unique index if not exists glossary_entry_scope_term
  on public.glossary_entry (scope, term);

create index if not exists glossary_entry_scope_enabled
  on public.glossary_entry (scope, enabled);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.glossary_entry to anon, authenticated;

alter table public.glossary_entry enable row level security;

drop policy if exists "public can read glossary entries" on public.glossary_entry;
create policy "public can read glossary entries"
  on public.glossary_entry
  for select
  to anon, authenticated
  using (true);

drop policy if exists "public can insert glossary entries" on public.glossary_entry;
create policy "public can insert glossary entries"
  on public.glossary_entry
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "public can update glossary entries" on public.glossary_entry;
create policy "public can update glossary entries"
  on public.glossary_entry
  for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "public can delete glossary entries" on public.glossary_entry;
create policy "public can delete glossary entries"
  on public.glossary_entry
  for delete
  to anon, authenticated
  using (true);`;

async function checkTableExists(url: string, apiKey: string): Promise<{ exists: boolean; error?: string }> {
	try {
		const response = await fetch(buildSupabaseTableUrl(url, "select=term&limit=0"), {
			headers: buildSupabaseHeaders(apiKey),
		});
		if (response.ok) return { exists: true };
		const text = await response.text();
		let data: { code?: string; message?: string } | undefined;
		try {
			data = JSON.parse(text) as { code?: string; message?: string };
		} catch {
			data = undefined;
		}
		if (response.status === 404 || data?.code === "42P01" || data?.code === "PGRST205") {
			return { exists: false };
		}
		return { exists: false, error: data?.message ?? text ?? `HTTP ${response.status}` };
	} catch (error) {
		return { exists: false, error: error instanceof Error ? error.message : String(error) };
	}
}

// ── Utility ───────────────────────────────────────────────────────────────────

function summarizeGlossarySources(files: string[]): string {
	if (files.length === 0) return "";
	if (files.length === 1) return ` from ${files[0]}`;
	return ` from ${files.join(" and ")}`;
}

function maskKey(key: string): string {
	if (key.length <= 8) return "****";
	return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function normalizeScope(scope?: string): string {
	const trimmed = scope?.trim();
	return trimmed ? trimmed : "default";
}

function getEntryScopes(entry: Partial<GlossaryEntry>): string[] {
	const scopes = entry.scopes?.map((scope) => scope.trim()).filter(Boolean);
	return scopes && scopes.length > 0 ? scopes : ["default"];
}

function entryHasScope(entry: Partial<GlossaryEntry>, scope: string): boolean {
	return getEntryScopes(entry).includes(normalizeScope(scope));
}

function parseAliasInput(value: string): string[] | undefined {
	const aliases = value
		.split(",")
		.map((alias) => alias.trim())
		.filter(Boolean);
	return aliases.length > 0 ? aliases : undefined;
}

function toEntryDraft(entry: GlossaryEntry, scope?: string): EntryDraft {
	const scopes = getEntryScopes(entry);
	return {
		term: entry.term,
		definition: entry.definition,
		aliases: entry.aliases,
		pattern: entry.pattern,
		flags: entry.flags,
		enabled: entry.enabled,
		source: entry.source,
		scope: normalizeScope(scope ?? scopes[0]),
	};
}

function supabaseRowToDraft(row: SupabaseRow): EntryDraft {
	return {
		id: row.id ?? undefined,
		term: row.term,
		definition: row.definition,
		aliases: row.aliases ?? undefined,
		pattern: row.pattern ?? undefined,
		flags: row.flags ?? undefined,
		enabled: row.enabled ?? true,
		source: row.source ?? undefined,
		scope: normalizeScope(row.scope),
		createdAt: row.created_at ?? undefined,
		updatedAt: row.updated_at ?? undefined,
	};
}

function buildGlossaryEntryRecord(draft: EntryDraft): GlossaryEntry {
	const validated = validateGlossaryEntry(
		{
			term: draft.term,
			definition: draft.definition,
			aliases: draft.aliases,
			pattern: draft.pattern,
			flags: draft.flags,
			enabled: draft.enabled,
			source: draft.source,
			scopes: draft.scope === "default" ? undefined : [draft.scope],
		},
		0,
	);

	return {
		...validated,
		enabled: draft.enabled ?? true,
	};
}

function formatGlossaryEntrySummary(entry: GlossaryEntry): string {
	const parts = [`term=${entry.term}`, `scopes=${getEntryScopes(entry).join(",")}`];
	if (entry.aliases?.length) parts.push(`aliases=${entry.aliases.join(",")}`);
	if (entry.pattern) parts.push(`pattern=${entry.pattern}`);
	if (entry.flags) parts.push(`flags=${entry.flags}`);
	if (entry.enabled === false) parts.push("enabled=false");
	if (entry.source) parts.push(`source=${entry.source}`);
	return `${parts.join(" | ")}\n${entry.definition}`;
}

function formatSupabaseEntrySummary(row: SupabaseRow): string {
	const parts = [`term=${row.term}`, `scope=${row.scope}`];
	if (row.id) parts.push(`id=${row.id}`);
	if ((row.aliases ?? []).length) parts.push(`aliases=${(row.aliases ?? []).join(",")}`);
	if (row.pattern) parts.push(`pattern=${row.pattern}`);
	if (row.flags) parts.push(`flags=${row.flags}`);
	if (row.enabled === false) parts.push("enabled=false");
	if (row.source) parts.push(`source=${row.source}`);
	if (row.created_at) parts.push(`created_at=${row.created_at}`);
	if (row.updated_at) parts.push(`updated_at=${row.updated_at}`);
	return `${parts.join(" | ")}\n${row.definition}`;
}

function resolveExistingGlossaryFileIfAny(basePath: string): string | undefined {
	const jsonFile = `${basePath}.json`;
	const jsonlFile = `${basePath}.jsonl`;
	const hasJson = fs.existsSync(jsonFile);
	const hasJsonl = fs.existsSync(jsonlFile);

	if (hasJson && hasJsonl) {
		throw new Error(`Ambiguous glossary configuration: found both ${jsonFile} and ${jsonlFile}. Keep only one.`);
	}

	if (hasJsonl) return jsonlFile;
	if (hasJson) return jsonFile;
	return undefined;
}

function chooseLocalGlossaryTarget(cwd: string): LocalGlossaryTarget {
	const projectBase = path.join(cwd, ".pi", "glossary");
	const globalBase = path.join(os.homedir(), ".pi", "agent", "glossary");
	const projectFile = resolveExistingGlossaryFileIfAny(projectBase);
	if (projectFile) return { path: projectFile, label: "project local" };

	const looksLikeProject = fs.existsSync(path.join(cwd, ".git")) || fs.existsSync(path.join(cwd, ".pi"));
	if (looksLikeProject && cwd !== os.homedir()) {
		return { path: `${projectBase}.jsonl`, label: "project local" };
	}

	const globalFile = resolveExistingGlossaryFileIfAny(globalBase) ?? `${globalBase}.jsonl`;
	return { path: globalFile, label: "global local" };
}

function readGlossaryRecordsForMutation(glossaryFile: string): GlossaryRecord[] {
	if (!fs.existsSync(glossaryFile)) {
		return [];
	}
	return parseGlossaryFile(fs.readFileSync(glossaryFile, "utf8"), glossaryFile);
}

function writeGlossaryRecords(glossaryFile: string, records: GlossaryRecord[]): void {
	fs.mkdirSync(path.dirname(glossaryFile), { recursive: true });
	if (glossaryFile.endsWith(".jsonl")) {
		const content = records.map((record) => JSON.stringify(record)).join("\n");
		fs.writeFileSync(glossaryFile, content.length > 0 ? `${content}\n` : "", "utf8");
		return;
	}
	fs.writeFileSync(glossaryFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

function findLocalGlossaryEntries(records: GlossaryRecord[], term: string, scope?: string): Array<{ index: number; entry: GlossaryEntry }> {
	const normalizedTerm = term.trim();
	const normalizedScope = scope ? normalizeScope(scope) : undefined;
	const matches: Array<{ index: number; entry: GlossaryEntry }> = [];

	for (const [index, record] of records.entries()) {
		if (!record || typeof record !== "object" || isScopeRef(record)) continue;
		const entry = record as GlossaryEntry;
		if (entry.term?.trim() !== normalizedTerm) continue;
		if (normalizedScope && !entryHasScope(entry, normalizedScope)) continue;
		matches.push({ index, entry });
	}

	return matches;
}

function buildSupabaseEqFilter(value: string): string {
	return `eq.${JSON.stringify(value)}`;
}

function buildSupabaseInFilter(values: string[]): string {
	return `in.(${values.map((value) => JSON.stringify(value)).join(",")})`;
}

async function runSupabaseMutation<T>(
	supabase: SupabaseConfig,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	query: URLSearchParams,
	body?: Record<string, unknown> | Array<Record<string, unknown>>,
): Promise<SupabaseMutationResult<T>> {
	const apiKey = getSupabaseApiKey(supabase);
	if (!apiKey) {
		return { ok: false, status: 0, error: "no publishable key configured" };
	}

	const headers: Record<string, string> = {
		...buildSupabaseHeaders(apiKey),
	};

	if (method !== "GET") {
		headers.Prefer = "return=representation";
	}

	try {
		const response = await fetch(buildSupabaseTableUrl(supabase.url, query.toString()), {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		});
		const text = await response.text();
		let data: unknown;
		if (text) {
			try {
				data = JSON.parse(text) as unknown;
			} catch {
				data = text;
			}
		}

		if (!response.ok) {
			const error =
				typeof data === "object" && data !== null && "message" in data
					? String((data as { message: unknown }).message)
					: typeof data === "string"
						? data
						: `HTTP ${response.status}`;
			return { ok: false, status: response.status, error };
		}

		return { ok: true, status: response.status, data: data as T };
	} catch (error) {
		return {
			ok: false,
			status: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function lazyGlossaryExtension(pi: ExtensionAPI) {
	let entries: CompiledEntry[] = [];
	let loadError: string | undefined;
	let remoteError: string | undefined;
	let remoteSkipped = true;
	let remoteCount = 0;
	let loadedTermsForSession = new Set<string>();
	let activeScopes: ScopeInfo[] = [{ scope: "default", sources: ["implicit"] }];

	const appendLoadedTerms = (terms: string[]) => {
		for (const term of terms) {
			loadedTermsForSession.add(term);
		}
	};

	const loadGlossary = async (cwd: string) => {
		entries = [];
		loadError = undefined;
		remoteError = undefined;
		remoteSkipped = true;
		remoteCount = 0;

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

			let supabaseEntries: GlossaryEntry[] = [];
			if (config.supabase) {
				const remoteResult = await loadRemoteEntries(config.supabase, activeScopeSet);
				remoteSkipped = remoteResult.skipped;
				if (remoteResult.error) {
					remoteError = remoteResult.error;
				} else {
					supabaseEntries = remoteResult.entries;
					remoteCount = supabaseEntries.length;
				}
			}

			const { merged, conflicts } = mergeEntries(filteredGlobal, supabaseEntries, filteredProject);

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

	const getDefaultScope = () => activeScopes.find((scope) => scope.scope !== "default")?.scope ?? "default";

	const reloadAfterMutation = async (ctx: ExtensionContext, message: string) => {
		loadedTermsForSession = new Set<string>();
		updateGlossaryWidget(ctx);
		const result = await loadGlossary(ctx.cwd);
		if (result.error) {
			ctx.ui.notify(`${message}\n\nGlossary reload failed: ${result.error}`, "warning");
			return false;
		}
		if (remoteError) {
			ctx.ui.notify(`Supabase load failed (local entries still active): ${remoteError}`, "warning");
		}
		for (const conflict of result.conflicts) {
			ctx.ui.notify(
				`Glossary conflict: "${conflict.term}" from ${conflict.winner} shadows ${conflict.shadowed.join(", ")}`,
				"warning",
			);
		}
		ctx.ui.notify(`${message}\n\nGlossary reloaded: ${result.count} entr${result.count === 1 ? "y" : "ies"}.`, "info");
		return true;
	};

	const chooseStore = async (ctx: ExtensionContext, purpose: string): Promise<GlossaryStore> => {
		const sb = loadConfig().supabase;
		if (!sb?.enabled) {
			return "local";
		}
		const useSupabase = await ctx.ui.confirm(
			`Use Supabase for ${purpose}?`,
			`Supabase is configured. Use Supabase instead of the local glossary file for ${purpose}?`,
		);
		return useSupabase ? "supabase" : "local";
	};

	const promptForScope = async (ctx: ExtensionContext, title: string, initial?: string, allowBlank = false) => {
		const value = await ctx.ui.input(title, allowBlank ? initial ?? "" : initial ?? getDefaultScope());
		if (value === undefined) return undefined;
		const trimmed = value.trim();
		if (allowBlank && trimmed.length === 0) return "";
		return normalizeScope(trimmed || initial || getDefaultScope());
	};

	const promptForDraft = async (ctx: ExtensionContext, base?: Partial<EntryDraft>) => {
		const termValue = await ctx.ui.input("Glossary term", base?.term ?? "");
		if (termValue === undefined) return undefined;
		const term = termValue.trim();
		if (!term) {
			ctx.ui.notify("Term is required.", "error");
			return undefined;
		}

		const scope = await promptForScope(ctx, "Scope", base?.scope);
		if (scope === undefined) return undefined;

		const definitionValue = await ctx.ui.input("Definition", base?.definition ?? "");
		if (definitionValue === undefined) return undefined;
		const definition = definitionValue.trim();
		if (!definition) {
			ctx.ui.notify("Definition is required.", "error");
			return undefined;
		}

		const aliasesValue = await ctx.ui.input("Aliases (comma-separated, optional)", base?.aliases?.join(", ") ?? "");
		if (aliasesValue === undefined) return undefined;

		const patternValue = await ctx.ui.input("Pattern (optional regex)", base?.pattern ?? "");
		if (patternValue === undefined) return undefined;

		const flagsValue = await ctx.ui.input("Pattern flags (optional)", base?.flags ?? "");
		if (flagsValue === undefined) return undefined;

		const sourceValue = await ctx.ui.input("Source (optional)", base?.source ?? "");
		if (sourceValue === undefined) return undefined;

		const enabledInitial = base?.enabled === false ? "false" : "true";
		const enabledValue = await ctx.ui.input("Enabled (true/false)", enabledInitial);
		if (enabledValue === undefined) return undefined;
		const normalizedEnabled = enabledValue.trim().toLowerCase();
		if (!["true", "false", "1", "0", "yes", "no", "y", "n"].includes(normalizedEnabled)) {
			ctx.ui.notify("Enabled must be true or false.", "error");
			return undefined;
		}
		const enabled = ["true", "1", "yes", "y"].includes(normalizedEnabled);

		return {
			id: base?.id,
			term,
			scope,
			definition,
			aliases: parseAliasInput(aliasesValue),
			pattern: patternValue.trim() || undefined,
			flags: flagsValue.trim() || undefined,
			source: sourceValue.trim() || undefined,
			enabled,
			createdAt: base?.createdAt,
			updatedAt: base?.updatedAt,
		} satisfies EntryDraft;
	};

	const getConfiguredSupabase = (ctx: ExtensionContext) => {
		const sb = loadConfig().supabase;
		if (!sb?.enabled) {
			ctx.ui.notify("Supabase is not configured. Run /glossary init supabase or save locally.", "error");
			return undefined;
		}
		if (!getSupabaseApiKey(sb)) {
			ctx.ui.notify("Supabase is configured but no publishable key is stored.", "error");
			return undefined;
		}
		return sb;
	};

	const maybeWarnInactiveScope = (ctx: ExtensionContext, scope: string, store: GlossaryStore) => {
		if (scope === "default") return;
		if (activeScopes.some((item) => item.scope === scope)) return;
		ctx.ui.notify(
			`Saved to ${store}, but scope "${scope}" is not active in this session. Run /glossary scope enable ${scope} if you want it loaded here.`,
			"warning",
		);
	};

	const mapSupabaseRowToEntry = (row: SupabaseRow): GlossaryEntry => ({
		term: row.term,
		definition: row.definition,
		aliases: row.aliases ?? [],
		pattern: row.pattern ?? undefined,
		flags: row.flags ?? undefined,
		enabled: row.enabled ?? true,
		source: row.source ?? `supabase:${row.scope}`,
		scopes: [row.scope],
	});

	pi.registerCommand("glossary", {
		description: "Show, reload, or manage glossary scopes, entries, and Supabase connection",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const parts = trimmed.split(/\s+/).filter(Boolean);
			const subcommand = parts[0] ?? "";

			if (!subcommand || subcommand === "reload") {
				if (subcommand === "reload") {
					loadedTermsForSession = new Set<string>();
					updateGlossaryWidget(ctx);
					const result = await loadGlossary(ctx.cwd);
					if (result.error) {
						ctx.ui.notify(`Glossary reload failed: ${result.error}`, "error");
						return;
					}
					if (remoteError) {
						ctx.ui.notify(`Supabase load failed (local entries still active): ${remoteError}`, "warning");
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
					const result = await loadGlossary(ctx.cwd);
					if (result.error) {
						ctx.ui.notify(`Glossary reload failed: ${result.error}`, "error");
						return;
					}
					if (remoteError) {
						ctx.ui.notify(`Supabase load failed (local entries still active): ${remoteError}`, "warning");
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
					const result = await loadGlossary(ctx.cwd);
					if (result.error) {
						ctx.ui.notify(`Glossary reload failed: ${result.error}`, "error");
						return;
					}
					if (remoteError) {
						ctx.ui.notify(`Supabase load failed (local entries still active): ${remoteError}`, "warning");
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

			if (subcommand === "entry" || subcommand === "entries") {
				if (!ctx.hasUI) {
					ctx.ui.notify("Glossary entry CRUD requires interactive mode.", "error");
					return;
				}

				const action = parts[1] ?? "list";
				const initialTerm = parts.slice(2).join(" ").trim();
				const store = await chooseStore(ctx, action);

				if (action === "create") {
					const draft = await promptForDraft(ctx, {
						term: initialTerm,
						scope: getDefaultScope(),
						enabled: true,
					});
					if (!draft) return;

					if (store === "local") {
						const target = chooseLocalGlossaryTarget(ctx.cwd);
						const records = readGlossaryRecordsForMutation(target.path);
						if (findLocalGlossaryEntries(records, draft.term, draft.scope).length > 0) {
							ctx.ui.notify(`A local entry already exists for term "${draft.term}" in scope "${draft.scope}".`, "error");
							return;
						}
						records.push(buildGlossaryEntryRecord(draft));
						writeGlossaryRecords(target.path, records);
						await reloadAfterMutation(
							ctx,
							`Created local glossary entry in ${target.label}: ${path.relative(ctx.cwd, target.path) || target.path}`,
						);
						maybeWarnInactiveScope(ctx, draft.scope, store);
						return;
					}

					const supabase = getConfiguredSupabase(ctx);
					if (!supabase) return;
					const result = await runSupabaseMutation<SupabaseRow[]>(supabase, "POST", new URLSearchParams(), [
						{
							scope: draft.scope,
							term: draft.term,
							definition: draft.definition,
							aliases: draft.aliases ?? [],
							pattern: draft.pattern ?? null,
							flags: draft.flags ?? null,
							enabled: draft.enabled ?? true,
							source: draft.source ?? null,
						},
					]);
					if (!result.ok) {
						ctx.ui.notify(`Supabase create failed: ${result.error}`, "error");
						return;
					}
					await reloadAfterMutation(ctx, `Created Supabase glossary entry in scope "${draft.scope}".`);
					maybeWarnInactiveScope(ctx, draft.scope, store);
					return;
				}

				if (action === "get" || action === "show" || action === "read") {
					const termInput = initialTerm || (await ctx.ui.input("Glossary term", ""))?.trim();
					if (!termInput) {
						ctx.ui.notify("Term is required.", "error");
						return;
					}
					const scope = await promptForScope(ctx, "Scope", getDefaultScope(), true);
					if (scope === undefined) return;

					if (store === "local") {
						const target = chooseLocalGlossaryTarget(ctx.cwd);
						const records = readGlossaryRecordsForMutation(target.path);
						const matches = findLocalGlossaryEntries(records, termInput, scope || undefined);
						if (matches.length === 0) {
							ctx.ui.notify(`No local entry found for term "${termInput}"${scope ? ` in scope "${scope}"` : ""}.`, "info");
							return;
						}
						ctx.ui.notify(
							`Local glossary entries (${path.relative(ctx.cwd, target.path) || target.path}):\n\n${matches.map((match) => formatGlossaryEntrySummary(match.entry)).join("\n\n")}`,
							"info",
						);
						return;
					}

					const supabase = getConfiguredSupabase(ctx);
					if (!supabase) return;
					const query = new URLSearchParams();
					query.set("select", SUPABASE_SELECT);
					query.set("term", buildSupabaseEqFilter(termInput));
					if (scope) query.set("scope", buildSupabaseEqFilter(scope));
					const result = await runSupabaseMutation<SupabaseRow[]>(supabase, "GET", query);
					if (!result.ok) {
						ctx.ui.notify(`Supabase read failed: ${result.error}`, "error");
						return;
					}
					const rows = result.data ?? [];
					if (rows.length === 0) {
						ctx.ui.notify(`No Supabase entry found for term "${termInput}"${scope ? ` in scope "${scope}"` : ""}.`, "info");
						return;
					}
					ctx.ui.notify(
						`Supabase glossary entries:\n\n${rows.map((row) => formatSupabaseEntrySummary(row)).join("\n\n")}`,
						"info",
					);
					return;
				}

				if (action === "update") {
					const termInput = initialTerm || (await ctx.ui.input("Glossary term", ""))?.trim();
					if (!termInput) {
						ctx.ui.notify("Term is required.", "error");
						return;
					}
					const scope = await promptForScope(ctx, "Scope", getDefaultScope());
					if (!scope) return;

					if (store === "local") {
						const target = chooseLocalGlossaryTarget(ctx.cwd);
						const records = readGlossaryRecordsForMutation(target.path);
						const matches = findLocalGlossaryEntries(records, termInput, scope);
						if (matches.length === 0) {
							ctx.ui.notify(`No local entry found for term "${termInput}" in scope "${scope}".`, "error");
							return;
						}
						const current = matches[0];
						const draft = await promptForDraft(ctx, toEntryDraft(current.entry, scope));
						if (!draft) return;
						const duplicate = findLocalGlossaryEntries(records, draft.term, draft.scope).find(
							(match) => match.index !== current.index,
						);
						if (duplicate) {
							ctx.ui.notify(`Another local entry already exists for term "${draft.term}" in scope "${draft.scope}".`, "error");
							return;
						}
						records[current.index] = buildGlossaryEntryRecord({ ...draft, enabled: current.entry.enabled ?? true });
						writeGlossaryRecords(target.path, records);
						await reloadAfterMutation(
							ctx,
							`Updated local glossary entry in ${target.label}: ${path.relative(ctx.cwd, target.path) || target.path}`,
						);
						maybeWarnInactiveScope(ctx, draft.scope, store);
						return;
					}

					const supabase = getConfiguredSupabase(ctx);
					if (!supabase) return;
					const readQuery = new URLSearchParams();
					readQuery.set("select", SUPABASE_SELECT);
					readQuery.set("term", buildSupabaseEqFilter(termInput));
					readQuery.set("scope", buildSupabaseEqFilter(scope));
					const existing = await runSupabaseMutation<SupabaseRow[]>(supabase, "GET", readQuery);
					if (!existing.ok) {
						ctx.ui.notify(`Supabase read failed: ${existing.error}`, "error");
						return;
					}
					if (!existing.data || existing.data.length === 0) {
						ctx.ui.notify(`No Supabase entry found for term "${termInput}" in scope "${scope}".`, "error");
						return;
					}
					const draft = await promptForDraft(ctx, supabaseRowToDraft(existing.data[0]));
					if (!draft) return;
					const patchQuery = new URLSearchParams();
					patchQuery.set("term", buildSupabaseEqFilter(termInput));
					patchQuery.set("scope", buildSupabaseEqFilter(scope));
					const result = await runSupabaseMutation<SupabaseRow[]>(supabase, "PATCH", patchQuery, {
						scope: draft.scope,
						term: draft.term,
						definition: draft.definition,
						aliases: draft.aliases ?? [],
						pattern: draft.pattern ?? null,
						flags: draft.flags ?? null,
						enabled: draft.enabled ?? true,
						source: draft.source ?? null,
					});
					if (!result.ok) {
						ctx.ui.notify(`Supabase update failed: ${result.error}`, "error");
						return;
					}
					await reloadAfterMutation(ctx, `Updated Supabase glossary entry in scope "${draft.scope}".`);
					maybeWarnInactiveScope(ctx, draft.scope, store);
					return;
				}

				if (action === "delete") {
					const termInput = initialTerm || (await ctx.ui.input("Glossary term", ""))?.trim();
					if (!termInput) {
						ctx.ui.notify("Term is required.", "error");
						return;
					}
					const scope = await promptForScope(ctx, "Scope", getDefaultScope());
					if (!scope) return;

					if (store === "local") {
						const target = chooseLocalGlossaryTarget(ctx.cwd);
						const records = readGlossaryRecordsForMutation(target.path);
						const matches = findLocalGlossaryEntries(records, termInput, scope);
						if (matches.length === 0) {
							ctx.ui.notify(`No local entry found for term "${termInput}" in scope "${scope}".`, "error");
							return;
						}
						const confirmed = await ctx.ui.confirm(
							"Delete glossary entry?",
							formatGlossaryEntrySummary(matches[0].entry),
						);
						if (!confirmed) return;
						records.splice(matches[0].index, 1);
						writeGlossaryRecords(target.path, records);
						await reloadAfterMutation(
							ctx,
							`Deleted local glossary entry from ${target.label}: ${path.relative(ctx.cwd, target.path) || target.path}`,
						);
						return;
					}

					const supabase = getConfiguredSupabase(ctx);
					if (!supabase) return;
					const confirmed = await ctx.ui.confirm(
						"Delete Supabase glossary entry?",
						`term=${termInput}\nscope=${scope}`,
					);
					if (!confirmed) return;
					const query = new URLSearchParams();
					query.set("term", buildSupabaseEqFilter(termInput));
					query.set("scope", buildSupabaseEqFilter(scope));
					const result = await runSupabaseMutation<SupabaseRow[]>(supabase, "DELETE", query);
					if (!result.ok) {
						ctx.ui.notify(`Supabase delete failed: ${result.error}`, "error");
						return;
					}
					await reloadAfterMutation(ctx, `Deleted Supabase glossary entry from scope "${scope}".`);
					return;
				}

				if (action === "list") {
					const scope = await promptForScope(ctx, "Scope (leave blank for all)", "", true);
					if (scope === undefined) return;

					if (store === "local") {
						const target = chooseLocalGlossaryTarget(ctx.cwd);
						const records = readGlossaryRecordsForMutation(target.path);
						const entriesOnly = records
							.filter((record) => record && typeof record === "object" && !isScopeRef(record))
							.map((record) => record as GlossaryEntry)
							.filter((entry) => !scope || entryHasScope(entry, scope))
							.sort((a, b) => a.term.localeCompare(b.term));
						if (entriesOnly.length === 0) {
							ctx.ui.notify(`No local glossary entries found${scope ? ` in scope "${scope}"` : ""}.`, "info");
							return;
						}
						ctx.ui.notify(
							`Local glossary entries (${path.relative(ctx.cwd, target.path) || target.path}):\n\n${entriesOnly.map(formatGlossaryEntrySummary).join("\n\n")}`,
							"info",
						);
						return;
					}

					const supabase = getConfiguredSupabase(ctx);
					if (!supabase) return;
					const query = new URLSearchParams();
					query.set("select", SUPABASE_SELECT);
					query.set("order", "scope.asc,term.asc");
					if (scope) query.set("scope", buildSupabaseEqFilter(scope));
					const result = await runSupabaseMutation<SupabaseRow[]>(supabase, "GET", query);
					if (!result.ok) {
						ctx.ui.notify(`Supabase list failed: ${result.error}`, "error");
						return;
					}
					const rows = result.data ?? [];
					if (rows.length === 0) {
						ctx.ui.notify(`No Supabase glossary entries found${scope ? ` in scope "${scope}"` : ""}.`, "info");
						return;
					}
					ctx.ui.notify(
						`Supabase glossary entries:\n\n${rows.map((row) => formatSupabaseEntrySummary(row)).join("\n\n")}`,
						"info",
					);
					return;
				}

				ctx.ui.notify(
					"Usage: /glossary entry create|get|update|delete|list",
					"warning",
				);
				return;
			}

			if (subcommand === "supabase") {
				const action = parts[1] ?? "";

				if (action === "status") {
					const config = loadConfig();
					const sb = config.supabase;

					if (!sb) {
						ctx.ui.notify(
							"Supabase: not configured\n\nRun /glossary init supabase to set up.",
							"info",
						);
						return;
					}

					const apiKey = getSupabaseApiKey(sb);
					const lines: string[] = [
						`Supabase: ${sb.enabled ? "enabled" : "disabled"}`,
						`URL: ${sb.url}`,
						`Schema/table: ${SUPABASE_TABLE_FQN}`,
						`Publishable key: ${apiKey ? maskKey(apiKey) : "not set"}`,
					];

					if (remoteSkipped) {
						lines.push("Remote load: skipped (disabled)");
					} else if (remoteError) {
						lines.push(`Remote load: failed — ${remoteError}`);
					} else {
						lines.push(`Remote load: ${remoteCount} entr${remoteCount === 1 ? "y" : "ies"} loaded`);
					}

					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				ctx.ui.notify(
					"Usage: /glossary supabase status\n\nTo set up Supabase, run: /glossary init supabase",
					"warning",
				);
				return;
			}

			if (subcommand === "init") {
				const target = parts[1] ?? "";

				if (target !== "supabase") {
					ctx.ui.notify("Usage: /glossary init supabase", "warning");
					return;
				}

				if (!ctx.hasUI) {
					ctx.ui.notify("Supabase init requires interactive mode.", "error");
					return;
				}

				const config = loadConfig();
				const existing = config.supabase;

				// ── Step 1: Connection ────────────────────────────────────────

				let updateConnection = true;
				const existingKey = existing ? getSupabaseApiKey(existing) : undefined;
				if (existing) {
					updateConnection = await ctx.ui.confirm(
						"Reconfigure Supabase connection?",
						`Current URL: ${existing.url}\nPublishable key: ${existingKey ? maskKey(existingKey) : "not set"}\nExpected table: ${SUPABASE_TABLE_FQN}\n\nUpdate these values?`,
					);
				}

				let url = existing?.url ?? "";
				let publishableKey = existingKey ?? "";

				if (updateConnection) {
					const urlInput = await ctx.ui.input(
						"Supabase project URL",
						existing?.url ?? "https://your-project.supabase.co",
					);
					if (urlInput === undefined) return;
					url = normalizeSupabaseProjectUrl(urlInput.trim() || existing?.url || "");
					if (!url) {
						ctx.ui.notify("URL is required.", "error");
						return;
					}

					const keyInput = await ctx.ui.input(
						"Supabase publishable key",
						existingKey ? maskKey(existingKey) : "sb_publishable_...",
					);
					if (keyInput === undefined) return;
					publishableKey = keyInput.trim() || existingKey || "";
					if (!publishableKey) {
						ctx.ui.notify("Publishable key is required.", "error");
						return;
					}

				}

				if (!url || !publishableKey) {
					ctx.ui.notify("Supabase URL and publishable key are required.", "error");
					return;
				}

				if (looksLikeSecretKey(publishableKey)) {
					ctx.ui.notify(
						"This looks like a Supabase secret key. Supabase docs say secret keys bypass RLS and should only be used on trusted backends. Use a publishable key here instead.",
						"warning",
					);
				}

				ctx.ui.notify(
					`pi-glossary reads and writes ${SUPABASE_TABLE_FQN} via the Supabase REST API.\n\nCopy/paste this DDL into the Supabase SQL editor:\n\n${PROVISIONING_SQL}`,
					"info",
				);

				// ── Step 2: Schema check and provisioning ─────────────────────

				ctx.ui.notify(`Checking table ${SUPABASE_TABLE_FQN}...`, "info");
				const tableResult = await checkTableExists(url, publishableKey);

				if (!tableResult.exists) {
					const reason = tableResult.error ? `\n\nSupabase said: ${tableResult.error}` : "";
					ctx.ui.notify(
						`Could not read ${SUPABASE_TABLE_FQN} with the provided key.${reason}\n\nIf you just created the table, paste the DDL above in Supabase SQL Editor, then continue. If the table already exists, verify that the key is a publishable key and that the grants/RLS policy from the DDL were applied.`,
						"warning",
					);

					const confirmed = await ctx.ui.confirm(
						"Schema ready?",
						`Have you pasted the DDL for ${SUPABASE_TABLE_FQN} into the Supabase SQL editor?`,
					);
					if (!confirmed) {
						ctx.ui.notify(
							"Setup cancelled. Run /glossary init supabase again after provisioning the table.",
							"info",
						);
						return;
					}

					ctx.ui.notify("Re-checking table...", "info");
					const recheck = await checkTableExists(url, publishableKey);
					if (!recheck.exists) {
						const recheckReason = recheck.error ?? "table still not found";
						ctx.ui.notify(
							`Table still not accessible: ${recheckReason}\n\nVerify the DDL ran without errors. For publishable keys, make sure the table has the grants and RLS policies from the DDL above.`,
							"error",
						);
						return;
					}
				}

				ctx.ui.notify(`Table OK: ${SUPABASE_TABLE_FQN}.`, "info");

				// ── Step 3: Save config and reload ────────────────────────────

				const newConfig: GlossaryConfig = {
					...config,
					supabase: {
						url: normalizeSupabaseProjectUrl(url),
						publishableKey,
						enabled: true,
					},
				};
				saveConfig(newConfig);

				loadedTermsForSession = new Set<string>();
				updateGlossaryWidget(ctx);
				const reloadResult = await loadGlossary(ctx.cwd);

				if (reloadResult.error) {
					ctx.ui.notify(`Config saved, but glossary reload failed: ${reloadResult.error}`, "warning");
					return;
				}
				if (remoteError) {
					ctx.ui.notify(`Config saved, but remote load failed: ${remoteError}`, "warning");
					return;
				}

				ctx.ui.notify(
					`Supabase configured.\n\nConfig saved to: ${configPath}\nSchema/table: ${SUPABASE_TABLE_FQN}\nRemote entries loaded: ${remoteCount}\nTotal glossary entries: ${reloadResult.count}\n\nUse /glossary entry create to add entries. Run /glossary scopes to see active scopes.`,
					"info",
				);
				return;
			}

			ctx.ui.notify(
				"Usage: /glossary [reload] | /glossary scopes | /glossary scope enable <scope> | /glossary scope disable <scope> | /glossary entry create|get|update|delete|list | /glossary supabase status | /glossary init supabase",
				"warning",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		loadedTermsForSession = new Set<string>();
		updateGlossaryWidget(ctx);
		const result = await loadGlossary(ctx.cwd);
		if (result.error) {
			ctx.ui.notify(`Glossary load failed: ${result.error}`, "error");
			return;
		}
		if (remoteError) {
			ctx.ui.notify(`Supabase load failed (local entries still active): ${remoteError}`, "warning");
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
