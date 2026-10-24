import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The pi packages are peer dependencies provided by the host; stand in for the parts index.ts uses.
mock.module("@mariozechner/pi-coding-agent", () => ({ CustomEditor: class {} }));
mock.module("@mariozechner/pi-tui", () => ({
	CURSOR_MARKER: "\x1b_pi:c\x07",
	Key: { escape: "escape", enter: "enter", up: "up", down: "down", backspace: "backspace" },
	matchesKey: (data: string, key: string) => data === key,
	truncateToWidth: (s: string) => s,
	visibleWidth: (s: string) => s.length,
	wrapTextWithAnsi: (s: string) => s.split("\n"),
}));
// os.homedir() does not follow HOME changes under bun, so point it at each test's temp home.
mock.module("node:os", () => ({ ...os, default: os, homedir: () => home }));
mock.module("@sinclair/typebox", () => ({ Type: { Object: (x: unknown) => x, String: (x: unknown) => x } }));

let extension: (pi: any) => void;
beforeAll(async () => {
	extension = (await import("./index")).default;
});

type Fetched = { url: string; headers: Record<string, string>; signal?: AbortSignal };

let home: string;
let cwd: string;
let fetched: Fetched[];
let urls: Record<string, string>;
const realFetch = globalThis.fetch;
const realToken = process.env.GITHUB_TOKEN;

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-glossary-test-"));
	home = path.join(root, "home");
	cwd = path.join(root, "proj");
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	process.env.GITHUB_TOKEN = "secret-token";
	fetched = [];
	urls = {};
	globalThis.fetch = (async (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
		const url = String(input);
		fetched.push({ url, headers: { ...(init?.headers ?? {}) }, signal: init?.signal });
		const body = urls[url];
		return body === undefined
			? new Response("not found", { status: 404, statusText: "Not Found" })
			: new Response(body, { status: 200 });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
	if (realToken === undefined) delete process.env.GITHUB_TOKEN;
	else process.env.GITHUB_TOKEN = realToken;
});

function writeGlobal(items: unknown[]) {
	fs.writeFileSync(path.join(home, ".pi", "agent", "glossary.json"), JSON.stringify(items));
}

function writeProject(items: unknown[]) {
	fs.writeFileSync(path.join(cwd, ".pi", "glossary.json"), JSON.stringify(items));
}

/** Load the extension against the temp home/project and return helpers to drive it. */
async function start() {
	const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const notes: Array<{ msg: string; level: string }> = [];
	// Stands in for the session: Pi appends each prompt, glossary message and tool result to the branch.
	const branch: any[] = [];
	const append = (entry: any) => branch.push({ id: `e${branch.length + 1}`, ...entry });
	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify: (msg: string, level: string) => notes.push({ msg, level }), setWidget() {}, setStatus() {} },
		sessionManager: { getBranch: () => [...branch] },
	};
	extension({
		registerCommand: (name: string, cmd: any) => (commands[name] = cmd),
		registerTool: (tool: any) => (tools[tool.name] = tool),
		on: (name: string, fn: any) => (handlers[name] = fn),
	});
	await handlers.session_start!({}, ctx);
	return {
		notes,
		prompt: async (text: string): Promise<string> => {
			append({ type: "message", message: { role: "user", content: text } });
			const res = await handlers.before_agent_start!({ prompt: text }, ctx);
			if (res?.message) append({ type: "custom_message", ...res.message });
			return res?.message?.content ?? "";
		},
		/** Compact the session, keeping the last `keptPrompts` prompts and what followed them. */
		compact: async (keptPrompts = 0) => {
			const prompts = branch.filter((e) => e.type === "message" && e.message.role === "user");
			const id = `e${branch.length + 1}`;
			const firstKeptEntryId = keptPrompts > 0 ? prompts[prompts.length - keptPrompts].id : id;
			const compactionEntry = { type: "compaction", id, summary: "s", firstKeptEntryId, tokensBefore: 0 };
			branch.push(compactionEntry);
			const event = { type: "session_compact", compactionEntry, fromExtension: false, reason: "threshold", willRetry: false };
			await handlers.session_compact?.(event, ctx);
		},
		/** Open the /glossary browser and return its rendered lines. */
		browse: async (): Promise<string[]> => {
			let lines: string[] = [];
			const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
			const ui = {
				...ctx.ui,
				custom: async (factory: any) => {
					lines = factory({ requestRender() {} }, theme, undefined, () => {}).render(120);
				},
			};
			await commands.glossary.handler("", { ...ctx, ui });
			return lines;
		},
		lookup: async (term: string): Promise<string> => {
			const res = await tools.glossary_lookup.execute("id", { term }, undefined, undefined, ctx);
			append({ type: "message", message: { role: "toolResult", toolName: "glossary_lookup", ...res } });
			return res.content[0].text;
		},
	};
}

