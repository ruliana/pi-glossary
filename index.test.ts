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

type Fetched = { url: string; headers: Record<string, string> };

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
	globalThis.fetch = (async (input: string, init?: { headers?: Record<string, string> }) => {
		const url = String(input);
		fetched.push({ url, headers: { ...(init?.headers ?? {}) } });
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
	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify: (msg: string, level: string) => notes.push({ msg, level }), setWidget() {}, setStatus() {} },
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
			const res = await handlers.before_agent_start!({ prompt: text }, ctx);
			return res?.message?.content ?? "";
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
			return res.content[0].text;
		},
	};
}

describe("remote glossaries", () => {
	test("cannot run shell templates unless a local https include opts in", async () => {
		urls["https://example.com/plain.json"] = JSON.stringify([{ term: "plain", definition: "p {{echo RAN-plain}}" }]);
		urls["https://example.com/opted.json"] = JSON.stringify([
			{ term: "opted", definition: "o {{echo RAN-opted}}", allowShell: false },
			// A remote file cannot widen trust for what it includes.
			{ include: "https://example.com/nested.json", allowShell: true },
		]);
		urls["https://example.com/nested.json"] = JSON.stringify([{ term: "nested", definition: "n {{echo RAN-nested}}" }]);
		urls["http://example.com/http.json"] = JSON.stringify([{ term: "overhttp", definition: "h {{echo RAN-http}}" }]);
		writeGlobal([
			{ term: "mine", definition: "m {{echo RAN-mine}}" },
			{ include: "https://example.com/plain.json" },
			{ include: "https://example.com/opted.json", allowShell: true },
			{ include: "http://example.com/http.json", allowShell: true },
		]);
		const g = await start();

		const out = await g.prompt("mine plain opted nested overhttp");
		expect(out).toContain("m RAN-mine");
		expect(out).toContain("o RAN-opted");
		expect(out).not.toContain("RAN-plain");
		expect(out).not.toContain("RAN-nested");
		expect(out).not.toContain("RAN-http");
		expect(out).toContain("p [shell template disabled: remote glossary source]");
		expect(g.notes.some((n) => n.msg.includes("Ignoring allowShell on http://example.com/http.json"))).toBe(true);

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
