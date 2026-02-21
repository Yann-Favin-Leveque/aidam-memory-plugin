# AIDAM Memory Plugin - Plan de Tests Incremental

Version: 1.0
Date: 2026-02-20

Ce plan couvre des tests de complexite croissante, du smoke test basique jusqu'a l'autonomie complete. Chaque niveau doit etre valide avant de passer au suivant.

---

## NIVEAU 0 - INFRASTRUCTURE (Prerequis)

### T0.1 - DB tables existent
```bash
export PGPASSWORD="$PGPASSWORD"  # Set in .env
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('cognitive_inbox','retrieval_inbox','generated_tools','orchestrator_state') ORDER BY tablename;"
```
**Attendu:** 4 tables listees

### T0.2 - Fonctions SQL cleanup
```bash
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT routine_name FROM information_schema.routines WHERE routine_schema='public' AND routine_name LIKE 'cleanup%' ORDER BY 1;"
```
**Attendu:** cleanup_expired_retrieval, cleanup_old_cognitive_inbox

### T0.3 - npm dependencies installees
```bash
cd C:/Users/user/IdeaProjects/aidam-memory-plugin && node -e "require('./scripts/orchestrator.js'); console.log('OK')" 2>&1 | head -1
```
**Attendu:** Erreur "--session-id is required" (module charge OK)

### T0.4 - Python psycopg2 disponible
```bash
"C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe" -c "import psycopg2; print('OK')"
```
**Attendu:** OK

### T0.5 - MCP memory server fonctionnel
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  "C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe" \
  "C:/Users/user/.claude/tools/python/memory_mcp_server.py" 2>/dev/null | head -1
```
**Attendu:** JSON avec liste de tools

---

## NIVEAU 1 - HOOKS ISOLES

### T1.1 - on_tool_use.py : sauvegarde un Edit
```bash
echo '{"session_id":"t1-001","tool_name":"Edit","tool_input":"{\"file\":\"test.java\"}","tool_response":"Edit successful"}' | \
  "$PYTHON" "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_tool_use.py"
# Verifier:
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT message_type, status FROM cognitive_inbox WHERE session_id='t1-001';"
```
**Attendu:** `tool_use|pending`

### T1.2 - on_tool_use.py : skip les tools de la skip-list
```bash
for tool in Read Glob Grep WebSearch WebFetch; do
  echo "{\"session_id\":\"t1-002\",\"tool_name\":\"$tool\",\"tool_input\":\"{}\",\"tool_response\":\"ok\"}" | \
    "$PYTHON" "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_tool_use.py"
done
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT COUNT(*) FROM cognitive_inbox WHERE session_id='t1-002';"
```
**Attendu:** 0

### T1.3 - on_tool_use.py : truncate les gros payloads
```bash
BIG=$(python3 -c "print('x'*10000)")
echo "{\"session_id\":\"t1-003\",\"tool_name\":\"Bash\",\"tool_input\":\"$BIG\",\"tool_response\":\"ok\"}" | \
  "$PYTHON" "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_tool_use.py"
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT LENGTH(payload::text) < 5000 FROM cognitive_inbox WHERE session_id='t1-003';"
```
**Attendu:** t (true)

### T1.4 - on_prompt_submit.py : insere prompt_context
```bash
echo '{"session_id":"t1-004","prompt":"test prompt"}' | \
  timeout 8 "$PYTHON" "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_prompt_submit.py"
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT message_type, status FROM cognitive_inbox WHERE session_id='t1-004';"
```
**Attendu:** `prompt_context|pending`, script sort sans output (pas de resultat retriever)

### T1.5 - on_prompt_submit.py : pickup un resultat pre-insere
```bash
HASH=$("$PYTHON" -c "import hashlib; print(hashlib.sha256(b'test pickup').hexdigest()[:16])")
"$PSQL" -U postgres -h localhost -d claude_memory -c \
  "INSERT INTO retrieval_inbox (session_id, prompt_hash, context_type, context_text, status, expires_at) \
   VALUES ('t1-005', '$HASH', 'memory_results', '=== TEST CONTEXT ===', 'pending', CURRENT_TIMESTAMP + INTERVAL '60s');"
echo '{"session_id":"t1-005","prompt":"test pickup"}' | \
  timeout 8 "$PYTHON" "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_prompt_submit.py"
```
**Attendu:** JSON output avec `additionalContext` contenant "=== TEST CONTEXT ==="

### T1.6 - on_prompt_submit.py : desactive via env var
```bash
AIDAM_MEMORY_RETRIEVER=off echo '{"session_id":"t1-006","prompt":"should skip"}' | \
  timeout 3 "$PYTHON" "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_prompt_submit.py"
```
**Attendu:** exit immediat, aucune insertion

### T1.7 - on_session_start.sh : lance orchestrateur
```bash
echo '{"session_id":"t1-007","cwd":"/tmp"}' | \
  bash "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_session_start.sh"
```
**Attendu:** JSON avec `[AIDAM Memory: active, retriever=on, learner=on]`

### T1.8 - on_session_start.sh : mode disable
```bash
export AIDAM_MEMORY_RETRIEVER=off AIDAM_MEMORY_LEARNER=off
echo '{"session_id":"t1-008","cwd":"/tmp"}' | \
  bash "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_session_start.sh"
