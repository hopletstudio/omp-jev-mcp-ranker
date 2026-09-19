import { deepEqual, equal } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@oh-my-pi/pi-coding-agent";

const SETTINGS_FILE = "mcp-tool-ranker.json";
const PROVIDER = "typesafe";
const MODEL = "jev-1.13.0";
const MAX_TOOLS = 5;
const MIN_SCORE = 0.5;
const REQUEST_TIMEOUT_MS = 4_000;

interface Settings {
	watchedServers: string[];
}

interface MCPTool extends ToolInfo {
	serverId: string;
}

interface RankedTool {
	name: string;
	description: string;
	score: number;
}
interface RankingResult {
	ok: boolean;
	tools: RankedTool[];
}

interface ServerChoice {
	id: string;
	label: string;
	toolCount: number;
}

interface NoulAnswer {
	type: "noul";
	noul: number;
}

interface TypeSafeResponse {
	answers?: Record<string, NoulAnswer>;
}

function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) return override;
	const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
	return profile ? join(homedir(), ".omp", "profiles", profile, "agent") : join(homedir(), ".omp", "agent");
}


function readSettings(): Settings {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(agentDir(), SETTINGS_FILE), "utf8"));
		if (!parsed || typeof parsed !== "object" || !("watchedServers" in parsed)) return { watchedServers: [] };
		const watchedServers = parsed.watchedServers;
		return {
			watchedServers: Array.isArray(watchedServers)
				? [...new Set(watchedServers.filter((value): value is string => typeof value === "string" && value.length > 0))]
				: [],
		};
	} catch {
		return { watchedServers: [] };
	}
}

function writeSettings(settings: Settings): void {
	const path = join(agentDir(), SETTINGS_FILE);
	mkdirSync(agentDir(), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

function sanitizeServerName(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, "_")
			.replace(/_+/g, "_")
			.replace(/^_+|_+$/g, "") || "server"
	);
}

function configuredServerNames(cwd: string): string[] {
	const paths = [
		join(cwd, ".omp", "mcp.json"),
		join(cwd, ".omp", ".mcp.json"),
		join(agentDir(), "mcp.json"),
		join(agentDir(), ".mcp.json"),
		join(cwd, "mcp.json"),
		join(cwd, ".mcp.json"),
	];
	const names = new Set<string>();
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!parsed || typeof parsed !== "object" || !("mcpServers" in parsed)) continue;
			const servers = parsed.mcpServers;
			if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
			for (const name of Object.keys(servers)) names.add(name);
		} catch {
			// OMP owns config diagnostics. One unreadable source must not disable ranking.
		}
	}
	return [...names];
}

export function serverIdForTool(toolName: string, configuredNames: string[]): string | undefined {
	if (!toolName.startsWith("mcp__")) return;
	const suffix = toolName.slice(5);
	const configured = configuredNames
		.map(name => ({ name, id: sanitizeServerName(name) }))
		.sort((a, b) => b.id.length - a.id.length)
		.find(server => suffix.startsWith(`${server.id}_`));
	const fallback = suffix.split("_", 1)[0];
	return configured?.id ?? (fallback || undefined);
}

function mcpTools(pi: ExtensionAPI, cwd: string): MCPTool[] {
	const active = new Set(pi.getActiveTools());
	const configuredNames = configuredServerNames(cwd);
	return pi
		.getAllTools()
		.filter(tool => tool.sourceInfo.source === "mcp" && active.has(tool.name))
		.flatMap(tool => {
			const serverId = serverIdForTool(tool.name, configuredNames);
			return serverId ? [{ ...tool, serverId }] : [];
		});
}

function serverChoices(tools: MCPTool[], configuredNames: string[]): ServerChoice[] {
	const rawById = new Map(configuredNames.map(name => [sanitizeServerName(name), name]));
	const counts = new Map(configuredNames.map(name => [sanitizeServerName(name), 0]));
	for (const tool of tools) counts.set(tool.serverId, (counts.get(tool.serverId) ?? 0) + 1);
	return [...counts]
		.map(([id, toolCount]) => ({ id, label: rawById.get(id) ?? id, toolCount }))
		.sort((a, b) => a.label.localeCompare(b.label));
}


