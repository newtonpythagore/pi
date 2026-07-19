# trigger-compact.ts

**Fichier source :** `examples/extensions/trigger-compact.ts`

## Ce qu'elle fait

Déclenche **automatiquement** une compaction de la conversation quand le nombre de tokens utilisés dépasse un seuil (**100 000 tokens** par défaut, constante `COMPACT_THRESHOLD_TOKENS`), pour éviter de saturer la fenêtre de contexte.

- S'accroche à `turn_end` (fin de chaque tour de conversation) : vérifie l'usage actuel de tokens (`ctx.getContextUsage()`).
- Ne déclenche que sur le **franchissement** du seuil (transition d'un état ≤ seuil vers > seuil, pas à chaque tour une fois au-dessus) — évite de re-déclencher en boucle.
- Appelle `ctx.compact({...})` (l'API native de compaction de pi), avec notifications de début/fin/erreur si l'UI est active.
- Ajoute aussi une commande manuelle **`/trigger-compact [instructions optionnelles]`** pour forcer une compaction immédiate, avec des instructions personnalisées optionnelles passées au résumé (ex : "garde tous les détails sur le module X").

## Comment l'utiliser

```bash
pi -e ./trigger-compact.ts
```
Ensuite c'est transparent : dès que le contexte dépasse 100k tokens, la compaction se lance automatiquement. Vous pouvez aussi taper `/trigger-compact` à tout moment pour la forcer.

## Comment la configurer

Le seuil est codé en dur (`COMPACT_THRESHOLD_TOKENS = 100_000`) — pour le changer, éditer directement cette constante dans le fichier. Pas de fichier JSON externe.

## Cas d'usage type

Sessions longues et automatisées (CI, agents non supervisés) où vous ne voulez pas gérer manuellement `/compact` — l'extension le fait pour vous dès que nécessaire, sans intervention.
