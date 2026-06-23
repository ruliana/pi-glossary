import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	GlossaryLoader,
	LocalFileSource,
	HttpSource,
	JsonParser,
	JsonlParser,
	createDefaultGlossaryLoader,
	type GlossarySource,
	type GlossaryParser,
	type RawContent,
} from "./loader.ts";
import type { GlossaryEntry, GlossaryInclude } from "./types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-glossary-test-"));
}

function writeJson(dir: string, name: string, data: unknown): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, JSON.stringify(data));
	return file;
}

function writeJsonl(dir: string, name: string, rows: unknown[]): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
	return file;
}

function entry(term: string, definition = `def of ${term}`): GlossaryEntry {
	return { term, definition };
}

// ─── JsonParser ───────────────────────────────────────────────────────────────

describe("JsonParser", () => {
	const parser = new JsonParser();

	test("canHandle — matches anything that is not .jsonl", () => {
		assert.equal(parser.canHandle("glossary.json"), true);
		assert.equal(parser.canHandle("https://example.com/file.json"), true);
		assert.equal(parser.canHandle("https://example.com/noext"), true);
		assert.equal(parser.canHandle("glossary.jsonl"), false);
	});

	test("parse — valid JSON array", () => {
		const content: RawContent = {
			text: JSON.stringify([entry("foo")]),
			location: "test.json",
			label: "test.json",
		};
		const result = parser.parse(content);
		assert.equal(result.length, 1);
		assert.equal((result[0] as GlossaryEntry).term, "foo");
	});

	test("parse — throws when root is not an array", () => {
		const content: RawContent = { text: '{"term":"foo"}', location: "test.json", label: "test.json" };
		assert.throws(() => parser.parse(content), /root value must be an array/);
	});
});

// ─── JsonlParser ──────────────────────────────────────────────────────────────

describe("JsonlParser", () => {
	const parser = new JsonlParser();

	test("canHandle — only .jsonl", () => {
		assert.equal(parser.canHandle("glossary.jsonl"), true);
		assert.equal(parser.canHandle("https://gist.example.com/file.jsonl"), true);
		assert.equal(parser.canHandle("glossary.json"), false);
		assert.equal(parser.canHandle("https://example.com/noext"), false);
	});

	test("parse — valid JSONL", () => {
		const lines = [entry("foo"), entry("bar")];
		const content: RawContent = {
			text: lines.map((l) => JSON.stringify(l)).join("\n"),
			location: "test.jsonl",
			label: "test.jsonl",
		};
		const result = parser.parse(content);
		assert.equal(result.length, 2);
		assert.equal((result[0] as GlossaryEntry).term, "foo");
		assert.equal((result[1] as GlossaryEntry).term, "bar");
	});

	test("parse — skips blank lines", () => {
		const content: RawContent = {
			text: `${JSON.stringify(entry("foo"))}\n\n${JSON.stringify(entry("bar"))}`,
			location: "test.jsonl",
			label: "test.jsonl",
		};
		assert.equal(parser.parse(content).length, 2);
	});

	test("parse — throws with line number on invalid JSON", () => {
		const content: RawContent = {
			text: `${JSON.stringify(entry("foo"))}\nnot-json`,
			location: "test.jsonl",
			label: "test.jsonl",
		};
		assert.throws(() => parser.parse(content), /line 2/);
	});
});

// ─── LocalFileSource ──────────────────────────────────────────────────────────

