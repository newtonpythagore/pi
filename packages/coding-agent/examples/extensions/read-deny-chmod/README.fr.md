# Read Deny (chmod)

*[English version](./README.md)*

Le **petit frère simplifié** de [`read-blocklist/`](../read-blocklist/) : au
lieu d'intercepter les outils de pi, il demande au système d'exploitation de
faire le travail. Au démarrage de la session, il retire toutes les
permissions (`chmod 000`) des fichiers et répertoires que vous listez ; à la
sortie, il restaure les permissions d'origine. Tant que le verrou est actif,
**toute** lecture et **toute** écriture échouent avec `EACCES` — les outils
`read` et `write` de pi, ripgrep, `cat`, un one-liner python, n'importe
quoi — parce que c'est le système de fichiers lui-même qui refuse, sans
aucune analyse de commande et sans aucun surcoût par appel.

```
démarrage                      pendant que pi tourne              sortie
─────────                      ─────────────────────              ──────
sauve les modes d'origine      watch inotify sur chaque chemin    restaure
  → .pi/read-deny.state.json     → re-verrouille instantanément   les modes
chmod 000 (fichiers et            si les droits changent          d'origine
           répertoires)        bash chmod/chown/chattr/setfacl
                                 sur un chemin protégé → bloqué
```

## Configuration

Créez `.pi-read-deny.json` à la racine de votre répertoire de travail.
**Chemins exacts uniquement — pas de jokers** (c'est le principe : simplicité
maximale ; utilisez `read-blocklist/` si vous avez besoin de globs) :

```json
{
  "denied": [
    ".env",
    "secrets",
    "config/prod.key"
  ]
}
```

Un simple tableau JSON est aussi accepté. Les chemins sont relatifs à la
racine du projet (les chemins absolus fonctionnent aussi). Une entrée avec
joker est ignorée avec un avertissement.

## Fonctionnement

1. **Démarrage** (`session_start`) : le mode courant de chaque chemin listé
   est lu et persisté dans `.pi/read-deny.state.json` **avant** tout chmod.
   Ensuite chaque chemin est verrouillé en mode `000` — ni lecture, ni
   écriture, ni exécution pour personne (pour un répertoire, le contenu est
   inaccessible même en connaissant le chemin exact). Un seul appel système
   par chemin (`fs.chmodSync`, l'équivalent exact de la commande `chmod`,
   sans lancer de shell).

2. **Pendant l'exécution** : un observateur inotify (`fs.watch`) est attaché
   à chaque chemin protégé. Si quelqu'un — l'agent, un autre terminal, un
   autre programme — remet un bit de permission quelconque, le noyau notifie
   pi instantanément et le chemin est re-verrouillé. Purement événementiel :
   pas de polling, pas de timer, aucun coût par appel d'outil. En première
   ligne, les commandes bash invoquant `chmod`/`chown`/`chattr`/`setfacl`
   sur un chemin protégé sont bloquées d'office ; l'observateur est le filet
   de sécurité pour tout ce qui serait plus retors.

3. **Sortie** (`session_shutdown`, plus une ceinture synchrone
   `process.on("exit")`) : les modes d'origine sont restaurés et le fichier
   d'état est supprimé.

4. **Récupération après crash** : si pi meurt sans nettoyage (kill -9,
   coupure de courant), le fichier d'état survit. Au démarrage suivant,
   l'extension restaure d'abord les modes sauvegardés, puis re-verrouille
   pour la nouvelle session. Vous pouvez aussi lancer `/read-deny restore` à
   tout moment, ou appliquer à la main les modes de
   `.pi/read-deny.state.json` si vous devez récupérer sans pi.

## Commandes

| Commande | Effet |
|---|---|
| `/read-deny` | Affiche les chemins protégés, l'état du verrou, les modes d'origine |
| `/read-deny restore` | Restaure les permissions d'origine maintenant (jusqu'à la prochaine session) |
| `/read-deny lock` | Relit la config et ré-applique les verrous |

## Comparaison avec `read-blocklist/`

| | `read-deny-chmod/` | `read-blocklist/` |
|---|---|---|
| Mécanisme | permissions OS (chmod) | interception d'outils + filtrage des sorties + sync sandbox |
| Config | chemins exacts uniquement | motifs glob |
| Couvre | tous les process à égalité (outils pi, bash, scripts) | outils pi de façon fiable ; bash exige la couche sandbox |
| Surcoût par appel | aucun | léger (matching de chemins à chaque appel d'outil) |
| Modifie le disque | oui (modes changés pendant la session) | non |
| Résultats de recherche | les recherches ignorent simplement les chemins illisibles | correspondances protégées filtrées avec une note |
| Mode de défaillance | un crash laisse les chemins verrouillés (auto-réparé au démarrage suivant) | aucun |

Choisissez celle-ci pour une courte liste de fichiers secrets connus et une
simplicité maximale ; choisissez `read-blocklist/` quand il vous faut des
motifs (`*.pem`, `secrets/**`) ou qu'il ne faut pas toucher aux permissions
sur le disque.

## Garanties et limites

- L'application est faite par le système de fichiers, donc elle s'applique à
  l'identique à tous les chemins d'accès, lecture comme écriture — aucun
  contournement par guillemets astucieux, jokers, liens symboliques vers le
  chemin verrouillé, interpréteurs ou sous-processus. Un symlink n'est qu'un
  nom : l'ouvrir aboutit quand même sur la cible verrouillée.
- **Lancez pi avec un utilisateur normal.** root (et les process disposant
  de `CAP_DAC_OVERRIDE`) ignorent totalement les bits de permission.
- Le propriétaire d'un fichier peut toujours refaire un `chmod`. L'agent est
  donc bloqué en amont (garde bash) et défait instantanément (observateur) —
  mais entre un changement de droits non intercepté et le rappel inotify, il
  existe une fenêtre de l'ordre de la milliseconde. Si votre modèle de
  menace est un agent délibérément hostile, combinez avec l'extension
  sandbox ou une isolation au niveau OS.
- Les contenus copiés *avant* le verrouillage (sauvegardes, artefacts de
  build, objets git) ne sont pas protégés — le verrou s'applique aux chemins
  listés uniquement.
- Les liens durs vers un fichier verrouillé partagent son inode et sont tout
  aussi illisibles ; mais une *copie* faite avant la session est un fichier
  indépendant.
- Unix uniquement (Linux/macOS). Sous Windows, `chmod` ne peut pas retirer
  le droit de lecture.
- Un fichier verrouillé ne peut pas être modifié en place, mais son *entrée
  de répertoire* le peut : si le répertoire parent est accessible en
  écriture, le fichier peut toujours être supprimé ou remplacé. Protégez
  aussi le répertoire parent si c'est important.

Lancez les tests unitaires avec :

```bash
node --experimental-strip-types test.ts
```