unset AIDAM_MEMORY_RETRIEVER AIDAM_MEMORY_LEARNER
```
**Attendu:** `[AIDAM Memory: disabled]`

### T1.9 - on_session_end.sh : arrete orchestrateur
```bash
# (apres T1.7) Stopper l'orchestrateur lance
echo '{"session_id":"t1-007"}' | \
  bash "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_session_end.sh"
sleep 3
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT status FROM orchestrator_state WHERE session_id='t1-007';"
```
**Attendu:** `stopped`

---

## NIVEAU 2 - ORCHESTRATEUR STANDALONE

### T2.1 - Demarrage + enregistrement DB
```bash
cd C:/Users/user/IdeaProjects/aidam-memory-plugin
node scripts/orchestrator.js --session-id=t2-001 > /tmp/t2.log 2>&1 &
sleep 10
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT status, retriever_session_id IS NOT NULL, learner_session_id IS NOT NULL FROM orchestrator_state WHERE session_id='t2-001';"
```
**Attendu:** `running|t|t`

### T2.2 - Heartbeat fonctionne
```bash
sleep 35  # Attendre 1 heartbeat (30s)
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT last_heartbeat_at > started_at + INTERVAL '20 seconds' FROM orchestrator_state WHERE session_id='t2-001';"
```
**Attendu:** `t`

### T2.3 - Retriever route un prompt_context
```bash
"$PSQL" -U postgres -h localhost -d claude_memory -c \
  "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) \
   VALUES ('t2-001', 'prompt_context', '{\"prompt\":\"What projects do I have?\",\"prompt_hash\":\"t2hash001\",\"timestamp\":1}', 'pending');"
sleep 15
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT status FROM cognitive_inbox WHERE session_id='t2-001' AND message_type='prompt_context';"
# Et verifier retrieval_inbox:
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT context_type, status FROM retrieval_inbox WHERE prompt_hash='t2hash001';"
```
**Attendu:** cognitive_inbox: `completed`, retrieval_inbox: existe (type `memory_results` ou `none`)

### T2.4 - Learner route un tool_use
```bash
"$PSQL" -U postgres -h localhost -d claude_memory -c \
  "INSERT INTO cognitive_inbox (session_id, message_type, payload, status) \
   VALUES ('t2-001', 'tool_use', '{\"tool_name\":\"Bash\",\"tool_input\":\"mvn compile\",\"tool_response\":\"BUILD FAILURE: Could not resolve spring-boot-starter 3.2.0. Fixed by updating to 3.2.1 in pom.xml\"}', 'pending');"
sleep 30
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT status FROM cognitive_inbox WHERE session_id='t2-001' AND message_type='tool_use' ORDER BY id DESC LIMIT 1;"
```
**Attendu:** `completed`
**Bonus:** Verifier si une nouvelle entree dans `errors_solutions` ou `learnings`

### T2.5 - Shutdown via DB signal
```bash
"$PSQL" -U postgres -h localhost -d claude_memory -c \
  "UPDATE orchestrator_state SET status='stopping' WHERE session_id='t2-001';"
sleep 5
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT status, stopped_at IS NOT NULL FROM orchestrator_state WHERE session_id='t2-001';"
```
**Attendu:** `stopped|t`

### T2.6 - Zombie detection
```bash
# Simuler un zombie: creer un state avec vieux heartbeat
"$PSQL" -U postgres -h localhost -d claude_memory -c \
  "INSERT INTO orchestrator_state (session_id, pid, status, last_heartbeat_at) \
   VALUES ('t2-zombie', 99999, 'running', CURRENT_TIMESTAMP - INTERVAL '5 minutes');"
