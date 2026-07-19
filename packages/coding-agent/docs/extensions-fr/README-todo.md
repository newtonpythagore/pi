# todo.ts

**Fichier source :** `examples/extensions/todo.ts`

## Ce qu'elle fait

Ajoute une **liste de tâches (todo list)** que le LLM peut gérer lui-même pendant la session, avec une interface pour la consulter. Sert aussi d'exemple pédagogique de gestion d'état via l'historique de session (pas de fichier externe).

- **Outil `todo`** enregistré pour le LLM (`pi.registerTool`), avec 4 actions :
  - `list` : liste les todos existants.
  - `add` (paramètre `text`) : ajoute une tâche, id auto-incrémenté.
  - `toggle` (paramètre `id`) : coche/décoche une tâche par son id.
  - `clear` : vide la liste (reset des ids).
- **Commande utilisateur `/todos`** (`pi.registerCommand`) : ouvre un composant UI custom en plein écran (`TodoListComponent`) qui affiche la liste avec coche ✓/○, compteur "X/Y complétés" ; se ferme avec `Escape`. Fonctionne uniquement en mode TUI interactif.
- **Persistance particulière — pas de fichier externe** : l'état (`todos`, `nextId`) est stocké dans le champ `details` du résultat de chaque appel d'outil `todo`, directement dans l'historique de la session (JSONL). Au démarrage (`session_start`) et à chaque changement de branche d'historique (`session_tree`), la fonction `reconstructState` rejoue tous les appels précédents à l'outil `todo` sur la branche courante pour reconstruire l'état en mémoire.
  - Avantage : si vous "branchez" (revenez en arrière dans l'historique via `/tree`), l'état des todos redevient automatiquement cohérent avec ce point précis de l'historique — sans synchronisation manuelle.
- Fournit aussi un rendu personnalisé dans le fil de conversation (`renderCall`/`renderResult`) au lieu du JSON brut.

## Point important : qui peut ajouter une todo ?

**Seul le LLM peut ajouter/modifier une todo**, pas directement l'utilisateur. `/todos` est une vue **en lecture seule** — son seul handler d'input gère `Escape`/`Ctrl+C` pour fermer la fenêtre, rien d'autre. Pour agir sur la liste, il faut demander au modèle en langage naturel (ex : "ajoute une todo pour X", "marque la tâche 2 comme faite") ; c'est lui qui invoque l'outil `todo` en conséquence.

## Comment l'utiliser

```bash
pi -e ./todo.ts
```
ou copier dans `~/.pi/agent/extensions/` (global) / `.pi/extensions/` (projet). Ensuite, demandez au modèle de gérer des tâches, et tapez `/todos` pour voir la liste dans une vue dédiée.

## Comment la configurer

Aucune option externe — pas de fichier de config. Exemple de "state management" destiné à être étudié/copié pour construire ses propres outils avec état persistant basé sur l'historique de session plutôt que sur des fichiers externes.

## Cas d'usage type

- **Suivi de tâches pendant une refacto multi-étapes** : vous demandez au modèle de planifier une todo list pour une refacto, puis vous suivez sa progression via `/todos` sans relire tout le chat.
- **Auto-planification par l'agent** : sur une tâche complexe, le modèle crée lui-même sa todo list interne pour structurer son travail et coche chaque étape en avançant — un plan d'exécution visible et cohérent même après un retour en arrière dans l'historique.