describe("LocalFileSource", () => {
	const source = new LocalFileSource();
	let dir: string;

	before(() => { dir = tmpDir(); });
	after(() => fs.rmSync(dir, { recursive: true }));

	test("canHandle — local paths only", () => {
		assert.equal(source.canHandle("/some/path.json"), true);
		assert.equal(source.canHandle("relative.json"), true);
		assert.equal(source.canHandle("https://example.com/file.json"), false);
		assert.equal(source.canHandle("http://example.com/file.json"), false);
	});

	test("read — returns text and friendly label for file under home", async () => {
		const home = os.homedir();
		const sub = path.join(home, ".pi-glossary-test-tmp.json");
		fs.writeFileSync(sub, JSON.stringify([entry("foo")]));
		try {
			const result = await source.read(sub);
			assert.ok(result.label.startsWith("~"), `expected ~ prefix, got: ${result.label}`);
			assert.equal(result.location, sub);
		} finally {
			fs.rmSync(sub);
		}
	});

	test("read — throws ENOENT for missing file", async () => {
		await assert.rejects(
			() => source.read(path.join(dir, "nonexistent.json")),
			(err: NodeJS.ErrnoException) => err.code === "ENOENT",
		);
	});

	test("normalize — resolves extension-less path to .json when .json exists", () => {
		writeJson(dir, "g.json", []);
		const resolved = source.normalize(path.join(dir, "g"), dir);
		assert.equal(resolved, path.join(dir, "g.json"));
	});

	test("normalize — resolves extension-less path to .jsonl when .jsonl exists", () => {
		const sub = tmpDir();
		try {
			writeJsonl(sub, "g.jsonl", []);
			const resolved = source.normalize(path.join(sub, "g"), sub);
			assert.equal(resolved, path.join(sub, "g.jsonl"));
		} finally {
			fs.rmSync(sub, { recursive: true });
		}
	});

	test("normalize — throws when both .json and .jsonl exist", () => {
		const sub = tmpDir();
		try {
			writeJson(sub, "g.json", []);
			writeJsonl(sub, "g.jsonl", []);
			assert.throws(
				() => source.normalize(path.join(sub, "g"), sub),
				/Ambiguous/,
			);
		} finally {
			fs.rmSync(sub, { recursive: true });
		}
	});

	test("normalize — leaves explicit extension intact", () => {
		const file = path.join(dir, "explicit.json");
		const resolved = source.normalize(file, dir);
		assert.equal(resolved, file);
	});

	test("normalize — resolves relative path against cwd", () => {
		writeJson(dir, "rel.json", []);
		const resolved = source.normalize("rel.json", dir);
		assert.equal(resolved, path.join(dir, "rel.json"));
	});
});

// ─── HttpSource ───────────────────────────────────────────────────────────────

describe("HttpSource", () => {
	const source = new HttpSource();

	test("canHandle — URLs only", () => {
		assert.equal(source.canHandle("https://example.com/file.json"), true);
		assert.equal(source.canHandle("http://example.com/file.json"), true);
		assert.equal(source.canHandle("/local/path.json"), false);
	});

	test("normalize — converts GitHub blob URL to raw", () => {
		const browser = "https://github.com/user/repo/blob/main/glossary.json";
		const raw = source.normalize(browser, "");
		assert.equal(raw, "https://raw.githubusercontent.com/user/repo/main/glossary.json");
	});

	test("normalize — converts gist raw URL to githubusercontent", () => {
		const gist = "https://gist.github.com/user/abc123/raw/rev/file.json";
		const raw = source.normalize(gist, "");
		assert.equal(raw, "https://gist.githubusercontent.com/user/abc123/raw/rev/file.json");
	});

	test("normalize — leaves non-GitHub URLs unchanged", () => {
		const url = "https://example.com/glossary.json";
		assert.equal(source.normalize(url, ""), url);
	});
});

// ─── GlossaryLoader ───────────────────────────────────────────────────────────