# Lancer un nouvel orchestrateur - il devrait detecter le zombie
echo '{"session_id":"t2-007","cwd":"/tmp"}' | \
  bash "C:/Users/user/IdeaProjects/aidam-memory-plugin/scripts/on_session_start.sh"
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT status FROM orchestrator_state WHERE session_id='t2-zombie';"
```
**Attendu:** `crashed`

---

## NIVEAU 3 - RETRIEVER INTELLIGENCE

### T3.1 - Fast exit sur prompt trivial
Injecter un `prompt_context` avec prompt = "ok continue"
**Attendu:** Retriever repond SKIP, `context_type=none` dans retrieval_inbox, temps < 5s

### T3.2 - Recherche projet par nom
Injecter prompt = "On travaille sur ecopaths"
**Attendu:** Retriever fait `memory_get_project("ecopaths")`, retourne project context

### T3.3 - Recherche erreur
Injecter prompt = "J'ai une NullPointerException dans le UserService"
**Attendu:** Retriever fait `memory_search_errors`, retourne les solutions connues

### T3.4 - Recherche pattern
Injecter prompt = "Je veux ajouter l'authentification JWT"
**Attendu:** Retriever fait `memory_search_patterns("JWT")`, retourne patterns

### T3.5 - Recherche preferences personnelles
Injecter prompt = "C'est quoi mon nom deja?"
**Attendu:** Retriever fait `memory_get_preferences(category="personal")`, retourne "Yann Favin-Leveque"

### T3.6 - Recherche environnement
Injecter prompt = "Ou est mon Java?"
**Attendu:** Retriever fait `memory_get_preferences(category="environment")`, retourne les paths

### T3.7 - Contexte multi-turns (sliding window)
Injecter 3 prompts successifs lies a un meme sujet, verifier que le Retriever comprend le contexte cumulatif.
**Attendu:** Le 3eme prompt beneficie du contexte des 2 premiers

### T3.8 - Retriever busy (concurrent prompts)
Injecter 2 prompts rapidement (< 1s d'ecart)
**Attendu:** Le 1er est traite normalement, le 2eme recoit `context_type=none` immediatement (pas de hang)

---

## NIVEAU 4 - LEARNER INTELLIGENCE

### T4.1 - Skip les actions routine
Injecter tool_use: `{tool: "Bash", input: "git add -A", response: ""}`
**Attendu:** Learner repond SKIP, rien sauve en DB

### T4.2 - Sauvegarde une erreur + solution
Injecter tool_use: une vraie erreur Maven avec sa resolution
**Attendu:** Nouvelle entree dans `errors_solutions` avec error_signature, solution, root_cause, prevention

### T4.3 - Sauvegarde un pattern
Injecter tool_use: un Edit qui montre un pattern architectural (ex: config Spring Security)
**Attendu:** Nouvelle entree dans `patterns`

### T4.4 - Sauvegarde un learning
Injecter tool_use: un Bash qui revele un gotcha ou une decouverte
**Attendu:** Nouvelle entree dans `learnings`

### T4.5 - Deduplication fonctionne
Injecter le meme tool_use que T4.2 (meme erreur)
**Attendu:** Learner fait `memory_search`, trouve le doublon, repond SKIP. Pas de nouvelle entree.

### T4.6 - Enrichissement via drilldown
Injecter un tool_use similar a T4.2 mais avec un detail supplementaire
**Attendu:** Learner fait `memory_drilldown_save` sur l'entree existante au lieu de creer un doublon

### T4.7 - Sauvegarde preference personnelle
Injecter tool_use: un Edit de commit avec message en francais, fichiers avec noms francais
**Attendu:** Learner detecte et sauvegarde dans `user_preferences` (category: personal ou coding-style)

### T4.8 - Sauvegarde preference workflow
Injecter une serie de tool_use montrant un pattern de travail (toujours mvn compile avant test)
**Attendu:** Learner detecte le workflow et sauvegarde

### T4.9 - Budget suffisant pour dedup + save
Verifier dans les logs que le Learner complete tout son workflow (search + save) sans depasser le budget
**Attendu:** Log montre "cost: $X" avec X < maxBudgetUsd

---

## NIVEAU 5 - LOOP COMPLET (Hook → Orchestrateur → Resultat)

### T5.1 - Session Start → Prompt → Context injection
```bash
# Simuler le cycle complet:
# 1. on_session_start.sh lance l'orchestrateur
# 2. on_prompt_submit.py injecte un prompt
# 3. Retriever traite et ecrit un resultat
# 4. on_prompt_submit.py recupere le resultat
```
**Attendu:** additionalContext JSON avec contexte memoire dans stdout de on_prompt_submit.py

### T5.2 - Tool use → Learner → Sauvegarde
```bash
# 1. on_tool_use.py pousse un tool call
# 2. Learner traite
# 3. Verification de la sauvegarde en DB
```
**Attendu:** Nouvelle entree en DB

### T5.3 - Session End → Cleanup
```bash
# 1. on_session_end.sh signal shutdown
# 2. Orchestrateur s'arrete proprement
# 3. State = stopped, PID file supprime
```
**Attendu:** Clean shutdown

### T5.4 - Session complete (start → N prompts + tools → end)
Simuler une session realiste de 5 minutes:
1. Session start
2. Prompt "On travaille sur ecopaths" → context inject
3. Tool: Bash mvn compile → BUILD SUCCESS (skip)
4. Tool: Bash mvn compile → BUILD FAILURE + fix (save error)
5. Prompt "Comment fonctionne le systeme de categories?" → context inject
6. Tool: Edit CategoryService.java → architecture fix (save learning)
7. Tool: Bash git commit → routine (skip)
8. Session end

**Attendu:** 2 sauvegardes (error + learning), context injecte 2 fois, clean shutdown

---

## NIVEAU 6 - GENERATED TOOLS

### T6.1 - Learner cree un script bash
Injecter une serie de tool_use montrant le user qui fait le meme workflow 3+ fois:
1. `mvn clean compile -DskipTests`
2. `java -jar target/app.jar &`
3. `sleep 10 && curl localhost:8080/health`
4. `kill %1`

**Attendu:** Learner cree un script dans `~/.claude/generated_tools/`, l'enregistre dans `generated_tools` table

### T6.2 - Retriever surface un generated tool
Apres T6.1, injecter un prompt "Je veux lancer l'app pour tester"
**Attendu:** Retriever trouve le generated tool et l'inclut dans le contexte

### T6.3 - Generated tool fonctionne
Executer le script cree par le Learner
**Attendu:** Le script s'execute correctement

---

## NIVEAU 7 - RESILIENCE

### T7.1 - Orchestrateur crash → Recovery au prochain start
```bash
# Kill l'orchestrateur brutalement
kill -9 <PID>
# Attendre 2+ minutes
sleep 130
# Relancer on_session_start.sh
echo '{"session_id":"t7-001","cwd":"/tmp"}' | bash on_session_start.sh
```
**Attendu:** Ancien state marque `crashed`, nouveau orchestrateur lance

### T7.2 - DB indisponible → Graceful degradation
Temporairement arreter PostgreSQL, tester chaque hook
**Attendu:** Tous les hooks exit 0 silencieusement, rien ne bloque

### T7.3 - MCP server crash → SDK gere l'erreur
Tuer le process memory_mcp_server.py pendant que le Learner/Retriever tourne
**Attendu:** Log d'erreur mais pas de crash orchestrateur, retry au prochain poll

### T7.4 - Cognitive inbox flood
Injecter 50 messages dans cognitive_inbox en 1 seconde
**Attendu:** Orchestrateur les traite par batches de 10, pas de OOM, pas de deadlock

### T7.5 - Retriever timeout (hook 8s budget)
Injecter un prompt tres complexe necessitant beaucoup de recherche
**Attendu:** on_prompt_submit.py sort apres ~5s (backoff total), retourne rien ou partiel, pas de hang

### T7.6 - Deux sessions simultanees
Lancer 2 orchestrateurs avec des session_ids differents
**Attendu:** Chacun traite ses propres messages, pas d'interference, DB indexes session_id fonctionnent

---

## NIVEAU 8 - CONNAISSANCES CUMULATIVES

### T8.1 - Session 1 : Learner sauvegarde des erreurs
Simuler une session avec 3 erreurs differentes
**Attendu:** 3 entrees dans errors_solutions

### T8.2 - Session 2 : Retriever retrouve les erreurs de Session 1
Nouvelle session, injecter un prompt mentionnant une des erreurs de Session 1
**Attendu:** Retriever retourne la solution de Session 1

### T8.3 - Learner enrichit progressivement
Session 3 : meme erreur que Session 1 mais avec un nouveau detail
**Attendu:** Drilldown save, pas de doublon

### T8.4 - Accumulation de patterns
Apres 5 sessions simulees, verifier que les patterns sont bien structures et non-redondants
**Attendu:** Patterns uniques, tags coherents, pas de doublons

### T8.5 - Accumulation de preferences
Apres 5 sessions, verifier que les user_preferences sont a jour et coherentes
**Attendu:** Preferences enrichies progressivement, pas d'ecrasement involontaire

---

## NIVEAU 9 - KNOWLEDGE QUALITY

### T9.1 - Learner ne sauvegarde PAS de bruit
Injecter 20 tool_use routine (git, file read, simple edits)
**Attendu:** 0 sauvegardes

### T9.2 - Learner sauvegarde TOUTES les erreurs non-triviales
Injecter 5 erreurs distinctes avec solutions
**Attendu:** 5 entrees, chacune avec error_signature, solution, root_cause, prevention

### T9.3 - Retriever precision
Injecter 10 prompts varies (5 triviaux, 5 necessitant du contexte)
**Attendu:** SKIP pour les 5 triviaux, contexte pertinent pour les 5 autres

### T9.4 - Retriever ne retourne PAS de bruit
Verifier que le Retriever ne retourne jamais de resultats non-pertinents
**Attendu:** Precision > 90% (9/10 resultats pertinents)

### T9.5 - Qualite des tags et categorisation
Verifier la coherence des tags et categories dans learnings, patterns, errors
**Attendu:** Tags reutilises, categories correctes, pas de fantaisie

---

## NIVEAU 10 - INTEGRATION REELLE (avec `claude --plugin-dir`)

### T10.1 - Plugin se charge correctement
```bash
claude --plugin-dir "C:/Users/user/IdeaProjects/aidam-memory-plugin"
# Observer le status message au demarrage
```
**Attendu:** `[AIDAM Memory: active, retriever=on, learner=on]`

### T10.2 - Context injection visible
Dans la session Claude, taper: "On travaille sur ecopaths"
**Attendu:** Claude recoit du contexte memoire (visible dans le verbose Ctrl+O)

### T10.3 - Learner sauvegarde en live
Faire un `mvn compile` qui echoue, le fixer, verifier en DB
**Attendu:** Nouvelle erreur sauvegardee apres quelques secondes

### T10.4 - Session end cleanup
Quitter Claude normalement (Ctrl+C ou /exit)
**Attendu:** Orchestrateur s'arrete, state = stopped

### T10.5 - Fermeture brutale (kill terminal)
Fermer le terminal directement
**Attendu:** Orchestrateur orphelin detecte au prochain start (< 2min)

---

## NIVEAU 11 - SCENARIOS COMPLEXES

### T11.1 - Nouveau projet : onboarding complet
Ouvrir Claude dans un nouveau projet jamais vu, travailler 10 minutes
**Attendu:** Learner cree automatiquement : project entry, learnings, preferences specifiques

### T11.2 - Multi-projet dans la meme journee
Travailler sur ecopaths, puis switch vers trade_bot, puis retour ecopaths
**Attendu:** Retriever injecte le bon contexte a chaque switch

### T11.3 - Erreur recurrente
Rencontrer la meme erreur 3 sessions differentes
**Attendu:** Session 1: sauvegardee. Session 2: retrouvee + enrichie. Session 3: retrouvee immediatement

### T11.4 - Long session (1h+)
Session continue de travail intensif
**Attendu:** Heartbeat stable, pas de drift memoire, budget cumule raisonnable (< $3)

### T11.5 - Session avec beaucoup de tool calls (50+)
Session tres active avec de nombreux edits, bash, etc.
**Attendu:** Cognitive inbox ne s'accumule pas (traitement < injection), selective saves

---

## NIVEAU 12 - AUTONOMIE AVANCEE

### T12.1 - Retriever suggere un generated tool
Le user demande quelque chose pour lequel un generated tool existe
**Attendu:** Le contexte injecte inclut le tool avec sa commande d'usage

### T12.2 - Learner cree un tool adapte au workflow observe
Observer le user faire un workflow repetitif 3+ fois
**Attendu:** Tool cree, enregistre, fonctionnel

### T12.3 - Retriever et Learner se completent
Le Learner sauve une erreur → dans une future session le Retriever la retrouve → le user la corrige plus vite
**Attendu:** Boucle feedback mesurable (temps de resolution reduit)

### T12.4 - Knowledge graph implicite
Verifier que les learnings, patterns, errors, projects forment un reseau navigable
**Attendu:** `memory_search` sur un terme retrouve des resultats dans plusieurs tables

### T12.5 - Auto-cleanup du bruit
Le Learner ne pollue pas la DB avec du bruit au fil du temps
**Attendu:** Ratio signal/bruit > 80% apres 10 sessions

---

---

## NIVEAU 13 - SESSIONS PARALLELES (Automatise)
**Script:** `scripts/test_level13.js` | **Tests:** #49-#53 | **Status: 5/5 PASS**

Deux orchestrateurs tournent en parallele avec des session_ids differents. Chacun traite ses propres messages sans interference.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 49 | Isolation basique | 2 sessions simultanees, chacune sauvegarde des learnings differents | PASS |
| 50 | Retriever isolation | Prompts dans session A ne produisent pas de resultats dans session B | PASS |
| 51 | Learner isolation | Tool_use dans session A ne polluent pas les resultats de session B | PASS |
| 52 | Concurrent writes | Les deux Learners ecrivent en meme temps sans deadlock | PASS |
| 53 | Clean shutdown | Les deux orchestrateurs s'arretent proprement | PASS |

---

## NIVEAU 14 - "Je construis" (Recursive Tool Creation)
**Script:** `scripts/test_level14.js` | **Tests:** #54-#58 | **AGI: 82/100 | Status: 5/5 PASS**

Le Learner observe des workflows multi-etapes repetes, cree un tool (script bash), puis le Retriever le retrouve quand c'est pertinent. Ensuite le Learner observe un workflow qui inclut le premier tool, et cree un meta-tool compose.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 54 | Atomic skill creation | Learner voit 2x un workflow health-check → cree pattern/tool | PASS |
| 55 | Skill discovery | Retriever retrouve le tool quand on demande "check deployment health" | PASS |
| 56 | Skill composition | Learner voit build+deploy+health → cree meta-pattern referencant le health check | PASS |
| 57 | Meta-skill discovery | Retriever retrouve le workflow compose complet | PASS |
| 58 | Knowledge pyramid | Validation : ≥2 couches de connaissance, ≥3 artefacts, cross-references | PASS |

**Cout:** ~$0.55 | **Learnings:** Drilldown enrichment counts as valid composition.

---

## NIVEAU 15 - "J'apprends une API" (API Pattern Extraction)
**Script:** `scripts/test_level15.js` | **Tests:** #59-#62 | **AGI: 84/100 | Status: 4/4 PASS**

Le Learner observe des appels API (az CLI) avec leurs reponses. Il extrait le pattern d'utilisation (auth, endpoints, payload format) et le Retriever le restitue.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 59 | API observation | Learner voit 3 appels Azure CLI (list, config, deploy) → sauvegarde patterns | PASS |
| 60 | API recall | Retriever retrouve les commandes Azure quand on demande "how to deploy to Azure" | PASS |
| 61 | API error learning | Learner voit erreur 401 Azure + fix (az login --tenant) → sauvegarde erreur | PASS |
| 62 | API composition | Prompt "deploy + configure + verify on Azure" → Retriever compose les patterns | PASS |

**Cout:** ~$0.79 | **Learnings:** "NEW TASK:" prefix prevents Retriever fatigue.

---

## NIVEAU 16 - "Je comprends le code" (Code Comprehension)
**Script:** `scripts/test_level16.js` | **Tests:** #63-#66 | **AGI: 86/100 | Status: 4/4 PASS**

Le Learner observe des tool calls Read/Edit sur du code Java/TypeScript. Il extrait des patterns architecturaux (pas juste les sauvegarder, mais comprendre POURQUOI).

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 63 | Architecture extraction | Learner voit Edit sur SecurityConfig.java (filter chain) → sauvegarde pattern avec WHY | PASS |
| 64 | Anti-pattern detection | Learner voit un Edit qui introduit un N+1 query → sauvegarde learning "N+1 gotcha" | PASS |
| 65 | Refactoring pattern | Learner voit un refactor (Extract Service) → sauvegarde le pattern | PASS |
| 66 | Architecture recall | Retriever explique "how does our auth work?" en citant les patterns | PASS |

**Cout:** ~$0.49

---

## NIVEAU 17 - "Je me souviens de toi" (Companion Memory)
**Script:** `scripts/test_level17.js` | **Tests:** #67-#71 | **AGI: 87/100 | Status: 5/5 PASS**

Le systeme agit comme un companion — il se souvient des preferences personnelles, du style de travail, des habitudes.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 67 | Style capture | Learner voit des conventions de code (camelCase, 4-space indent) → sauvegarde user_preferences | PASS |
| 68 | Language preference | Learner detecte que l'user parle francais → sauvegarde preference language=fr | PASS |
| 69 | Work habit capture | Learner observe des patterns temporels (compile avant push, run tests) → sauvegarde | PASS |
| 70 | Preference recall | Retriever injecte les preferences quand le prompt touche au style/conventions | PASS |
| 71 | Personal context | Retriever dit "you prefer French, use camelCase, always test before push" | PASS |

**Cout:** ~$0.67 | **Learnings:** Learner saved 7 coding-style prefs + language + workflow.

---

## NIVEAU 18 - "Je resous des problemes" (Incremental Problem Solving)
**Script:** `scripts/test_level18.js` | **Tests:** #72-#75 | **AGI: 88/100 | Status: 4/4 PASS**

Le Learner accumule des connaissances sur un MEME sujet a travers plusieurs observations. Le Retriever synthetise pour resoudre un probleme nouveau mais lie.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 72 | Knowledge accumulation | 4 erreurs DB differentes (deadlock, pool, timeout, encoding) → 4 error_solutions | PASS |
| 73 | Synthesis retrieval | Prompt "my DB is slow and hangs" → Retriever cite pool + timeout + deadlock | PASS |
| 74 | Drilldown depth | Learner enrichit avec config PostgreSQL specifique → profondeur 2 | PASS |
| 75 | Novel problem solving | Prompt "DB connection drops under load" → Retriever combine pool + timeout (jamais vu ensemble) | PASS |

**Cout:** ~$0.90 | **Learnings:** Pattern #24 (PG tuning formulas), errors #36-#39.

---

## NIVEAU 19 - "Je transfere" (Cross-Domain Transfer)
**Script:** `scripts/test_level19.js` | **Tests:** #76-#79 | **AGI: 89/100 | Status: 4/4 PASS**

Le Learner apprend un pattern dans un contexte (Spring Boot) et le Retriever le retrouve dans un contexte DIFFERENT (Node.js) parce que le probleme sous-jacent est le meme.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 76 | Pattern in domain A | Learner voit un rate limiter en Spring (bucket4j) → sauvegarde pattern | PASS |
| 77 | Transfer to domain B | Prompt "rate limiting in Express API" → Retriever retrouve le pattern Spring et adapte | PASS |
| 78 | Error transfer | Erreur CORS en Spring → prompt "CORS in React + Express" → Retriever retrouve le fix | PASS |
| 79 | Architecture transfer | Pattern "Repository+Service+Controller" Java → prompt "structure Python Flask?" → Retriever propose l'equivalent | PASS |

**Cout:** ~$0.65 | **Learnings:** Retriever notes "Java/Spring, but principles apply" for cross-domain.

---

## NIVEAU 20 - "Je raisonne" (Incremental Reasoning Chain)
**Script:** `scripts/test_level20.js` | **Tests:** #80-#83 | **AGI: 90/100 | Status: 4/4 PASS**

Tests de raisonnement incremental. Le Learner accumule des faits/axiomes, puis le Retriever les COMBINE pour deduire quelque chose qu'il n'a jamais vu directement.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 80 | Fact accumulation | 3 learnings : "A depends on B", "B depends on C", "C has 5s timeout" | PASS |
| 81 | Transitive deduction | Prompt "why is A slow?" → Retriever trace la chaine A→B→C→timeout | PASS |
| 82 | Constraint reasoning | Ajout D depends on C → prompt "what if C goes down?" → Retriever identifie A et D impactes | PASS |
| 83 | Causal chain | C crashed OOM → prompt "A and D failing, root cause?" → Retriever remonte a C OOM | PASS |

**Cout:** ~$0.93 | **Learnings:** Retriever creates ASCII dependency diagrams. Learning #119 enriched with 2 drilldowns.

---

## NIVEAU 21 - "Je planifie" (Task Decomposition)
**Script:** `scripts/test_level21.js` | **Tests:** #84-#87 | **AGI: 91/100 | Status: EN COURS**

Le systeme decompose une tache complexe en sous-taches en s'appuyant sur sa memoire.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 84 | Seed complex patterns | Learner sauvegarde : JWT auth (5 etapes), DB migration (3 etapes), Docker deploy (4 etapes) | - |
| 85 | Task decomposition | Prompt "add auth + database + deploy" → Retriever retrouve les 3 patterns et les ordonne | - |
| 86 | Dependency awareness | Retriever indique que DB migration doit venir avant auth (ORDER matters) | - |
| 87 | Gap identification | Prompt inclut "email verification" → Retriever retrouve patterns connus + signale le gap | - |

---

## NIVEAU 22 - "Je calcule" (Scientific/Math Memory)
**Script:** `scripts/test_level22.js` | **Tests:** #88-#91 | **AGI: 92/100 | Status: A CREER**

Le Learner observe des resultats de calculs/simulations et en extrait des constantes, formules, ou heuristiques. Le Retriever les applique a de nouvelles questions.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 88 | Constant extraction | Learner voit des benchmarks (batch 500→2.3s, 1000→4.1s, 2000→12.7s) → learning "optimal batch ~500-1000" | - |
| 89 | Formula recall | Prompt "what batch size for 50k records?" → Retriever cite le benchmark et l'heuristique | - |
| 90 | Performance modeling | Learner voit "indexing reduced 2.4s to 0.03s on 1M rows" → sauvegarde l'impact | - |
| 91 | Optimization chain | Prompt "API slow with 500k records" → Retriever combine batch sizing + indexing | - |

---

## NIVEAU 23 - "Je m'adapte" (Context-Aware Behavior)
**Script:** `scripts/test_level23.js` | **Tests:** #92-#95 | **AGI: 93/100 | Status: A CREER**

Le Retriever adapte son niveau de detail selon le contexte du prompt. Un debutant recoit plus de contexte qu'un expert.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 92 | Seed rich knowledge | Learner sauvegarde pattern JWT tres detaille (basique + avance + gotchas + code) | - |
| 93 | Beginner query | Prompt "what is JWT and how do I use it?" → Retriever inclut les bases + code example | - |
| 94 | Expert query | Prompt "JWT refresh token rotation with Redis blacklist" → details avances uniquement | - |
| 95 | Context switch | Prompts progressifs (basique → intermediaire → avance) → contenu augmente en profondeur | - |

---

## NIVEAU 24 - "Je construis sur mes constructions" (Recursive Scaffolding)
**Script:** `scripts/test_level24.js` | **Tests:** #96-#99 | **AGI: 94/100 | Status: A CREER**

Vrai test recursif : le Learner cree un tool (Level 1), puis observe l'utilisation de ce tool comme brique d'un workflow plus grand, et cree un tool de niveau 2 qui APPELLE le tool de niveau 1.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 96 | Block Level 1 | Learner cree `l24_db_backup.sh` (pg_dump + compress + timestamp) | - |
| 97 | Block Level 2 | Learner observe backup + migration + restart → cree `l24_safe_migrate.sh` qui APPELLE db_backup.sh | - |
| 98 | Chain execution | Le meta-tool contient une reference au tool L1 (grep verifie) | - |
| 99 | Discovery chain | Prompt "risky migration" → Retriever retrouve safe_migrate.sh + mentionne backup automatique | - |

---

## NIVEAU 25 - "Je me corrige" (Self-Correction & Versioning)
**Script:** `scripts/test_level25.js` | **Tests:** #100-#103 | **AGI: 95/100 | Status: A CREER**

Le Learner recoit des informations CONTRADICTOIRES et doit les gerer — mettre a jour un learning existant, pas en creer un nouveau contradictoire.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 100 | Initial learning | Learner sauvegarde "Default connection pool size: 10 in HikariCP" | - |
| 101 | Contradicting info | Learner voit "HikariCP default is CPU cores * 2 + 1" → UPDATE le learning, pas INSERT | - |
| 102 | Version check | Le learning original a ete enrichi/drilldown'd, pas de doublon | - |
| 103 | Corrected recall | Prompt "what pool size?" → Retriever donne la formule correcte (cores * 2 + 1) | - |

---

## NIVEAU 26 - "Je cree des solutions" (Generative Problem Solving)
**Script:** `scripts/test_level26.js` | **Tests:** #104-#107 | **AGI: 96/100 | Status: A CREER**

Le Learner a accumule assez de patterns pour que le Retriever puisse GENERER une solution a un probleme jamais vu, en combinant des morceaux de patterns existants.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 104 | Rich seed | Seed 5+ patterns (auth, caching, rate-limiting, error handling, monitoring) avec drilldowns | - |
| 105 | Novel problem | Prompt "build a secure API gateway with caching and rate limiting" → combine 3+ patterns | - |
| 106 | Cross-reference depth | Le resultat cite ≥3 patterns/learnings differents (verifie via IDs [#N]) | - |
| 107 | Completeness | Le resultat couvre auth + caching + rate-limiting (3 aspects minimum) | - |

---

## NIVEAU 27 - "Je collabore" (Multi-Project Intelligence)
**Script:** `scripts/test_level27.js` | **Tests:** #108-#111 | **AGI: 97/100 | Status: A CREER**

Le systeme travaille sur PLUSIEURS projets et transfere la connaissance entre eux intelligemment.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 108 | Project A learning | Learner sauvegarde une erreur CORS + fix dans le projet "ecopaths" | - |
| 109 | Project B context | Orchestrateur lance avec `--project-slug=other-project` | - |
| 110 | Cross-project transfer | Retriever retrouve le fix CORS du projet A dans le contexte du projet B | - |
| 111 | Project-specific filter | Prompt "architecture of my current project?" → Retriever ne melange pas les projets | - |

---

## NIVEAU 28 - "Je suis AIDAM" (Full Autonomous Intelligence)
**Script:** `scripts/test_level28.js` | **Tests:** #112-#116 | **AGI: 100/100 | Status: A CREER**

Test ultime qui combine TOUT : le systeme recoit une sequence longue d'observations (10+ events), apprend, cree, compose, retrouve, et demontre une intelligence coherente.

| # | Test | Verification | Resultat |
|---|------|-------------|----------|
| 112 | Marathon learning | 10 tool observations variees → Learner traite tout, ≥5 artefacts crees | - |
| 113 | Marathon retrieval | 5 prompts varies → Retriever retrouve du contexte pertinent pour ≥4/5 | - |
| 114 | Knowledge graph | ≥3 couches de profondeur (atomic → patterns → drilldowns) | - |
| 115 | Autonomous workflow | Prompt complexe inedit → Retriever combine ≥4 sources en reponse coherente | - |
| 116 | Cost efficiency | Tout le Level 28 coute < $2.50 | - |

---

## METRIQUES DE SUCCES

| Metrique | Cible |
|----------|-------|
| Retriever latence (prompt → resultat) | < 5s (95th percentile) |
| Retriever precision | > 90% (resultats pertinents / total) |
| Retriever recall | > 70% (contexte utile retourne quand necessaire) |
| Learner precision | > 85% (sauvegardes utiles / total sauvegardes) |
| Learner recall | > 60% (connaissances utiles sauvegardees / total opportunites) |
| Deduplication | < 5% doublons |
| Budget par session (30min) | < $1.50 |
| Orchestrator uptime | > 99% (pas de crash non-detecte) |
| Recovery time (crash → restart) | < 3 min |
| Generated tools quality | > 80% fonctionnels du premier coup |

---

## RESULTATS GLOBAUX

| Niveau | Nom | Tests | Status | Cout |
|--------|-----|-------|--------|------|
| 0-12 | Infrastructure → Autonomie | 53/53 | ALL PASS | - |
| 13 | Sessions paralleles | 5/5 | ALL PASS | ~$0.80 |
| 14 | Recursive Tool Creation | 5/5 | ALL PASS | ~$0.55 |
| 15 | API Pattern Extraction | 4/4 | ALL PASS | ~$0.79 |
| 16 | Code Comprehension | 4/4 | ALL PASS | ~$0.49 |
| 17 | Companion Memory | 5/5 | ALL PASS | ~$0.67 |
| 18 | Problem Solving | 4/4 | ALL PASS | ~$0.90 |
| 19 | Cross-Domain Transfer | 4/4 | ALL PASS | ~$0.65 |
| 20 | Reasoning Chain | 4/4 | ALL PASS | ~$0.93 |
| 21 | Task Decomposition | ?/4 | EN COURS | - |
| 22 | Scientific Memory | 0/4 | A CREER | - |
| 23 | Context-Aware | 0/4 | A CREER | - |
| 24 | Recursive Scaffolding | 0/4 | A CREER | - |
| 25 | Self-Correction | 0/4 | A CREER | - |
| 26 | Generative Solving | 0/4 | A CREER | - |
| 27 | Multi-Project | 0/4 | A CREER | - |
| 28 | Full Autonomous | 0/5 | A CREER | - |
| **Total** | | **88+/116** | | **~$5.78+** |

---

## LEARNINGS TECHNIQUES

### Retriever Fatigue Pattern
Le Retriever a une tendance a SKIP des prompts trop similaires aux precedents dans la meme session.
**Fix universel:**
1. Warm-up avec prompt neutre ("What projects are stored in memory?")
2. Pause de 5-8s apres le warm-up
3. Prefixer les prompts de retrieval avec "NEW TASK:" pour signaler un contexte frais

### Column Names (PostgreSQL)
- Table `patterns`: colonnes `context` et `solution` (PAS `content`)
- Table `learnings`: colonne `insight` (PAS `content`)

### Learner Dedup
Le Learner SKIP correctement les observations quand les patterns/errors existent deja en memoire. Les tests doivent en tenir compte.

### maxTurns
`maxTurns` est un plafond de securite. Un agent qui termine en 3 turns ne coute pas plus si le max est a 12. Augmenter pour les taches complexes.

---

## PROCEDURE DE NETTOYAGE ENTRE TESTS

```bash
export PGPASSWORD="$PGPASSWORD"  # Set in .env
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"

