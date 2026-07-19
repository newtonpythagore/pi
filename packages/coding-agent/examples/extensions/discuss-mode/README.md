# Extension Discuss Mode

Variante de l'extension `plan-mode` orientée conception collaborative de fonctionnalités.

Le principe : discuter avec l'IA en lecture seule pour définir ensemble comment construire
une fonctionnalité, puis générer un document markdown « recette de cuisine » qu'un
développeur peut appliquer à la lettre, sans se poser la moindre question.

## Fonctionnalités

- **Outils d'écriture désactivés** : `edit` et `write` sont retirés pendant la discussion,
  les autres outils actifs sont conservés
- **Allowlist bash** : seules les commandes en lecture seule sont autorisées
- **Génération en deux phases** : `/generate-plan` produit d'abord un sommaire des
  étapes soumis à validation, puis le plan complet (code, fichiers à
  créer/modifier/supprimer, commandes, validations)
- **Écriture par l'IA, cantonnée à `plans/`** : le fichier est écrit par l'IA avec
  l'outil `write`, mais l'extension bloque toute écriture hors du dossier `plans/`
- **Détection de modification manuelle** : si le fichier de plan est modifié en
  dehors de la conversation, l'IA en est prévenue au tour suivant
- **Persistance de session** : l'état survit à une reprise de session

## Commandes

- `/discuss` — Activer/désactiver le mode discussion
- `/generate-plan [nom de la fonctionnalité]` — Générer le plan (sommaire d'abord)
- `/modif_plan [nom]` — Modifier un plan existant sans passer par la génération
- `Ctrl+Alt+D` — Activer/désactiver le mode discussion (raccourci)
- Flag CLI `--discuss` — Démarrer directement en mode discussion

## Utilisation

1. Activer le mode discussion avec `/discuss` (ou le flag `--discuss`)
2. Discuter avec l'IA de la fonctionnalité à construire : elle explore le code,
   pose des questions de clarification, propose des approches et challenge vos choix
3. Quand la discussion est concluante, lancer `/generate-plan Mon nom de fonctionnalité`
   (sans argument, l'IA déduit le nom de la discussion)
4. **Phase 1 — sommaire** : l'IA affiche uniquement la liste numérotée des étapes
   prévues (sans code). Un menu propose :
   - **Generate the full plan** — valider et lancer la génération complète
   - **Adjust the outline** — saisir des remarques ; l'IA représente un nouveau
     sommaire, le menu revient
   - **Cancel** — abandonner, rester en mode discussion
5. **Phase 2 — génération** : l'IA écrit elle-même le document complet avec l'outil
   `write` dans `plans/<slug>/<slug>.md` (ex.
   `plans/authentification-oauth/authentification-oauth.md`) — un seul fichier pour
   le moment, dans un sous-répertoire par fonctionnalité. L'extension vérifie que le
   fichier attendu existe bien
6. Un choix est ensuite proposé :
   - **Execute the plan now** — sortir du mode discussion, restaurer tous les outils
     et demander à l'IA d'appliquer le plan à la lettre
   - **Modify the plan** — passer en mode modification de plan (voir ci-dessous)
   - **Exit discuss mode** — sortir du mode sans exécuter

## Modifier un plan existant : `/modif_plan`

Pour reprendre un plan après avoir quitté `pi`, sans repasser par la discussion ni
la génération :

- `/modif_plan oauth` — cherche le fichier dans cet ordre : chemin donné tel quel,
  `plans/oauth`, `plans/oauth.md`, `plans/oauth/oauth.md`, puis les variantes en
  slug. Introuvable : message d'erreur listant les plans disponibles
- `/modif_plan` sans argument — affiche un sélecteur listant tous les fichiers
  `.md` du dossier `plans/`

Dans les deux cas, on entre directement en mode modification de plan, avec les
mêmes restrictions quel que soit le point d'entrée (écriture limitée à `plans/`,
bash en lecture seule).

## Mode modification de plan

Après génération, choisir **Modify the plan** permet d'itérer sur le document de
manière économe : plutôt que de régénérer tout le plan à chaque retouche (coûteux
en tokens et sujet aux erreurs de recopie), l'IA modifie le fichier directement
par retouches ciblées avec l'outil `edit`.

Dans ce mode :
- `edit` et `write` sont réactivés, mais **uniquement pour les fichiers du dossier
  `plans/`** — toute écriture ailleurs est bloquée par l'extension, qui vérifie le
  chemin après résolution des `../` et des liens symboliques
- Bash reste restreint aux commandes en lecture seule
- L'historique de la conversation est conservé : chaque nouvelle demande de
  modification bénéficie du contexte des échanges précédents
- L'IA n'est pas obligée de relire le fichier à chaque tour : le contexte injecté
  lui indique le fichier de travail et lui laisse juger si une relecture est
  nécessaire avant d'éditer
- Si le fichier a été modifié **manuellement** (en dehors de la conversation),
  l'extension le détecte via sa date de modification et ajoute un avertissement
  au contexte : « relis-le avant toute édition »
- `/discuss` quitte le mode et restaure tous les outils
- Pour exécuter le plan une fois les modifications terminées : quitter avec
  `/discuss` puis demander l'exécution, le fichier faisant foi

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

### Génération (deux phases)
- **Phase 1** : `/generate-plan` demande à l'IA un sommaire seul (titre + étapes
  numérotées, sans code). À la fin du tour, un menu de validation s'affiche ;
  « Adjust the outline » ouvre un éditeur pour vos remarques et relance un
  sommaire
