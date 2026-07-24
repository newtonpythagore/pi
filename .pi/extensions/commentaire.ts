/**
 * Extension "commentaire" - commenter la dernière réponse de l'agent
 *
 * La commande /commentaire récupère le texte de la dernière réponse de l'agent,
 * l'ouvre dans un éditeur pour que vous puissiez y ajouter vos remarques, puis
 * renvoie l'ensemble à l'agent sous forme de message utilisateur.
 *
 * Deux éditeurs possibles :
 *
 * 1. L'éditeur intégré à pi (par défaut, aucune configuration nécessaire).
 * 2. Un éditeur graphique externe, déclaré dans un fichier de configuration.
 *
 * ── Configuration d'un éditeur graphique ────────────────────────────────────
 *
 * Créez `.pi/commentaire.json` (projet, prioritaire) ou
 * `~/.pi/agent/commentaire.json` (global) :
 *
 *   {
 *     "editor": "code",
 *     "args": ["--wait"]
 *   }
 *
 * `args` est facultatif. Il sert surtout à passer l'argument qui force
 * l'éditeur à *attendre* la fermeture du fichier : sans lui, la plupart des
 * éditeurs graphiques rendent la main immédiatement et vos commentaires ne
 * seraient jamais lus.
 *
 *   Éditeur         editor    args         Remarque
 *   ─────────────────────────────────────────────────────────────────────────
 *   VS Code         "code"    ["--wait"]   indispensable
 *   Sublime Text    "subl"    ["--wait"]   indispensable
 *   gVim            "gvim"    ["-f"]       -f = premier plan (no fork)
 *   Kate (KDE)      "kate"    ["--block"]  attend la fermeture du fichier
 *   gedit (GNOME)   "gedit"   []           bloquant nativement
 *
 * ── Comportement en cas de problème ─────────────────────────────────────────
 *
 *   Aucun fichier de configuration  → éditeur intégré, silencieusement
 *   Configuration invalide          → message d'erreur, puis éditeur intégré
 *   Lancement de l'éditeur en échec → message d'erreur, puis éditeur intégré
 *
 * Rien n'est envoyé à l'agent si vous annulez, si vous ne modifiez pas le
 * contenu, ou si vous le videz entièrement.
 *
 * Usage :
 *   /commentaire
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE_NAME = "commentaire.json";
const EN_TETE = "Voici mes commentaires sur ta réponse précédente";

/** Éditeur graphique déclaré par l'utilisateur. */
type EditorConfig = {
	editor: string;
	args: string[];
};

/** Résultat de l'édition dans un éditeur graphique externe. */
type GuiEditResult = { ok: true; text: string } | { ok: false; error: string };

/** Résultat de la lecture du fichier de configuration. */
type ConfigLookup =
	| { kind: "absent" }
	| { kind: "invalid"; path: string; reason: string }
	| { kind: "ok"; path: string; config: EditorConfig };

/**
 * Cherche la configuration dans le projet puis dans le répertoire global.
 * Le premier fichier trouvé décide, même s'il est invalide : un fichier présent
 * traduit une intention explicite, on ne la contourne pas silencieusement.
 */
function loadConfig(cwd: string): ConfigLookup {
	const candidates = [join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME), join(getAgentDir(), CONFIG_FILE_NAME)];

	for (const path of candidates) {
		if (!existsSync(path)) continue;
		return parseConfig(path);
	}
	return { kind: "absent" };
}