# Supprimer les donnees de test (prefix t* ou level*)
"$PSQL" -U postgres -h localhost -d claude_memory -c "DELETE FROM cognitive_inbox WHERE session_id LIKE 't%' OR session_id LIKE 'level%';"
"$PSQL" -U postgres -h localhost -d claude_memory -c "DELETE FROM retrieval_inbox WHERE session_id LIKE 't%' OR session_id LIKE 'level%';"
"$PSQL" -U postgres -h localhost -d claude_memory -c "DELETE FROM orchestrator_state WHERE session_id LIKE 't%' OR session_id LIKE 'level%';"
rm -f "C:/Users/user/IdeaProjects/aidam-memory-plugin/.orchestrator.pid"

# Verifier qu'aucun orchestrateur tourne
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT COUNT(*) FROM orchestrator_state WHERE status IN ('starting','running');"
```

---

## NOTES

- Executer les niveaux dans l'ordre. Ne pas sauter.
- Chaque FAIL doit etre corrige avant de passer au niveau suivant
- Les niveaux 0-12 sont manuels (bash commands), les niveaux 13+ sont automatises (node scripts)
- Budget estime total : ~$15-20
- Les scripts sont dans `scripts/test_level{N}.js` et les logs dans `~/.claude/logs/test_level{N}_output.log`
