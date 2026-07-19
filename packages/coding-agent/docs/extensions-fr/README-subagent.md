# subagent/

**Fichiers source :** `examples/extensions/subagent/index.ts`, `agents.ts`, `agents/*.md`, `prompts/*.md`, `README.md` (anglais)

Système de **délégation à des sous-agents spécialisés**, chacun tournant dans son propre process `pi` isolé (contexte séparé, ne pollue pas la conversation principale). C'est l'extension d'exemple la plus avancée du dépôt.

---

## 1. Vue d'ensemble

L'extension **ajoute un nouvel outil nommé `subagent`** à la liste des outils que le LLM principal peut appeler — exactement comme `read` ou `bash`. Sauf qu'exécuter cet outil ne lit pas un fichier : ça **lance un tout nouveau process `pi` complet**, avec son propre LLM qui tourne dedans, fait sa propre boucle d'appels d'outils, et renvoie un résultat final au premier LLM. Un LLM qui pilote un autre LLM.

3 modes d'appel :

| Mode | Paramètre | Description |
|---|---|---|
| Simple (`single`) | `{ agent, task }` | un agent, une tâche |
| Parallèle (`parallel`) | `{ tasks: [...] }` | plusieurs agents en même temps (max 8, 4 en concurrence) |
| Chaîné (`chain`) | `{ chain: [...] }` | séquentiel, chaque étape réutilise la sortie de la précédente via `{previous}` |

---

## 2. Le rappel de base : qu'est-ce qu'un "outil" pour un LLM ?

Un LLM ne fait normalement que produire du texte. Pour qu'il puisse "agir", on lui fournit une liste d'outils (nom, description, schéma de paramètres). À chaque tour, il peut produire une structure spéciale "je veux appeler l'outil X avec ces paramètres Y" au lieu de répondre en texte. Le programme qui l'entoure (pi) :
1. intercepte cette demande,
2. exécute le vrai code de l'outil,
3. renvoie le résultat au LLM sous forme de "tool result",
4. le LLM continue sa réponse en tenant compte de ce résultat.

Cycle : **LLM demande → programme exécute → programme renvoie le résultat → LLM continue.**

---

## 3. Que sont `scout`, `planner`, `reviewer`, `worker` ?

Ce ne sont **pas du code** — ce sont des fichiers Markdown définissant une "recette" d'agent, avec un frontmatter YAML. Exemple `agents/scout.md` :

```markdown
---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
---

You are a scout. Quickly investigate a codebase and return structured findings...
```

- **`name`** : le nom que le LLM principal utilise pour l'invoquer.
- **`tools`** : liste blanche des outils disponibles pour cet agent (un `scout` n'a pas `write`/`edit` — il ne fait qu'explorer).
- **`model`** : **oui, on peut choisir un modèle différent par agent.** `scout` tourne sur Haiku (rapide, peu cher, suffisant pour explorer des fichiers) ; `planner`/`reviewer`/`worker` tournent sur Sonnet (plus capable, nécessaire pour raisonner/écrire du code).
- **Le corps du fichier** = le system prompt injecté dans ce sous-agent.

`agents.ts` (`discoverAgents`) scanne deux dossiers au moment de l'exécution de l'outil :
- `~/.pi/agent/agents/*.md` (agents "user", chargés par défaut, scope `"user"`)
- `.pi/agents/*.md` dans le projet (agents "project", chargés seulement si `agentScope: "both"` ou `"project"`)

Vous pouvez créer votre propre agent en écrivant simplement un nouveau fichier `.md` de ce format.

### Les 4 agents fournis en exemple

| Agent | Rôle | Modèle | Outils | Fichier |
|---|---|---|---|---|
| `scout` | Reconnaissance rapide du code, renvoie un contexte compressé | Haiku | read, grep, find, ls, bash | `agents/scout.md` |
| `planner` | Crée un plan d'implémentation à partir du contexte du scout | Sonnet | read, grep, find, ls | `agents/planner.md` |
| `worker` | Implémente réellement (écrit/modifie du code) | Sonnet | tous les outils | `agents/worker.md` |
| `reviewer` | Revue de code (qualité, sécurité) | Sonnet | read, grep, find, ls, bash (lecture seule) | `agents/reviewer.md` |

Chacun impose dans son prompt un **format de sortie strict** (voir section 6).

---

## 4. Exemple pas à pas — mode `single`

Vous tapez : *"Utilise scout pour trouver tout le code d'authentification"*

**Étape 1 — Le LLM principal voit l'outil `subagent`** dans sa liste, avec sa description (*"Delegate tasks to specialized subagents with isolated context. Modes: single, parallel, chain..."*).

**Étape 2 — Il décide de l'appeler :**
```json
{ "tool": "subagent", "params": { "agent": "scout", "task": "Trouve tout le code lié à l'authentification" } }
```
Il choisit `"scout"` parce que la liste des agents disponibles (avec leurs descriptions) lui a été fournie dans le prompt système de pi.

**Étape 3 — pi exécute `execute()`** de l'outil `subagent` (`index.ts`), qui tombe dans la branche `runSingleAgent(...)`.