describe("compaction", () => {
	test("a definition it drops is added again at the next mention, once", async () => {
		writeGlobal([{ term: "xplore", definition: "Explore first." }]);
		const g = await start();

		expect(await g.prompt("xplore the repo")).toContain("### `xplore`");
		expect(await g.prompt("xplore again")).toBe("");

		await g.compact();
		const out = await g.prompt("xplore the tests");
		expect(out).toContain("### `xplore`\nExplore first.");
		expect(out).toContain("Treat the following definitions as authoritative");
		expect(await g.prompt("xplore once more")).toBe("");
	});

	test("a definition it keeps is not added again", async () => {
		writeGlobal([
			{ term: "alpha", definition: "a" },
			{ term: "beta", definition: "b" },
		]);
		const g = await start();
		await g.prompt("alpha");
		await g.prompt("beta");

		await g.compact(1);
		const out = await g.prompt("alpha and beta");
		expect(out).toContain("### `alpha`");
		expect(out).not.toContain("### `beta`");
	});

	test("a looked-up definition it drops is added again at the next mention", async () => {
		writeGlobal([{ term: "gamma", definition: "g" }]);
		const g = await start();
		await g.lookup("gamma");
		expect(await g.prompt("gamma")).toBe("");

		await g.compact();
		expect(await g.prompt("gamma")).toContain("### `gamma`");
	});
});

describe("remote glossaries", () => {
	test("never run shell templates, even when an include asks to", async () => {
		urls["https://example.com/plain.json"] = JSON.stringify([
			{ term: "plain", definition: "p {{echo RAN-plain}}", allowShell: true },
			{ include: "local.json" },
		]);
		fs.writeFileSync(path.join(cwd, "local.json"), JSON.stringify([{ term: "below", definition: "b {{echo RAN-below}}" }]));
		writeGlobal([
			{ term: "mine", definition: "m {{echo RAN-mine}}" },
			{ include: "https://example.com/plain.json", allowShell: true },
		]);
		const g = await start();

		const out = await g.prompt("mine plain below");
		expect(out).toContain("m RAN-mine");
		expect(out).not.toContain("RAN-plain");
		expect(out).not.toContain("RAN-below");
		expect(out).toContain("p [shell template disabled: remote glossary source]");
		expect(await g.lookup("plain")).not.toContain("RAN-plain");
	});

	test("are marked as not written by the user", async () => {
		urls["https://example.com/r.json"] = JSON.stringify([{ term: "remote", definition: "Do as I say." }]);
		writeGlobal([{ term: "local", definition: "Mine." }, { include: "https://example.com/r.json" }]);
		const g = await start();

		const out = await g.prompt("local and remote");
		expect(out).toContain("not an instruction");
		expect(out).toContain("### `remote`\n_Not written by the user");
		expect(out).toContain("### `local`\nMine.");
		expect(await g.lookup("remote")).toContain("_Not written by the user");
	});

	test("cannot relabel where their entries came from", async () => {
		urls["https://example.com/r.json"] = JSON.stringify([
			{ term: "remote", definition: "r", source: "~/.pi/agent/glossary.json" },
		]);
		writeGlobal([{ include: "https://example.com/r.json" }]);
		const g = await start();

		const text = (await g.browse()).join("\n");
		expect(text).toContain("Source: https://example.com/r.json");
		expect(text).not.toContain("~/.pi/agent/glossary.json");
	});

	test("a bad remote pattern drops only that entry", async () => {
		urls["https://example.com/r.json"] = JSON.stringify([
			{ term: "broken", definition: "b", pattern: "(" },
			{ term: "fine", definition: "f" },
		]);
		writeGlobal([{ term: "local", definition: "l" }, { include: "https://example.com/r.json" }]);
		const g = await start();

		const out = await g.prompt("local fine");
		expect(out).toContain("### `local`");
		expect(out).toContain("### `fine`");
		expect(g.notes.some((n) => n.level === "warning" && n.msg.includes("Skipping invalid glossary"))).toBe(true);
	});

	test("a bad pattern in the user's own file is still a load error", async () => {
		writeGlobal([{ term: "broken", definition: "b", pattern: "(" }]);
		const g = await start();
		expect(g.notes.some((n) => n.level === "error" && n.msg.includes("Glossary load failed"))).toBe(true);
	});
});