- **Phase 2** : une fois validé, l'extension calcule le slug (à partir du nom
  donné en argument ou du titre `#` du sommaire — accents retirés, caractères
  spéciaux remplacés par des tirets), active les outils d'écriture restreints à
  `plans/`, et demande à l'IA d'écrire elle-même le document complet dans
  `plans/<slug>/<slug>.md` avec l'outil `write`
- À la fin du tour, l'extension vérifie que le fichier attendu existe ; sinon
  elle signale l'échec et propose de relancer

### Mode modification de plan
- Un contexte caché est injecté à chaque tour : « Nous travaillons sur la
  modification du plan : `plans/<slug>/<slug>.md`. Tu n'as pas besoin de le
  relire à chaque tour ; relis une section seulement si tu as un doute sur son
  contenu exact avant de l'éditer. »
- Le hook `tool_call` valide chaque appel `edit`/`write` : le chemin cible est
  résolu en absolu, son dossier parent et le fichier lui-même sont canonisés
  (liens symboliques suivis), et l'appel est bloqué si le résultat sort de
  `plans/`

### Détection de modification manuelle
- Après chaque tour où l'IA a pu écrire le plan, l'extension mémorise la date de
  modification (`mtime`) du fichier
- Avant chaque tour en mode modification, elle compare la date actuelle à celle
  mémorisée : si elles diffèrent, le fichier a été modifié en dehors de la
  conversation (éditeur, autre outil...) et une ligne d'avertissement est
  ajoutée au contexte injecté pour demander une relecture avant édition

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

## Problème connu : fausse erreur lors de la vérification des types

### Le symptôme

Si on lance la vérification des types des exemples (`tsgo -p tsconfig.examples.json`
depuis `packages/coding-agent`), une erreur apparaît sur cette extension :

```
error TS2307: Cannot find module '@earendil-works/pi-agent-core'
```

### Est-ce grave ?

**Non. L'extension fonctionne parfaitement malgré ce message.** Voici pourquoi,
expliqué simplement :

- TypeScript est le langage dans lequel l'extension est écrite. Avant d'exécuter
  du code TypeScript, on peut lancer un « vérificateur de types » : un outil qui
  relit le code et signale les incohérences, un peu comme un correcteur
  orthographique. Ce vérificateur ne fait que **lire** le code, il ne l'exécute pas.
- Le projet `pi` est découpé en plusieurs briques (des « packages »). L'extension
  mentionne l'une de ces briques, `pi-agent-core`, uniquement pour lui emprunter
  une **description de format de données** (à quoi ressemble un message de l'agent).
  Cette mention est purement documentaire : elle est complètement supprimée du
  code réellement exécuté.
- Le fichier de configuration du vérificateur (`tsconfig.examples.json`, commun à
  tous les exemples) contient une liste d'adresses : « quand un exemple mentionne
  telle brique, va lire sa description à tel endroit ». Cette liste mentionne les
  briques `pi-coding-agent`, `pi-tui` et `pi-ai`... mais **pas** `pi-agent-core`.
  Le vérificateur ne sait donc pas où lire sa description, et affiche l'erreur.
- Preuve que ce n'est pas un défaut de cette extension : l'extension officielle
  `plan-mode`, livrée avec `pi` et parfaitement fonctionnelle, mentionne la même
  brique et affiche **exactement la même erreur**.

En résumé : c'est l'annuaire du correcteur qui est incomplet, pas le code qui est faux.

### Comment remettre en place le correctif

Ajouter l'adresse manquante dans la liste `paths` du fichier
`packages/coding-agent/tsconfig.examples.json` :

```json
"paths": {
	"@earendil-works/pi-coding-agent": ["./src/index.ts"],
	"@earendil-works/pi-coding-agent/hooks": ["./src/core/hooks/index.ts"],
	"@earendil-works/pi-agent-core": ["../agent/src/index.ts"],
	"@earendil-works/pi-tui": ["../tui/src/index.ts"],
	"@earendil-works/pi-ai": ["../ai/src/index.ts"],
	"typebox": ["../../node_modules/typebox"]
}
```

La ligne à ajouter est celle de `@earendil-works/pi-agent-core`. Attention :
ce fichier étant partagé par **tous** les exemples du dossier, cette ligne fera
aussi disparaître l'erreur pour les autres extensions concernées (`plan-mode`,
`handoff`, ...). Autre option, sans toucher au fichier partagé : créer un
`tsconfig.json` local dans ce dossier qui étend `../../../tsconfig.examples.json`
et redéclare la liste `paths` complète avec la ligne manquante (les chemins
relatifs doivent alors être ajustés depuis ce dossier, par exemple
`../../../../agent/src/index.ts`).