**Étape 4 — `runSingleAgent` lance un vrai nouveau process `pi` via `spawn()`**, équivalent à :
```
pi --mode json -p --no-session --model claude-haiku-4-5 --tools read,grep,find,ls,bash \
   --append-system-prompt /tmp/pi-subagent-xxx/prompt-scout.md \
   "Task: Trouve tout le code lié à l'authentification"
```
- `--mode json` : ce sous-process crache sur `stdout` un flux de lignes JSON (un événement par ligne), format machine-à-machine, pas d'interface terminal.
- `-p --no-session` : mode "one-shot", pas de session sauvegardée sur disque.
- `--model` / `--tools` : appliquent concrètement le modèle et la liste blanche d'outils définis dans le fichier `.md` de l'agent.
- `--append-system-prompt` : le corps du fichier `.md` (écrit dans un fichier temporaire) devient le system prompt du sous-process.
- Le dernier argument est le message utilisateur initial du sous-agent.

Ce process enfant est un **agent complet et autonome** : il a son propre LLM, sa propre boucle de tool-calling (comme en section 2), limitée aux outils autorisés.

**Étape 5 — Le process parent lit le flux JSON ligne par ligne** au fur et à mesure (`proc.stdout.on("data", ...)`). Pour chaque événement `message_end` (message assistant) ou `tool_result_end`, le message est ajouté à `currentResult.messages` et `emitUpdate()` est appelé — ce qui alimente le **streaming en direct** : vous voyez en temps réel les `grep`/`read` que fait le scout, sans attendre la fin.

**Étape 6 — Le sous-process se termine** (`proc.on("close", ...)`). `runSingleAgent` a maintenant accumulé tout l'historique complet de la conversation interne du scout dans `currentResult.messages`.

**Étape 7 — Extraction du résultat final** via `getFinalOutput(messages)`, qui parcourt les messages **à l'envers** et retourne le **dernier texte produit par l'assistant** :
```ts
function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
            for (const part of messages[i].content) {
                if (part.type === "text") return part.text;
            }
        }
    }
    return "";
}
```

**Étape 8 — Ce texte devient le "tool result" renvoyé au LLM principal :**
```ts
return {
    content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
    details: makeDetails("single")([result]),  // pour l'affichage UI, PAS envoyé au LLM
};
```
Le LLM principal reçoit **uniquement le rapport final du scout** — il n'a jamais vu les dizaines d'appels `grep`/`read` internes : ce "bruit" reste isolé dans le sous-process. C'est ça, l'isolation de contexte : seul le résumé final traverse la frontière entre les deux agents.

*(Le champ `details` contient l'historique complet, mais sert uniquement à l'affichage visuel dans le terminal via `renderCall`/`renderResult` — jamais renvoyé au LLM.)*

---

## 5. Mode `parallel` et mode `chain`

