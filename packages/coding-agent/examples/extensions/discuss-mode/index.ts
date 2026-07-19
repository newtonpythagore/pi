/**
 * Discuss Mode Extension
 *
 * Variant of the plan-mode extension focused on collaborative feature design.
 * While enabled, built-in write tools are disabled and the agent discusses
 * with the user how to build a feature. When the discussion is conclusive,
 * /generate-plan makes the agent produce a complete "recipe" markdown
 * document (files to create/modify, full code, commands, validation steps)
 * that the extension writes to plans/<feature-slug>.md itself.
 *
 * Features:
 * - /discuss command or Ctrl+Alt+D to toggle
 * - Bash restricted to allowlisted read-only commands while discussing
 * - /generate-plan [feature name] writes the recipe file
 * - After generation: execute the plan, or enter plan edit mode where
 *   edit/write are allowed only inside the plans/ directory
 * - Session persistence: state survives session resume
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractPlanDocument, isSafeCommand, PLAN_END_MARKER, PLAN_START_MARKER, slugify } from "./utils.ts";

// Tools
const DISCUSS_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const DISCUSS_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const DISCUSS_MANAGED_TOOLS = new Set<string>([...DISCUSS_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

const PLANS_DIR = "plans";

interface DiscussModeState {
	enabled: boolean;
	planEditMode?: boolean;
	toolsBeforeDiscussMode?: string[];
	planFilePath?: string;
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function discussModeExtension(pi: ExtensionAPI): void {
	let discussModeEnabled = false;
	let planEditMode = false;
	let toolsBeforeDiscussMode: string[] | undefined;
	let planFilePath: string | undefined;
	// Set by /generate-plan until the resulting document has been captured.
	// Holds the feature name given as command argument ("" when omitted).
	let pendingGeneration: string | undefined;

	pi.registerFlag("discuss", {
		description: "Start in discuss mode (collaborative feature design, read-only)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (planEditMode) {
			ctx.ui.setStatus("discuss-mode", ctx.ui.theme.fg("accent", "✏ plan-edit"));
		} else if (discussModeEnabled) {
			ctx.ui.setStatus("discuss-mode", ctx.ui.theme.fg("warning", "💬 discuss"));
		} else {
			ctx.ui.setStatus("discuss-mode", undefined);
		}
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getDiscussModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !DISCUSS_MODE_DISABLED_TOOLS.has(name)),
			...DISCUSS_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !DISCUSS_MANAGED_TOOLS.has(name)),
		]);
	}

	function enableDiscussModeTools(): void {
		if (toolsBeforeDiscussMode === undefined) {
			toolsBeforeDiscussMode = pi.getActiveTools();
		}
		pi.setActiveTools(getDiscussModeTools(toolsBeforeDiscussMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforeDiscussMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforeDiscussMode = undefined;
	}

	function enablePlanEditModeTools(): void {
		if (toolsBeforeDiscussMode === undefined) {
			toolsBeforeDiscussMode = pi.getActiveTools();
		}
		pi.setActiveTools(uniqueToolNames([...getDiscussModeTools(toolsBeforeDiscussMode), "edit", "write"]));
	}

	// Check that a path targeted by edit/write stays inside the plans directory,
	// after resolving relative segments and symlinks.
	function isInsidePlansDir(rawPath: string): boolean {
		const plansDir = join(process.cwd(), PLANS_DIR);
		mkdirSync(plansDir, { recursive: true });
		const realPlans = realpathSync(plansDir);
		const resolved = resolve(process.cwd(), rawPath);

		let realParent: string;
		try {
			realParent = realpathSync(dirname(resolved));
		} catch {
			return false;
		}
		if (realParent !== realPlans && !realParent.startsWith(realPlans + sep)) {
			return false;
		}

		// If the target already exists it may itself be a symlink pointing elsewhere
		try {
			const realTarget = realpathSync(resolved);
			return realTarget === realPlans || realTarget.startsWith(realPlans + sep);
		} catch {
			return true; // does not exist yet: parent check above is enough
		}
	}

	function persistState(): void {
		pi.appendEntry("discuss-mode", {
			enabled: discussModeEnabled,
			planEditMode,
			toolsBeforeDiscussMode,
			planFilePath,
		});
	}

	function toggleDiscussMode(ctx: ExtensionContext): void {
		pendingGeneration = undefined;

		if (planEditMode) {
			planEditMode = false;
			restoreNormalModeTools();
			ctx.ui.notify("Plan edit mode disabled. Full access restored.");
			updateStatus(ctx);
			persistState();
			return;
		}

		discussModeEnabled = !discussModeEnabled;
		if (discussModeEnabled) {
			enableDiscussModeTools();
			ctx.ui.notify("Discuss mode enabled. Built-in write tools disabled.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Discuss mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("discuss", {
		description: "Toggle discuss mode (collaborative feature design, read-only)",
		handler: async (_args, ctx) => toggleDiscussMode(ctx),
	});

	pi.registerCommand("generate-plan", {
		description: "Generate the recipe markdown file from the current discussion",
		handler: async (args, ctx) => {
			if (planEditMode) {
				ctx.ui.notify("Plan edit mode: ask for changes directly, the plan file is edited in place.", "warning");
				return;
			}
			if (!discussModeEnabled) {
				ctx.ui.notify("Not in discuss mode. Enable it first with /discuss", "warning");
				return;
			}

			pendingGeneration = args?.trim() ?? "";
			const featureHint = pendingGeneration
				? `Nom de la fonctionnalité : "${pendingGeneration}".`
				: "Déduis le nom de la fonctionnalité de la discussion.";

			pi.sendMessage(
				{
					customType: "discuss-mode-generate",
					content: `Génère maintenant le document de plan final à partir de notre discussion.
${featureHint}

Produis un document markdown complet, autonome, écrit comme une recette de cuisine :
un développeur doit pouvoir l'appliquer À LA LETTRE sans se poser la moindre question.

Exigences du document :
- Commence par un titre de niveau 1 : "# <Nom de la fonctionnalité>"
- Une section "## Contexte" résumant l'objectif et les décisions prises pendant la discussion
- Une section "## Prérequis" (outils, versions, commandes d'installation exactes)
- Puis des étapes numérotées "## Étape N — <titre>" dans l'ordre d'exécution. Chaque étape indique :
  - L'action exacte : CRÉER / MODIFIER / SUPPRIMER, avec le chemin complet du fichier
  - Le code COMPLET, prêt à copier-coller (pas de pseudo-code, pas d'extraits partiels,
    pas de "..." ni de "reste inchangé" sans montrer le contenu final)
  - Les commandes shell exactes à exécuter, le cas échéant
  - Une sous-section "Validation" : comment vérifier que l'étape est correcte
    (commande de test, comportement attendu)
- Termine par une section "## Validation finale" décrivant la vérification de bout en bout
- Si une information manque pour être exhaustif, écris quand même l'étape et insère
  un bloc "> TODO : <ce qu'il reste à préciser>" à l'endroit concerné

Encadre le document EXACTEMENT entre ces deux marqueurs, seuls sur leur ligne :
${PLAN_START_MARKER}
<document markdown>
${PLAN_END_MARKER}

N'écris aucun fichier toi-même : sors uniquement le document entre les marqueurs.`,
					display: true,
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle discuss mode",
		handler: async (ctx) => toggleDiscussMode(ctx),
	});

	// Block destructive bash commands in discuss/plan-edit mode,
	// and restrict edit/write to the plans directory in plan edit mode
	pi.on("tool_call", async (event) => {
		if (!discussModeEnabled && !planEditMode) return;

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Discuss mode: command blocked (not allowlisted). Use /discuss to disable discuss mode first.\nCommand: ${command}`,
				};
			}
		}

		if (planEditMode && (event.toolName === "edit" || event.toolName === "write")) {
			const input = event.input as { path?: string; file_path?: string };
			const target = input.path ?? input.file_path;
			if (!target || !isInsidePlansDir(target)) {
				return {
					block: true,
					reason: `Plan edit mode: writes are restricted to the "${PLANS_DIR}/" directory.\nBlocked path: ${target ?? "(missing)"}`,
				};
			}
		}
	});

	// Filter out stale mode context messages once the matching mode is off
	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "discuss-mode-context" && !discussModeEnabled) return false;
				if (msg.customType === "plan-edit-context" && !planEditMode) return false;
				if (discussModeEnabled) return true;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[DISCUSS MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[DISCUSS MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject discussion context before agent starts
	pi.on("before_agent_start", async () => {
		if (planEditMode) {
			return {
				message: {
					customType: "plan-edit-context",
					content: `[PLAN EDIT MODE ACTIVE]
Tu es en mode modification de plan.

Le plan courant est dans le fichier : ${planFilePath ?? `${PLANS_DIR}/`}
Lis-le avant de le modifier si tu ne l'as pas déjà fait dans cette conversation.

Règles :
- Tu peux utiliser edit et write UNIQUEMENT sur des fichiers du dossier "${PLANS_DIR}/"
  (toute écriture ailleurs sera bloquée)
- Bash reste restreint aux commandes en lecture seule
- Applique les modifications demandées par l'utilisateur directement dans le fichier,
  par retouches ciblées (edit) plutôt qu'en réécrivant tout le document
- Le document doit rester une recette exhaustive : code complet, chemins exacts,
  commandes, validation par étape`,
					display: false,
				},
			};
		}

		if (!discussModeEnabled) return;

		return {
			message: {
				customType: "discuss-mode-context",
				content: `[DISCUSS MODE ACTIVE]
Tu es en mode discussion : une phase de conception collaborative, en lecture seule.

Objectif : définir AVEC l'utilisateur comment construire une fonctionnalité du projet.
- Discute, propose des approches, challenge les choix, explique les compromis
- Pose des questions de clarification (utilise le tool questionnaire si disponible)
- Explore le code existant pour ancrer la discussion dans la réalité du projet

Restrictions :
- Les outils edit et write sont désactivés
- Bash est restreint à une liste de commandes en lecture seule
- Ne tente PAS de modifier le code : décris ce qui serait fait

Ne génère pas de plan final maintenant. Le document final ne sera produit que
lorsque l'utilisateur lancera la commande /generate-plan.`,
				display: false,
			},
		};
	});

	// Capture the generated plan document and write it to disk
	pi.on("agent_end", async (event, ctx) => {
		if (pendingGeneration === undefined) return;

		const featureNameArg = pendingGeneration;
		pendingGeneration = undefined;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (!lastAssistant) return;

		const doc = extractPlanDocument(getTextContent(lastAssistant));
		if (!doc) {
			ctx.ui.notify("Plan document not found in the response (missing markers). Run /generate-plan again.", "error");
			return;
		}

		const featureName = featureNameArg || doc.title || "plan";
		const slug = slugify(featureName) || "plan";
		const absoluteDir = join(process.cwd(), PLANS_DIR);
		const absolutePath = join(absoluteDir, `${slug}.md`);

		try {
			mkdirSync(absoluteDir, { recursive: true });
			writeFileSync(absolutePath, `${doc.content}\n`, "utf8");
		} catch (error) {
			ctx.ui.notify(`Failed to write plan file: ${String(error)}`, "error");
			return;
		}

		planFilePath = relative(process.cwd(), absolutePath);
		persistState();
		ctx.ui.notify(`Plan written to ${planFilePath}`, "info");

		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select(`Plan generated (${planFilePath}) - what next?`, [
			"Execute the plan now",
			"Modify the plan",
			"Exit discuss mode",
		]);

		if (choice?.startsWith("Execute")) {
			discussModeEnabled = false;
			planEditMode = false;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			pi.sendMessage(
				{
					customType: "discuss-mode-execute",
					content: `Le mode discussion est terminé, tous les outils sont réactivés.
Exécute le plan décrit dans le fichier ${planFilePath}.
Lis le fichier puis applique chaque étape à la lettre, dans l'ordre,
en effectuant la validation indiquée à la fin de chaque étape.`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Modify the plan") {
			discussModeEnabled = false;
			planEditMode = true;
			enablePlanEditModeTools();
			updateStatus(ctx);
			persistState();
			ctx.ui.notify(
				`Plan edit mode: writes allowed only inside "${PLANS_DIR}/". Describe your changes; use /discuss to exit.`,
				"info",
			);
		} else if (choice === "Exit discuss mode") {
			toggleDiscussMode(ctx);
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("discuss") === true) {
			discussModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();
		const discussModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "discuss-mode")
			.pop() as { data?: DiscussModeState } | undefined;

		if (discussModeEntry?.data) {
			discussModeEnabled = discussModeEntry.data.enabled ?? discussModeEnabled;
			planEditMode = discussModeEntry.data.planEditMode ?? planEditMode;
			toolsBeforeDiscussMode = discussModeEntry.data.toolsBeforeDiscussMode ?? toolsBeforeDiscussMode;
			planFilePath = discussModeEntry.data.planFilePath ?? planFilePath;
		}

		if (planEditMode) {
			enablePlanEditModeTools();
		} else if (discussModeEnabled) {
			enableDiscussModeTools();
		}
		updateStatus(ctx);
	});
}
