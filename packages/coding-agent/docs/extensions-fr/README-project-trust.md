# project-trust.ts

**Fichier source :** `examples/extensions/project-trust.ts`

## Ce qu'elle fait

Extension de démonstration de l'événement `project_trust`, qui contrôle si pi a le droit de faire confiance à un dossier de projet (charger `.pi/settings.json`, ressources projet, `.agents/skills`, extensions locales du projet, etc.).

- S'accroche à `pi.on("project_trust", ...)` :
  - Notifie via `ctx.ui.notify(...)` que l'événement s'est déclenché (cwd, mode, compteur de chargement `loadCount`).
  - **Sans UI** (`!ctx.hasUI`) : retourne `{ trusted: "undecided" }`, ce qui laisse le prompt intégré de pi (ou un autre handler) décider.
  - **Avec UI** : propose un `ctx.ui.select(...)` avec 5 choix :
    - "Trust and remember" → `{ trusted: "yes", remember: true }` (confiance mémorisée dans `~/.pi/agent/trust.json`)
    - "Trust with note and remember" → demande une note via `ctx.ui.input(...)`, l'affiche, puis même résultat que ci-dessus
    - "Trust this session" → `{ trusted: "yes" }` (confiance seulement pour la session en cours, non mémorisée)
    - "Do not trust this session" → `{ trusted: "no" }`
    - "Let built-in prompt decide" → `{ trusted: "undecided" }` (délègue au prompt natif de pi)
- S'accroche aussi à `pi.on("session_start", ...)` pour notifier que l'extension est chargée, une fois la confiance résolue.
- **Règle importante** : si plusieurs extensions écoutent `project_trust`, le premier handler qui renvoie `"yes"` ou `"no"` gagne et supprime le prompt intégré ; `"undecided"` passe la main au handler suivant.

## Comment l'utiliser

Installation globale (s'applique à tous les projets) :
```bash
mkdir -p ~/.pi/agent/extensions
cp packages/coding-agent/examples/extensions/project-trust.ts ~/.pi/agent/extensions/
```
Ou chargement ponctuel :
```bash
pi -e packages/coding-agent/examples/extensions/project-trust.ts
```
Pour la tester : ouvrir pi dans un dossier contenant `.pi`, `AGENTS.md`/`CLAUDE.md`, ou `.agents/skills` (signaux qui déclenchent normalement le prompt de confiance intégré).

**Important** : les extensions globales et celles passées via `-e` sont chargées **avant** la résolution de confiance (donc elles peuvent répondre à `project_trust`), contrairement aux extensions **locales au projet**, qui ne sont chargées **qu'après** que le projet a été jugé de confiance.

## Comment la configurer

Aucune option de config — c'est un exemple purement démonstratif (avec `ctx.ui.notify` verbeux) à adapter selon vos besoins réels (ex. auto-trust pour certains chemins, whitelist, intégration avec un système externe). Le vrai stockage de la décision "remember" se fait par pi dans `~/.pi/agent/trust.json`.

## Cas d'usage type

Base de départ pour construire une politique de confiance personnalisée : par exemple auto-approuver certains chemins connus (ex: vos propres dépôts sous `~/work/`), ou refuser automatiquement tout dossier hors d'une liste blanche, sans jamais afficher le prompt intégré.
