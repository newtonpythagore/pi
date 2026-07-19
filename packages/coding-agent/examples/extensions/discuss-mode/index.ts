/**
 * Discuss Mode Extension
 *
 * Variant of the plan-mode extension focused on collaborative feature design.
 * While enabled, built-in write tools are disabled and the agent discusses
 * with the user how to build a feature. When the discussion is conclusive,
 * /generate-plan first produces a step outline for user validation, then the
 * agent writes the complete "recipe" markdown document (files to
 * create/modify, full code, commands, validation steps) itself with the write
 * tool, restricted to plans/<feature-slug>/<feature-slug>.md.
 *
 * Features:
 * - /discuss command or Ctrl+Alt+D to toggle
 * - Bash restricted to allowlisted read-only commands while discussing
 * - /generate-plan [feature name]: outline -> validation menu -> generation
 * - After generation: execute the plan, or enter plan edit mode where
 *   edit/write are allowed only inside the plans/ directory
 * - /modif_plan [name]: edit an existing plan without regenerating it
 * - External-change detection: warns the agent when the plan file was
 *   modified outside the conversation
 * - Session persistence: state survives session resume
 */

import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractHeadingTitle, isSafeCommand, slugify } from "./utils.ts";

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
	planFileMtimeMs?: number;
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
	let generatingPlan = false;
	let toolsBeforeDiscussMode: string[] | undefined;
	let planFilePath: string | undefined;
	let planFileMtimeMs: number | undefined;
	// Set by /generate-plan while the outline awaits validation.
	// Holds the feature name given as command argument ("" when omitted).
	let pendingOutline: string | undefined;
	// Slug of the plan being generated (phase 2)
	let pendingSlug: string | undefined;

	pi.registerFlag("discuss", {
		description: "Start in discuss mode (collaborative feature design, read-only)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (generatingPlan) {
			ctx.ui.setStatus("discuss-mode", ctx.ui.theme.fg("accent", "⚙ plan-gen"));
		} else if (planEditMode) {
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

	function statPlanMtime(): number | undefined {
		if (!planFilePath) return undefined;
		try {
			return statSync(resolve(process.cwd(), planFilePath)).mtimeMs;
		} catch {
			return undefined;
		}
	}

	function listPlanFiles(): string[] {
		try {
			return (readdirSync(join(process.cwd(), PLANS_DIR), { recursive: true }) as string[])
				.filter((f) => f.endsWith(".md"))
				.map((f) => join(PLANS_DIR, f))
				.sort();
		} catch {
			return [];
		}
	}

	function persistState(): void {
		pi.appendEntry("discuss-mode", {
			enabled: discussModeEnabled,
			planEditMode,
			toolsBeforeDiscussMode,
			planFilePath,
			planFileMtimeMs,
		});
	}

	function enterPlanEditMode(ctx: ExtensionContext, fileRelPath: string): void {
		discussModeEnabled = false;
		generatingPlan = false;
		planEditMode = true;
		planFilePath = fileRelPath;
		enablePlanEditModeTools();
		planFileMtimeMs = statPlanMtime();
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(
			`Plan edit mode on ${fileRelPath}: writes allowed only inside "${PLANS_DIR}/". Describe your changes; use /discuss to exit.`,
			"info",
		);
	}

	function exitAllModes(ctx: ExtensionContext, notice: string): void {
		discussModeEnabled = false;
		planEditMode = false;
		generatingPlan = false;
		pendingOutline = undefined;
		pendingSlug = undefined;
		restoreNormalModeTools();
		ctx.ui.notify(notice);
		updateStatus(ctx);
		persistState();
	}

	function toggleDiscussMode(ctx: ExtensionContext): void {
		if (planEditMode || generatingPlan) {
			exitAllModes(ctx, "Plan mode disabled. Full access restored.");
			return;
		}

		pendingOutline = undefined;
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
		description: "Generate the recipe plan file (outline validated first)",
		handler: async (args, ctx) => {
			if (planEditMode) {
				ctx.ui.notify("Plan edit mode: ask for changes directly, the plan file is edited in place.", "warning");
				return;
			}
			if (!discussModeEnabled) {
				ctx.ui.notify("Not in discuss mode. Enable it first with /discuss", "warning");
				return;
			}

			pendingOutline = args?.trim() ?? "";
			const featureHint = pendingOutline
				? `Nom de la fonctionnalité : "${pendingOutline}".`
				: "Déduis le nom de la fonctionnalité de la discussion.";

			pi.sendMessage(
				{
					customType: "discuss-mode-outline",
					content: `Prépare le sommaire du plan à partir de notre discussion.
${featureHint}

Produis UNIQUEMENT le sommaire, pas le plan complet :
- Un titre de niveau 1 : "# <Nom de la fonctionnalité>"
- La liste numérotée des étapes prévues, dans l'ordre d'exécution, avec pour
  chacune une à deux lignes décrivant ce qu'elle fera (fichiers touchés,
  commandes), sans code

N'écris aucun fichier. Ce sommaire sera soumis à validation avant la
génération du plan complet.`,
					display: true,
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.registerCommand("modif_plan", {
		description: "Edit an existing plan file from plans/ (skips generation)",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";
			let chosen: string | undefined;

			if (arg) {
				const slug = slugify(arg);
				const candidates = [
					arg,
					`${arg}.md`,
					join(PLANS_DIR, arg),
					join(PLANS_DIR, `${arg}.md`),
					join(PLANS_DIR, arg, `${arg}.md`),
					join(PLANS_DIR, slug, `${slug}.md`),
					join(PLANS_DIR, `${slug}.md`),
				];
				for (const candidate of candidates) {
					const abs = resolve(process.cwd(), candidate);
					if (existsSync(abs) && statSync(abs).isFile() && isInsidePlansDir(abs)) {
						chosen = relative(process.cwd(), abs);
						break;
					}
				}
				if (!chosen) {
					const available = listPlanFiles();
					const hint = available.length > 0 ? `\nAvailable plans:\n${available.join("\n")}` : "";
					ctx.ui.notify(`Plan not found for "${arg}".${hint}`, "error");
					return;
				}
			} else {
				const available = listPlanFiles();
				if (available.length === 0) {
					ctx.ui.notify(`No plan found in "${PLANS_DIR}/". Generate one first with /generate-plan`, "warning");
					return;
				}
				if (!ctx.hasUI) return;
				chosen = await ctx.ui.select("Which plan do you want to edit?", available);
				if (!chosen) return;
			}

			enterPlanEditMode(ctx, chosen);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle discuss mode",
		handler: async (ctx) => toggleDiscussMode(ctx),
	});

	// Block destructive bash commands in discuss/plan-edit/generation mode,
	// and restrict edit/write to the plans directory when writing is allowed
	pi.on("tool_call", async (event) => {
		if (!discussModeEnabled && !planEditMode && !generatingPlan) return;

		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Discuss mode: command blocked (not allowlisted). Use /discuss to disable plan/discuss mode first.\nCommand: ${command}`,
				};
			}
		}

		if ((planEditMode || generatingPlan) && (event.toolName === "edit" || event.toolName === "write")) {
			const input = event.input as { path?: string; file_path?: string };
			const target = input.path ?? input.file_path;
			if (!target || !isInsidePlansDir(target)) {
				return {
					block: true,
					reason: `Plan mode: writes are restricted to the "${PLANS_DIR}/" directory.\nBlocked path: ${target ?? "(missing)"}`,
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

	// Inject mode context before agent starts
	pi.on("before_agent_start", async () => {
		if (generatingPlan) return; // the generation message carries the instructions

		if (planEditMode) {
			let externalChangeWarning = "";
			const currentMtime = statPlanMtime();
			if (planFileMtimeMs !== undefined && currentMtime !== undefined && currentMtime !== planFileMtimeMs) {
				externalChangeWarning =
					"\n⚠ Le fichier du plan a été modifié en dehors de cette conversation. Relis-le avant toute édition.\n";
				planFileMtimeMs = currentMtime;
				persistState();
			}

			return {
				message: {
					customType: "plan-edit-context",
					content: `[PLAN EDIT MODE ACTIVE]
Nous travaillons sur la modification du plan : ${planFilePath ?? `${PLANS_DIR}/`}
Tu n'as pas besoin de le relire à chaque tour ; relis une section seulement si tu as
un doute sur son contenu exact avant de l'éditer.
${externalChangeWarning}
Règles :
- edit et write sont utilisables UNIQUEMENT dans le dossier "${PLANS_DIR}/"
  (toute écriture ailleurs sera bloquée)
- Bash reste restreint aux commandes en lecture seule
- Privilégie les retouches ciblées (edit) plutôt que la réécriture complète
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

	// Track the plan file mtime after turns where the agent may have written it
	pi.on("turn_end", async () => {
		if (!planEditMode && !generatingPlan) return;
		const current = statPlanMtime();
		if (current !== planFileMtimeMs) {
			planFileMtimeMs = current;
			persistState();
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		// Phase 2 done: the agent was asked to write the plan file
		if (generatingPlan) {
			generatingPlan = false;
			const slug = pendingSlug ?? "plan";
			pendingSlug = undefined;

			const expectedRel = join(PLANS_DIR, slug, `${slug}.md`);
			if (!existsSync(resolve(process.cwd(), expectedRel))) {
				updateStatus(ctx);
				ctx.ui.notify(
					`Plan file not found (${expectedRel}). The agent did not write it; run /generate-plan again.`,
					"error",
				);
				return;
			}

			planFilePath = expectedRel;
			planFileMtimeMs = statPlanMtime();
			persistState();
			ctx.ui.notify(`Plan written to ${expectedRel}`, "info");

			if (!ctx.hasUI) return;
			const choice = await ctx.ui.select(`Plan generated (${expectedRel}) - what next?`, [
				"Execute the plan now",
				"Modify the plan",
				"Exit discuss mode",
			]);

			if (choice?.startsWith("Execute")) {
				exitAllModes(ctx, "Plan mode disabled. Executing the plan with full access.");
				pi.sendMessage(
					{
						customType: "discuss-mode-execute",
						content: `Le mode discussion est terminé, tous les outils sont réactivés.
Exécute le plan décrit dans le fichier ${expectedRel}.
Lis le fichier puis applique chaque étape à la lettre, dans l'ordre,
en effectuant la validation indiquée à la fin de chaque étape.`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} else if (choice === "Modify the plan") {
				enterPlanEditMode(ctx, expectedRel);
			} else if (choice === "Exit discuss mode") {
				exitAllModes(ctx, "Discuss mode disabled. Full access restored.");
			}
			return;
		}

		// Phase 1 done: the agent produced the outline, ask for validation
		if (pendingOutline === undefined || !ctx.hasUI) return;

		const featureNameArg = pendingOutline;
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const title = lastAssistant ? extractHeadingTitle(getTextContent(lastAssistant)) : undefined;
		const featureName = featureNameArg || title || "plan";
		const slug = slugify(featureName) || "plan";

		const choice = await ctx.ui.select(`Outline for "${featureName}" - what next?`, [
			"Generate the full plan",
			"Adjust the outline",
			"Cancel",
		]);

		if (choice?.startsWith("Generate")) {
			pendingOutline = undefined;
			pendingSlug = slug;
			generatingPlan = true;
			discussModeEnabled = false;
			enablePlanEditModeTools();
			updateStatus(ctx);
			persistState();

			const planRelPath = join(PLANS_DIR, slug, `${slug}.md`);
			pi.sendMessage(
				{
					customType: "discuss-mode-generate",
					content: `Le sommaire est validé. Génère maintenant le plan complet.

Écris le document avec l'outil write dans le fichier : ${planRelPath}
(l'écriture n'est autorisée que dans le dossier "${PLANS_DIR}/").

Le document est une recette de cuisine exhaustive : un développeur doit pouvoir
l'appliquer À LA LETTRE sans se poser la moindre question.

Exigences du document :
- Commence par un titre de niveau 1 : "# ${featureName}"
- Une section "## Contexte" résumant l'objectif et les décisions prises pendant la discussion
- Une section "## Prérequis" (outils, versions, commandes d'installation exactes)
- Puis les étapes du sommaire validé, numérotées "## Étape N — <titre>". Chaque étape indique :
  - L'action exacte : CRÉER / MODIFIER / SUPPRIMER, avec le chemin complet du fichier
  - Le code COMPLET, prêt à copier-coller (pas de pseudo-code, pas d'extraits partiels,
    pas de "..." ni de "reste inchangé" sans montrer le contenu final)
  - Les commandes shell exactes à exécuter, le cas échéant
  - Une sous-section "Validation" : comment vérifier que l'étape est correcte
    (commande de test, comportement attendu)
- Termine par une section "## Validation finale" décrivant la vérification de bout en bout
- Si une information manque pour être exhaustif, écris quand même l'étape et insère
  un bloc "> TODO : <ce qu'il reste à préciser>" à l'endroit concerné

Une fois le fichier écrit, réponds simplement que le plan est prêt.`,
					display: true,
				},
				{ triggerTurn: true },
			);
		} else if (choice === "Adjust the outline") {
			const remarks = await ctx.ui.editor("Your remarks on the outline:", "");
			if (remarks?.trim()) {
				pi.sendUserMessage(
					`Ajuste le sommaire du plan selon ces remarques, puis représente-le en entier :\n${remarks.trim()}`,
				);
			}
			// pendingOutline stays set: the next agent_end shows this menu again
		} else {
			pendingOutline = undefined;
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
			planFileMtimeMs = discussModeEntry.data.planFileMtimeMs ?? planFileMtimeMs;
		}

		if (planEditMode) {
			enablePlanEditModeTools();
		} else if (discussModeEnabled) {
			enableDiscussModeTools();
		}
		updateStatus(ctx);
	});
}
