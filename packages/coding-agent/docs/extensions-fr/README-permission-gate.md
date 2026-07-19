# permission-gate.ts

**Fichier source :** `examples/extensions/permission-gate.ts`

## Ce qu'elle fait

Intercepte chaque appel de l'outil `bash` avant son exécution et le classe en trois niveaux :

1. **Bloqué inconditionnellement** — si la commande matche un pattern dangereux, l'appel est refusé immédiatement (`{ block: true, reason: "Dangerous command blocked by policy (<description>)" }`), sans prompt et qu'il y ait une UI ou non. Patterns détectés (regex, insensible à la casse), regroupés par catégorie : destruction de données (`rm -rf`, `dd of=/dev/...`, `mkfs`, `shred`, `wipefs`, `find -delete`, `truncate -s 0`), élévation de privilèges (`sudo`, `chmod/chown 777`, setuid/setgid, `setcap`, `visudo`/`sudoers`, `passwd`/`usermod`), système (`shutdown`/`reboot`, `kill -1`, fork bomb, `systemctl stop/disable/mask`, `swapoff`, `sysctl -w`, `crontab -r`), réseau (`curl|wget ... | sh`, flush/désactivation du pare-feu, shells netcat, écriture dans `authorized_keys`), git (`push --force`, `reset --hard`, `clean -f`, `branch -D`, `push --delete`), secrets et traces (clés SSH, `history -c`, `journalctl --vacuum`, suppression de logs, `LD_PRELOAD`), et paquets/système de fichiers (`apt/yum/dnf remove`, `mount`/`umount`, symlinks forcés vers des chemins système).
2. **Autorisé librement** — les commandes en lecture seule (`ls`, `cat`, `grep`, `find` sans `-exec`/`-delete`, `git status/log/diff`, `npm list`, etc.) passent sans confirmation. Chaque segment de la ligne de commande (découpée sur `&&`, `||`, `;`, `|`) doit matcher l'allowlist, et toute redirection vers un fichier (`>`, `>>`, hors `2>&1` et `/dev/null`) disqualifie la commande.
3. **Confirmation utilisateur** — tout le reste (donc tout ce qui peut modifier le système de fichiers ou l'état du système : `rm`/`rmdir`/`mv` simples, `find -exec`, `mkdir`, `sed -i`, redirections, `git commit`, `npm install`, one-liners python/perl, ...) déclenche un dialogue `ctx.ui.confirm` affichant la commande. Refus ou fermeture du dialogue → commande bloquée. **Sans UI disponible** (mode non-interactif `--print`, RPC sans dialogues) → commande bloquée par défaut avec un message explicite.

- S'accroche à l'événement `tool_call` via `pi.on("tool_call", ...)`. Ignore tout appel dont `toolName !== "bash"`.

Ce découpage en trois niveaux empêche notamment le contournement classique du blocage de `rm -rf` par décomposition : `find ... -exec rm {} \;` puis `find ... -exec rmdir {} \;` supprimaient auparavant une arborescence entière sans déclencher aucun pattern ; ces commandes tombent désormais dans le niveau 3 et exigent une validation humaine.

## Comment l'utiliser

Charger ponctuellement :
```bash
pi -e packages/coding-agent/examples/extensions/permission-gate.ts
```
Ou copier le fichier dans un dossier d'extensions (global `~/.pi/agent/extensions/`, projet `.pi/extensions/`) pour un chargement automatique.

## Comment la configurer

Aucune option externe : tout est codé en dur dans deux tableaux du fichier — `dangerousPatterns` (niveau 1, blocage dur) et `readOnlyPatterns` (niveau 2, allowlist lecture seule). Pour personnaliser, éditer directement ces tableaux (ajouter/retirer des regex). Pas de fichier de config JSON associé — c'est un exemple minimal destiné à être copié/adapté.

## Cas d'usage type

Vous voulez un filet de sécurité contre les commandes destructrices (accidentelles ou induites par une injection de prompt) qui laisse l'agent explorer librement en lecture seule, tout en gardant la main sur chaque modification irréversible du système de fichiers — sans mettre en place un vrai sandboxing OS (voir `sandbox/`). Le filtrage par regex reste contournable en théorie (obfuscation, scripts écrits puis exécutés — mais l'écriture du script demandera elle-même confirmation) : pour une isolation réelle, combiner avec `sandbox/` ou `gondolin/`.
