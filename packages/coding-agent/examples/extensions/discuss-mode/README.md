# Extension Discuss Mode

Variante de l'extension `plan-mode` orientée conception collaborative de fonctionnalités.

Le principe : discuter avec l'IA en lecture seule pour définir ensemble comment construire
une fonctionnalité, puis générer un document markdown « recette de cuisine » qu'un
développeur peut appliquer à la lettre, sans se poser la moindre question.

## Fonctionnalités

- **Outils d'écriture désactivés** : `edit` et `write` sont retirés pendant la discussion,
  les autres outils actifs sont conservés
- **Allowlist bash** : seules les commandes en lecture seule sont autorisées
- **Génération d'une recette** : `/generate-plan` produit un fichier markdown exhaustif
  (code complet, fichiers à créer/modifier/supprimer, commandes, validations)
- **Écriture par l'extension** : le fichier est écrit par l'extension elle-même via
  `node:fs` — l'IA n'a jamais accès à l'outil `write` pendant la discussion
- **Persistance de session** : l'état survit à une reprise de session

## Commandes

- `/discuss` — Activer/désactiver le mode discussion
- `/generate-plan [nom de la fonctionnalité]` — Générer le fichier de plan
- `Ctrl+Alt+D` — Activer/désactiver le mode discussion (raccourci)
- Flag CLI `--discuss` — Démarrer directement en mode discussion

## Utilisation

1. Activer le mode discussion avec `/discuss` (ou le flag `--discuss`)
2. Discuter avec l'IA de la fonctionnalité à construire : elle explore le code,
   pose des questions de clarification, propose des approches et challenge vos choix
3. Quand la discussion est concluante, lancer `/generate-plan Mon nom de fonctionnalité`
   (sans argument, l'IA déduit le nom de la discussion)
4. L'extension extrait le document généré et l'écrit dans `plans/<slug>.md`
   (ex. `plans/authentification-oauth-2-0.md`)
5. Un choix est ensuite proposé :
   - **Execute the plan now** — sortir du mode discussion, restaurer tous les outils
     et demander à l'IA d'appliquer le plan à la lettre
   - **Stay in discuss mode (refine)** — continuer la discussion et régénérer plus tard
   - **Exit discuss mode** — sortir du mode sans exécuter

## Contenu du fichier généré

Le document est structuré comme une recette :

- `# <Nom de la fonctionnalité>` — titre
- `## Contexte` — objectif et décisions prises pendant la discussion
- `## Prérequis` — outils, versions, commandes d'installation exactes
- `## Étape N — <titre>` — pour chaque étape, dans l'ordre :
  - action exacte : CRÉER / MODIFIER / SUPPRIMER, avec le chemin complet du fichier
  - code complet prêt à copier-coller (pas de pseudo-code ni d'extraits partiels)
  - commandes shell exactes, le cas échéant
  - sous-section **Validation** : comment vérifier que l'étape est correcte
- `## Validation finale` — vérification de bout en bout

Si une information manque, le document est généré quand même avec des blocs
`> TODO : ...` aux endroits à préciser.

## Fonctionnement interne

### Mode discussion (lecture seule)
- `edit`/`write` désactivés, la liste d'outils précédente est sauvegardée
- Commandes bash filtrées par une allowlist
- Un contexte caché est injecté à chaque tour : co-concevoir la fonctionnalité,
  ne pas générer de plan tant que `/generate-plan` n'a pas été lancé

### Génération
- `/generate-plan` envoie à l'IA les exigences du document et lui demande de
  l'encadrer entre les marqueurs `===PLAN-FILE===` et `===END-PLAN-FILE===`
- À la fin du tour, l'extension extrait le contenu entre les marqueurs,
  calcule un slug à partir du nom de la fonctionnalité (accents retirés,
  caractères spéciaux remplacés par des tirets) et écrit `plans/<slug>.md`

### Allowlist de commandes

Commandes sûres (autorisées) :
- Inspection de fichiers : `cat`, `head`, `tail`, `less`, `more`
- Recherche : `grep`, `find`, `rg`, `fd`
- Répertoires : `ls`, `pwd`, `tree`
- Git en lecture : `git status`, `git log`, `git diff`, `git branch`
- Infos paquets : `npm list`, `npm outdated`, `yarn info`
- Infos système : `uname`, `whoami`, `date`, `uptime`

Commandes bloquées :
- Modification de fichiers : `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git en écriture : `git add`, `git commit`, `git push`
- Installation de paquets : `npm install`, `yarn add`, `pip install`
- Système : `sudo`, `kill`, `reboot`
- Éditeurs : `vim`, `nano`, `code`

## Vérification des types

Le dossier contient un `tsconfig.json` dédié qui ajoute le mapping du module
`@earendil-works/pi-agent-core` (absent de `tsconfig.examples.json`) :

```sh
# depuis packages/coding-agent
npx tsgo -p examples/extensions/discuss-mode/tsconfig.json
```
