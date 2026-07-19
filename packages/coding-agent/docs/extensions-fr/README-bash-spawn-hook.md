# bash-spawn-hook.ts

**Fichier source :** `examples/extensions/bash-spawn-hook.ts`

## Ce qu'elle fait

Exemple minimal montrant comment intercepter et **modifier une commande bash juste avant son exécution réelle** (au niveau du spawn du process, pas juste au niveau de l'appel d'outil).

- Crée un outil bash personnalisé via `createBashTool(cwd, { spawnHook: ... })`.
- Le `spawnHook` reçoit `{ command, cwd, env }` et retourne une version modifiée :
  - Préfixe la commande par `source ~/.profile\n` (charge le profil shell de l'utilisateur avant d'exécuter la commande).
  - Ajoute une variable d'environnement `PI_SPAWN_HOOK=1` à l'environnement transmis.
  - Le `cwd` est repris tel quel ici (mais pourrait aussi être modifié).
- Enregistre ce bash modifié à la place du `bash` intégré via `pi.registerTool`.

## Comment l'utiliser

```bash
pi -e ./bash-spawn-hook.ts
```
C'est un point de départ à copier-coller/adapter (pas destiné à être utilisé tel quel en production) — typiquement pour : charger un environnement shell spécifique, injecter des variables d'env globales, rediriger le `cwd`, ou faire du logging/wrapping de commandes.

## Comment la configurer

Aucune — tout est en dur dans le code (le `source ~/.profile` et la variable `PI_SPAWN_HOOK`). Pour personnaliser, il faut éditer directement la fonction `spawnHook`.

## Cas d'usage type

Votre environnement de développement nécessite que certaines variables (nvm, pyenv, alias custom...) soient chargées avant chaque commande, or l'agent lance bash sans shell de login. Ce hook permet d'injecter systématiquement `source ~/.profile` (ou un fichier d'environnement dédié) sans modifier chaque commande individuellement.
