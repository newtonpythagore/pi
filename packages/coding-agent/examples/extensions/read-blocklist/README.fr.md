# Read Blocklist

*[English version](./README.md)*

Interdit à l'agent de **lire** les fichiers et répertoires que vous listez
dans un simple fichier JSON par projet. L'écriture n'entre pas dans le
périmètre (voir l'exemple `protected-paths.ts` pour cela) ; cette extension
vise à garder les secrets — fichiers `.env`, clés privées, dossiers
d'identifiants — hors du contexte du LLM.

```
.pi-read-blocklist.json          vous éditez ce fichier
        │
        ├──► hook tool_call       bloque read/grep/find visant un chemin
        │                         protégé (liens symboliques résolus)
        ├──► hook tool_result     retire les résultats protégés des sorties
        │                         grep/find ; revérifie read après exécution
        ├──► heuristiques bash    bloque les commandes bash référençant
        │                         visiblement un chemin protégé
        └──► .pi/sandbox.json     denyRead synchronisé automatiquement →
             (extension sandbox)  application au niveau OS pour tout ce
                                   que fait bash
```

## Configuration

Créez `.pi-read-blocklist.json` à la **racine de votre répertoire de
travail**. Chaque projet a sa propre liste. Le fichier est relu
automatiquement à chaque modification — pas besoin de redémarrer.

```json
{
  "blocked": [
    ".env",
    "*.pem",
    "*.key",
    "secrets/**",
    "config/prod.key",
    ".ssh/"
  ],
  "ignoreCase": false,
  "syncSandbox": true
}
```

Un simple tableau JSON (`[".env", "secrets/**"]`) est également accepté.

| Option | Défaut | Signification |
|---|---|---|
| `blocked` | `[]` | Motifs glob des chemins illisibles (voir la syntaxe ci-dessous) |
| `ignoreCase` | `false` | Correspondance insensible à la casse — à activer sur macOS/Windows, dont les systèmes de fichiers ignorent la casse |
| `syncSandbox` | `true` | Refléter la liste dans `.pi/sandbox.json` → `filesystem.denyRead` |

### Syntaxe des globs (façon gitignore)

- `*` correspond à n'importe quoi dans **un seul** segment de chemin (`*.pem`)
- `**` correspond à travers plusieurs répertoires (`secrets/**`)
- `?` correspond à un seul caractère
- Un motif **sans** slash (`.env`, `*.key`) correspond par nom **n'importe
  où** dans l'arborescence, y compris les répertoires de ce nom et leur
  contenu.
- Un motif **avec** slash (`config/prod.key`) est ancré à la racine du
  projet.
- Un slash final (`.ssh/`) signifie « ce répertoire et tout ce qu'il
  contient ».

## Fonctionnement

Défense en profondeur, quatre couches :

1. **Blocage avant exécution (`tool_call`).** pi émet un événement
   `tool_call` avant chaque exécution d'outil, et renvoyer
   `{ block: true }` empêche l'exécution. Pour `read`, `grep` et `find`, le
   chemin ciblé est comparé à la liste — à la fois tel quel **et** après
   résolution des liens symboliques (`realpath`), ce qui permet d'intercepter
   `ln -s .env x; read x` ainsi que les lectures passant par des répertoires
   symlinkés. Cette interception est architecturale : le LLM ne peut pas
   appeler un outil sans passer par ce hook.

2. **Filtrage des sorties (`tool_result`).** Un `grep` ou un `find` sur toute
   une arborescence traverse légitimement des fichiers protégés — bloquer de
   telles recherches handicaperait l'agent. À la place, ce sont les
   *résultats* qui sont filtrés : chaque ligne/chemin rapporté est résolu
   (liens symboliques inclus) et retiré s'il appartient à un fichier
   protégé, avec une mention `[N résultat(s) masqué(s)]`. Même si ripgrep a
   lu le fichier sur disque, son contenu n'atteint jamais le LLM — c'est
   cette frontière qui compte. Les résultats de `read` sont eux aussi
   revérifiés après exécution, ce qui referme la petite fenêtre de course
   entre la vérification et la lecture.

3. **Heuristiques bash (`tool_call` sur `bash`).** Les commandes sont
   scannées à la recherche de références à des chemins protégés (mentions
   directes, redirections, affectations de variables, one-liners
   d'interpréteur). Cela attrape les accidents involontaires à moindre coût,
   mais un shell est Turing-complet : aucune analyse de chaîne ne peut
   attraper toutes les ruses (`cat .e*`, `cd secrets && cat db.txt`,
   éclatement de guillemets…). C'est volontaire — l'application réelle pour
   bash est la couche 4.

4. **Application au niveau OS (synchronisation sandbox).** La liste est
   automatiquement reflétée dans `.pi/sandbox.json` sous
   `filesystem.denyRead`, la configuration consommée par l'extension
   d'exemple [`sandbox/`](../sandbox/) (`@anthropic-ai/sandbox-runtime` :
   bubblewrap sur Linux, `sandbox-exec` sur macOS). Le sandbox actif, c'est
   le **noyau** qui refuse l'`open()` — peu importe comment la commande a
   été écrite, développée par le shell, ou obfusquée. C'est la seule couche
   réellement infalsifiable pour bash, et c'est précisément pourquoi les
   deux extensions sont conçues pour être utilisées ensemble.

### Pourquoi ce lien avec le sandbox ?

Cette séparation existe parce que chaque côté couvre l'angle mort de
l'autre :

| | `read`/`grep`/`find` | `bash` |
|---|---|---|
| Où ça s'exécute | dans le process Node de pi | process shell enfant |
| Cette extension | ✅ fiable (arguments structurés + filtrage des sorties) | ⚠️ heuristique seulement |
| `denyRead` du sandbox | ❌ non couvert (s'exécute hors du sandbox) | ✅ appliqué par le noyau |

Le sandbox n'enveloppe que les commandes bash, il ne peut donc pas voir les
outils in-process de pi ; cette extension les couvre précisément parce que
leurs entrées et sorties sont structurées. À l'inverse, aucune analyse de
chaîne de commande ne peut sécuriser bash, donc la liste est poussée dans le
sandbox où l'OS l'applique. Un seul fichier JSON alimente les deux couches,
qui ne peuvent donc jamais diverger.

Détails de la synchronisation : les entrées que cette extension ajoute à
`denyRead` sont suivies sous une clé marqueur
`readBlocklistManagedDenyRead` (ignorée par le sandbox), afin que vos
propres entrées manuelles de `denyRead` soient préservées et que les
entrées gérées obsolètes soient retirées quand vous modifiez la liste.
L'extension sandbox lit sa configuration au démarrage — faites `/reload`
(ou redémarrez pi) après la première synchronisation, ou après avoir modifié
la liste pendant que le sandbox est actif.

## Installation

```bash
# Liste seule (outils in-process + heuristiques bash) :
pi -e ./examples/extensions/read-blocklist

# Protection complète (recommandé) — ajoutez l'extension sandbox :
cp -r examples/extensions/read-blocklist ~/.pi/agent/extensions/
cp -r examples/extensions/sandbox ~/.pi/agent/extensions/
(cd ~/.pi/agent/extensions/sandbox && npm install)
```

Puis créez `.pi-read-blocklist.json` dans votre projet (voir
[`blocklist.example.json`](./blocklist.example.json)).

Lancez les tests unitaires avec :

```bash
node --experimental-strip-types test.ts
```

## Garanties et limites

- `read`, `grep`, `find` : fiable en pratique — entrées structurées,
  résolution des liens symboliques et filtrage côté sortie ne laissent
  aucun contournement connu. L'écart théorique résiduel est une course
  TOCTOU (un processus concurrent qui échange un lien symbolique en cours
  d'appel), atténuée par la revérification post-exécution.
- `bash` **avec** la couche sandbox : appliqué par le noyau, infalsifiable.
- `bash` **sans** la couche sandbox : heuristiques best-effort uniquement.
  Considérez ce mode comme une protection contre les accidents, pas contre
  un adversaire déterminé.
- `ls` n'est pas intercepté : les *noms* de fichiers (métadonnées) restent
  visibles ; ce que protège cette extension, c'est le contenu.
- Seule la certitude mathématique vient du noyau. Si vous avez besoin d'une
  garantie stricte pour absolument tout, y compris le process de pi
  lui-même, utilisez les permissions de l'OS ou exécutez pi lui-même dans
  un sandbox.