function parseConfig(path: string): ConfigLookup {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "invalid", path, reason: `lecture impossible (${errorMessage(error)})` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { kind: "invalid", path, reason: `JSON malformé (${errorMessage(error)})` };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "invalid", path, reason: "le contenu doit être un objet JSON" };
	}

	const { editor, args } = parsed as { editor?: unknown; args?: unknown };

	if (typeof editor !== "string" || editor.trim() === "") {
		return { kind: "invalid", path, reason: 'champ "editor" manquant ou vide' };
	}

	if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
		return { kind: "invalid", path, reason: 'champ "args" doit être un tableau de chaînes' };
	}

	return {
		kind: "ok",
		path,
		config: { editor: editor.trim(), args: (args as string[] | undefined) ?? [] },
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Sur Linux, un éditeur graphique n'a aucune chance de s'afficher sans serveur
 * X ou Wayland (session SSH par exemple). On le détecte avant de lancer quoi
 * que ce soit pour donner un message clair plutôt qu'un échec obscur.
 */
function missingDisplayServer(): boolean {
	if (process.platform !== "linux") return false;
	return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/**
 * Écrit le texte dans un fichier temporaire, ouvre l'éditeur graphique et
 * attend sa fermeture, puis relit le fichier. Le fichier est toujours supprimé.
 *
 * Retourne le contenu édité, ou un message d'erreur si le lancement a échoué.
 */
function editViaGuiEditor(config: EditorConfig, contenu: string): GuiEditResult {
	if (missingDisplayServer()) {
		return { ok: false, error: "aucun environnement graphique détecté (DISPLAY et WAYLAND_DISPLAY absents)" };
	}

	const tempFile = join(tmpdir(), `pi-commentaire-${Date.now()}.md`);

	try {
		writeFileSync(tempFile, contenu, "utf8");
	} catch (error) {
		return { ok: false, error: `création du fichier temporaire impossible (${errorMessage(error)})` };
	}

	try {
		const result = spawnSync(config.editor, [...config.args, tempFile], {
			stdio: "ignore",
			env: process.env,
		});

		if (result.error) {
			const reason =
				(result.error as NodeJS.ErrnoException).code === "ENOENT"
					? `éditeur "${config.editor}" introuvable`
					: `échec du lancement (${result.error.message})`;
			return { ok: false, error: reason };
		}

		if (result.status !== 0) {
			return { ok: false, error: `l'éditeur "${config.editor}" s'est terminé avec le code ${result.status}` };
		}

		return { ok: true, text: readFileSync(tempFile, "utf8") };
	} catch (error) {
		return { ok: false, error: `relecture du fichier temporaire impossible (${errorMessage(error)})` };
	} finally {
		try {
			rmSync(tempFile, { force: true });
		} catch {
			// Le fichier temporaire sera de toute façon nettoyé par le système.
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("commentaire", {
		description: "Commenter la dernière réponse de l'agent dans un éditeur",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/commentaire nécessite un mode interactif", "error");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("L'agent est occupé, attendez la fin de sa réponse", "error");
				return;
			}

			// Texte final de la dernière réponse de l'agent : on remonte la branche
			// courante et on ne garde que les parties textuelles, en ignorant le
			// raisonnement et les appels d'outils.
			const branch = ctx.sessionManager.getBranch();
			let reponseAgent: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type !== "message") continue;

				const msg = entry.message;
				if (!("role" in msg) || msg.role !== "assistant") continue;

				if (msg.stopReason !== "stop") {
					ctx.ui.notify(`La dernière réponse de l'agent est incomplète (${msg.stopReason})`, "error");
					return;
				}

				const textParts = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text);

				if (textParts.length > 0) {
					reponseAgent = textParts.join("\n");
					break;
				}
			}

			if (!reponseAgent) {
				ctx.ui.notify("Aucune réponse de l'agent à commenter", "error");
				return;
			}

			// Choix de l'éditeur. En cas de configuration invalide ou d'échec du
			// lancement, on prévient puis on bascule sur l'éditeur intégré : on ne
			// bloque jamais la prise de commentaires.
			const lookup = loadConfig(ctx.cwd);
			let contenu: string | undefined;

			if (lookup.kind === "invalid") {
				ctx.ui.notify(`Configuration invalide (${lookup.path}) : ${lookup.reason} — éditeur de pi utilisé`, "error");
			} else if (lookup.kind === "ok") {
				const result = editViaGuiEditor(lookup.config, reponseAgent);
				if (result.ok) {
					contenu = result.text;
				} else {
					ctx.ui.notify(`Éditeur graphique indisponible : ${result.error} — éditeur de pi utilisé`, "error");
				}
			}

			if (contenu === undefined) {
				contenu = await ctx.ui.editor("Commentez la réponse de l'agent :", reponseAgent);
			}

			// Annulation (Échap), contenu vidé, ou aucune modification : dans les
			// trois cas l'utilisateur n'a rien à dire, on n'envoie rien à l'agent.
			if (contenu === undefined || contenu.trim() === "" || contenu.trim() === reponseAgent.trim()) {
				ctx.ui.notify("Aucun commentaire ajouté", "info");
				return;
			}

			pi.sendUserMessage(`${EN_TETE}\n\n${contenu}`);
		},
	});
}
