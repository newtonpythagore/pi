# handoff.ts

**Fichier source :** `examples/extensions/handoff.ts`

## Ce qu'elle fait

Ajoute une commande **`/handoff <objectif>`** qui **transfère le contexte utile vers une nouvelle session fraîche**, plutôt que de faire une compaction (résumé "lossy" avec perte d'info). C'est une alternative plus intelligente au `/compact` classique quand on veut repartir sur une base propre mais focalisée.

Déroulement :
1. Récupère l'historique de la branche courante (`ctx.sessionManager.getBranch()`), en tenant compte d'une éventuelle compaction déjà appliquée (`getHandoffMessages` reprend le résumé de compaction + les messages gardés après).
2. Sérialise cette conversation en texte.
3. Envoie ce texte + votre objectif (`goal`, ce que vous avez tapé après `/handoff`) à un **appel LLM séparé** (avec un prompt système dédié) qui génère un **prompt auto-suffisant** pour démarrer un nouveau fil : contexte pertinent (décisions prises, approches), fichiers concernés, et la tâche à faire ensuite.
4. Affiche un loader pendant la génération (annulable).
5. Ouvre le résultat généré dans un **éditeur** pour que vous puissiez le relire/modifier avant de l'envoyer.
6. Crée une **nouvelle session** (`ctx.newSession`, avec traçabilité du parent via `parentSession`), pré-remplit l'éditeur avec le prompt édité, et vous laisse l'envoyer manuellement.

## Comment l'utiliser

```
/handoff maintenant implémente ça aussi pour les équipes
/handoff exécute la phase 1 du plan
/handoff vérifie les autres endroits qui ont besoin de ce fix
```
Nécessite le mode interactif (TUI) et qu'un modèle soit sélectionné.

## Comment la configurer

Aucune — le prompt système de génération est codé en dur dans le fichier. Rien à paramétrer côté utilisateur, à part le texte de l'objectif passé en argument à `/handoff`.

## Cas d'usage type

Votre session actuelle est devenue longue/encombrée (beaucoup d'exploration, essais-erreurs) mais vous voulez enchaîner sur une tâche liée sans traîner tout le bruit — `/handoff` produit un résumé propre et démarre une session neuve avec seulement l'essentiel, contrairement à `/compact` qui résume sur place et perd des détails de façon irréversible.