export function selectRankedTools(
	tools: Pick<MCPTool, "name" | "description">[],
	answers: Record<string, NoulAnswer> | undefined,
): RankedTool[] {
	if (!answers || answers.scope?.type !== "noul" || answers.scope.noul < MIN_SCORE) return [];
	return tools
		.map((tool, index) => ({ ...tool, score: answers[`tool_${index}`]?.noul ?? 0 }))
		.filter(tool => Number.isFinite(tool.score) && tool.score >= MIN_SCORE)
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_TOOLS);
}
export function filteredActiveTools(
	activeTools: string[],
	watchedTools: Pick<MCPTool, "name">[],
	rankedTools: Pick<RankedTool, "name">[],
): string[] {
	const watched = new Set(watchedTools.map(tool => tool.name));
	const ranked = new Set(rankedTools.map(tool => tool.name));
	return activeTools.filter(name => !watched.has(name) || ranked.has(name));
}

function parseAnswers(value: unknown): Record<string, NoulAnswer> | undefined {
	if (!value || typeof value !== "object" || !("answers" in value)) return;
	const answers = value.answers;
	if (!answers || typeof answers !== "object" || Array.isArray(answers)) return;
	const parsed: Record<string, NoulAnswer> = {};
	for (const [id, answer] of Object.entries(answers)) {
		if (
			answer &&
			typeof answer === "object" &&
			"type" in answer &&
			answer.type === "noul" &&
			"noul" in answer &&
			typeof answer.noul === "number"
		) {
			parsed[id] = { type: "noul", noul: answer.noul };
		}
	}
	return parsed;
}

async function rankTools(
	prompt: string,
	tools: MCPTool[],
	ctx: ExtensionContext,
): Promise<RankingResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const sessionId = ctx.sessionManager.getSessionId();
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER, sessionId, { signal: controller.signal });
		if (!apiKey) return { ok: false, tools: [] };
		const questions: Record<string, unknown> = {
			scope: {
				type: "noul",
				instructions: `Would fulfilling this request materially benefit from at least one of these MCP tools?\n${tools
					.map(tool => `${tool.name}: ${tool.description}`)
					.join("\n")}`,
				criteria: {
					true: "At least one listed tool would materially help fulfill the request.",
					false: "The request can be fulfilled without any listed tool.",
				},
			},
		};
		for (const [index, tool] of tools.entries()) {
			questions[`tool_${index}`] = {
				type: "noul",
				instructions: `Would invoking this MCP tool materially help fulfill the request?\nTool name: ${tool.name}\nTool description: ${tool.description}`,
				criteria: {
					true: "This tool directly helps produce or verify the requested result.",
					false: "This tool is unrelated, redundant, or only weakly relevant.",
				},
			};
		}
		const response = await fetch("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ state: prompt, model: MODEL, questions }),
			signal: controller.signal,
		});
		if (!response.ok) return { ok: false, tools: [] };
		const body: unknown = await response.json();
		const answers = parseAnswers(body);
		if (!answers?.scope) return { ok: false, tools: [] };
		return { ok: true, tools: selectRankedTools(tools, answers) };
	} catch {
		return { ok: false, tools: [] };
	} finally {
		clearTimeout(timeout);
	}
}


async function configureServers(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const tools = mcpTools(pi, ctx.cwd);
	const servers = serverChoices(tools, configuredServerNames(ctx.cwd));
	if (servers.length === 0) {
		ctx.ui.notify("No configured or active MCP servers were found.", "warning");
		return;
	}
	const selected = new Set(readSettings().watchedServers);
	const labels = servers.map(server => (server.label === server.id ? server.label : `${server.label} (${server.id})`));
	for (;;) {
		const choice = await ctx.ui.select(
			"MCP Tool Ranker — prompts and watched tool descriptions are sent to TypeSafe",
			[
				...servers.map((server, index) => ({
					label: labels[index]!,
					description: `${server.toolCount} active tool${server.toolCount === 1 ? "" : "s"}${selected.has(server.id) ? " · watched" : ""}`,
				})),
				"Save and close",
			],
			{
				selectionMarker: "checkbox",
				checkedIndices: servers.flatMap((server, index) => (selected.has(server.id) ? [index] : [])),
				markableCount: servers.length,
				helpText: "Enter toggles a server; choose Save and close when done",
			},
		);
		if (choice === undefined) return;
		if (choice === "Save and close") {
			writeSettings({ watchedServers: [...selected].sort() });
			ctx.ui.notify(
				selected.size > 0
					? `MCP Tool Ranker watches: ${[...selected].sort().join(", ")}`
					: "MCP Tool Ranker disabled: no servers are watched.",
				"info",
			);
			return;
		}
		const index = labels.indexOf(choice);
		const server = servers[index];
		if (!server) continue;
		if (selected.has(server.id)) selected.delete(server.id);
		else selected.add(server.id);
	}
}

