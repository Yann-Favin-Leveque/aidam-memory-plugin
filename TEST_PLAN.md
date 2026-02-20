# AIDAM Memory Plugin - Plan de Tests Incremental

Version: 1.0
Date: 2026-02-20

Ce plan couvre des tests de complexite croissante, du smoke test basique jusqu'a l'autonomie complete. Chaque niveau doit etre valide avant de passer au suivant.

---

## NIVEAU 0 - INFRASTRUCTURE (Prerequis)

### T0.1 - DB tables existent
```bash
export PGPASSWORD=***REDACTED***
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

## PROCEDURE DE NETTOYAGE ENTRE TESTS

```bash
export PGPASSWORD=***REDACTED***
PSQL="C:/Program Files/PostgreSQL/17/bin/psql.exe"

# Supprimer les donnees de test (prefix t*)
"$PSQL" -U postgres -h localhost -d claude_memory -c "DELETE FROM cognitive_inbox WHERE session_id LIKE 't%';"
"$PSQL" -U postgres -h localhost -d claude_memory -c "DELETE FROM retrieval_inbox WHERE session_id LIKE 't%';"
"$PSQL" -U postgres -h localhost -d claude_memory -c "DELETE FROM orchestrator_state WHERE session_id LIKE 't%';"
rm -f "C:/Users/user/IdeaProjects/aidam-memory-plugin/.orchestrator.pid"

# Verifier qu'aucun orchestrateur tourne
"$PSQL" -U postgres -h localhost -d claude_memory -t -A -c \
  "SELECT COUNT(*) FROM orchestrator_state WHERE status IN ('starting','running');"
```

---

## NOTES

- Executer les niveaux dans l'ordre. Ne pas sauter.
- Logger les resultats dans ce fichier (OK / FAIL + details)
- Chaque FAIL doit etre corrige avant de passer au niveau suivant
- Les niveaux 10+ necessitent une session Claude reelle (pas juste du bash)
- Budget estime pour tous les tests : ~$5-10