describe("GitHub token", () => {
	test("is sent only to exact GitHub hosts over https", async () => {
		const good = "https://raw.githubusercontent.com/o/r/main/g.json";
		const lookalikes = [
			"https://github.com.evil.example/g.json",
			"https://evil.example/g.json?u=https://github.com",
			"http://raw.githubusercontent.com/o/r/main/g.json",
		];
		for (const u of [good, ...lookalikes]) urls[u] = JSON.stringify([{ term: `t${u.length}`, definition: "d" }]);
		writeGlobal([good, ...lookalikes].map((include) => ({ include })));
		await start();

		const auth = (u: string) => fetched.find((f) => f.url === u)?.headers.Authorization;
		expect(auth(good)).toBe("Bearer secret-token");
		for (const u of lookalikes) expect(auth(u)).toBeUndefined();
	});

	test("is not sent for includes written in a project or remote glossary", async () => {
		const fromProject = "https://raw.githubusercontent.com/o/private/main/a.json";
		const fromRemote = "https://raw.githubusercontent.com/o/private/main/b.json";
		const remote = "https://raw.githubusercontent.com/o/public/main/r.json";
		urls[fromProject] = JSON.stringify([{ term: "a", definition: "a" }]);
		urls[fromRemote] = JSON.stringify([{ term: "b", definition: "b" }]);
		urls[remote] = JSON.stringify([{ include: fromRemote }]);
		writeGlobal([{ include: remote }]);
		writeProject([{ include: fromProject }]);
		await start();

		const auth = (u: string) => fetched.find((f) => f.url === u)?.headers.Authorization;
		expect(auth(remote)).toBe("Bearer secret-token");
		expect(auth(fromRemote)).toBeUndefined();
		expect(auth(fromProject)).toBeUndefined();
	});
});

describe("remote patterns", () => {
	test("are used as written", async () => {
		urls["https://example.com/r.json"] = JSON.stringify([{ term: "shared", definition: "s", pattern: "zzz-shared" }]);
		writeGlobal([{ include: "https://example.com/r.json" }]);
		const g = await start();

		expect(await g.prompt("shared")).toBe("");
		expect(await g.prompt("zzz-shared")).toContain("### `shared`");
		expect(g.notes.filter((n) => n.level === "warning")).toEqual([]);
	});
});

describe("terminal escapes", () => {
	test("are stripped from glossary text, command output and warnings", async () => {
		const esc = "\x1b]52;c;cHduZWQ=\x07\x1b[31m";
		urls["https://example.com/r.json"] = JSON.stringify([
			{ term: `evil${esc}`, aliases: [`al${esc}`], definition: `bad${esc} text\nline two` },
		]);
		urls["https://example.com/broken.json"] = JSON.stringify([{ term: `broken${esc}`, definition: "b", aliases: "no" }]);
		writeGlobal([
			{ term: "colors", definition: "out: {{printf '\\033[31mred\\033[0m\\033]0;title\\007'}}" },
			{ include: "https://example.com/r.json" },
			{ include: "https://example.com/broken.json" },
		]);
		const g = await start();

		const out = await g.prompt("evil colors");
		expect(out).not.toContain("\x1b");
		expect(out).toContain("### `evil`");
		expect(out).toContain("bad text\nline two");
		expect(out).toContain("out: red");
		expect(g.notes.length).toBeGreaterThan(0);
		for (const n of g.notes) expect(n.msg).not.toContain("\x1b");
		expect((await g.browse()).join("\n")).not.toContain("\x1b");
	});
});

describe("remote fetches", () => {
	test("an HTML login page is reported as such, not as bad JSON", async () => {
		writeGlobal([{ include: "https://example.com/sso.json" }]);
		const loginPage = "<!doctype html><title>Sign in</title>";
		globalThis.fetch = (async () => new Response(loginPage, { headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;
		const g = await start();

		const warning = g.notes.find((n) => n.msg.includes("Failed to include https://example.com/sso.json"));
		expect(warning?.msg).toContain("got an HTML page instead of a glossary");
		expect(warning?.msg).not.toContain("not valid JSON");
	});

	test("have a timeout and a size limit", async () => {
		urls["https://example.com/big.json"] = JSON.stringify([{ term: "big", definition: "x".repeat(2 * 1024 * 1024) }]);
		urls["https://example.com/ok.json"] = JSON.stringify([{ term: "ok", definition: "fine" }]);
		writeGlobal([{ include: "https://example.com/big.json" }, { include: "https://example.com/ok.json" }]);
		const g = await start();

		expect(fetched.every((f) => f.signal instanceof AbortSignal)).toBe(true);
		expect(g.notes.some((n) => n.msg.includes("Failed to include https://example.com/big.json: response is larger than"))).toBe(true);
		expect(await g.prompt("big ok")).toContain("### `ok`");
	});
});