### Parallel — tâches indépendantes
```json
{ "tasks": [
    { "agent": "scout", "task": "Trouve où sont définis les models" },
    { "agent": "scout", "task": "Trouve où sont définis les providers" }
] }
```
- Max **8 tâches** (`MAX_PARALLEL_TASKS`), exécutées avec un pool de **4 workers concurrents max** (`MAX_CONCURRENCY`, via `mapWithConcurrencyLimit`) : dès qu'une tâche se termine, la suivante démarre.
- Chaque tâche = un process `pi` indépendant (mécanisme de la section 4), avec son propre callback de streaming (statut "2/3 done, 1 running" affiché en direct).
- Une fois toutes terminées, les résultats sont **agrégés en un seul texte** renvoyé au LLM principal :
```
Parallel: 2/2 succeeded

### [scout] completed
[rapport du scout 1]

---

### [scout] completed
[rapport du scout 2]
```
- Chaque sortie individuelle est plafonnée à **50 Ko** (`PER_TASK_OUTPUT_CAP`) avant transmission au LLM principal (le texte complet reste dans `details` pour l'affichage).

### Chain — séquentiel avec passage de contexte
```json
{ "chain": [
    { "agent": "scout",   "task": "Trouve tout le code d'authentification" },
    { "agent": "planner", "task": "Crée un plan pour ajouter OAuth, basé sur : {previous}" },
    { "agent": "worker",  "task": "Implémente ce plan : {previous}" }
] }
```
- Chaque étape s'exécute l'une après l'autre. Avant de lancer l'étape suivante, le code remplace le placeholder littéral `{previous}` par le **rapport final texte** de l'étape précédente : `taskWithContext = step.task.replace(/\{previous\}/g, previousOutput)`.
- Si une étape échoue, la chaîne **s'arrête immédiatement** avec une erreur indiquant l'étape en cause.
- Le résultat final renvoyé au LLM principal = uniquement le texte final de la **dernière** étape (pas la concaténation de tout).

C'est ce que fait la commande `/implement` (`prompts/implement.md`) : un simple template qui envoie au LLM principal l'instruction *"utilise le mode chain avec scout puis planner puis worker sur : <votre requête>"* — un raccourci pour ne pas reformuler cette demande à chaque fois.

Autres workflows prédéfinis : `/scout-and-plan` (scout → planner) et `/implement-and-review` (worker → reviewer → worker).

---

## 6. Comment être sûr que le travail du sous-agent est bien récupéré ?

**Point clé : le LLM principal ne reçoit JAMAIS l'intégralité du travail du sous-agent — seulement le dernier message texte qu'il a produit** (`getFinalOutput`). Tous les appels d'outils intermédiaires du sous-agent restent invisibles pour le LLM principal (ils sont seulement stockés dans `details`, pour affichage humain).

### Le garde-fou principal : un format de sortie imposé dans chaque prompt

Chaque agent fourni en exemple est **explicitement instruit** de produire un rapport final structuré et auto-suffisant, pas un simple "j'ai fini" :

- **`scout.md`** : *"Your output will be passed to an agent who has NOT seen the files you explored."* → format imposé : `## Files Retrieved` (avec plages de lignes exactes), `## Key Code`, `## Architecture`, `## Start Here`.
- **`planner.md`** : *"Keep the plan concrete. The worker agent will execute it verbatim."* → format imposé : `## Goal`, `## Plan`, `## Files to Modify`, `## New Files`, `## Risks`.
- **`worker.md`** : *"If handing off to another agent (e.g. reviewer), include: exact file paths changed, key functions/types touched."* → format imposé : `## Completed`, `## Files Changed`, `## Notes`.
- **`reviewer.md`** : format imposé : `## Files Reviewed`, `## Critical`, `## Warnings`, `## Suggestions`, `## Summary`.

### Ce qui protège réellement, et ce qui ne protège pas

| Mécanisme | Protège contre |
|---|---|
| Format de sortie imposé dans chaque `.md` | Oublis structurels — force l'agent à produire un rapport complet |
| `details` conserve tout l'historique (accessible via `Ctrl+O`) | Perte définitive d'information — vous pouvez toujours creuser manuellement |
| Gestion d'erreur (`isFailedResult` : exitCode ≠ 0, stopReason "error"/"aborted") | Échecs techniques (crash, timeout, abort) — renvoie un message d'erreur explicite plutôt qu'un résultat vide |
| **Rien** | Un sous-agent qui termine "proprement" mais avec un résumé bâclé ou incomplet |

**Il n'y a aucune garantie structurelle forte** que le résumé soit complet — c'est une garantie de *convention* (prompt engineering), pas une garantie *technique*. Un LLM peut toujours mal appliquer les consignes de son prompt. C'est pour cette raison que les prompts insistent lourdement sur le fait que ce texte final est le seul pont vers la suite.

**Recommandation pour construire vos propres agents** : soigner le prompt comme le font ces 4 exemples — être explicite ("ce texte est tout ce que le suivant verra"), imposer une checklist de sortie stricte, et pour les cas critiques préférer l'exhaustivité à la concision (ex: citer des plages de lignes exactes plutôt que "j'ai regardé le fichier X").

---

## 7. Installation

```bash
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Comment l'utiliser

```
Utilise scout pour trouver tout le code d'authentification
Lance 2 scouts en parallèle : un pour les models, un pour les providers
Utilise une chaîne : scout trouve d'abord l'outil read, puis planner suggère des améliorations
/implement ajoute un cache Redis au session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Comment la configurer

- Créer vos propres agents = fichiers `.md` avec frontmatter (`name`, `description`, `tools`, `model`) dans `~/.pi/agent/agents/` (ou `.pi/agents/` en projet, avec `agentScope: "project"` ou `"both"`).
- Les agents projet peuvent surcharger les agents user du même nom si `agentScope: "both"`.
- `confirmProjectAgents: false` (paramètre de l'outil) désactive la confirmation avant d'exécuter des agents project-local — à ne faire que pour des dépôts de confiance.

## Sécurité

- Par défaut, seuls les agents **user-level** (`~/.pi/agent/agents`) sont chargés.
- Les agents **project-local** (`.pi/agents/*.md`) sont repo-controlled : ils peuvent contenir des instructions arbitraires (lire des fichiers, exécuter du bash). Il faut explicitement passer `agentScope: "both"` ou `"project"` pour les activer, et pi demande confirmation avant de les exécuter (sauf si `confirmProjectAgents: false`).

## Limites

- Sortie repliée aux 10 derniers items en vue collapsed (Ctrl+O pour tout voir).
- Résultat parallèle plafonné à 50 Ko par tâche transmis au modèle parent (le détail complet reste stocké).
- Max 8 tâches parallèles, 4 en concurrence.
- Agents redécouverts à chaque appel (permet de les éditer en cours de session).

## Cas d'usage type

- **Exploration coûteuse déléguée à un modèle bon marché** : `scout` (Haiku) explore un gros codebase sans faire exploser le coût/contexte de la session principale (Sonnet/Opus).
- **Pipeline structuré en une commande** : `/implement <tâche>` enchaîne automatiquement scout → planner → worker, sans avoir à orchestrer manuellement chaque étape.
- **Parallélisation de recherches indépendantes** : lancer plusieurs scouts en même temps sur des zones de code différentes plutôt que séquentiellement.