describe("GlossaryLoader", () => {
	let dir: string;

	before(() => { dir = tmpDir(); });
	after(() => fs.rmSync(dir, { recursive: true }));

	function loader() {
		return createDefaultGlossaryLoader();
	}

	test("load — returns found:false for missing file", async () => {
		const result = await loader().load(path.join(dir, "nonexistent"), { cwd: dir });
		assert.equal(result.found, false);
		assert.deepEqual(result.entries, []);
	});

	test("load — reads JSON file by extension-less path", async () => {
		writeJson(dir, "a.json", [entry("alpha")]);
		const result = await loader().load(path.join(dir, "a"), { cwd: dir });
		assert.equal(result.found, true);
		assert.equal(result.entries.length, 1);
		assert.equal(result.entries[0]!.term, "alpha");
	});

	test("load — reads JSONL file", async () => {
		writeJsonl(dir, "b.jsonl", [entry("beta"), entry("gamma")]);
		const result = await loader().load(path.join(dir, "b.jsonl"), { cwd: dir });
		assert.equal(result.found, true);
		assert.equal(result.entries.length, 2);
	});

	test("load — resolves include directives", async () => {
		const sub = tmpDir();
		try {
			writeJson(sub, "included.json", [entry("included-term")]);
			writeJson(sub, "main.json", [{ include: path.join(sub, "included.json") }, entry("local-term")]);
			const result = await loader().load(path.join(sub, "main.json"), { cwd: sub });
			const terms = result.entries.map((e) => e.term);
			assert.ok(terms.includes("included-term"), `expected included-term in ${terms}`);
			assert.ok(terms.includes("local-term"), `expected local-term in ${terms}`);
		} finally {
			fs.rmSync(sub, { recursive: true });
		}
	});

	test("load — detects and skips circular includes", async () => {
		const sub = tmpDir();
		try {
			const a = path.join(sub, "a.json");
			const b = path.join(sub, "b.json");
			fs.writeFileSync(a, JSON.stringify([{ include: b }, entry("from-a")]));
			fs.writeFileSync(b, JSON.stringify([{ include: a }, entry("from-b")]));

			const warnings: string[] = [];
			const result = await loader().load(a, { cwd: sub, warnings });
			assert.ok(warnings.some((w) => w.includes("circular")), `expected circular warning, got: ${warnings}`);
			assert.ok(result.entries.length > 0, "should still return non-circular entries");
		} finally {
			fs.rmSync(sub, { recursive: true });
		}
	});

	test("load — skips disabled entries", async () => {
		writeJson(dir, "disabled.json", [
			{ ...entry("active"), enabled: true },
			{ ...entry("hidden"), enabled: false },
		]);
		const result = await loader().load(path.join(dir, "disabled.json"), { cwd: dir });
		const terms = result.entries.map((e) => e.term);
		assert.ok(terms.includes("active"));
		assert.equal(terms.includes("hidden"), false);
	});

	test("load — sets source label on entries that omit it", async () => {
		writeJson(dir, "sourced.json", [entry("labelled")]);
		const result = await loader().load(path.join(dir, "sourced.json"), { cwd: dir });
		assert.ok(result.entries[0]!.source, "entry should have a source label");
	});

	test("load — last registered parser wins (custom plugin overrides built-in)", async () => {
		const called: string[] = [];
		const customParser: GlossaryParser = {
			name: "custom",
			canHandle: (loc) => loc.endsWith(".json"),
			parse: (_content) => {
				called.push("custom");
				return [entry("from-custom")];
			},
		};
		const l = createDefaultGlossaryLoader().registerParser(customParser);
		writeJson(dir, "custom.json", [entry("original")]);
		const result = await l.load(path.join(dir, "custom.json"), { cwd: dir });
		assert.deepEqual(called, ["custom"]);
		assert.equal(result.entries[0]!.term, "from-custom");
	});

	test("load — last registered source wins (custom plugin overrides built-in)", async () => {
		const customSource: GlossarySource = {
			name: "custom",
			canHandle: () => true,
			normalize: (loc) => loc,
			read: async (loc) => ({
				text: JSON.stringify([entry("from-custom-source")]),
				location: loc + ".json",
				label: "custom-source",
			}),
		};
		const l = createDefaultGlossaryLoader().registerSource(customSource);
		const result = await l.load("/any/path", { cwd: dir });
		assert.equal(result.entries[0]!.term, "from-custom-source");
	});

	test("load — label is the absolute path for non-home-dir files (caller makes it relative)", async () => {
		const sub = tmpDir();
		try {
			writeJson(sub, "rel.json", [entry("x")]);
			const result = await loader().load(path.join(sub, "rel.json"), { cwd: sub });
			// LoadResult.label carries the raw source label; index.ts converts to relative via makeRelative()
			assert.equal(result.label, path.join(sub, "rel.json"));
		} finally {
			fs.rmSync(sub, { recursive: true });
		}
	});
});
