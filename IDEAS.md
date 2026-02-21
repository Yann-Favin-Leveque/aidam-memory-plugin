# AIDAM Memory Plugin — Ideas & Future Improvements



## PostgreSQL Search Improvements

### Stemming francais
- Ajouter config `'french'` en plus du `'english'` actuel
- `to_tsvector('french', text)` pour les contenus en francais
- Ou multilingue : creer un tsv dual-language

## ~~Implementes~~

> Les items suivants ont ete implementes et sont retires de la roadmap :
> - ~~ts_rank avec poids differencies~~ → Phase 1, setweight A/B/C/D
> - ~~pg_trgm pour fuzzy matching~~ → Phase 1, migration_v3_trigram.sql
> - ~~Pondérations des données en mémoire (confidence)~~ → Deja present dans le schema
> - ~~Budget configurable~~ → Phase 2, --retriever-budget, --session-budget, etc.
> - ~~Batch processing~~ → Phase 2, Learner batch (window 10s, min 3, max 10)
> - ~~Clean up DB memory (Curator agent)~~ → Phase 3, 4e agent Haiku
> - ~~Knowledge compaction (Compactor)~~ → Deja present dans l'orchestrator

## Parametrisation

### maxTurns configurable
- Actuellement hardcode dans orchestrator.ts
- Pourrait etre passe en CLI arg (`--retriever-max-turns=12`)
- Ou dans config/defaults.json

### Modeles configurables
- Pouvoir choisir le modele du Retriever et du Learner via CLI
- `--retriever-model=haiku` / `--learner-model=haiku`
- Actuellement les modeles sont dans config/defaults.json mais pas exposes en CLI

## Architecture

### Retriever caching
- Cache les resultats de retrieval pour des prompts similaires (embeddings?)
- Eviterait les appels redondants dans une meme session

### ~~Retriever multi-strategy~~ → Implémenté (Dual Retriever A/B)
> Remplacé par 2 agents Haiku parallèles : A (keyword FTS) + B (cascade via knowledge_index).
> Chacun utilise des tool calls parallèles et maxTurns=15.

### Session-Aware Retriever (v3)
- La session principale devrait savoir qu'elle a des retrievers en background
- Pourrait planifier en sachant qu'un retrieval arrive (commencer à poser des bases)
- Tool MCP pour déclencher un retrieval à la demande depuis la session principale
- Exemple : "J'ai besoin du pattern d'auth JWT" → trigger direct au retriever
- Utile quand la session a une grosse réflexion en cours

## Intelligence & Analytics

### Retrieval confidence score
- Le Retriever retourne un score de confiance (0-1) avec chaque resultat
- Permet au systeme de savoir quand il est sur vs quand il devine
- Utile pour le self-improvement (L36) et l'optimisation des couts (L34)
- Implementation : le Retriever ajoute `[confidence: 0.8]` a chaque bloc de resultat

### Memory usage analytics
- Nouvelle table `memory_analytics` pour tracker l'utilisation des connaissances
- Quels learnings/patterns sont retrouves, a quelle frequence, et si l'user les a trouves utiles
- Colonnes : `artifact_type`, `artifact_id`, `retrieved_at`, `was_useful` (nullable)
- Permet le garbage collection intelligent et l'optimisation des couts
- Les connaissances jamais retrouvees en 30 jours → candidates au cleanup

## Data Management

### Export/Import memoire
- Exporter toute la memoire (ou un sous-ensemble par projet) en JSON
- Importer dans une autre instance PostgreSQL
- Use cases :
  - Backup avant une operation risquee
  - Partager la memoire d'un projet avec un collegue
  - Migrer vers une autre machine
- Format : `{ learnings: [...], patterns: [...], errors: [...], tools: [...] }`

### Knowledge versioning
- Historiser les modifications des learnings/patterns (pas juste UPDATE)
- Table `knowledge_history` : `artifact_type`, `artifact_id`, `old_value`, `new_value`, `changed_at`
- Permet de voir l'evolution d'une connaissance au fil du temps
- Utile pour le self-correction (L25) — verifier que le systeme UPDATE plutot que INSERT

## Features

### PC use like a human
- Permettre a Claude d'utiliser un navigateur comme un user?
- (screenshot, click?)
- Pour certaines taches le nécessitants
- **Partiellement teste dans L30** : le systeme apprend lui-meme a prendre des screenshots

### Permittre d'utiliser claude code
- Permettre d'utiliser claude code pour certaines taches
- (appeler une session, avec plugin ou sans, et interagir avec)
- SSI utile par rapport aux subagent natifs
- **Partiellement teste dans L31** : le systeme apprend lui-meme a le faire
