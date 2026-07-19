# sandbox/

**Fichiers source :** `examples/extensions/sandbox/index.ts`, `package.json`

## Ce qu'elle fait

Ajoute un **sandboxing au niveau OS** pour toutes les commandes bash exécutées par l'agent, via la librairie `@anthropic-ai/sandbox-runtime` (utilise `sandbox-exec` sur macOS, `bubblewrap` sur Linux). Contrairement à `permission-gate.ts` qui *demande confirmation*, celle-ci *empêche réellement* techniquement les accès non autorisés (réseau, lecture/écriture fichiers), même sans intervention humaine.

Concrètement :
- **Remplace complètement l'outil intégré `bash`** (`pi.registerTool`) par une version qui, si le sandbox est actif, enveloppe la commande via `SandboxManager.wrapWithSandbox()` avant de la spawn dans un process séparé (avec gestion de timeout et d'annulation/`AbortSignal`).
- S'accroche aussi à `user_bash` (bash lancé manuellement par l'utilisateur, pas par le LLM) pour lui appliquer le même sandboxing.
- Restrictions par défaut (`DEFAULT_CONFIG`) :
  - **Réseau** : domaines autorisés uniquement — npm, PyPI, GitHub (tout le reste bloqué).
  - **Filesystem** : lecture interdite sur `~/.ssh`, `~/.aws`, `~/.gnupg` ; écriture autorisée seulement dans `.` (le cwd) et `/tmp` ; écriture interdite sur `.env`, `.env.*`, `*.pem`, `*.key`.
- À `session_start` : charge la config, vérifie la plateforme (macOS/Linux seulement — désactivé ailleurs), initialise `SandboxManager`, puis affiche un badge de statut permanent `🔒 Sandbox: N domaines, N chemins d'écriture` dans l'UI.
- À `session_shutdown` : nettoie le sandbox (`SandboxManager.reset()`).
- Ajoute une commande **`/sandbox`** qui affiche la configuration active (domaines/chemins autorisés-interdits).
- Ajoute un flag CLI **`--no-sandbox`** pour désactiver le sandboxing au lancement.

## Comment l'utiliser

1. Copier le dossier `sandbox/` entier dans `~/.pi/agent/extensions/` (installation globale).
2. Lancer `npm install` dans ce dossier (dépendance `@anthropic-ai/sandbox-runtime`).
3. Sur Linux, installer en plus les outils système : `bubblewrap`, `socat`, `ripgrep`.
4. Lancer avec `pi -e ./sandbox` (sandbox actif par défaut) ou `pi -e ./sandbox --no-sandbox` pour le désactiver.
5. `/sandbox` en session pour vérifier la config appliquée.

## Comment la configurer

Deux fichiers JSON fusionnés (le projet a priorité sur le global) :
- Global : `~/.pi/agent/extensions/sandbox.json`
- Projet : `<cwd>/.pi/sandbox.json`

Exemple :
```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env"]
  }
}
```
- `enabled: false` désactive le sandbox via config (indépendamment du flag CLI).
- Les clés `network`/`filesystem` de chaque niveau sont fusionnées avec les valeurs par défaut (pas remplacées entièrement).
- Support additionnel : `ignoreViolations` et `enableWeakerNestedSandbox`.

## Cas d'usage type

Vous laissez l'agent exécuter des commandes de manière autonome et prolongée (sans confirmation manuelle à chaque fois) mais voulez garantir qu'il ne peut techniquement pas lire vos clés SSH/AWS, écrire en dehors du projet, ou contacter des domaines non whitelistés — utile pour un usage sans surveillance constante ou en environnement semi-fiable.
