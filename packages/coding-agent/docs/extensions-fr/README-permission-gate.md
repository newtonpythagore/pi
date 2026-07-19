# permission-gate.ts

**Fichier source :** `examples/extensions/permission-gate.ts`

## Ce qu'elle fait

Intercepte chaque appel de l'outil `bash` avant son exécution et bloque sans confirmation si la commande semble dangereuse — aucun prompt utilisateur, aucun mode CI spécial : le blocage est systématique.

- Patterns détectés (regex, insensible à la casse), regroupés par catégorie : destruction de données (`rm -rf`, `dd of=/dev/...`, `mkfs`, `shred`, `wipefs`, `find -delete`, `truncate -s 0`), élévation de privilèges (`sudo`, `chmod/chown 777`, setuid/setgid, `setcap`, `visudo`/`sudoers`, `passwd`/`usermod`), système (`shutdown`/`reboot`, `kill -1`, fork bomb, `systemctl stop/disable/mask`, `swapoff`, `sysctl -w`, `crontab -r`), réseau (`curl|wget ... | sh`, flush/désactivation du pare-feu, shells netcat, écriture dans `authorized_keys`), git (`push --force`, `reset --hard`, `clean -f`, `branch -D`, `push --delete`), secrets et traces (clés SSH, `history -c`, `journalctl --vacuum`, suppression de logs, `LD_PRELOAD`), et paquets/système de fichiers (`apt/yum/dnf remove`, `mount`/`umount`, symlinks forcés vers des chemins système).
- S'accroche à l'événement `tool_call` via `pi.on("tool_call", ...)`. Ignore tout appel dont `toolName !== "bash"`.
- Si une commande matche un pattern dangereux, l'appel est bloqué immédiatement (`{ block: true, reason: "Dangerous command blocked by policy (<description>)" }`), qu'il y ait une UI ou non.
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

Vous voulez un filet de sécurité basique contre les commandes destructrices ou dangereuses (accidentelles ou induites par une injection de prompt) sans mettre en place un vrai sandboxing OS (voir `sandbox/`). Le filtrage par regex reste contournable (obfuscation, sous-shells, scripts écrits puis exécutés) : pour une isolation réelle, combiner avec `sandbox/` ou `gondolin/`.
