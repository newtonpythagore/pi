# ssh.ts

**Fichier source :** `examples/extensions/ssh.ts`

## Ce qu'elle fait

Redirige tous les outils du filesystem/exécution (`read`, `write`, `edit`, `bash`) vers une **machine distante via SSH**, au lieu d'agir sur la machine locale. L'agent travaille comme d'habitude, mais chaque opération est en réalité exécutée sur le serveur distant.

- Remplace les 4 outils intégrés en gardant leur interface (mêmes paramètres pour le LLM), mais l'implémentation (`execute`) bascule sur des "operations" distantes si SSH est configuré :
  - `readFile`/`access`/`detectImageMimeType` → passent par `ssh remote "cat ..."`, `test -r ...`, `file --mime-type ...`
  - `writeFile` → encode le contenu en base64 et l'écrit via `echo ... | base64 -d > fichier` sur le remote
  - `bash` → exécute la commande via `ssh remote "cd <remoteCwd> && <commande>"`, avec gestion du timeout et de l'abort (Ctrl+C)
- Traduit les chemins locaux en chemins distants par simple substitution de préfixe (`localCwd` → `remoteCwd`).
- Gère aussi `user_bash` (commandes `!` tapées manuellement) pour les exécuter également via SSH.
- Modifie le **prompt système** (`before_agent_start`) pour indiquer au modèle le vrai cwd distant plutôt que le cwd local — évite que le LLM se trompe de contexte.
- Affiche un badge de statut permanent `SSH: user@host:/chemin` dans l'UI.

## Comment l'utiliser

```bash
pi -e ./ssh.ts --ssh user@host
pi -e ./ssh.ts --ssh user@host:/remote/path
```
Si aucun chemin n'est donné, exécute `pwd` sur le remote pour le déduire automatiquement.

**Prérequis :**
- Authentification SSH par clé (pas de mot de passe) — sinon les commandes bloqueraient en attente d'un prompt.
- `bash` disponible sur la machine distante.

## Comment la configurer

Pas de fichier de config — tout passe par le flag CLI `--ssh` (`pi.registerFlag("ssh", ...)`). Sans ce flag, tout se comporte normalement en local.

## Cas d'usage type

Développer/déboguer sur un serveur distant (VM de test, machine avec un environnement matériel/logiciel spécifique) sans ouvrir de session SSH manuelle — l'agent lit/édite/exécute directement là-bas comme si c'était en local.
