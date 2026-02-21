# AIDAM Memory Plugin — Ideas & Future Improvements

## PostgreSQL Search Improvements (suggested session)

### 1. ts_rank avec poids differencies
- Donner plus de poids aux titres (topic/name) qu'au contenu (insight/context)
- Gratuit, deja supporte par PostgreSQL
- `ts_rank('{0.1, 0.2, 0.4, 1.0}', tsv, query)` — poids D < C < B < A

### 2. pg_trgm pour fuzzy matching
- Extension native PostgreSQL (`CREATE EXTENSION pg_trgm`)
- Permet de matcher malgre les fautes de frappe
- Utile pour le francais mal stemme
- `similarity()`, `%` operator, index GIN/GiST

### 3. Stemming francais
- Ajouter config `'french'` en plus du `'english'` actuel
- `to_tsvector('french', text)` pour les contenus en francais
- Ou multilingue : creer un tsv dual-language

### 4. Pondérations des données en mémoire
- avec un niveau de confiance / certitude

## Parametrisation

### maxTurns configurable
- Actuellement hardcode dans orchestrator.js
- Pourrait etre passe en CLI arg (`--retriever-max-turns=12`)
- Ou dans un fichier de config JSON

### Budget configurable
- `--max-budget-usd=0.50` pour le Retriever/Learner per-call
- `--session-budget=5.00` pour le budget total de la session

### Modeles configurables
- Pouvoir choisir le modele du Retriever et du Learner via CLI
- `--retriever-model=haiku` / `--learner-model=haiku`

## Architecture

### Batch processing
- Quand plusieurs tool_use arrivent en rafale, les grouper en un seul appel Learner
- Reduirait les couts et le temps de traitement

### Retriever caching
- Cache les resultats de retrieval pour des prompts similaires (embeddings?)
- Eviterait les appels redondants dans une meme session

### Knowledge compaction
- Le Compactor agent (desactive pour les tests) pourrait consolider les learnings similaires
- Fusionner les drilldowns redondants
- Archiver les erreurs obsoletes

### Clean up DB memory
- Agent qui passe tous les X temps dans la mémoire pour clean up
- système de "data used tracker" pour aider

## Features

### PC use like a human
- Permettre a Claude d'utiliser un navigateur comme un user? 
- (screenshot, click?)
- Pour certaines taches le nécessitants

### Permettre d'utiliser claude code
- permettre d'utiliser claude code pour certaines taches
- (appeler une session, avec plugin ou sans, et interagir avec)
- SSI utile par rapport aux subagent natifs
- **Teste dans L31** : le systeme apprend lui-meme a le faire

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

### Retriever multi-strategy
- Au lieu de toujours faire `plainto_tsquery`, le Retriever choisit sa strategie :
  - **Exact match** pour les error signatures connues
  - **Fuzzy** (pg_trgm) pour les descriptions vagues ou avec fautes
  - **Project-scoped** quand un projet est mentionne dans le prompt
  - **Recency-biased** quand le prompt parle de "recent" ou "last time"
- Prerequis : pg_trgm (section PostgreSQL #2)

### Learner observation batching
- Quand 5+ tool_use arrivent en <10s, les grouper en un seul appel Learner
- Le Learner recoit le batch et extrait les patterns ENTRE les observations
- Exemple : 3 Edits consecutifs sur le meme fichier → le Learner comprend le refactoring global
- Reduirait les couts (~5x moins d'appels) et ameliorerait la qualite (contexte plus riche)

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
