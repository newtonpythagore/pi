# permission-gate.ts

**Fichier source :** `examples/extensions/permission-gate.ts`

## Ce qu'elle fait

Intercepte chaque appel de l'outil `bash` avant son exécution et bloque ou demande confirmation si la commande semble dangereuse.

- Patterns détectés (regex, insensible à la casse) :
  - `rm -rf` / `rm -r` / `rm --recursive`
  - `sudo`
  - `chmod 777` ou `chown 777`
- S'accroche à l'événement `tool_call` via `pi.on("tool_call", ...)`. Ignore tout appel dont `toolName !== "bash"`.
- Si une commande matche un pattern dangereux :
  - **Mode interactif** (`ctx.hasUI === true`) : ouvre un `ctx.ui.select(...)` avec les choix "Yes"/"No". Si l'utilisateur ne choisit pas "Yes", l'appel est bloqué (`{ block: true, reason: "Blocked by user" }`).
  - **Mode non-interactif** (pas d'UI, ex. CI/scripté) : bloque automatiquement par défaut, sans jamais exécuter la commande (`reason: "Dangerous command blocked (no UI for confirmation)"`).
- Si la commande n'est pas dangereuse, retourne `undefined` → laisse passer normalement.

## Comment l'utiliser

Charger ponctuellement :
```bash
pi -e packages/coding-agent/examples/extensions/permission-gate.ts
```
Ou copier le fichier dans un dossier d'extensions (global `~/.pi/agent/extensions/`, projet `.pi/extensions/`) pour un chargement automatique.

## Comment la configurer

Aucune option externe : tout est codé en dur dans le tableau `dangerousPatterns`. Pour personnaliser, éditer directement ce tableau dans le fichier (ajouter/retirer des regex). Pas de fichier de config JSON associé — c'est un exemple minimal destiné à être copié/adapté.

## Cas d'usage type

Vous voulez un filet de sécurité basique contre les commandes destructrices accidentelles (l'agent qui tente un `rm -rf` mal ciblé) sans mettre en place un vrai sandboxing OS (voir `sandbox/`). En mode non-interactif (agent lancé en CI par exemple), ces commandes sont bloquées d'office plutôt que de risquer une exécution silencieuse.