function showStatus(ctx: ExtensionContext): void {
	const watched = readSettings().watchedServers;
	const authenticated = ctx.modelRegistry.authStorage.hasAuth(PROVIDER);
	ctx.ui.notify(
		[
			`MCP Tool Ranker: ${watched.length > 0 ? "enabled" : "disabled"}`,
			`Watched servers: ${watched.join(", ") || "none"}`,
			`TypeSafe API key: ${authenticated ? "configured" : "missing — run /login typesafe"}`,
		].join("\n"),
		"info",
	);
}

export default function mcpToolRanker(pi: ExtensionAPI) {
	pi.setLabel("MCP Tool Ranker");
	let restoreActiveTools: string[] | undefined;
	let memo: { key: string; result: Promise<RankingResult> } | undefined;

	async function restoreTools(): Promise<void> {
		if (!restoreActiveTools) return;
		const tools = restoreActiveTools;
		restoreActiveTools = undefined;
		await pi.setActiveTools(tools);
	}

	pi.on("before_agent_start", async (event, ctx) => {
		await restoreTools();
		const watched = new Set(readSettings().watchedServers);
		if (watched.size === 0 || !ctx.modelRegistry.authStorage.hasAuth(PROVIDER)) return;
		const activeTools = pi.getActiveTools();
		const tools = mcpTools(pi, ctx.cwd).filter(tool => watched.has(tool.serverId));
		if (tools.length === 0) return;
		const key = JSON.stringify([event.prompt, tools.map(tool => [tool.name, tool.description])]);
		if (!memo || memo.key !== key) memo = { key, result: rankTools(event.prompt, tools, ctx) };
		const result = await memo.result;
		if (!result.ok) return;
		try {
			await pi.setActiveTools(filteredActiveTools(activeTools, tools, result.tools));
			restoreActiveTools = activeTools;
		} catch {
			await pi.setActiveTools(activeTools);
		}
	});

	pi.on("agent_end", restoreTools);

	pi.registerCommand("mcp-ranker", {
		description: "Configure Jev ranking for selected MCP servers",
		handler: async (args, ctx) => {
			const action = String(Array.isArray(args) ? args[0] ?? "" : args ?? "").trim().toLowerCase();
			if (action === "status") return showStatus(ctx);
			if (action === "key" || action === "login") {
				ctx.ui.setEditorText("/login typesafe");
				ctx.ui.notify("Press Enter to open OMP's masked TypeSafe API-key prompt.", "info");
				return;
			}
			if (action === "servers" || action === "configure") return configureServers(pi, ctx);
			if (action.length > 0) {
				ctx.ui.notify("Usage: /mcp-ranker [configure|status|key]", "warning");
				return;
			}
			const choice = await ctx.ui.select("MCP Tool Ranker", [
				"Choose watched MCP servers",
				"Set or replace TypeSafe API key",
				"Show status",
			]);
			if (choice === "Choose watched MCP servers") return configureServers(pi, ctx);
			if (choice === "Set or replace TypeSafe API key") {
				ctx.ui.setEditorText("/login typesafe");
				ctx.ui.notify("Press Enter to open OMP's masked TypeSafe API-key prompt.", "info");
				return;
			}
			if (choice === "Show status") showStatus(ctx);
		},
	});
}

if (import.meta.main) {
	equal(serverIdForTool("mcp__renpai_lore_lookup", ["renpai"]), "renpai");
	equal(serverIdForTool("mcp__my_server_lookup", ["my-server"]), "my_server");
	deepEqual(
		selectRankedTools(
			[
				{ name: "a", description: "A" },
				{ name: "b", description: "B" },
			],
			{
				scope: { type: "noul", noul: 0.9 },
				tool_0: { type: "noul", noul: 0.6 },
				tool_1: { type: "noul", noul: 0.8 },
			},
		).map(tool => tool.name),
		["b", "a"],
	);
	deepEqual(
		filteredActiveTools(
			["read", "mcp__renpai_a", "mcp__renpai_b", "mcp__other_x"],
			[
				{ name: "mcp__renpai_a" },
				{ name: "mcp__renpai_b" },
			],
			[{ name: "mcp__renpai_b" }],
		),
		["read", "mcp__renpai_b", "mcp__other_x"],
	);
	console.log("MCP Tool Ranker self-check passed");
}
