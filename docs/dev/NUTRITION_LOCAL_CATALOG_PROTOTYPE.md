# Prototype de catalogue Nutrition local

## Correctif ciblé du préchargement de l'index de recherche

Le laboratoire Docker a révélé un timeout SQL systématique de « lait » à 2002 ms,
avec 22518 correspondances FTS wger et 19036 OFF, soit 22852 identités après
déduplication. Le délai de requête reste **2 secondes**, le réchauffement optionnel
au démarrage conserve son budget préexistant de **3 secondes**.

Diagnostic sur les vraies générations, SQLite local 3.46.1 : le plan de recherche
utilise déjà `products_fts` puis `search_rank_idx (id=?)`, les clés primaires de
`bindings` et `exclusions`, les FTS OFF/alias, puis les regroupement/tri temporaires.
Pas d'index manquant. `CROSS JOIN` ne change pas le plan ; supprimer l'index
couvrant fait lire les grandes lignes de `products` et dépasse aussi les 2 s.

La vraie anomalie est le SELECT censé réchauffer l'index après les gros hashes :

```sql
SELECT count(*) FROM products INDEXED BY search_rank_idx;
-- EXPLAIN QUERY PLAN : SCAN products USING COVERING INDEX language_idx
-- VM SQLite : OpenRead(language_idx), Count
```

Le chemin rapide de COUNT(*) choisit le petit index de langue dans cette version,
malgré INDEXED BY. Il ne lit donc pas l'index couvrant requis par les recherches
larges ; les vérifications SHA-256 des gros fichiers peuvent avoir évincé ses pages.
Le coût est sensible au cache et à la limite mémoire du conteneur, pas à CORS.
La correction compte la clé primaire entière non nulle :

```sql
SELECT count(id) FROM products INDEXED BY search_rank_idx;
-- EXPLAIN QUERY PLAN : SCAN products USING COVERING INDEX search_rank_idx
-- VM : OpenRead(search_rank_idx), Rewind, IdxRowid, AggStep, Next
```

Même résultat de contrôle : **3058354**. Le moteur ne modifie ni SQL de recherche,
poids BM25, priorités exact/préfixe/ajoutabilité/langue, déduplication, pagination,
snapshots, nutriments ou index stockés. Aucun ANALYZE, rebuild, cache flush ou
changement système. L'API et les contrats ne changent pas.

Mesure comparative locale, six requêtes identiques après deux initialisations
complètes séparées, caches OS déjà réchauffés par le diagnostic :

| Requête | Ancien préchargement, ms | Corrigé, ms | Identités |
| --- | ---: | ---: | ---: |
| Nutella | 77,56 | 56,94 | 657 |
| Coca-Cola | 276,51 | 111,66 | 2925 |
| lait | 430,04 | 423,68 | 22852 |
| riz | 844,60 | 611,50 | 11070 |
| pâtes | 288,36 | 275,22 | 4226 |
| yaourt | 274,13 | 312,00 | 8134 |

Ce n'est pas un benchmark froid ni une preuve de gain correspondant au timeout
Docker : l'ancienne requête réussissait déjà dans ces conditions locales chaudes.
Les empreintes des résultats complets des six recherches et des codes-barres
sont identiques. Initialisations (hors délai de recherche) : **26,59 s / 25,89 s**.
Pic RSS de la comparaison : **56,40 Mio**, limite d'adresse du lecteur maintenue
à 512 Mio. Une relance corrigée indépendante donne lait **424,85 ms**, riz
**486,45 ms**, Nutella **66,04 ms**, Coca-Cola **121,62 ms**, pâtes **214,56 ms**,
yaourt **304,10 ms**, initialisation **26,10 s**, pic **55,44 Mio**. La page 2 de
« lait » retourne 20 résultats avec le même total. Les marges de temps peuvent
varier sous contention ou éviction de cache ; le délai de protection n'est pas relevé.

Reproduction sans Internet ni écriture catalogue :

```bash
python3 scripts/nutrition-local-catalog/profile-reference-search.py --compare-legacy
python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_wger*.py'
python3 -m unittest discover -s scripts/private-beta/docker -p test_fix_catalog_warmup.py
```

Le mode comparatif remplace seulement le SELECT du préchargement dans une copie
en mémoire du code local de confiance, jamais dans les fichiers. Le rapport JSON
inclut version SQLite, plans réels, index existants, six temps, empreintes, page 2
et références g/ml des codes Nutella/Coca-Cola. Aucune requête fournisseur.

Validation : **43 tests Python wger réussis**, dont 7 du lecteur combiné ; **4 tests
du correctif d'installation réussis** ; **17 tests Node/API ciblés réussis**, aucun
échec/ignoré final. Une nouvelle fixture a d'abord été refusée par la règle
d'alias générique (marque non vide) : correction de la fixture, pas du validateur.
Le test de deadline fait avancer une horloge contrôlée, vérifie l'interruption
SQLite, puis la récupération du lecteur ; aucune attente de timeout artificielle.
Journaux : `scripts/nutrition-local-catalog/artifacts/catalog-sql-20261103/`.

L'application du correctif au contexte Docker réel et sa reconstruction sont
documentées dans [PERSONAL_BETA_DOCKER.md](PERSONAL_BETA_DOCKER.md), section
« Correctif du préchargement ». Le test réel dans l'image installée reste requis :
les mesures ci-dessus sont locales, pas des performances Docker attestées.

**État actuel (26 octobre 2026) :** le catalogue wger complet est construit et
validé dans le laboratoire : 3 058 354 produits, 124 943 Foods techniquement
ajoutables dans la base. Le lecteur V1 conserve 121 000 candidats après mise en
revue de 3 943 fiches à quatre zéros ; 22 libellés français sont isolés dans un
complément de 434 176 octets. Les registres serveur sont confirmés. La V1 utilise recherche littérale/préfixes/accents, sans fuzzy
ni API alimentaire externe à l’usage. Le raccordement applicatif reste expérimental
et désactivé par défaut. Le complément OFF issu de la deuxième passe complète
a été vérifié : 835 231 références explicites (803 100 en g, 32 131 en ml).
Son raccordement applicatif expérimental est maintenant implémenté ; voir
`NUTRITION_FOOD_CATALOG.md`, section « Intégration validée en développement ».
Aucun téléchargement massif supplémentaire n'est autorisé. Les anciennes sections constituent la trace
chronologique ; les dernières sections décrivent les résultats actuels.

## Périmètre et invariants

Prototype isolé dans `scripts/nutrition-local-catalog`, sans serveur supplémentaire
ni accès au stockage des utilisateurs réels. Une intégration API/UI expérimentale
désactivée par défaut existe ; le mode `wger-v1` décrit en fin de document la
raccorde aux générations confirmées sans l’activer sur une instance. Aucun téléchargement ou tâche planifiée automatique.
La branche reste `feature/nutrition`. Les travaux non committés de l'étape 4 sont
conservés. Aucun export complet n'est autorisé dans ce travail.

Le catalogue externe est reconstructible et séparé de `customFoods`, `savedFoods`,
recettes, snapshots, historiques, sauvegardes et opérations non acquittées. Une mise
à jour du catalogue ne donne jamais autorité pour modifier une consommation passée.
La disponibilité de la recherche locale ne dépend pas du CGI OFF actuellement 503.

## Sources et choix initiaux (2026-10-12)

Pages demandées : [réutilisation](https://wiki.openfoodfacts.org/Reusing_Open_Food_Facts_Data)
et [exports](https://world.openfoodfacts.org/data). Le navigateur documentaire a reçu
respectivement une protection Anubis et une réponse NOINDEX, pas un listing exploitable.
Un seul HEAD curl vers static.openfoodfacts.org a échoué à la résolution DNS dans la
sandbox. Aucun téléchargement de données réelles n'a été réalisé.

Sources primaires complémentaires :

- [Service officiel d'exports](https://github.com/openfoodfacts/openfoodfacts-exports) :
  génération quotidienne ; Parquet à partir du JSONL ; CSV et différences quotidiennes
  restent mentionnés dans la transition entre services, sans garantie opérationnelle.
- [Dataset officiel OFF](https://huggingface.co/datasets/openfoodfacts/product-database/blob/main/README.md) :
  `food.parquet`, version simplifiée du JSONL, données structurées et suppression de
  certains champs. Il faut conserver la révision du dataset, pas seulement `main`.
- [Fichier Parquet identifié](https://huggingface.co/datasets/openfoodfacts/product-database/blob/7f75c003d7ba579cad106e0340fd03a4fe280f3c/food.parquet) :
  4,27 Go annoncés pour cette révision précise. Ce n'est ni une mesure HTTP actuelle
  ni le budget autorisé du prototype. Aucun téléchargement.
- [Export CSV officiel](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/scripts/export_database.pl) :
  champs séparés par tabulations, nutriments standardisés. Les suffixes `_100g`
  ne suffisent pas à déduire une référence solide/liquide sans les métadonnées.
- [Licences officielles](https://openfoodfacts.github.io/openfoodfacts-server/api/tutorials/license-be-on-the-legal-side/) :
  ODbL pour la base, DbCL pour les contenus, licence distincte pour les images.
- [SQLite FTS5](https://www.sqlite.org/fts5.html) et
  [PostgreSQL recherche textuelle](https://www.postgresql.org/docs/current/textsearch.html).

Choix : JSONL brut, lu ligne par ligne, puis normalisation par le vrai module
`frontend/src/lib/nutrition/catalog/normalize.js`. Une passerelle TSV bornée sera
testée comme option, avec rejet des références ambiguës. Parquet permet une projection
par colonnes et groupes de lignes, mais exige un lecteur supplémentaire (PyArrow ou
DuckDB) absent de ce prototype sans dépendance ; il n'est pas importé ici.

Les tailles courantes CSV/JSONL, les ETag/date de modification et le schéma actuel
des différentiels ne sont pas vérifiables par HEAD dans cet environnement. Ne pas
inventer ces chiffres ni assimiler un préfixe du dump à un échantillon représentatif.
Une petite extraction officielle autorisée par pays via les exports/dataset viewers
est à rechercher sur VPS ; les fixtures utilisées ici ne sont pas des données OFF.

## Décisions d'architecture en cours

SQLite embarqué convient à une base publique, immuable, avec nombreux lecteurs et un
seul processus d'import séparé. Si aucune instance réutilisable n'existe, PostgreSQL
introduirait un service permanent, son cache, ses sauvegardes et sa maintenance ; aucun
client PostgreSQL n'est présent dans cette session. Son intérêt
serait une charge concurrente importante, des mises à jour fréquentes ou une recherche
linguistique plus riche, à mesurer ultérieurement. Aucun service n'est installé.

Le prototype doit construire une génération séparée, vérifier SQLite et FTS, sceller
le fichier avec SHA-256, puis publier un manifeste par remplacement atomique. L'ancienne
génération reste disponible. Les interruptions ne doivent pas rendre un import partiel
visible. Le hash détecte une corruption accidentelle ; ce n'est pas une signature.

Budget conservateur initial : entrée décompressée 256 Mio, 100 000 produits maximum,
base 512 Mio maximum, cache SQLite 8 Mio, une importation à la fois, mémoire Node bornée
et contrôles de ressources avant import. Les mesures synthétiques ne justifient pas
encore plusieurs millions de produits. Les règles et résultats seront complétés à
chaque validation de l'implémentation.

## Vérification de l'infrastructure avant choix du moteur

À la demande du propriétaire, le développement et les benchmarks sont suspendus
avant un choix définitif. Cette section distingue le code openGym de l'ensemble du
VPS, auquel la sandbox ne donne pas une visibilité complète.

### Stockage réellement utilisé par openGym

| Ensemble | Implémentation constatée | Rôle |
|---|---|---|
| Comptes/authentification | `api/server.js`, `DATA_DIR/db.json` et `.bak` | Comptes, passkeys, invitations, abonnements push, liens d'appareil ; chargé en mémoire et enregistré par écriture durable |
| Entraînements serveur | `DATA_DIR/state-<uid>.json` | Document de profil et révisions de synchronisation existantes |
| Nutrition serveur | `api/nutrition/store.js` / `files.js`, `DATA_DIR/nutrition/SHA256(uid)/...` | Partitions JSON, manifestes et références immuables, publications/verrous/récupération |
| Nutrition navigateur/mobile | `local-store.js`, backends IndexedDB / fichiers JSON privés | Stockage offline-first et file durable, indépendant du catalogue externe |
| Déploiement fourni | `docker-compose.yml` : seulement `api` et `web`, montage `./data:/data` | Aucun service PostgreSQL, aucune connexion SQL configurée |

`api/package.json` ne comporte aucun pilote PostgreSQL ou ORM ; `.env.example`
documente les fichiers, pas DATABASE_URL/PGHOST. La recherche dans les sources suivies
ne trouve pas d'adaptateur SQL actif. Les mentions de SQLite dans Undici/node_modules
décrivent une capacité de cache de la dépendance et ne prouvent pas que l'application
l'utilise. `db.json` est une base logique, pas un serveur PostgreSQL.

### PostgreSQL opérationnel / accessible : statut non confirmé

Vérifications en lecture effectuées :

- Aucun `psql`, `pg_isready` ou binaire `postgres` dans le PATH de cette session.
- Aucun répertoire PostgreSQL standard visible sous /etc ou /usr/lib aux niveaux
  inspectés ; aucun processus nommé postgres/postmaster visible.
- Aucune variable PostgreSQL parmi les noms inspectés dans l'environnement de cette
  session ; pas de `.env` dans ce checkout. Aucune valeur/secrète n'a été affichée.
- Aucun listener 5432 dans les tables TCP IPv4/IPv6 visibles. Cela ne couvre pas un
  autre port, un socket Unix, un autre namespace Docker ou un serveur distant.
- `docker ps` refusé sur `/var/run/docker.sock` ; `ss` échoue à ouvrir un socket netlink.
  Aucun contournement, sudo, installation ou modification de service n'a été tenté.

Conclusion vérifiable : **l'API de ce dépôt n'utilise actuellement pas PostgreSQL**.
Conclusion non vérifiable ici : l'absence d'une instance PostgreSQL appartenant à un
autre service du VPS. Aucune authentification ou requête SQL réelle n'a été testée.

Pour confirmer en SSH avec les droits déjà disponibles, sans modifier de base :

```sh
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
# Adapter aux services/rôles EXISTANTS ; ne pas créer de rôle/base/extension ici.
docker exec <conteneur-postgres> pg_isready
docker exec -i <conteneur-postgres> psql -X -v ON_ERROR_STOP=1 \
  -U <role-de-lecture-existant> -d <base-autorisee> <<'SQL'
BEGIN READ ONLY;
SELECT version(), current_database(), current_user;
SELECT extname, extversion FROM pg_extension
 WHERE extname IN ('pg_trgm', 'unaccent');
SHOW shared_buffers;
SHOW work_mem;
SHOW maintenance_work_mem;
COMMIT;
SQL
```

Ces commandes vérifient le conteneur/base, pas encore l'accès depuis l'API. Depuis
le conteneur API existant, un test TCP unique vers l'hôte identifié est possible
sans pilote SQL ; un succès ne prouve ni authentification ni privilèges SQL :

```sh
docker exec <conteneur-api> node --input-type=module -e '
import net from "node:net";
const socket=net.connect({host:process.argv[1],port:5432});
socket.setTimeout(3000);
socket.once("connect",()=>{console.log("TCP reachable; SQL access unverified");socket.end()});
socket.once("timeout",()=>{socket.destroy();process.exitCode=1});
socket.once("error",()=>{console.error("TCP unreachable");process.exitCode=1});
' <hote-postgres-identifie>
```

Pas de scan réseau ; ne pas communiquer les mots de passe/URLs de connexion. Une
connexion SQL en lecture depuis l'API restera à valider une fois l'instance et un
rôle dédié identifiés, avant toute éventuelle dépendance ou intégration.

### Comparaison architecturale (aucun benchmark comparatif validé)

| Critère | PostgreSQL existant + full-text / trigrammes | SQLite FTS5 |
|---|---|---|
| Recherche française | `tsvector`, poids nom/marque, configuration française + unaccent ; configuration simple utile pour marques/codes ; trigrammes pour fautes de frappe | unicode61/remove_diacritics, préfixes et BM25 ; pas de correction orthographique automatique équivalente à pg_trgm |
| Indexation | B-tree code-barres ; GIN full-text ; GIN/GiST trigrammes ciblés si bénéfice mesuré | B-tree code-barres ; FTS external-content et index de préfixes |
| Latence | Dépend du corpus, caches, plans, réseau et autres charges ; pas de chiffre sans EXPLAIN/benchmark | Dépend du corpus et termes fréquents ; pas de chiffre de recherche validé à ce stade |
| RAM | Coût serveur déjà payé si instance existante, mais cache et mémoire par tri/connexion/import supplémentaires ; pool et budgets nécessaires | Pas de démon permanent ; cache par lecteur/processus et cache OS ; intégration Node à limiter pour ne pas bloquer l'event loop |
| Disque | Tables, index full-text/trigrammes, WAL et double génération pendant reconstruction ; amplification à mesurer | Tables, FTS et éventuel journal ; deux fichiers générations nécessaires pour publication sûre |
| Concurrence | MVCC, lecteurs et écrivains simultanés, plusieurs API ; imports pouvant perturber les autres bases du cluster | Nombreux lecteurs d'une génération immuable, un écrivain par fichier ; reconstruction séparée |
| Maintenance | Réutilise supervision existante, mais nouveaux rôles, migrations, analyse/vacuum et dimensionnement ; extension à vérifier avant toute activation | Fichier/version/checksum et publication atomique ; sauvegarde/reconstruction du catalogue indépendante |

[GIN full-text](https://www.postgresql.org/docs/current/textsearch-indexes.html),
[pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) et
[unaccent](https://www.postgresql.org/docs/current/unaccent.html) décrivent ces capacités.
Ne pas indexer tous les champs avec toutes les méthodes par défaut : les trigrammes
ajoutent une charge disque/import et les requêtes très courtes peuvent être coûteuses.
Même dans un cluster existant, un import catalogue utilise CPU, I/O, cache et WAL des
autres services ; une base séparée n'offre pas une isolation de ressources physique.

### Recommandation conditionnelle et isolation

1. Si PostgreSQL est déjà maintenu, accessible par l'API et dispose de marge mesurée,
   privilégier sa réutilisation pour un essai borné dans une **nouvelle base catalogue**,
   sans toucher aux bases existantes. Alternative : schéma dédié à ACL strictes si
   une base indépendante est impossible. Un schéma seul n'est pas une garantie.
2. Sinon, poursuivre SQLite comme candidat léger : openGym utilise déjà des fichiers,
   donc réutiliser son « db.json » ne fournit pas d'index textuel ni de moteur SQL.
   Ne pas installer PostgreSQL uniquement sur l'hypothèse qu'il existe déjà.
3. Comparer sur le même sous-ensemble OFF représentatif autorisé : p50/p95, termes
   fréquents, qualité française, index/disque temporaire, mémoire/CPU et lecteurs
   simultanés. Décider seulement après ces mesures et inventaire VPS.

Pour les deux moteurs : importer uniquement des données publiques OFF, avec licence,
provenance et version ; rôle API lecture seule et rôle d'import distinct si PostgreSQL,
fichiers immuables/lecture seule et processus d'import séparé si SQLite. Aucun lien de
privilège vers comptes, historiques, recettes ou outbox. La requête publique ne reçoit
ni nom de base/table, ni SQL/FTS libre, ni chemin. Les sauvegardes utilisateur excluent
le catalogue ; seul l'aliment choisi est normalisé et publié via les services v1 et
snapshots existants. La séparation technique n'annule pas les obligations ODbL lors
d'une redistribution ou combinaison de bases.

### État du prototype au moment de cette suspension

Les scripts isolés existent, sans intégration. Un essai de 120 produits **synthétiques**
a construit un fichier de 90 112 octets (FTS 32 768 ; index code-barres 4 096) en
environ 0,43 s au total. La lecture a ensuite échoué avec `corrupt-record` : le hash
de record compare la forme entière de certains nombres entrants à la forme REAL
restituée par SQLite. La canonicalisation numérique du prototype est à corriger et
tester avant de considérer cet essai comme réussi. Les contrôles n'ont pas été
affaiblis ; aucune donnée utilisateur n'est concernée.

Il n'existe donc à ce stade **aucun résultat de performance de recherche validé**,
aucun benchmark réel OFF, aucune mesure PostgreSQL et aucun choix définitif. Les
artifacts sont ignorés par Git et isolés ; aucun export complet téléchargé, aucune
base/service de production modifié, aucun commit ou push. Cette suspension correspond
à la demande de revue architecturale préalable du propriétaire.

## Reprise SQLite autorisée et correction numérique

Le propriétaire retient désormais SQLite FTS5 comme candidat principal, sans chercher
PostgreSQL davantage. La suspension ci-dessus reste l'état historique de l'essai initial.
Le prototype reste isolé : aucune intégration ni choix de dimensionnement définitif.

La canonicalisation du prototype traite `6` et `6.0`, ainsi que `0` et `-0.0`, comme
la même valeur JSON. Seuls les flottants **exactement entiers** sont normalisés ; aucune
tolérance ou précision décimale réduite n'est introduite. SQLite REAL conserve les
valeurs binaires double précision utilisées par le moteur JavaScript ; il ne s'agit
pas d'un type décimal exact arbitraire. Les nombres non finis et hors contrat restent
interdits. Le constructeur relit et vérifie chaque record SQL avant publication, en
plus du contrôle SQLite, FTS et du hash de fichier.

Les premiers 29 tests Python vérifient notamment les décimales, les fractions, les
valeurs absentes versus zéro, les références ml/g, les doublons incompatibles, les
six recherches françaises, les paramètres malformés, les écritures concurrentes et
les interruptions aux étapes de construction/publication. Le test de profondeur a
révélé que le parseur JSON seul n'impose pas notre limite ; une inspection explicite
bornée à 12 niveaux a été ajoutée. Les tests d'interruption simulent des exceptions,
pas une coupure électrique. Les résultats complets seront consignés après benchmarks.

## Référence wger et décisions retenues

L'[importateur wger consulté](https://github.com/wger-project/wger/blob/master/wger/nutrition/management/commands/import-off-products.py)
prévoit import JSONL complet, mode insertion/mise à jour, filtrage de langues et
compteurs de produits ignorés. Son option delta utilise
`https://static.openfoodfacts.org/data/delta/index.txt` et sélectionne la première
entrée, puis traite le gzip correspondant. Son
[extracteur](https://github.com/wger-project/wger/blob/master/wger/nutrition/extract_info/off.py)
exige les macros et l'énergie ; son modèle Django n'est pas repris ici.

Idées réutilisées : séparation import/extraction, lecture progressive, identité
produit et compteurs. Différences choisies : conserver les produits incomplets avec
`null`, distinguer ml/g avec le moteur openGym, refuser les doublons divergents,
construire une génération indépendante plutôt que modifier la base servie. Reprendre
uniquement le dernier delta ferait manquer des journées à un appareil/serveur arrêté.
Aucun code wger n'a été copié ; son fichier indique AGPL-3.0-or-later. Les licences
OFF restent indépendantes de celle du code.

L'index delta documentaire n'a pas fourni de contenu exploitable et le schéma des
suppressions n'est pas confirmé. **Aucun import différentiel n'est activé.** Futur
protocole : snapshot daté, liste explicite de tous les deltas contigus, hashes et
curseur source validés, upserts/suppressions uniquement dans une copie candidate,
rejeu idempotent par identifiant de delta, contrôle des changements de pays et des
produits fusionnés, vérification avant publication. Une lacune de la chaîne ou une
suppression inconnue bloque l'incrémental et exige une reconstruction officielle.
L'absence d'un produit dans un delta ne constitue jamais une suppression. Un nouveau
snapshot complet remplace le catalogue public seulement, jamais les aliments déjà
sauvegardés ni les historiques. Pas de cron/téléchargement automatique.

## Composants effectivement implémentés

| Fichier dans `scripts/nutrition-local-catalog/` | Rôle |
|---|---|
| `normalize.mjs` | Projection JSONL/TSV ; réemploi du normaliseur OFF, `validateFood` et `nutrientsForQuantity` existants |
| `build.mjs` | Lecture progressive JSONL/gzip, passerelle TSV, hash d'entrée et protocole scellé du constructeur |
| `tsv.py` | TSV avec en-têtes uniques, colonnes/valeurs bornées ; transport vers le normaliseur JavaScript |
| `catalog.py` | Construction SQLite, publication, lecteur FTS/code-barres, rollback et nettoyage explicite |
| `fixtures.mjs` | Générateur déterministe de données inventées, aucun produit réel garanti |
| `benchmark.py` | Moyenne/p50/p95, ouverture/vérification, pagination et quatre lecteurs concurrents |
| `measure.py` | CPU et RSS de l'arbre du seul processus lancé, sans observer d'autres services |
| `normalize.test.mjs`, `build.test.mjs`, `test_catalog.py` | Tests métier, pipeline réel et SQLite/interruption/concurrence |
| `.gitignore` | Exclut bases, exports temporaires et bytecode Python |
| `benchmarks.json` | Résultats synthétiques conservés pour revue ; aucun fichier SQLite versionné |

### Schéma et index

Base STRICT, `application_id` dédié et `user_version=1` (format du prototype, distinct
et indépendant du contrat Nutrition portable v1).

- `products` : identifiant SQL interne, `code TEXT UNIQUE`, noms générique/français,
  marque, pays JSON, unité de référence (`g`/`ml`/NULL), kcal/protéines/glucides/lipides
  REAL/NULL, portions compatibles, avertissements, date OFF de modification,
  indicateur de complétude et hash du record.
- `products_fts` : FTS5 external-content sur nom/nom français/marque, tokenizer
  `unicode61 remove_diacritics 2`, index de préfixes 3 et 4 caractères. Le rebuild et
  l'intégrité FTS vérifient le lien aux lignes `products`.
- `metadata` : provenance du fichier, SHA-256 de l'entrée décompressée, version
  indiquée par l'opérateur, compteurs et attribution/licence. Les fixtures sont
  explicitement identifiées comme synthétiques et ne prétendent pas relever d'OFF.

Référence des nutriments enregistrés : **100 g ou 100 ml**, sans conversion entre
ces unités. Les portions connues sont ramenées à 100 dans la même unité par le
moteur existant ; leur quantité reste disponible. kJ/kcal utilise la conversion
existante, avec sa précision IEEE-754. Les champs inconnus restent NULL, y compris
quand une référence TSV est ambiguë. Une référence connue reste affichable même
si tous les nutriments sont absents. Pas de calcul d'énergie à partir des macros.
Les champs images, contributeurs et tout contenu inconnu sont exclus.

Le code-barres reste une chaîne. La normalisation des alias de zéros initiaux est
celle du client Nutrition existant (elle peut ramener un alias 13 chiffres à son
identité normalisée 8 chiffres) ; aucune conversion en nombre. La recherche exacte
normalise les mêmes alias. La chaîne `00012345` est conservée et testée.

### Requêtes et classement

Recherche de 2 à 120 caractères, maximum huit tokens de 2 à 40 caractères ; tokens
littéraux quotés avec AND et préfixe généré seulement sur le dernier token de trois
caractères ou plus. Les opérateurs FTS/SQL de l'utilisateur ne sont jamais exécutés.
Accents/casse sont ignorés ; tirets sont séparateurs. Ceci gère `pates`/`pâtes`,
`Coca-Cola`/`coca cola`, `yaourt`/`yaourts`, sans prétendre corriger toutes les fautes
ou fournir une recherche linguistique avec synonymes.

Classement : quatre nutriments présents et unité connue d'abord, puis BM25 pondéré
(nom 4, nom français 6, marque 2), enfin code stable. « Complet » ne signifie pas
exactitude certifiée. Les résultats incomplets restent trouvables plus bas.
Pagination : maximum 20 résultats et 20 pages ; total exact FTS, `hasMore` et
`limited` explicites. Le total, le classement et la lecture partagent un budget
SQL de 150 ms avec interruption via progress handler. Aucune réponse partielle
n'est présentée comme succès lorsque ce budget expire. Réponse plafonnée à 128 Kio.
Connexion `mode=ro&immutable=1`, `query_only`, extensions non chargées, schéma non
fiable désactivé ; aucun SQL, nom de fichier ou nom de table libre.

## Import reproductible et budgets

Aucun téléchargement intégré au constructeur. Il accepte un **fichier local de
sous-ensemble approuvé**, JSONL ou TSV, éventuellement gzip. Installer uniquement
les dépendances du dépôt existant si nécessaires ; le prototype ajoute zéro paquet.
Python standard avec SQLite/FTS5 et Node 22 sont déjà disponibles sur ce VPS.

```sh
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
python3 -c "import sqlite3; c=sqlite3.connect(':memory:'); c.execute('CREATE VIRTUAL TABLE f USING fts5(name)'); print(sqlite3.sqlite_version)"
free -h
df -h /home/codex
# Exemple : le fichier doit déjà être un sous-ensemble officiel approuvé.
# sha256 ci-dessous désigne son contenu DECOMPRESSE, pas celui du gzip.
nice -n 10 ionice -c 3 node --max-old-space-size=128 \
  scripts/nutrition-local-catalog/build.mjs \
  --input /chemin/vers/echantillon-off.jsonl.gz --workspace offsample \
  --source off-jsonl --version export-date-revision \
  --expected-input-sha256 <sha256-verifie-du-contenu-decompresse> \
  --country en:france
# TSV : --format tsv --source off-tsv
python3 scripts/nutrition-local-catalog/catalog.py --workspace offsample search 'pâtes'
python3 scripts/nutrition-local-catalog/catalog.py --workspace offsample barcode 3017620422003
```

Limites : 256 Mio de fichier compressé **et** de contenu décompressé ; 1 Mio par
ligne JSONL/TSV, 100 000 lignes entrantes, 16 Kio par record normalisé, 512 Mio par
base, 2 Gio par workspace. Cache constructeur 8 Mio, lecteur 4 Mio ; constructeur
Python limité à 256 Mio d'espace virtuel, passerelle TSV à 128 Mio ; Node doit être
lancé avec le plafond de heap ci-dessus (RSS différent du heap). En TSV, maximum
512 colonnes, champ 64 Kio ; valeurs excessives/colonnes irrégulières refusées.

Avant import et chaque lot de 500 : au moins 512 Mio de RAM disponible et 1 Gio de
disque libre. Ces contrôles ne réservent pas les ressources des autres services.
`nice`/`ionice` réduisent la priorité, sans garantir un plafond CPU. Un import n'est
pas un benchmark de l'impact sur les services de production, qui n'ont pas été sondés.
Les plafonds rendent volontairement l'export complet non importable dans ce prototype.

Politique par défaut : erreur de normalisation = échec global, ancienne génération
conservée. `--skip-invalid` explicite permet de compter les produits invalides avec
codes d'erreur, sans copier leurs payloads dans les logs. JSON tronqué/malformé,
échec gzip/TSV, hash source divergent et doublons incompatibles restent fatals.
Doublons identiques : dédupliqués et comptés. Stats de sortie : scannés/importés,
filtrés, invalides, causes et doublons. Une baisse importante de couverture ou de
complétude sur des données réelles devra demander une décision avant publication
applicative ; aucune mise à jour automatique n'existe pour masquer cette baisse.

## Publication, interruptions, retour arrière et nettoyage

Le constructeur prend un flock exclusif, vérifie la génération courante puis crée
un fichier UUID `.partial`. Les lots SQL utilisent journal DELETE et synchronous
FULL. Le normaliseur transmet un sceau final contenant le nombre et le hash de
**toutes** les lignes envoyées ; EOF prématuré n'autorise aucune publication.

Après réception : rebuild FTS, contrôle FTS, `PRAGMA integrity_check`, reconstruction
et hash de chaque record, essais indexés Nutella/Coca-Cola/lait/riz/pâtes/yaourt.
Zéro résultat est légitime dans un sous-ensemble : ces essais vérifient l'index,
pas une couverture universelle. Le fichier fermé est fsync, renommé en génération
immuable, puis le répertoire est fsync. Son hash/taille/nombre et la précédente
génération sont écrits dans un manifeste temporaire fsync, remplacé atomiquement
sur `current.json` et le répertoire est à nouveau fsync.

Un lecteur vérifie le manifeste, le hash/taille du fichier et le schéma avant de
pinner une génération. Ses requêtes ne re-hashent pas le fichier complet. La
publication concurrente ne lui change pas de base ; un nouveau lecteur prend la
nouvelle génération. Le manifeste garde **une seule** ancre précédente, sans
chaîne récursive. Les anciennes générations restent sur disque jusqu'à autorisation.

- Interruption avant manifeste : ancienne génération visible ; candidate/orphelin
  sans autorité. Au redémarrage, vérifier current et recommencer l'import.
- Interruption après publication, avant résultat utilisateur : current désigne la
  nouvelle génération complète ; inspection permet de vérifier la version/source.
  Un nouvel import peut reconstruire le même contenu sans modifier les utilisateurs.
- Échec pendant fsync/remplacement : résultat non confirmé ; inspecter current,
  accepter uniquement une génération valide. Pas de succès fictif.
- Manifest/fichier courant corrompu : lecture refusée ; pas de fallback silencieux.
  Récupération opérateur à partir d'une génération validée ou reconstruction. Le
  rollback ordinaire exige un current valide et une ancre précédente valide.
- SIGKILL : test réel de terminaison du processus et libération du flock ; **pas**
  une simulation de panne électrique ou une preuve sur tous les systèmes de fichiers.

```sh
python3 scripts/nutrition-local-catalog/catalog.py --workspace offsample inspect
python3 scripts/nutrition-local-catalog/catalog.py --workspace offsample rollback
# Après revue des versions : noms UUID EXACTS de générations obsolètes uniquement.
python3 scripts/nutrition-local-catalog/catalog.py --workspace offsample cleanup \
  --delete catalog-<uuid-obsolete>.sqlite
```

Le nettoyage est sérialisé avec publication/rollback et valide tous les noms avant
suppression. Current et previous sont protégés ; chemins/symlinks sont refusés.
Sous Linux, un lecteur déjà ouvert conserve son descripteur d'une ancienne génération
supprimée ; cela est testé. La libération d'espace peut attendre sa fermeture. Aucun
âge/TTL ne déclenche de suppression. Les `.partial` d'une coupure brutale et fichiers
source ne sont pas supprimés par ce nettoyage ; l'opérateur peut les supprimer après
revue, dans `artifacts/` uniquement, avec aucun écrivain actif. Une exception normale
supprime seulement le partial/journal créé par cet import.

## Préparation de l'intégration, pas de modification applicative

Architecture validée pour la prochaine revue :

1. Worker de lecture limité, base publique montée indépendamment de DATA_DIR utilisateur,
   avec manifeste/génération pinners et réouverture contrôlée après publication.
2. Conserver les routes catalogue actuelles : recherche textuelle locale sans requête
   OFF ; réponse compatible `products` + **count exact**, pagination bornée. Les DTO
   SQL doivent être projetés vers le schéma externe validé, avec référence explicite
   et aucune valeur inventée. Cette projection HTTP n'est pas encore implémentée.
3. Code-barres local d'abord ; seulement en cas d'absence, OFF v3 avec cache/dedup et
   quotas existants. Actualisation d'un produit sur action ciblée ; erreur fournisseur
   permet une restitution locale identifiée comme datée, sans modifier l'historique.
4. Mode invité : route publique bornée ; aucun uid, cookie, token ou journal n'est
   stocké dans le catalogue. Produits déjà sauvegardés restent indépendants du serveur.
5. Web/Android/iOS peuvent employer l'API openGym lorsque configurée. Un mobile sans
   serveur garde sa bibliothèque locale et la consultation v3 native existante ; il
   ne dispose pas magiquement du catalogue complet hors ligne. Prévoir un message clair.

Le Python du prototype n'est **pas** livré dans le Docker API actuel. Le Node 22.23.3
local expose `node:sqlite` et FTS5 (SQLite 3.51.3), vérifiés sur une base mémoire ; cette
API reste signalée expérimentale. Avant intégration, vérifier aussi l'image Alpine et
choisir un worker Node (sans bloquer l'event loop) ou un worker Python isolé avec coût
runtime justifié. Ne pas lancer un process ou re-hasher la base entière par frappe.
Le format de hash de records Python doit être respecté/porté si le lecteur change de
langage ; ce n'est pas le canonical JSON du contrat Nutrition v1.

Aucune API, UI, synchronisation, contrat v1, sauvegarde ou dépendance du projet n'est
modifiée. Le catalogue complet n'entre pas dans les sauvegardes personnelles ; seul
un produit effectivement choisi passe par normalisation et publication durable
existantes. Attribution OFF/ODbL et version source doivent suivre les données réelles.
Les images ne sont pas importées. La séparation ne dispense pas des obligations
ODbL lors d'une distribution publique d'une base dérivée ; vérifier attribution,
partage à l'identique et accès à la base dérivée avant publication. Les recettes et
historiques privés ne sont pas ajoutés à la base OFF. Aucune conformité juridique
universelle n'est affirmée.


## Mesures synthétiques finales

Environnement : Debian 13 / Linux 6.12.57, 4 vCPU, RAM 7,6 Gio, disponible environ
3,9 Gio, disque libre 51 Go, aucun swap. Node 22.23.3, Python 3.13.5, SQLite Python
3.46.1 avec FTS5. Imports successifs à priorité nice 10 / ionice idle, heap Node
128 Mio, pas de téléchargement ni de requête réseau pendant les mesures.

Corpus déterministe : six familles de noms français, marques de test, pays France
et Belgique, références massiques/volumiques explicites, portions, dates source ;
10 % de produits sans nutriments. Les chiffres nutritionnels sont **inventés**.
Environ un sixième des lignes matche chaque mot courant : c'est une charge de
classement importante mais un vocabulaire beaucoup plus répétitif que le vrai OFF.
Ces résultats ne sont donc pas représentatifs de millions de produits réels.

Les résultats complets et les compteurs sont conservés dans
`scripts/nutrition-local-catalog/benchmarks.json`. Les tables ci-dessous utilisent
les dernières exécutions, sans additionner les relances. Aucun invalide/filtré ni
doublon dans ces deux corpus ; tous les produits ont été importés.

| Mesure | 10 000 produits | 50 000 produits |
|---|---:|---:|
| Entrée JSONL (Mio) | 4.442 | 22.235 |
| SQLite total (Mio) | 4.012 | 21.957 |
| FTS alloué (Mio) | 1.020 | 5.168 |
| Index code-barres (Mio) | 0.176 | 0.898 |
| Import total Node + SQLite (s) | 5.583 | 28.599 |
| Construction/contrôle FTS (s) | 0.084 | 0.402 |
| SQLite + reconstruction/hashes des records (s) | 0.574 | 2.858 |
| Normalisation JS cumulée, chevauche écriture (s) | 4.357 | 22.672 |
| RSS Node maximum (Mio) | 70.809 | 99.109 |
| RSS constructeur Python maximum (Mio) | 26.535 | 31.277 |
| RSS arbre échantillonné 25 ms (Mio) | 97.812 | 130.949 |
| CPU arbre cumulé (s) | 8.389 | 40.972 |
| CPU moyen, % d’un cœur | 147.001 | 142.707 |
| Ouverture + hash complet, cache OS chaud (ms) | 6.897 | 21.071 |
| Lecteur, RSS max avec quatre connexions (Mio) | 40.832 | 44.980 |

Temps par requête : 30 répétitions à cache chaud, moyenne et p95 par rang supérieur,
avec validation/hashes des records retournés et total FTS exact. Aucune latence HTTP,
frontend ou fournisseur incluse. Pas de purge du cache OS global pour fabriquer un
benchmark froid ; l'ouverture vérifiée lit déjà le fichier entier.

| Recherche | 10k moyenne / p95 (ms) | 50k moyenne / p95 (ms) |
|---|---:|---:|
| Nutella | 4.784 / 5.430 | 23.683 / 26.180 |
| Coca-Cola | 5.715 / 7.480 | 26.101 / 28.486 |
| lait | 4.838 / 5.492 | 23.886 / 27.194 |
| riz | 5.089 / 6.332 | 23.575 / 25.319 |
| pâtes | 4.961 / 5.868 | 25.133 / 30.987 |
| yaourt | 4.938 / 5.418 | 23.537 / 24.910 |
| pates | 5.324 / 6.364 | 24.493 / 26.521 |
| Panzani | 5.114 / 5.760 | 23.645 / 25.245 |
| lait demi ecreme | 6.083 / 7.282 | 27.944 / 31.070 |
| Code-barres exact | 0.064 / 0.075 | 0.063 / 0.070 |
| Pagination lait, page 20 | 5.661 / 6.306 | 24.076 / 28.278 |
| Quatre lecteurs simultanés | 18.780 / 25.507 | 41.944 / 55.447 |

Les quatre lecteurs exécutent 120 requêtes en tout, chacun avec sa connexion épinglée ;
l'ouverture/hash de chaque connexion est incluse dans le débit global mais exclue du
temps individuel de requête. Le RSS contient les caches SQLite des quatre connexions.
La mesure d'arbre additionne les RSS (pages partagées potentiellement comptées plusieurs
fois), et l'échantillonnage peut manquer un pic très bref : ni PSS ni garantie maximale.

Pertinence synthétique : les six recherches donnent la bonne famille ; les vingt
premiers résultats ont leurs quatre nutriments. `pates` et `pâtes` donnent les mêmes
produits ; marque Panzani et mots multiples sans accents retrouvent la famille visée.
Les tests prouvent que les produits incomplets restent accessibles après les complets.
Ceci valide le comportement, pas une évaluation humaine de pertinence du catalogue réel.
Pas de synonymes, distance de frappe ni préférences géographiques dans le classement
actuel (le filtre pays est appliqué à l'import, pas appris).

### Disque temporaire, impact et extrapolation

Pour B octets de base et I octets d'entrée approuvée : prévoir current + previous
(2B), candidate (B), journal temporaire pessimiste (jusqu'à B), I et une marge pour
index/tri/manifeste. Avec le corpus 50k, cela représente environ **110 Mio plus marge**
si deux générations sont déjà retenues ; aucun besoin de décompresser le gzip en
fichier supplémentaire. Une troisième ancienne génération non nettoyée s'ajoute au
budget : la rétention n'est pas automatiquement plafonnée par suppression.

La construction utilise environ 1,4 à 1,5 cœur en moyenne sur quatre (Node + Python),
pas un plafond instantané. Le pic RSS arbre de l'import 50k est environ 131 Mio,
petit devant les 3,9 Gio disponibles relevés. L'indexation consomme aussi I/O/cache OS ;
aucune absence d'impact sur les autres services n'est garantie ou prétendue mesurée.

Extrapolation purement mécanique du corpus 50k : environ 460 octets par produit,
dont environ 108 octets FTS ; un million donnerait environ 439 Mio de base, cinq
millions environ 2,14 Gio. Ce n'est pas une estimation fiable du vrai OFF : noms,
pays, vocabulaire, qualité et portions diffèrent. Pour une **hypothèse de travail**
plus large de 0,5–2 Kio/produit, un million ferait environ 0,5–1,9 Gio et cinq millions
2,4–9,5 Gio, avant les générations/journaux/source. Mesurer ces ratios sur l'échantillon
réel est indispensable. Les plafonds du prototype restent 100k/512 Mio/256 Mio entrée.

Le temps des mots très fréquents grandit avec le nombre de matchs car le classement
complétude/BM25 trie les candidats ; le nombre retourné seul ne borne pas ce travail.
Ne pas extrapoler les 25 ms à plusieurs millions : le budget SQL de 150 ms peut alors
refuser ces recherches. Une indexation/candidate selection plus élaborée doit être
évaluée sans sacrifier les résultats complets ni les contrôles d'intégrité.

## Échantillon officiel : limitation actuelle

Un seul essai borné (20 lignes, maximum 1 Mio, timeout 10 s) sur le viewer du dataset
OFF officiel a échoué DNS : `Could not resolve host: datasets-server.huggingface.co`.
Aucun produit officiel téléchargé ou importé ; aucun benchmark réel. Les pages
world/wiki étaient également non exploitables par le navigateur documentaire.
Aucune recherche/consultation OFF en rafale n'a été utilisée pour remplir le corpus.

La réponse du viewer Hugging Face est une enveloppe `rows`, **pas** un dump JSONL
Product Opener : vérifier son schéma et sa conversion avant de la donner à l'importeur.
Un préfixe de vingt lignes, même obtenu, ne serait pas représentatif. Prochaine
expérimentation proposée après autorisation et réseau disponible : sous-ensemble
officiel daté France, 20–100k produits, entrée <=256 Mio, base <=512 Mio, workspace
<=2 Gio, priorité réduite, mêmes mesures et validation humaine des résultats. Ne pas
lancer un download complet ni une projection qui lit à distance tout un Parquet de
plusieurs Go sans budget/accord. Les tailles/ETag actuels de JSONL/CSV et le schéma
réel des deltas restent à confirmer.

## Commandes de reproduction des benchmarks

```sh
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
mkdir -p scripts/nutrition-local-catalog/artifacts
free -h
df -h /home/codex
# Le générateur refuse d'écraser une fixture existante ; la réutiliser pour les relances.
node scripts/nutrition-local-catalog/fixtures.mjs scripts/nutrition-local-catalog/artifacts/fixture-10000.jsonl 10000
node scripts/nutrition-local-catalog/fixtures.mjs scripts/nutrition-local-catalog/artifacts/fixture-50000.jsonl 50000
nice -n 10 ionice -c 3 python3 scripts/nutrition-local-catalog/measure.py   node --max-old-space-size=128 scripts/nutrition-local-catalog/build.mjs   --input scripts/nutrition-local-catalog/artifacts/fixture-50000.jsonl   --workspace bench50k --source fixture --version synthetic-50000-v1
nice -n 10 ionice -c 3 python3 scripts/nutrition-local-catalog/benchmark.py   --workspace bench50k --iterations 30 --readers 4
# Même procédure avec fixture-10000.jsonl / bench10k.
```

Les bases et exports restent dans artifacts, ignorés par Git. Pas de nettoyage
implicite des fichiers existants ni d'utilisation de données utilisateur.

## Revues critiques et validation finale

### Fonctionnelle

Défauts corrigés : formes numériques entier/REAL divergentes dans le hash, perte de
la référence connue pour un produit entièrement incomplet, attribution OFF ambiguë
des fixtures. Les décimales ne sont pas arrondies ; les tests comparent les valeurs
binaires réellement relues et plusieurs reconstructions successives. La conversion
418,4 kJ / 4,184 donne la représentation double précision du moteur (proche de 100),
pas un arrondi forcé. Les erreurs de test initiales ont été corrigées sans affaiblir
les validateurs. Les six recherches, marques, accents, quantités et doublons sont
couverts. Le classement réel et la couverture France restent à évaluer sur OFF.

### Concurrence et durabilité

Défauts corrigés : attente de fermeture complète des pipes du constructeur (close,
pas seulement exit) avant de lire ses résultats, terminaison attendue du constructeur
après abandon pour libérer son flock, ancre précédente bornée et publiée dans le
même manifeste que la nouvelle génération. Les tests couvrent lecteur épinglé,
écrivain concurrent refusé, interruptions avant/après publication, disque plein
injecté pendant insertion, quota insuffisant, gzip CRC incorrect, seal manquant et
arrêt SIGKILL réel. Les anciennes données publiques ne sont pas détruites avant que
la nouvelle génération soit vérifiée. Une panne électrique réelle et différents
systèmes de fichiers restent à valider ; les mocks de quota ne remplissent pas le VPS.

### Sécurité, limites et maintenance

Défauts corrigés : profondeur JSON non bornée par le parseur seul, clés dangereuses
ou dupliquées, mauvaises formes de pays/warnings/provenance pouvant lever une erreur
non structurée, erreur de parsing susceptible d'inclure un fragment du payload dans
les logs. Requêtes SQL paramétrées, tokens FTS construits, quotas d'entrée/base/réponse,
progress handler SQL, génération/path allowlist, lecteur read-only et absence de
secrets dans le catalogue vérifiés. Un test force l'expiration de requête et vérifie
qu'aucun succès partiel n'est retourné, puis que le lecteur reste utilisable.

Un SHA-256 n'authentifie pas une donnée si l'opérateur change fichier et manifeste.
Le normaliseur et les validations restent nécessaires ; l'adaptateur applicatif
futur ne devra ni accepter une fixture ni transplanter les hashes internes dans les
contrats de publication des utilisateurs.

### Résultats et commandes

| Groupe, dernière exécution uniquement | Résultat |
|---|---|
| Prototype SQLite Python | 37 réussis, 0 échec/ignoré, 0,480 s |
| Normaliseur et pipeline réel Node/Python | 25 réussis, 0 échec/ignoré, 1,425 s |
| Catalogue frontend existant + composant réel | 130 réussis / 7 fichiers, 0 échec/ignoré, 5,23 s |
| Build web existant | Réussi, 1,79 s ; avertissements chunk/dynamic import conservés |
| Locales | 18 langues, 2 464 clés synchronisées |
| Syntaxe Node/Python et whitespace | Vérifiés ; git diff --check réussi |
| OFF réel / benchmarks réels | Non exécutables ici : DNS ; 0 produit officiel importé |
| API HTTP / appareils | Non relancés pour ce prototype sans modification API/UI/native |

Ne pas additionner les relances des mêmes suites. Aucun test n'est désactivé. Dans
cette sandbox, lancer Node depuis Node a produit EPERM ou une sortie vide même pour
un console.log simple ; le runner est exécuté sans isolation de processus Node.
Les tests de pipeline appellent le **vrai build()** et son constructeur Python,
la passerelle TSV et SQLite réels, sans mock de normalisation/persistance. Les tests
Python utilisent des dossiers temporaires propres au test ; le test SIGKILL lance
et termine uniquement son propre constructeur. Aucun socket HTTP n'est requis.

```sh
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py' -v
node --test --experimental-test-isolation=none --test-reporter=spec scripts/nutrition-local-catalog/*.test.mjs
node --check scripts/nutrition-local-catalog/build.mjs
node --check scripts/nutrition-local-catalog/normalize.mjs
python3 -m py_compile scripts/nutrition-local-catalog/catalog.py scripts/nutrition-local-catalog/benchmark.py scripts/nutrition-local-catalog/measure.py scripts/nutrition-local-catalog/tsv.py
cd frontend
npm test -- src/lib/nutrition/catalog src/views/nutrition/FoodCatalog.test.jsx
npm run build
node scripts/check-locales.mjs
cd ..
git diff --check
```

Les suites complètes frontend/API ne sont pas relancées : aucun fichier applicatif
n'a changé dans cette reprise isolée. Les modifications préexistantes de l'étape 4
restent dans l'arbre Git, sans être annulées, committées ou poussées.

## Décision de revue et travaux avant intégration

**Prototype prêt à la revue technique sur fixtures ; pas de validation du catalogue
réel ni d'intégration applicative.** SQLite FTS5 est confirmé comme moteur retenu,
avec une empreinte viable pour les volumes testés. Il faut encore :

1. Obtenir un sous-ensemble officiel autorisé, daté et suffisamment varié ; mesurer
   couverture, doublons, unités ambiguës, invalides et pertinence française.
2. Mesurer mots fréquents, ressources temporaires et concurrence sur ce corpus ;
   adapter les budgets uniquement avec ces preuves, sans affaiblir l'intégrité.
3. Choisir/valider le worker dans l'image API et la projection compatible aux DTO
   actuels ; conserver cache, quotas v3, annulations et fallback barcode/local.
4. Vérifier le schéma et la continuité des deltas, notamment suppressions et
   changement de pays. Reconstruction complète manuelle tant que non confirmé.
5. Tester durabilité réelle et arrêt/redémarrage de lecteurs sur le système de
   fichiers de déploiement. Pas de migration du stockage utilisateurs.

Aucun téléchargement complet, installation permanente, service, déploiement, tâche
planifiée, remplacement de route/UI, commit ou push n'a été effectué.

## Diagnostic réseau et prochaine récupération manuelle

Revue demandée après approbation architecturale du prototype : aucune intégration.
Le diagnostic supplémentaire a utilisé uniquement deux résolutions et des ouvertures
locales de sockets, pas une série de requêtes HTTP ni un téléchargement.

- `getaddrinfo(datasets-server.huggingface.co, 443)` et
  `getaddrinfo(static.openfoodfacts.org, 443)` : EAI_AGAIN (-3), résolution temporairement
  impossible dans cette session.
- Création seule de sockets UDP IPv4 et IPv6 : EPERM (1), aucun paquet envoyé.
- `/etc/resolv.conf` et NSS consultés en lecture ; résolveurs configurés, non modifiés.

Cela établit un blocage de capacités réseau dans l'environnement de cette session
Codex, compatible avec les restrictions de sandbox, avant toute connexion HTTP.
Cela **ne prouve pas** une panne du DNS du VPS hors sandbox, ni un refus d'accès du
viewer, ni un mauvais chemin API. Les précédentes consultations OFF réussies par
le propriétaire depuis SSH ne vérifient pas à elles seules l'hôte Hugging Face.
Le navigateur documentaire utilise un transport distinct ; accéder à la documentation
via cet outil ne démontre pas un accès réseau depuis le processus d'import.

L'endpoint officiel du viewer
[rows](https://huggingface.co/docs/dataset-viewer/rows) accepte des tranches bornées
(offset, length <=100) sans télécharger tout le Parquet. Le
[dataset OFF officiel](https://huggingface.co/datasets/openfoodfacts/product-database/blob/main/README.md)
déclare config default et split food. Premier essai conseillé : **20 lignes seulement**,
maximum 8 Mio, sans retry automatique, pour vérifier accès et schéma. Cette tranche
n'est pas un corpus représentatif de la France ou des six mots recherchés.

À copier dans le terminal SSH du VPS (aucun sudo, changement DNS ou service) :

```sh
(
set -euo pipefail
cd /home/codex/openGym
free -h
df -h /home/codex
mkdir -p scripts/nutrition-local-catalog/artifacts
CATALOG_SAMPLE_DIR=$(mktemp -d "$PWD/scripts/nutrition-local-catalog/artifacts/off-sample.XXXXXX")
CATALOG_SAMPLE_HTTP=$(curl --fail --silent --show-error --proto '=https' \
  --connect-timeout 10 --max-time 60 --max-filesize 8388608 \
  --user-agent 'openGym/1.4.1 (https://github.com/solhren/openGym)' \
  --get 'https://datasets-server.huggingface.co/rows' \
  --data-urlencode 'dataset=openfoodfacts/product-database' \
  --data-urlencode 'config=default' --data-urlencode 'split=food' \
  --data-urlencode 'offset=0' --data-urlencode 'length=20' \
  --dump-header "$CATALOG_SAMPLE_DIR/headers.txt" \
  --output "$CATALOG_SAMPLE_DIR/rows.part.json" --write-out '%{http_code}')
test "$CATALOG_SAMPLE_HTTP" = 200
python3 - "$CATALOG_SAMPLE_DIR/rows.part.json" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
if p.stat().st_size > 8388608:
    raise SystemExit('Sample exceeds 8 MiB')
data = json.loads(p.read_text(encoding='utf8'))
rows = data.get('rows') if isinstance(data, dict) else None
if not isinstance(rows, list) or not 1 <= len(rows) <= 20:
    raise SystemExit('Invalid or empty viewer response')
if data.get('partial') is True:
    raise SystemExit('Partial viewer response; preserve for inspection, do not import')
for item in rows:
    if not isinstance(item, dict) or not isinstance(item.get('row'), dict) or item.get('truncated_cells'):
        raise SystemExit('Invalid/truncated rows; do not import')
print('Viewer envelope OK:', len(rows), 'rows; product schema still needs review')
PY
mv "$CATALOG_SAMPLE_DIR/rows.part.json" "$CATALOG_SAMPLE_DIR/rows.json"
sha256sum "$CATALOG_SAMPLE_DIR/rows.json" > "$CATALOG_SAMPLE_DIR/SHA256SUMS"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$CATALOG_SAMPLE_DIR/retrieved-at.txt"
printf 'Sample saved in: %s\n' "$CATALOG_SAMPLE_DIR"
)
```

Un échec curl arrête le bloc avant publication du fichier final. Ne pas relancer en
boucle sur 401/403/429/503, ajouter de jeton à l'aveugle ou suivre d'autres domaines.
Le plafond est le maximum transféré accepté, pas la taille attendue. La capture
est conservée avec date, en-têtes et hash ; ils ne sont pas une signature d'authenticité
ni une preuve de révision Git du dataset. Sans révision fournisseur connue, réutiliser
le fichier capturé pour une importation reproductible, pas prétendre retrouver
exactement les mêmes lignes lors d'une nouvelle requête sur main.

**Ne pas donner rows.json directement au build.mjs** : enveloppe du viewer, pas
JSONL Product Opener. Préserver d'abord les types/features et contrôler la structure
réelle des noms et nutriments. Aucune conversion Parquet/viewer non vérifiée n'est
ajoutée tant qu'on n'a pas ce fichier. La petite capture débloquera ce contrôle ;
un échantillon représentatif limité sera ensuite défini selon pays, familles,
complétude et offsets distribués, avec budget explicite. Pas d'acquisition massive
par les endpoints OFF produit/recherche.

Pour un sous-ensemble OFF brut obtenu manuellement depuis une source officielle :
utiliser les commandes d'import précédentes, `--source off-jsonl`/`off-tsv`, une
version source documentée, le hash de son contenu décompressé et un workspace neuf.
Garder le fichier source et sa provenance ; ne jamais le décrire comme représentatif
simplement parce que son format est valide. Les plafonds 256 Mio/100k restent actifs.

### Worker Python dans Docker : analyse statique, pas intégration

L'image API actuelle `node:22-alpine` n'installe pas Python ; son contexte de build
est `./api`, donc les scripts sous `scripts/` et le normaliseur frontend ne sont pas
copiables hors contexte par un simple COPY. Docker n'est pas accessible à cette
session avec ses droits actuels. Aucun build d'image, changement Dockerfile/Compose
ou lancement de conteneur n'a été effectué pour cette revue.

Préparation recommandée après validation des données : cible/image de développement
séparée, Python3/SQLite/FTS5 vérifiés au build, copie du seul lecteur et de son futur
protocole stdio sous api/nutrition. Le script CLI actuel n'est pas encore un worker
persistant : il faut éviter un process et un hash complet par requête. L'importeur
JS reste un outil de préparation externe à l'API, avec ses sources frontend/core.

Supervision à tester isolément : processus Python persistant possédé par Node,
UID/GID lecteur dédiés, sans groupes supplémentaires, environnement minimal sans
secrets ; catalogue monté en lecture seule à un emplacement distinct de /data.
Pas de port public supplémentaire. Protocole JSONL borné avec identifiant de job,
queue/concurrence plafonnées, délais, validation des réponses et génération épinglée.
Démarrage : hash/intégrité puis état ready/version ; arrêt : SIGTERM, attente bornée,
SIGKILL du seul enfant si nécessaire ; échec : requêtes catalogue en erreur explicite,
redémarrage temporisé/plafonné, jamais arrêt ni mutation de la sync entraînements.
Logs techniques sans requêtes privées ou credentials. Limiter mémoire/CPU de cette
image de développement ; ne pas monter le volume de données personnelles pour les
essais. Le contrôle de disponibilité catalogue doit être distinct de celui des
comptes/entraînements, et un catalogue absent ne doit pas arrêter openGym.

Restent non validés : FTS5 dans l'image Alpine, taille/coût des paquets, protocole et
superviseur, limites effectives, compatibilité du worker avec le format Python des
hashes, essais Docker et données OFF réelles. Les simulations de reconstruction,
rollback, disque plein et SIGKILL du prototype sont celles déjà documentées ; elles
n'ont pas été relancées ici, conformément à l'arrêt demandé lorsque le réseau bloque.

### État de cette passe

Blocage réseau confirmé ; aucune mesure réelle nouvelle, aucun échantillon importé,
aucune modification applicative. Seule cette référence a été complétée pour la passe
réseau/Docker. La commande SSH est documentée mais son accès fournisseur ne peut pas
être validé dans cette sandbox. Arrêt en attente de l'échantillon conformément à la
consigne du propriétaire. Branche feature/nutrition, HEAD 6610d192, sans commit/push.


## Validation réelle et durcissement autonomes (2026-10-12, en cours)

La capture SSH `artifacts/off-sample.OPuy4R/rows.json` est désormais disponible :
251 815 octets, SHA-256
`7d340dbe507a5256c45efafc60f3cb8312910f748dd9bff6c9272a8cd14e5be5`.
Vingt lignes distinctes, indices 0..19, 111 champs, aucune cellule tronquée,
4 792 125 lignes annoncées par le fournisseur. Le schéma n'est pas le JSONL
Product Opener : noms localisés en listes `{lang,text}`, nutriments en listes
`{name,100g,serving,...}` avec flottants float32. La conversion est volontairement
spécifique à ce schéma et refuse ses évolutions incomprises. Les anciens constats
« réseau bloqué / pas de capture » ci-dessus décrivent les passes précédentes.

### Invariants supplémentaires

- Préserver les décimales reçues, sans arrondi de correction. `8.890000343322754`
  est une valeur float32 exportée ; SQLite la conserve. La canonicalisation réunit
  uniquement les flottants exactement entiers avec leurs équivalents JSON entiers.
- Les champs standardisés `100g`/`serving` utilisent les unités documentées par OFF :
  grammes pour les macros, kJ pour `energy`/`energy-kj`, kcal pour `energy-kcal`.
  Le champ `unit` décrit la saisie du contributeur et ne rééchelonne pas ces valeurs.
  [Schéma officiel](https://raw.githubusercontent.com/openfoodfacts/openfoodfacts-server/main/docs/api/ref/schemas/product_nutrition.yaml).
- Les suffixes absents/null ne créent aucun zéro ni fausse référence. Aucun repli
  sur `value`, préparé ou une estimation de fruits/légumes. Aucune densité inventée.
- Ce schéma simplifié ne contient pas les modificateurs `<`, `>` ni toutes les
  sources : avertissement `export-qualifiers-unavailable`. Son absence de qualificatif
  n'est pas une preuve de valeur exacte. Évaluer le JSONL complet avant un catalogue
  de production ; validation ponctuelle v3 possible, jamais collecte massive API.
- Les unités réelles testées ici sont seulement g ; 100 ml est couvert par fixtures,
  pas par ces vingt produits. Quatre noms français et quatre produits France, seize
  produits USA : aucune prétention de représentativité française.

### Classes de fiches et conservation prudente

Le mode strict initial conserve treize fiches : neuf avec les quatre macros et
quatre sans macros exploitables. « Complet » décrit la présence des valeurs, pas
leur exactitude : le pain de seigle possède un avertissement de qualité OFF conservé.
Les sept autres sont refusés pour nutrition incohérente : quatre erreurs de qualité
OFF explicites, trois portions impossibles refusées par le moteur existant.

`classifyHuggingFace()` distingue `complete`, `partial`, `unusable` ; une identité ou
structure dangereuse reste une erreur. L'option explicite
`--retain-unusable-nutrition` conserve l'identité de ces sept fiches, **en retirant
la totalité de leurs nutriments, références et portions**, avec `nutrition-rejected`
et le motif original dans le rapport. Cela ne corrige aucune donnée et ne relâche
aucun validateur. Une fiche sans référence n'est pas un aliment utilisable pour les
calculs utilisateur ; l'intégration future devra proposer une consultation v3 ou
une saisie personnelle explicite. Les données utilisateur v1 sont inchangées.

### Travaux de cette passe

- Correction du repli sur nom générique : auparavant `product_name: undefined`
  violait le contrat JSON ; le nom générique validé sert désormais de nom affichable.
- Relevance de recherche : nom exact, puis début du nom/préfixe, puis marque exacte,
  puis BM25 ; à pertinence comparable, nombre de macros disponibles puis présence
  d'un nom français. Pas de popularité inventée. Aucune migration SQLite nécessaire.
  Le cache de normalisation Unicode est borné à 4 096 chaînes et les requêtes
  conservent leur délai SQL de 150 ms. Son coût est à mesurer sur le même corpus.
- `worker.py` et `worker-client.mjs` : processus persistant réellement testé localement,
  catalogue en lecture seule, protocole v1 JSONL 4 Kio entrant / 256 Kio sortant,
  queue 16 + une requête active, délai 10 s, trois démarrages maximum par minute.
  Le manifeste est lu à chaque requête, le hash complet seulement au changement de
  génération ; une nouvelle génération corrompue ne se transforme pas en succès périmé.
  EOF pour arrêt propre puis SIGKILL après 500 ms ; aucune requête échouée rejouée.
  L'isolation d'UID et le montage Docker en lecture seule restent à valider : le mode
  SQL lecture seule ne constitue pas à lui seul une sandbox de processus.
- `sample.py` : plan sans réseau par défaut, acquisition explicite `--fetch`, domaine
  et endpoints HF fixes, 20 pages maximum, 100 lignes/page, 8 Mio/page et 32 Mio total,
  délai global CLI 600 s, aucun retry ni redirect. Capture des URLs/offsets/hash/date,
  arrêt sur 429/503/DNS/timeout et manifeste incomplet inspectable. Aucune tâche.
  Les offsets systématiques répartis évitent le seul préfixe de codes-barres, mais
  ne donnent ni échantillon aléatoire ni représentativité des achats français.

Les nouveaux tests et mesures seront inscrits ci-dessous après leur exécution.


### Détail des sept rejets initiaux

Les noms et codes-barres de ces sept lignes sont valides. Le rejet strict concerne
**les valeurs nutritionnelles**, pas une preuve de fausse identité.

| Code-barres | Produit | Champs responsables | Appréciation et récupération sûre |
|---|---|---|---|
| 0000105000011 | Chamomile Herbal Tea | `serving_size=1g`, glucides `serving=70`, kcal `serving=280` | Rejet légitime : 70 g de glucides pour 1 g. Identité seule récupérable, pas correction par facteur 100 supposé. |
| 0000105000059 | Linden Flowers Tea | portion 1,5 g, glucides 53,33000183105469 g, énergie 213,32000732421875 kcal | Rejet légitime : macros supérieures au poids de la portion. Identité seule récupérable. |
| 0000105000196 | Apple & Cinnamon Tea | erreur qualité énergie OFF, portion 1,5 g, glucides 60 g et protéines 66,66999816894531 g | Rejet légitime et indépendant de l'étiquette OFF. Identité seule. |
| 0000105000356 | Chamomile & Mint Herbal Tea | erreur qualité énergie OFF, kcal 0 et glucides 3,3299999237060547 g/100 g | Refuser les chiffres contradictoires est conservateur ; supprimer l'identité serait excessif. Impossible de choisir l'énergie ou les glucides vrais. |
| 0000105200923 | Kidney Health Herbal Tea | même erreur énergie, kcal 0 et glucides 3,3299999237060547 g/100 g | Même décision : identité conservable, nutrition à vérifier auprès de la source. |
| 0000105200961 | Herbal Tea, Senna Leaves | portion 1 g, glucides 100 g et kcal 400 par portion | Rejet légitime. Ne pas supposer que les valeurs étaient destinées à 100 g. |
| 0000111301201 | Canola Harvest Original Vegetable Oil Spread | erreurs OFF `nutrition-value-over-105-fat`, etc.; lipides 510 g et énergie 4 590 kcal/100 g | Rejet légitime. Les zéros d'autres macros ne suffisent pas à prouver une table fiable : identité seule. |

L'option de récupération conserve les vingt fiches : neuf complètes, zéro partielle,
onze sans nutrition exploitable (quatre déjà présentes et sept mises à l'écart).
Ce compte n'est pas une amélioration du taux de données fiables. Le rapport conserve
les sept erreurs originales, contrairement à un effacement silencieux de valeurs.

### Optimisation du classement et version du catalogue

La première implémentation du tri appelait une fonction Python de normalisation
Unicode pour tous les candidats : 89–99 ms moyens sur 50k fixtures, contre 24–28 ms
pour l'ancien tri moins pertinent. Elle n'est pas retenue pour les nouveaux imports.

Le **format de catalogue prototype v2** ajoute seulement trois colonnes dérivées
`name_fold`, `name_fr_fold`, `brand_fold`. Elles sont calculées à l'import puis
vérifiées lors de la reconstruction, couvertes par le hash du fichier, et vérifiées
pour chaque fiche retournée. Le tri s'exécute ensuite en SQL. Le lecteur reconnaît
v1 et v2, refuse les versions futures et permet rollback v2→v1. Une génération v1
reste immuable ; on reconstruit une nouvelle v2 au lieu de modifier l'ancienne.
**Aucun changement au contrat portable Nutrition utilisateur v1**. Le mode v1
utilise la fonction Python de repli et est moins rapide : rebuild conseillé avant
intégration si une génération v1 volumineuse subsiste.


### Acquisition reproductible du prochain échantillon

Les endpoints [rows](https://huggingface.co/docs/dataset-viewer/rows) et
[filter](https://huggingface.co/docs/dataset-viewer/filter) limitent chaque page à
100 lignes. Les filtres documentés concernent les colonnes scalaires : `lang='fr'`
est une cohorte linguistique, **pas** une preuve de disponibilité en France.
Les listes `countries_tags` sont contrôlées ensuite hors ligne. Ne pas inventer un
filtre LIKE/array-contains non documenté. Le classement HF n'est pas notre classement
SQLite ; ne pas sélectionner seulement les six noms de test comme corpus principal.

Commandes SSH exactes, depuis `/home/codex/openGym` (pas exécutées ici) :

```bash
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
# Premier sondage borné : au maximum cent produits francophones, pas un dump.
python3 scripts/nutrition-local-catalog/sample.py --total 100 --pages 1 --length 100 \
  --language fr --workspace off-fr-probe-100 --fetch
# Afficher le total réellement annoncé pour cette cohorte.
python3 -c 'import json;print(json.load(open("scripts/nutrition-local-catalog/artifacts/off-fr-probe-100/sample-manifest.json"))["totalRowsReported"])'
# Produire le plan SANS réseau avec le total ci-dessus (remplacer NOMBRE_OBSERVE).
python3 scripts/nutrition-local-catalog/sample.py --total NOMBRE_OBSERVE \
  --pages 20 --length 100 --language fr --workspace off-fr-diverse-2000
# Acquérir ce plan seulement après inspection : ajouter --fetch à la même commande.
# Conversion hors ligne, après succès complet du manifeste de capture :
node --max-old-space-size=128 scripts/nutrition-local-catalog/combine-sample.mjs \
  scripts/nutrition-local-catalog/artifacts/off-fr-diverse-2000/sample-manifest.json \
  scripts/nutrition-local-catalog/artifacts/off-fr-diverse-2000/products.jsonl \
  --retain-unusable-nutrition
# La commande précédente donne sourceVersion et jsonlSha256. Les utiliser pour :
nice -n 10 ionice -c 3 node --max-old-space-size=128 \
  scripts/nutrition-local-catalog/build.mjs \
  --input scripts/nutrition-local-catalog/artifacts/off-fr-diverse-2000/products.jsonl \
  --workspace off-fr-diverse-db --source off-jsonl --version VERSION_DU_RAPPORT
```

Le premier `--total 100` est un sondage d'offset zéro ; il ne prétend pas connaître
la taille de la cohorte. Pour plusieurs pages le total doit correspondre au total
actuel du fournisseur, sinon la capture s'arrête. Choisir un nouveau nom de workspace
pour toute relance : aucune capture existante n'est écrasée. Aucun retry automatique,
aucun contournement d'une erreur 401/403/429/503. Une capture interrompue reste
inspectable mais `combine-sample.mjs` refuse son manifeste incomplet. Il contrôle à
nouveau hashes, schéma, nombres, cellules tronquées, doublons d'indices et chemins,
traite une page à la fois et publie un JSONL exclusif après vérification complète.

En complément, une cohorte mondiale distribuée de même budget peut vérifier unités,
langues, produits liquides et nutrition manquante. Ne pas fusionner implicitement des
captures de totaux/schémas différents ; garder les cohortes et leurs rapports séparés.
Le plan représente au plus 2 000 lignes/32 Mio, vingt requêtes successives, une seule
connexion à la fois, 30 s par requête et watchdog global CLI de 600 s. Une page tronquée
n'est jamais réparée. Une indisponibilité de `/filter` doit être signalée, pas contournée.

Le viewer documenté n'offre pas de paramètre de révision dans `/rows`/`/filter`.
Date, ETag/Last-Modified si fournis, schéma, total et SHA-256 des octets sont conservés.
Même total et même schéma ne garantissent pas que main n'a pas changé pendant la
capture. La reproductibilité exacte est celle des fichiers retenus, pas celle d'un
nouveau téléchargement aux mêmes offsets. Vérifier une révision export immuable pour
l'import de production. Aucun échantillon supplémentaire n'a été téléchargé ici :
le contrôle local de création de socket UDP reçoit encore EPERM.

Après acquisition : mesurer la répartition France/autres pays, g/ml/ambigu, macros
complètes/partielles/inconnues, erreurs de qualité, marques et familles. Inclure des
produits réels connus pour les six recherches (jeu de pertinence ciblé séparé de la
cohorte distribuée). Deux mille lignes servent à valider la qualité/normalisation ;
elles ne prouvent pas les capacités d'hébergement de plusieurs millions de produits.

### Worker et image Docker de développement

`Dockerfile.worker` et son `.dockerignore` dédiés ne modifient ni `api/Dockerfile`,
ni Compose, ni routes. Contexte racine filtré : uniquement le lecteur, le superviseur
et leurs sources de validation ; données, captures, dépendances npm et secrets exclus.
L'image ajoute Python système uniquement, vérifie FTS5 au build, reste sans API/port.
Le normaliseur existant est chargé pour réutiliser `inspectExternal`/`CatalogError` :
quelques sources métier sont donc copiées, sans base ni données utilisateur. Extraire
ces deux utilitaires vers un module runtime-neutral sera un ajustement futur distinct.

Build et essai éphémère **à effectuer hors de cet environnement** :

```bash
docker build -f scripts/nutrition-local-catalog/Dockerfile.worker \
  -t opengym-catalog-worker-prototype .
docker run --rm --network none --read-only --cpus=1 --memory=192m --pids-limit=32 \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD/scripts/nutrition-local-catalog/artifacts/bench50k-ranking,dst=/app/scripts/nutrition-local-catalog/artifacts/trial,readonly" \
  opengym-catalog-worker-prototype
```

L'override UID/GID de développement permet la lecture des fichiers privés 0600/0700
créés par le même utilisateur, sans changer leurs permissions. La cible finale doit
avoir un UID/GID lecteur dédié et un catalogue publiable 0640/0750 pour ce seul groupe,
un montage distinct de `/data`, sans montage des données personnelles ni accès réseau
pour le worker. Aucun conteneur n'a été lancé, aucun paquet installé sur le VPS.
Les dépendances et FTS5 ont été testés sur Debian uniquement ; Alpine, coût d'image,
limites cgroup et signaux Docker restent non validés. Le superviseur Node gère crash,
file bornée, timeout, arrêt EOF/SIGKILL, réponses partielles et redémarrages limités.
Il échoue explicitement si la base manque, sans arrêter les fonctions entraînement.

### Reconstruction et récupération explicites

Le lecteur épingle la génération ouverte ; publication d'un manifeste et rollback
ne changent pas cette ancienne connexion. Le worker adopte une nouvelle génération
seulement après vérification complète du fichier et des métadonnées. Les tests couvrent
SIGKILL réel du writer, exceptions aux phases d'écriture/publication, disque plein
SQLite simulé, rejet d'une nouvelle génération corrompue et lecteurs actifs.
Ce ne sont pas des essais de coupure électrique ni de disque réellement saturé.

`rollback` exige une génération courante valide, et échange current/previous sous
verrou sans supprimer les fichiers. La revue a identifié qu'il ne suffisait pas
pour une base courante corrompue. `recover-previous`, ajouté séparément, exige une
intention explicite, un manifeste lisible et une ancre previous intégralement
vérifiée (hash, schéma, comptages et chaque fiche). Il publie cette ancre comme current,
retire seulement l'ancre corrompue du manifeste et conserve les deux fichiers.
Il refuse de deviner une génération à partir des noms du répertoire. Un manifeste
illisible ou un previous corrompu exige un reçu sauvegardé ou une reconstruction.

```bash
python3 scripts/nutrition-local-catalog/catalog.py --workspace NOM rollback
python3 scripts/nutrition-local-catalog/catalog.py --workspace NOM recover-previous
```

Les temporaires après SIGKILL ne sont jamais publiés : seul current.json fait autorité.
Le nettoyage des générations reste explicite et protège current/previous ; ne pas
ajouter un `rm *.sqlite` ni un nettoyage utilisateur. Pour les `.partial`/journaux,
l'opérateur doit prendre le verrou du writer et cibler uniquement des noms générés
orphelins du prototype. Aucun nettoyage automatique de temporaires n'est activé.


### Mesures finales de cette passe

Source des chiffres : `validation-results.json` (rapports complets),
`real-sample-validation.json` (mode strict) et
`real-sample-metadata-validation.json` (identités conservées). Les octets source
restent dans artifacts ignoré par Git. Les rapports de données réelles conservent
ODbL/DbCL, attribution et URL source ; pas d'images, auteurs individuels ni données
privées. Environnement Debian, Linux 6.12.57, 4 vCPU, Node 22.23.3,
Python 3.13.5, SQLite 3.46.1. RAM disponible contrôlée avant import : ~4,5 Gio,
disque ~50,7 Gio, aucun swap. Imports sous nice 10/ionice classe 3, sans toucher
aux priorités des autres processus. Le prélèvement RSS additionne les processus
Node/Python toutes les 25 ms (pages partagées comptées plusieurs fois).

| Mesure | Capture réelle limitée (20 identités, 9 nutritions complètes) | Fixtures synthétiques 50 000 |
|---|---:|---:|
| Taille SQLite v2 | 44 Kio | 25,33 Mio |
| FTS5 | 16 Kio | 5,17 Mio |
| Index code-barres | 4 Kio | 0,90 Mio |
| Import moteur + construction | 0,092 s | 28,046 s |
| Import enveloppe processus/mesure | 0,205 s | 28,138 s |
| CPU cumulé import | 0,205 s | 41,672 s (1,48 cœur en moyenne) |
| RSS arbre import observée | 79,68 Mio | 127,07 Mio |
| RSS writer Python maximale | 21,18 Mio | 32,07 Mio |
| Ouverture worker + hash | 70,64 ms | 93,27 ms |
| Recherche via worker (moyenne) | 0,67–2,11 ms | 32,08–36,43 ms |
| Recherche via worker (p95) | 0,88–3,15 ms | 35,38–49,37 ms |
| Code-barres via worker moyen / p95 | 0,39 / 0,46 ms | 0,62 / 0,81 ms |
| RSS arbre worker observée | 75,24 Mio | 80,30 Mio |

**La colonne réelle est un contrôle fonctionnel/startup, pas un benchmark
représentatif.** Elle n'a ni liquide réel ni les six produits français demandés.
Les recherches Nutella/Coca-Cola/lait/riz/pâtes/yaourt renvoient légitimement zéro.
`pâte`/`pate`, Bovetti, dinde, framboise et croissant trouvent les fiches attendues ;
les vingt codes-barres sont vérifiés, zéros initiaux conservés. Les quatre noms fr
restent des noms source, pas des traductions fabriquées. Le mode strict initial
avait 13 fiches/36 Kio et le mode enrichi garde seulement sept **identités** de plus.

Tri v2 SQL direct, 30 itérations chaudes/requête sur le corpus identique :
29,28–36,15 ms moyens, p95 31,24–45,56 ms, ~26,65 Mio RSS Python.
Le tri intermédiaire Python sur une génération v1 mesurait 88,73–99,25 ms moyens.
L'ancien benchmark historique du tri complétude/BM25 était ~24–28 ms : le nouveau
tri pertinent garde un coût modéré, pas une accélération revendiquée face à ce tri
plus simple. Ces runs ne sont pas une expérience de CPU exclusif sur le VPS ;
la variabilité système subsiste. Le délai SQL de 150 ms n'est pas relevé.

Quatre lecteurs Python séparés (80 requêtes, 20 itérations chacun, 50k fixtures) :
76,19 requêtes/s ouvertures incluses, p95 74,46 ms, max 91,97 ms,
45,25 Mio RSS total de ce processus à quatre threads. **Le superviseur livré utilise
un seul worker**, donc cela ne prouve pas ce débit pour l'API future : quatre demandes
simultanées dans sa queue prennent 0,192 s, la dernière ~192 ms. Timeout 10 s couvre
chargement/changement de génération ; deadline SQL 150 ms couvre le calcul d'une
requête, pas son attente dans la queue. Une queue pleine refuse proprement le travail.

Espace de reconstruction conservateur : current + previous + candidate + journal,
soit au plus ~4B, plus source, captures et marge. À 50k fixtures, ~124 Mio avec source,
hors autres générations volontairement conservées. À titre d'hypothèse seulement,
531 octets/produit donneraient ~507 Mio pour un million, avec >2 Gio transitoires :
**non validé, hors plafonds 100k/512 Mio de ce prototype**. Les noms, pays, diversité
de tokens et données OFF réelles peuvent changer fortement cette extrapolation.
Aucune conclusion d'hébergement de millions de produits sur ce VPS n'est acquise.

Commandes de mesure reproductibles (requêtes locales, aucun réseau) :

```bash
nice -n 10 python3 scripts/nutrition-local-catalog/benchmark.py \
  --workspace bench50k-ranking --iterations 30
nice -n 10 python3 scripts/nutrition-local-catalog/benchmark.py \
  --workspace bench50k-ranking --iterations 20 --readers 4
nice -n 10 python3 scripts/nutrition-local-catalog/measure.py \
  /home/codex/.local/opt/node22/bin/node --max-old-space-size=128 \
  scripts/nutrition-local-catalog/worker-benchmark.mjs bench50k-ranking 30
```

### Revue critique et intégration future

Passes fonctionnelle, concurrence/durabilité et sécurité/maintenance réalisées :

1. `undefined` après nom générique seul : correction au niveau projection.
2. Tables serving seules avec `_100g:null` : ne plus émettre la fausse référence qui
   masquait une portion impossible. Valeurs float32 conservées bit pour bit.
3. Rejet total de produits aux macros erronées : récupération facultative de l'identité
   sans chiffres, références ni portions ; jamais choix arbitraire entre deux macros.
4. Portion textuelle et `serving_quantity` contradictoires : contrôle croisé, tolérance
   numérique relative 1e-6 seulement pour la représentation. Les valeurs nutritionnelles
   ne sont pas arrondies. Types d'unités et nombres du schéma HF vérifiés.
5. Coût de normalisation à chaque tri : colonnes dérivées v2 et lecture/rollback v1.
6. Protocole Node : réponses nulles, poison keys, mauvaises IDs, surdimensionnées et
   fragmentées traitées sans exception non gérée ; buffers/queue/restarts plafonnés.
7. Fermeture SQLite de tests via context manager : ajout d'une fermeture effective
   (le context manager SQLite valide la transaction, il ne ferme pas la connexion).
8. Base courante corrompue : récupération explicite de previous vérifié, sans purge.
9. Capture distribuée avec population modifiée : arrêt plutôt qu'un faux échantillon
   complet ; URI fixes, redirects refusés, aucun retry, limites mémoire CLI 256 Mio.

Plan d'intégration après validation humaine des vrais échantillons et de Docker :

1. Conserver les scripts d'import hors runtime API et fixer un catalogue immutable
   avec attribution et métriques de qualité, monté indépendamment de `/data`.
2. Déplacer seulement lecteur/superviseur validés sous le contexte API ; ajouter
   Python système/FTS5 à une cible de développement avant toute image production.
3. Adapter les descripteurs à l'enveloppe de recherche existante (`count`, `products`
   OFF-shaped) via un adaptateur strict testé par le normaliseur frontend actuel.
   Les fiches `nutrition-rejected` ne devront jamais redevenir addables sans validation
   v3 ou saisie personnelle. Aucune route n'est modifiée dans cette passe.
4. Texte = local ; code-barres = local puis v3 seulement si absent/actualisation
   explicite. Cache public borné/déduplication, budgets OFF réservés aux appels réels.
   Aucun repli automatique massif vers la recherche distante actuellement 503.
5. Tester mode invité, sessions, snapshots immuables, sauvegardes et file offline ;
   la bibliothèque personnelle reste le stockage durable des produits utilisés.
6. Ajouter métriques worker non sensibles : version, requêtes, erreurs, queue, restart,
   temps ; disponibilité catalogue indépendante de la santé comptes/entraînements.

Mises à jour : le commandement wger est une référence de lecture progressive et de
compteurs, pas un protocole prouvé de continuité/suppression. Aucun code copié. Son
mode différentiel prend la première entrée de l'index ; openGym doit au contraire
valider une chaîne complète depuis le snapshot (date/révision/hash/curseur), acquitter
le curseur avec la publication de la génération, refuser les trous, changements de
schéma ou suppressions ambiguës. Une interruption prolongée ou deltas disparus exige
un nouvel export officiel autorisé. Les changements de pays retirent un produit du
catalogue filtré, jamais d'une consommation passée. Les suppressions nécessitent une
preuve source explicite : absence dans un delta n'est pas une suppression. Construire
les upserts/tombstones dans une copie candidate puis reconstruire FTS/vérifier/publier ;
rejouer le même lot ne doit pas dupliquer ni réécrire une génération déjà acquittée.
**Schéma réel des deltas/suppressions encore non confirmé ; adaptateur incrémental
non livré et aucune tâche automatique.** Une acquisition de dump complet reste soumise
à autorisation explicite avec budget current/previous/candidate/source et marge.

ODbL/DbCL : catalogue tiers techniquement séparé, attribution conservée, images non
importées. Une base dérivée publique peut imposer partage à l'identique et accès aux
données correspondantes ; les termes exacts d'une distribution combinée avec d'autres
catalogues doivent être examinés avant production. La séparation n'est pas une
certification juridique ; ce prototype n'établit aucune obligation de publier les
recettes privées ou journaux. Leur confidentialité reste un invariant technique.
Le packaging futur ne devra pas inclure le catalogue complet dans les sauvegardes
utilisateur. Sources officielles citées dans ce document, pas de code wger copié.


### Validation finale et commandes de tests

| Groupe | Commande | Résultat de la dernière exécution |
|---|---|---|
| Normalisation, HF, pipeline réel SQLite, conversions multi-pages, superviseur/packaging | `node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs` avec Node 22 dans PATH | **59 réussis**, 0 échec, 0 ignoré |
| SQLite, pertinence, atomicité, corruption, rollback, récupération, capture, protocole Python | `python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py' -v` | **55 réussis**, 0 échec, 0 ignoré |
| Régressions catalogue/interface actuelle | depuis frontend : `npm test -- --maxWorkers=2 src/lib/nutrition/catalog src/views/nutrition/FoodCatalog.test.jsx` | **130 réussis**, 7 fichiers, 0 échec, 0 ignoré (5,39 s) |
| Build frontend | depuis frontend : `npm run build` | Réussi (1,79 s), avertissements préexistants de chunks volumineux/imports dynamiques |

Résultats des relances non additionnés. Les fixtures des tests ne nécessitent aucun
accès Internet. Les assertions couvrent des vrais imports et requêtes SQLite,
vrais processus Python, SIGKILL, publications et reprises, et le chargement de la
fermeture de dépendances copiée selon le futur layout Docker. Ce dernier test utilise
**Debian**, pas une image Alpine ; aucun build Docker réussi n'est revendiqué.
Le client Docker 29.2.1 est présent mais le socket du daemon répond permission denied.
La capture distante supplémentaire reste impossible : création socket UDP EPERM.
Aucune requête HTTP fournisseur n'a été multipliée ou ignorée dans les suites.
Les suites frontend/API complètes ne sont pas relancées pour ce changement isolé
qui ne modifie pas de code applicatif ; les régressions ciblées et le build sont verts.

La dernière revue a aussi rendu explicite l'incertitude d'une table HF portant un
suffixe 100g sans référence ni unité de conditionnement connues : les macros restent
inconnues et `reference-required` est conservé. Aucun postulat « aliment solide »
ni densité n'est ajouté. Ce contrôle ne change pas les résultats des vingt produits.
L'état strict et l'état avec conservation d'identités ont été audités indépendamment,
avec les vingt codes-barres et les valeurs nutritionnelles relues dans SQLite.

Fichiers créés/complétés dans cette passe (préfixe scripts/nutrition-local-catalog) :

- `huggingface.mjs`, `huggingface.test.mjs` : enveloppe observée, noms/float32/unités,
  contrôles de portions, qualité, références ambiguës et conservation optionnelle.
- `audit-huggingface.mjs`, `real-sample-validation.json`,
  `real-sample-metadata-validation.json` : relecture réelle de chaque code et macro,
  résultats stricts et conservation des identités avec motifs originaux.
- `normalize.mjs`, `catalog.py`, `test_catalog.py`, `build.test.mjs` : règles partagées,
  diagnostics, tri v2 et compatibilité v1, récupération et tests pipeline.
- `sample.py`, `test_sample.py`, `combine-sample.mjs`, `combine-sample.test.mjs` :
  capture bornée, reprise manuelle par nouvelle capture, conversion hors ligne sûre.
- `worker.py`, `worker-client.mjs`, `worker.test.mjs`, `test_worker.py` : lecteur
  persistant, superviseur borné, arrêt/reprise, protocole et tests opérationnels.
- `worker-benchmark.mjs`, `validation-results.json` : mesures reproductibles et
  rapports séparant vrais produits limités et fixtures.
- `Dockerfile.worker`, `Dockerfile.worker.dockerignore` : image de développement
  indépendante, à construire/tester ultérieurement. Aucun Dockerfile de production modifié.
- Ce document : invariants, décisions, anomalies, mesures, licences, commandes,
  récupération, limites et plan d'intégration.

Les outils de génération de fixtures/import JSONL-TSV/mesure préexistants sont
conservés. Les fichiers générés SQLite/sources/captures restent sous artifacts ignoré.
Le dossier prototype et ce document sont encore non suivis dans Git, comme avant
cette passe ; aucun ajout à l'index, commit, push, déploiement ou tâche automatique.
Branche feature/nutrition, HEAD 6610d192. Les modifications applicatives préexistantes
de l'étape 4 sont conservées et ne font pas partie du diff de cette passe.

**Décision technique : prototype prêt pour revue isolée ; intégration non validée.**
Conditions restantes : capture réelle diversifiée avec liquides/portions/incomplets,
mesure de pertinence de six requêtes sur produits présents, comparaison de qualité
avec JSONL préservant les qualificatifs, essai Docker Alpine/cgroup/UID/GID, vérification
des deltas/suppressions si l'incrémental est demandé. Aucune opération utilisateur ni
route ne doit être migrée avant cette validation. Aucune prochaine étape lancée.

Contrôle final additionnel : les types/structures des nutriments sont vérifiés **avant**
la décision fondée sur un tag de qualité. Un tag OFF ne peut donc pas masquer une
structure malformée derrière le mode de récupération d'identité. Le test couvre ce
cas ; les comptes réels restent 13/7 en strict et 20/7 identités conservées. Les hashes
protègent de la corruption accidentelle, pas d'un tiers capable de remplacer à la
fois les fichiers et le manifeste : aucune signature d'authenticité n'est promise.
`git diff --check` est propre ; une inspection complémentaire des trente fichiers
prototype/document (non suivis, donc absents du diff Git normal) ne relève aucun
espace final. Les 34 fichiers applicatifs déjà modifiés au démarrage sont conservés.


## Intégration expérimentale : préparation, validations externes bloquées

La passe suivante conserve le worktree de l'étape 4. `sample.py` importe désormais
sys et distingue DNS, timeout, permissions réseau, connexion, TLS, réponse tronquée
et statuts HTTP. Les pages et le manifeste sont publiés par fichier temporaire fsync
puis lien exclusif : échec d'écriture ne crée aucune page finale partielle. Aucun retry.
Une seule tentative de capture de cent lignes fr a échoué `sample-dns-error`; son
manifeste incomplet est conservé dans off-fr-validation-20261012, sans page téléchargée.
Docker 29.2.1 refuse encore l'accès au daemon. Aucune nouvelle donnée réelle ou image
Docker validée : les travaux suivants sont du code/test indépendant de ces validations.

`api/nutrition/catalog-local.js` prépare un relais compatible avec les deux routes
existantes. Désactivé par défaut, activable seulement avec NODE_ENV=development,
NUTRITION_LOCAL_CATALOG=1, workspace explicitement choisi et DATA_DIR isolé hors /data.
Le chargement du worker est dynamique et n'est jamais nécessaire dans l'image API
production inchangée. Ce prototype exige un checkout complet ; la migration des
scripts dans le contexte API attend les validations de données et Docker.

Texte = SQLite uniquement ; indisponibilité = erreur locale explicite, sans repli
CGI ni faux délai quota. Code-barres = SQLite, puis le relais v3 existant si absent
ou indisponible. Staging reste séparé. Les origines/validations/limites HTTP existantes
restent en vigueur et le processus expérimental écoute seulement 127.0.0.1.
Les erreurs et logs ne contiennent ni requêtes, codes-barres, credentials ni données
personnelles. Le worker ne reçoit que requête publique/page ou code-barres.

L'extension read-only `product` du protocole worker associe fiche et hash de génération
en une seule lecture. `barcode` garde son ancien résultat : aucun inspect séparé
susceptible de courir avec une publication. L'adaptateur retourne count/products ou
status/product OFF-shaped. Les valeurs nulles restent absentes du tableau nutritionnel;
une référence rejetée ne peut pas produire Food. Les avertissements de qualité sont
validés puis conservés dans la provenance JSON des nouveaux aliments; le hash global
de génération n'entre pas dans l'identité Food, évitant les doublons à chaque rebuild.
Aucun changement du contrat utilisateur v1 ni des snapshots déjà enregistrés.
Les contrôles et tests complets de cette passe seront consignés après exécution.


### Revue de l'intégration expérimentale et dernières corrections

- sys.stderr : import sys corrigé et chemin CLI d'erreur testé dans un vrai processus.
- Réseau : erreurs DNS/timeout/permissions/connexion/TLS/HTTP séparées ; Content-Length
  tronqué détecté ; les codes ne dévoilent ni exception brute ni paramètres privés.
- Capture : écriture courte et ENOSPC simulés, fsync puis publication exclusive du
  fichier complet. Aucun retry ; une capture incomplète ne peut pas être importée.
- Superviseur : le délai 10 s inclut désormais l'attente dans la file. Un abort retire
  la demande en attente ; une lecture déjà envoyée est drainée avec son délai original,
  sans livrer de succès tardif ni casser le framing des autres requêtes. Le code conserve
  la file/restarts/mémoire bornés et n'interrompt aucun processus d'un autre service.
- Réponse v3 tardive après fermeture : rejet explicite ; un runtime Python absent ne
  plante pas les entraînements, seule la recherche locale est indisponible.
- Recherche française : le rejet des tokens à une lettre bloquait "pâte à tartiner"
  et "lait d'amande". Ils sont acceptés comme tokens AND littéraux dans une requête
  comprenant un mot d'au moins deux lettres ; "a b" et wildcards seuls restent refusés.
- Inspecteur API : contrôle des descripteurs/prototypes/symboles avant lecture, pas
  d'exécution de getter. Le relais remote valide toujours types/profondeur/taille.
- Nouvelle provenance : warnings validés conservés dans source.catalogueWarnings,
  génération exclue du hash Food. Anciens produits/snapshots inchangés ; une fiche
  nutrition-rejected reste sans Food. Aucun état de synchronisation transplanté.

Les tests de l'adaptateur appellent le vrai normaliseur frontend. Les nouveaux tests
HTTP utilisent vrais sockets/Python/SQLite et données synthétiques explicitement
isolées ; ils ne dépendent pas d'Internet et ne sont pas désactivés quand EPERM bloque.
Le test de serveur complet crée son propre DATA_DIR temporaire et vérifie que les
lectures anonymes ne changent pas db.json et ne désactivent pas l'auth Nutrition.

### Mesures réelles de l'adaptateur (sans HTTP)

`experimental-validation.json` contient les mesures du nouveau chemin sur la seule
capture réelle disponible : vingt produits, neuf tables macro complètes, onze fiches
sans nutrition exploitable. Bovetti, pâte à tartiner et dinde existent ; Nutella et
lait n'y existent pas. Les valeurs Bovetti restent 617 kcal/100 g et les sept fiches
récupérées ne deviennent pas ajoutables. Aucun appel fournisseur lors de ces mesures.
Trente répétitions par requête, démarrage froid inclus dans la première série ; RAM
arbre Node/Python échantillonnée à 25 ms. Les données restent non représentatives et
ce ne sont ni des latences HTTP ni un benchmark d'un grand corpus OFF.

### Commandes SSH : validation Docker isolée

Préparer des COPIES du catalogue public, sans modifier les permissions des sources.
Les copies 0444/0755 sont lisibles par l'UID non privilégié 65534 de l'image. Seuls
current.json et sa base publique vérifiée sont copiés, aucun fichier personnel.
Ces noms de lab doivent être neufs ; une destination existante est refusée.

```bash
cd /home/codex/openGym
python3 scripts/nutrition-local-catalog/docker-lab.py \
  --source off-real-20-metadata --name docker-catalog-valid
python3 scripts/nutrition-local-catalog/docker-lab.py \
  --source off-real-20-metadata --name docker-catalog-corrupt --corrupt
docker build -f scripts/nutrition-local-catalog/Dockerfile.worker \
  -t opengym-catalog-worker-prototype .
# UID/GID 65534 imposé, aucune exposition de port, aucun réseau, aucune donnée personnelle.
docker run --rm --network none --read-only --user 65534:65534 \
  --memory=192m --cpus=1 --pids-limit=32 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777 \
  --mount "type=bind,src=$PWD/scripts/nutrition-local-catalog/artifacts/docker-catalog-valid,dst=/app/scripts/nutrition-local-catalog/artifacts/trial,readonly" \
  opengym-catalog-worker-prototype \
  node scripts/nutrition-local-catalog/worker-smoke.mjs trial
# Absence de catalogue : erreur attendue, aucun montage.
docker run --rm --network none --read-only --user 65534:65534 \
  --memory=192m --cpus=1 --pids-limit=32 -e CATALOG_EXPECT_UNAVAILABLE=1 \
  opengym-catalog-worker-prototype \
  node scripts/nutrition-local-catalog/worker-smoke.mjs trial
# Corruption uniquement de la copie créée ci-dessus : erreur attendue.
docker run --rm --network none --read-only --user 65534:65534 \
  --memory=192m --cpus=1 --pids-limit=32 -e CATALOG_EXPECT_UNAVAILABLE=1 \
  --mount "type=bind,src=$PWD/scripts/nutrition-local-catalog/artifacts/docker-catalog-corrupt,dst=/app/scripts/nutrition-local-catalog/artifacts/trial,readonly" \
  opengym-catalog-worker-prototype \
  node scripts/nutrition-local-catalog/worker-smoke.mjs trial
```

Le smoke valide démarrage, quatre lectures simultanées, SIGKILL du seul enfant,
redémarrage et arrêt ; les unités injectent timeout, protocoles invalides et annulation.
Le smoke a passé sur Debian (20 fiches et absence), pas dans Docker. Le daemon refuse
l'accès dans cette session : **aucune image construite/contournement de droits**.
Mesurer l'image/permissions/cgroup et processus restants après les essais sur SSH.
Les copies peuvent être conservées pour diagnostic ; aucun nettoyage automatique.

### Commandes SSH : vrai échantillon et tests

Le nom off-fr-probe-100 contient déjà une tentative échouée ; ne pas l'écraser.
Le nom off-fr-validation-20261012 contient la tentative DNS de cette passe.

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
python3 scripts/nutrition-local-catalog/sample.py --total 100 --pages 1 \
  --length 100 --language fr --workspace off-fr-ssh-probe-100 --fetch
# Lire totalRowsReported du manifeste complet, puis préparer le plan distribué
# --total NOMBRE_OBSERVE --pages 20 --length 100 --language fr avec un NOUVEAU workspace.
# Les commandes combine-sample.mjs/build.mjs de la section précédente s'appliquent.
node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs
python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py' -v
cd api
node --test test/catalog-local-http.test.js test/server-local-catalog.test.js \
  test/food-catalog-http.test.js test/server-food-catalog.test.js \
  test/nutrition-http.test.js test/server-nutrition.test.js test/sync-stamps.test.js
npm test
cd ../frontend
npm test -- --maxWorkers=2
node scripts/check-locales.mjs
npm run build
```

Ne pas concaténer jobs.test.js et coach-limits.test.js en mode no-isolation : ils
fixent DATA_DIR au chargement de module et nécessitent les processus séparés prévus
par le script npm. Les relances diagnostiques ne sont pas ajoutées aux compteurs.

### Commandes navigateur : source checkout expérimental, pas production

Après examen des limitations et des résultats SSH, deux terminaux VPS. Nouveau port
frontend 5174 pour garder séparés IndexedDB/localStorage du test antérieur en 5173.
**DATA_DIR doit être un nouveau répertoire temporaire**, jamais celui de production.

Terminal API :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
CATALOG_PERSONAL_LAB=$(mktemp -d /tmp/opengym-catalog-api.XXXXXX)
NODE_ENV=development DATA_DIR="$CATALOG_PERSONAL_LAB" PORT=3002 \
  ORIGIN=http://localhost:8080 NUTRITION_LOCAL_CATALOG=1 \
  NUTRITION_LOCAL_CATALOG_WORKSPACE=off-real-20-metadata \
  node api/server.js
```

Terminal Vite :

```bash
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
API_TARGET=http://127.0.0.1:3002 API_ORIGIN=http://localhost:8080 \
  npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Terminal sur l'ordinateur :

```bash
ssh -N -L 5174:127.0.0.1:5174 VOTRE_UTILISATEUR@VOTRE_VPS
```

Ouvrir http://localhost:5174, Continuer sans compte, Nutrition, catalogue, rechercher
Bovetti ou "pâte à tartiner", choisir une quantité et ajouter au journal de ce lab.
Les totaux doivent utiliser 617 kcal/100 g. Rechercher le code 0000105000011 : fiche
identitaire affichable, pas d'ajout faute de nutrition. Chercher 3017620422003 : absent
des vingt fiches, une seule consultation v3 explicite (réseau VPS requis). Tester langue,
refus de valeur/unité invalide, offline, rechargement, compte et source/licences.
Nutella par texte renvoie zéro dans ce minuscule corpus : ce n'est pas une panne.

Vérification curl dans le terminal VPS, backend démarré :

```bash
curl -i --get 'http://127.0.0.1:3002/api/nutrition/catalog/search' \
  --data-urlencode 'q=pâte à tartiner' --data-urlencode 'lc=fr'
curl -i 'http://127.0.0.1:3002/api/nutrition/catalog/product?code=0000101209159'
```

Réponse source local-sqlite et hash de génération dans les en-têtes. Pour revenir au
comportement précédent : arrêter seulement ce Node de laboratoire (Ctrl-C), relancer
la même commande avec NUTRITION_LOCAL_CATALOG=0, même DATA_DIR de lab si souhaité.
Aucune suppression de données, aucun changement Docker/production. Le mode distant
précédent peut toujours recevoir le CGI OFF 503 : rollback ne garantit pas la santé
OFF. NODE_ENV=production refuse le mode local même si le flag vaut 1. Activer la
production nécessitera une décision et un packaging distincts, hors de cette passe.

### Résultats des dernières exécutions et limites

- Prototype Node : 60 réussis, 0 échec, 0 ignoré (dont vrai worker et packaging).
- Prototype Python : 63 réussis, 0 échec, 0 ignoré (capture/clone/corruption inclus).
- API ciblée : 169 réussis, 0 échec, 0 ignoré. Commande depuis racine :
  `node --test --experimental-test-isolation=none api/test/catalog-local.test.js api/test/food-catalog.test.js api/test/nutrition-packaging.test.js api/test/nutrition-protocol.test.js api/test/nutrition-store.test.js api/test/nutrition-files.test.js api/test/nutrition-backup-history.test.js api/test/queue.test.js`.
- Frontend ciblé : 133 réussis sur 7 fichiers, 0 échec/ignoré, commande catalogue/UI
  précédente. Contrôle direct locales : 18 langues, 2 464 clés chacune, cohérentes.
- Frontend complet tenté avant les deux derniers tests de normalisation : 5 773
  réussis, 7 échecs sur 437 fichiers, aucun ignoré. Les sept échecs sont exactement
  `spawnSync Node EPERM` dans check-locales.test.mjs ; vérificateur direct réussi.
- API complète via npm test : 84 groupes de fichiers, 43 réussis, 41 échoués, aucun
  ignoré. Ce runner sandbox rapporte des groupes de fichiers, pas 84 cas unitaires.
  Écoutes/HTTP bloqués ; certains tests Coach attendent ready et obtiennent failed,
  à confirmer hors sandbox. Ne pas déclarer tous ces échecs corrigés ou attribués
  uniquement au réseau. Ils ne motivent pas de changement du Coach hors périmètre.
- Nouveaux tests HTTP : cinq tests de route et trois du vrai serveur échouent au
  setup sur listen EPERM. Aucun test désactivé. Commandes SSH données ci-dessus.
- Build frontend réussi, avertissements préexistants de chunks/imports dynamiques.
  Suites complètes non vertes : aucune validation globale revendiquée.

Aucun navigateur réel ni appareil testé dans cette passe. Compatibilité web/mobile
préparée par les mêmes contrats/transports ; backend expérimental lié à loopback,
accès téléphone nécessitant un tunnel/proxy de développement approprié. Aucun changement
au fonctionnement des synchronisations/sauvegardes privées, aucune migration du v1.

Fichiers applicatifs de cette passe : api/server.js, api/nutrition/catalog-local.js,
api/nutrition/food-catalog.js, leurs nouveaux tests catalog-local/server-local et le
contrôle packaging ; frontend catalogue normalize.js/client.js et leurs tests.
Fichiers prototype : sample.py/test_sample.py, worker.py/worker-client.mjs/worker.test.mjs,
catalog.py/test_catalog.py, Dockerfile.worker et ignore dédié, worker-smoke.mjs,
experimental-benchmark.mjs, docker-lab.py/test_docker_lab.py, experimental-validation.json.
Les documents catalogue/prototype sont actualisés ; tous les changements antérieurs
sont conservés. Aucun commit/push/déploiement/configuration de production modifiée.

**Statut : intégration expérimentale préparée et désactivée, validation externe
encore bloquée.** Avant toute activation définitive : vrai corpus diversifié (liquides,
France, marques, incomplets), Docker Alpine/UID/cgroup/arrêt, suites complètes SSH vertes,
Firefox et parcours ajout/snapshots/offline, puis revue humaine du packaging production.


Le checkout API de développement lance Python avec le même UID que Node : limitation
explicite, ce n'est pas une isolation OS du lecteur par rapport aux fichiers du parent.
Son interface et ses chemins sont bornés/read-only ; le Docker de test n'expose que la
copie publique et utilise UID 65534. Un worker de production devra avoir un UID/GID
lecteur distinct ou une isolation équivalente avant accès aux données réelles.
`git diff --check` et inspection des nouveaux fichiers n'ont relevé aucune erreur
d'espacement. Branche feature/nutrition, HEAD 6610d192, aucun fichier indexé. Le worktree
reste volontairement modifié, avec tous les changements de l'étape 4 préservés.

## Recherche dynamique et tolérance orthographique

La demande suivante autorise des imports bornés mais impose une réserve de 20 Gio
libres. Le contrôle `resources()` applique désormais cette réserve aux imports et
captures. Les plafonds existants (100 000 lignes, base 512 Mio) restent en place :
ils ne constituent pas un importateur dimensionné pour le catalogue entier.
Préflight Codex : 54 458 396 672 octets libres, 3 950 Mio disponibles, 4 CPU, aucun
swap. Les processus des autres services ne sont pas visibles dans cet espace PID ;
leur absence dans `ps` ne prouve rien. HEAD vers le JSONL officiel : échec DNS curl 6.
La taille actuelle des exports et le coût de deux générations réelles restent inconnus.
Aucun téléchargement complet n'est lancé et aucune activation n'est effectuée.

Décision recherche : conserver FTS5/BM25 et les préfixes, puis utiliser une table
inversée de trigrammes du vocabulaire, uniquement après zéro résultat littéral.
FTS5 `tokenize=trigram` seul réalise des sous-chaînes, pas une correction de fautes.
Le calcul OSA Damerau-Levenshtein ne porte jamais sur tous les produits : au plus
128 candidats par terme, 256 entrées par trigramme, trois alternatives par terme,
seize expressions FTS, et le budget partagé de 150 ms. Termes de moins de quatre
caractères : aucune correction ; quatre à six : une édition ; sept et plus : deux.
Les formes jointes de deux tokens permettent `cocacola` → `coca cola`. Les noms,
marques et accents suivent la normalisation commune. Aucun score de popularité.
Le plafonnement des candidats implique une limite de rappel documentée.

Le schéma **catalogue** v3 ajoute `search_terms` et `search_grams`. Les lecteurs
continuent de lire v1/v2 et le rollback peut revenir à ces générations, sans fuzzy.
Le contrat personnel portable Nutrition v1 reste intégralement inchangé.
Le nouveau module utilise uniquement la bibliothèque standard Python/SQLite.

Côté UI, la recherche dynamique ne sera activée que par une capacité serveur
explicite, jamais en sondant OFF avec les frappes. Le mode distant garde son bouton
Search. La combobox suivra la sélection manuelle APG : focus dans le champ,
`aria-activedescendant`, flèches/Entrée/Échap, aucune sélection à la sortie du champ,
respect du clavier d'édition et de la composition IME. Temporisation initiale
300 ms, réglable ultérieurement sur des mesures humaines ; ce n'est pas une valeur
prescrite par WAI-ARIA. Tests et mesures à compléter avant conclusion.

### Résultats de la recherche v3 et revue (2026-10-12)

Schéma catalogue v3 : table `search_terms(term,expansion)` WITHOUT ROWID et table
`search_grams(gram,length,term)` WITHOUT ROWID. La clé gram/length évite de filtrer
la longueur par un scan du vocabulaire entier. `fts5vocab` fournit les termes ; les
paires de mots adjacents fournissent uniquement des alias de séparateurs (pas de
synonymes inventés). Construction progressive, contrôles de ressources toutes les
500 entrées aussi pendant l'indexation, et avant publication. Les générations v1/v2
restent lisibles ; v2 ne prétend pas fournir de correction. Les champs produit et
les données personnelles sont inchangés. Le protocole worker v1 accepte en plus
`language` optionnel ; ancien appel inchangé avec défaut fr. La préférence d'un nom
français s'applique uniquement pour `lc=fr`, sans prétendre gérer toutes les langues.

Classement : résultat littéral/exact prioritaire (aucune expansion si FTS trouve des
résultats). En fallback, coût d'édition minimal des expansions, puis pertinence du
nom/préfixe/marque, nombre de macros connues, langue française si demandée, BM25
pondéré nom 4 / nom français 6 / marque 2 et code-barres comme départage stable.
Le calcul de distance porte sur les termes candidats ; les produits trouvés par
FTS ne subissent pas de distance de chaîne. Budget total SQL+Python 150 ms : l'échec
est explicite, jamais un succès partiel. Pagination maximum 20 × 20 résultats.

Comparaison des techniques : FTS5/BM25 traite les mots et la fréquence documentaire,
préfixes pour la saisie partielle ; un tokenizer trigram FTS5 complet traiterait les
sous-chaînes mais n'est pas un correcteur. Le vocabulaire/trigrammes puis OSA apporte
un fallback borné, avec moins de duplication des textes complets. OSA supporte une
transposition adjacente mais n'est pas la distance Damerau non restreinte. Les termes
courts et les fautes sans trigramme commun ne sont pas corrigés. La limite de
postings peut manquer un terme pourtant correct : rappel à mesurer sur vrai catalogue.
Pas de popularité inventée ni de distance sur toute la base.

Mesures reproductibles : Python 3.13.5 / SQLite 3.46.1 / Node 22.23.3, Debian kernel
6.12.57, 4 CPU ; caches chauds, 30 répétitions par requête, même fichier source
`fixture-50000.jsonl` pour les générations v2 et v3. Aucun chiffre n'est un temps
Firefox, réseau OFF, ni une projection validée pour cinq millions de produits.

| Requête synthétique | v2 moyenne/p95 ms | v3 moyenne/p95 ms | Résultats v2 → v3 |
|---|---:|---:|---:|
| Nutella | 31,99 / 33,85 | 31,63 / 35,17 | 8 334 → 8 334 |
| nutela | 0,23 / 0,31 | 52,35 / 62,42 | 0 → 8 334 |
| cocacola | 0,25 / 0,29 | 59,05 / 69,61 | 0 → 8 334 |
| pate tartiner | 35,60 / 38,01 | 36,44 / 45,20 | 8 334 → 8 334 |
| yaort | 0,23 / 0,29 | 51,98 / 61,46 | 0 → 8 333 |
| pate tartinre | 0,25 / 0,30 | 63,37 / 73,56 | 0 → 8 334 |

La fixture 50k contient six familles répétées, donc ni lait d'amande ni chocolat
noir : leurs réponses vides ne valident pas le rappel. Les six exemples demandés
sont tous vérifiés dans le corpus unitaire explicitement synthétique qui les contient.
La capture réelle contient la pâte Bovetti chocolat noir, mais pas Nutella/Coca-Cola/
yaourt/lait d'amande. `boveti` : 0,62 / 0,74 ms et un résultat ; `pate tartinre` :
0,75 / 0,84 ms et un résultat ; chocolat noir : 0,37 / 0,45 ms, un résultat.
Les autres requêtes absentes ne font apparaître aucun faux produit.

Base synthétique 50k : 26 562 560 octets (25,33 Mio), FTS 5 419 008,
trigrammes 1 527 808, termes 360 448, index codes-barres 942 080. Les deux générations
ont ici la même taille physique parce que v2 avait 483 pages libres et v3 n'en a
plus que 22 : les nouveaux index consomment l'espace libre, ils ne sont pas gratuits.
16 702 termes et 73 076 postings. Import v3 36,61 s (50,40 s CPU arbre, environ
1,37 cœur moyen), pic RSS arbre échantillonné 130,16 Mio ; Node 98,45 Mio maximum,
Python 32,21 Mio. RSS lecteur v3 25,36 Mio. L'import ancien mesuré précédemment
28,05 s n'est pas une comparaison de charge parfaitement contrôlée ; la construction
du dictionnaire est un coût supplémentaire d'environ 8 s dans la phase d'indexation.
Quatre lecteurs, 80 recherches littérales : 45,51 requêtes/s incluant ouverture,
moyenne 81,43 ms, p95 108,31 ms, maximum 132,10 ms, RSS processus 45,09 Mio.
Ce sont des lecteurs Python, pas quatre workers HTTP ni une preuve de charge maximale.

Vraies données : nouvel espace `off-real-20-fuzzy-v3`, **20 identités seulement**,
9 avec quatre macros, 0 partielles, 11 sans nutrition exploitable, 4 noms français.
Audit des vingt codes-barres et égalité des floats avec la capture d'origine réussi.
Bovetti conserve 617 kcal / 100 g ; les sept fiches incohérentes conservent uniquement
leur identité et restent non ajoutables. Aucun ml réel dans cette capture.
Base 69 632 octets (68 Kio), FTS 16 Kio, trigrammes 20 Kio, termes 4 Kio,
index barcode 4 Kio ; 97 termes / 669 postings. Import 0,153 s, CPU Node 0,055 s,
Python 0,097 s, RSS Node 59,4 Mio / Python 21,4 Mio (maximums séparés).
Adaptateur API + normalisation réelle, sans socket : Bovetti moyenne 2,81 ms,
p95 2,51 ms incluant démarrage à froid dans la série ; aucun appel fournisseur.
Ces petits nombres **ne sont pas un benchmark représentatif**.

Rapports JSON dans `scripts/nutrition-local-catalog/` : `fuzzy-import-synthetic`,
`fuzzy-import-real`, `fuzzy-benchmark-before`, `fuzzy-benchmark-synthetic`,
`fuzzy-benchmark-real`, `fuzzy-concurrency-synthetic`, `fuzzy-api-real`,
`fuzzy-audit-real`, `preflight-validation`. Les générations/artifacts sont locaux et
ignorés par Git ; aucun ancien catalogue n'est remplacé ou supprimé.

Défauts corrigés pendant les trois revues : ancien `finally` libérant le verrou d'une
requête plus récente ; rollback changeant implicitement une suggestion locale en
appel OFF ; copie Docker de test oubliant le nouveau `fuzzy.py` (test initial échoué,
copie corrigée) ; seuil disque antérieur de 1 Gio ; budget non recontrôlé pendant
l'indexation ; préférence française appliquée aussi aux autres langues ; recherche
explicite/pagination masquée lorsque le bouton avait pris le focus. Les sorties
unittest temporaires doivent être sur le volume disque, pas `/tmp` tmpfs de 3,8 Gio,
pour tester le véritable garde-fou de 20 Gio sans le désactiver.

### Obtenir les données manquantes depuis SSH — sans dump complet

Préflight lecture seule ; un HEAD par export, sans retry ni redirection. Le rapport
contient taille HTTP, type, ETag, date, Accept-Ranges et Digest éventuel. Une page HTML
200 n'est pas traitée comme un export. Aucun fichier catalogue téléchargé par ce script.

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
python3 scripts/nutrition-local-catalog/preflight.py --head jsonl
python3 scripts/nutrition-local-catalog/preflight.py --head tsv
free -m
df -B1 /home/codex/openGym
ps -eo comm,rss,pcpu --sort=-rss | head -20
docker stats --no-stream
```

Ne pas déduire un checksum SHA-256 d'un ETag. Si le fournisseur fournit un Digest ou
un fichier SHA-256, vérifier l'algorithme et son application aux octets téléchargés.
Sinon SHA-256 local + taille + `gzip -t`/EOF/CRC complet détectent les corruptions
accidentelles sans prouver l'authenticité. Reprise future seulement si Accept-Ranges
et ETag/Last-Modified stable vérifiés : requête Range avec If-Range, vérifier 206 et
Content-Range, ne pas concaténer un 200 ni des versions quotidiennes différentes.
Cette reprise de dump n'est **pas encore implémentée**, aucun téléchargement complet
n'étant dimensionné. Les captures HF sont unitaires, pas reprises en boucle.

Échantillon français distribué : 100 lignes pour connaître la population puis
maximum 2 000 lignes, 32 Mio, dix minutes. `lang=fr` est une langue déclarée, **pas**
la disponibilité France ni la popularité. Faire séparément le même échantillon global
sans `--language fr` pour comparer liquides/importations/marques/incomplets. Captures
exclusives conservées avec paramètres, checksums, indices et date ; HF `main` est
mutable et son API Viewer ne garantit pas une révision figée. Pas de contournement.

```bash
set -e
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
CATALOG_FR_PROBE="fr-probe-$(date -u +%Y%m%dT%H%M%S)"
python3 scripts/nutrition-local-catalog/sample.py --total 100 --pages 1 --length 100 \
  --language fr --workspace "$CATALOG_FR_PROBE" --fetch
CATALOG_FR_POPULATION=$(node --input-type=module -e 'import fs from "node:fs"; const m=JSON.parse(fs.readFileSync(process.argv[1])); if(!m.complete||!Number.isSafeInteger(m.totalRowsReported)) process.exit(1); process.stdout.write(String(m.totalRowsReported));' \
  "scripts/nutrition-local-catalog/artifacts/$CATALOG_FR_PROBE/sample-manifest.json")
CATALOG_FR_SAMPLE="fr-sample-$(date -u +%Y%m%dT%H%M%S)"
python3 scripts/nutrition-local-catalog/sample.py --total "$CATALOG_FR_POPULATION" \
  --pages 20 --length 100 --language fr --workspace "$CATALOG_FR_SAMPLE" --fetch
node scripts/nutrition-local-catalog/combine-sample.mjs \
  "scripts/nutrition-local-catalog/artifacts/$CATALOG_FR_SAMPLE/sample-manifest.json" \
  "scripts/nutrition-local-catalog/artifacts/$CATALOG_FR_SAMPLE/products.jsonl" --retain-unusable-nutrition
CATALOG_FR_BUILD="fr-build-$(date -u +%Y%m%dT%H%M%S)"
python3 scripts/nutrition-local-catalog/measure.py node --max-old-space-size=128 \
  scripts/nutrition-local-catalog/build.mjs \
  --input "scripts/nutrition-local-catalog/artifacts/$CATALOG_FR_SAMPLE/products.jsonl" \
  --workspace "$CATALOG_FR_BUILD" --source off-jsonl --version "$CATALOG_FR_SAMPLE" --skip-invalid
python3 scripts/nutrition-local-catalog/fuzzy-benchmark.py --workspace "$CATALOG_FR_BUILD" --iterations 30
```

Ces 2 000–4 000 fiches seront un contrôle qualitatif plus diversifié, pas une preuve
suffisante de charge de millions de fiches. Il faut ensuite un extrait brut JSONL
officiel nettement plus large et représentatif, fourni ou obtenu par une méthode
bornée convenue. TSV est moins riche pour langues/qualificatifs/unités ; JSONL brut
reste préféré pour le catalogue final. HF simplifie les floats/qualificatifs : les
avertissements du convertisseur restent nécessaires. Aucun prélèvement produit par
produit, scraping ou tentative répétée n'est proposé.

### Dimensionnement conditionnel et import complet non réalisé

Réserve effective 20 Gio (plus stricte que 20 Go décimaux), environ 50,7 Gio libres
au préflight, soit environ 30,7 Gio utilisables. RAM disponible environ 3,9 Gio sans
swap, import limité Node 128 Mio de heap et Python 256 Mio d'espace virtuel, pic réel
synthétique 130 Mio. Cette mémoire ne valide pas encore l'indexation de millions de
termes distincts, ni la charge des autres services invisibles dans la sandbox.

Plan conservateur : source compressée + **trois générations** (current, previous,
candidate) + journal/temp d'index + marge. Pas de décompression entière sur disque.
Avec cinq millions de produits hypothétiques, 2 000 octets/base/produit, source
hypothétique 5 Gio et temp 2 Gio, le budget dépasse la marge ; avec 1 000 octets il
peut tenir arithmétiquement. **Aucune de ces hypothèses n'est une taille réelle OFF.**
Les coûts 531 octets/produit synthétique et 3 482 octets/produit sur seulement vingt
lignes ne sont pas extrapolables (vocabulaire répétitif et pages fixes respectivement).

Le script calcule une projection, jamais une autorisation :

```bash
python3 scripts/nutrition-local-catalog/preflight.py \
  --compressed-bytes 5368709120 --products 5000000 \
  --db-bytes-per-product 2000 --temporary-bytes 2147483648
```

Bloquants avant catalogue entier : taille courante HEAD, échantillon brut représentatif,
mesures vocabulaire/FTS/fuzzy/journal, tests charge/lecteurs/quotas, puis évolution
explicite des plafonds actuellement **100k lignes / 256 Mio source / 512 Mio base**.
Le filtre France ne suffit pas : il faut scanner le dump global, qui dépasse aussi
le plafond de lignes scannées. Ne pas relever aveuglément les limites. Choix prudent
si budget insuffisant : catalogue ciblé avec méthode de source officielle validée,
ou acquisition progressive, sans suppression d'anciens fichiers pour faire de la place.
Aucun téléchargement complet, aucun catalogue publié dans l'application.

### Actualisations

La commande wger étudiée importe le JSONL et le dernier fichier de l'index delta.
Ce n'est pas une preuve de continuité complète après une longue interruption ni de
sémantique des suppressions. Le service officiel d'exports indique encore une
migration en cours des différences quotidiennes. Aucun code wger copié.

Pour l'avenir : index des deltas versionné/checksummé, séquence contiguë depuis le
curseur d'une génération, upserts et suppressions explicites appliqués à une copie,
validation intégrité/index/recherches, manifeste atomique avec ancre précédente.
Absence dans un delta ≠ suppression. Trou de séquence, suppression ambiguë ou schéma
inconnu : suspendre l'incrémental, garder l'ancienne génération, reconstruire sur un
export complet validé. Aucun cron, delta automatique ou purge automatique ajouté.
Les sauvegardes personnelles n'incluent jamais cette base reconstructible. Attribution
OFF/ODbL/DbCL conservée ; séparation technique du catalogue public et des données
personnelles, pas de promesse juridique sur une diffusion future d'une base dérivée.

Dernier durcissement ressources : `resources()` exige désormais **2 Gio de RAM
disponible** aux points de contrôle (ancien seuil 512 Mio) et 20 Gio disque. Ce n'est
pas une réservation contre les autres processus, mais l'import s'arrête si la
marge tombe sous ces seuils. Ces contrôles couvrent ingestion, vocabulaire, index et
publication. Les essais préflight testent aussi une page HTML 200 pour ne pas
confondre la taille d'un challenge avec celle d'une archive officielle.

### Validation et exploitation manuelle de cette passe

Commandes reproductibles (Node 22 local, aucune installation) :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
mkdir -p scripts/nutrition-local-catalog/artifacts/test-tmp
TMPDIR="$PWD/scripts/nutrition-local-catalog/artifacts/test-tmp" \
  python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py' -q
node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs
npm --prefix frontend test -- --maxWorkers=2 src/lib/nutrition/catalog src/views/nutrition/FoodCatalog.test.jsx
node --test --experimental-test-isolation=none \
  api/test/catalog-local.test.js api/test/food-catalog.test.js \
  api/test/openapi-routes.test.js api/test/nutrition-packaging.test.js \
  api/test/nutrition-protocol.test.js api/test/nutrition-store.test.js \
  api/test/nutrition-files.test.js api/test/nutrition-backup-history.test.js api/test/queue.test.js
npm --prefix frontend test -- --maxWorkers=2
npm --prefix api test
node frontend/scripts/check-locales.mjs
npm --prefix frontend run build
VITE_MOBILE=1 npm --prefix frontend run build
git diff --check
```

Le deuxième build compile le web mobile ; il **ne lance pas** cap sync, ne construit
pas Android/iOS et n'exécute pas un téléphone. Aucun changement natif de cette passe.
Les commandes avec `--experimental-test-isolation=none` sont des exécutions ciblées,
pas une désactivation de cas de test ; ne pas regrouper les suites Coach qui ont
un DATA_DIR global dans un seul processus. Le runner API normal est exécuté aussi.

Résultats ciblés après corrections : Python 81 cas ; Node prototype 60 ; frontend
catalogue/Journal/bridge 154 cas sur huit fichiers ; API catalogue/persistance/queue/
packaging/openapi 175 cas. Tous réussis, zéro ignoré. Audit réel vingt codes-barres
réussi, smoke Debian worker v3/redémarrage réussi. Locales 18 × 2 464 clés cohérentes.
Builds web et web mobile réussis, avertissements préexistants chunks/import scan.
Les chiffres des suites complètes sont consignés séparément ci-dessous ; ne pas
les additionner aux ciblées qui réexécutent les mêmes tests.

Dans la sandbox, les neuf tests HTTP `catalog-local-http`/`server-local-catalog`
échouent tous au setup `listen EPERM 127.0.0.1`. Aucun test n'est ignoré. Sur SSH :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
node --test api/test/catalog-local-http.test.js api/test/server-local-catalog.test.js
npm --prefix api test
npm --prefix frontend test -- --maxWorkers=2
```

Le runner API complet rapporte **85 groupes de fichiers**, 43 réussis / 42 échoués,
zéro ignoré ; ce n'est pas un compte de cas comparable aux 175 ciblés. Le reporter
isolé ne donne pas le détail interne de chaque fichier échoué. Diagnostic séparé
Coach limits : 5 réussites / 4 assertions échouées (`failed` au lieu de `ready` ou
`nochange`). Un appel isolé à l'adaptateur de processus existant avec un enfant Node
qui doit écrire `isolated-child-ok` termine avec code 0, zéro octet stdout et stderr.
Cette perte de sortie est observée dans l'environnement ; elle ne doit pas être
présentée comme une preuve que chaque autre échec API est exclusivement HTTP.
Aucun code Coach, entraînement, test ou protection n'a été modifié pour contourner.
Reproduire la suite complète hors sandbox avant validation globale.

Diagnostic UI : une exécution complète intermédiaire avait deux échecs additionnels
parce que le nouveau test de pagination cliquait le premier bouton `Next`, celui de
la date du Journal. Le test cible maintenant le catalogue ; tous les 154 ciblés
réussissent. Les anciennes relances ne sont pas additionnées aux résultats finaux.
La relance complète finale et les restrictions Node des sept tests de locales sont
consignées après terminaison. Un diagnostic filtré isolait ce test (20 autres non
sélectionnés), il ne sert pas de validation complète.

Pour Docker, suivre les commandes de la section Docker précédente, mais utiliser
`--source off-real-20-fuzzy-v3` et **de nouveaux noms de copies**. Le Dockerfile de lab
et son contexte incluent désormais `fuzzy.py`. Test de packaging par copie du même
layout réussi ; daemon Docker inaccessible (permission socket), aucune image
construite dans cette session. Valider UID 65534, montage read-only, absence/corruption,
redémarrage après SIGKILL, sortie propre et cgroup 192 Mio / un CPU hors sandbox.
Ne pas modifier le Dockerfile API de production ni les services existants.

Pour Firefox, suivre les deux terminaux API/Vite et le tunnel de la section
« Commandes navigateur », en remplaçant seulement la variable workspace par :

```bash
NUTRITION_LOCAL_CATALOG_WORKSPACE=off-real-20-fuzzy-v3
```

Toujours DATA_DIR neuf, API port 3002, Vite port 5174, API_ORIGIN/ORIGIN
http://localhost:8080 conformément au proxy Vite qui réécrit Origin. Vérifier
`GET /api/nutrition/catalog/capabilities` : local. Journal → OFF → taper `boveti`,
attendre environ 300 ms, sans Entrée ; choisir par flèches/Entrée, quantité et repas,
ajout durable. Réseau navigateur : URL openGym `local=1`, aucun CGI OFF. Tester
`pate tartinre`, `chocolat noir`, ordre inverse ; Nutella textuel reste absent de ce
petit corpus. Utiliser 3017620422003 explicitement par code-barres pour le fallback
v3 si le réseau VPS est disponible. Arrêter le backend de lab, relancer **sans**
NUTRITION_LOCAL_CATALOG : page déjà ouverte refuse ses suggestions locales ; réouvrir
le panneau pour retrouver le parcours explicite distant. Aucun rollback de données
personnelles. Tester effacement, focus, composition, mobile/tactile, clair/sombre et
lecteurs d'écran dans Firefox et sur appareils, sans revendiquer ces essais ici.

**Décision : recherche prête pour revue de code, catalogue complet et activation
réelle non validés.** Conditions : vrais échantillons diversifiés puis dimensionnement
plus large, tailles d'exports/continuité, Docker et HTTP réels, suites VPS vertes,
essais Firefox et mobiles. Ne pas relever les limites, télécharger le dump ou publier
une génération réelle dans l'application sans démontrer les budgets et obtenir le
choix requis si le budget ne peut pas être prouvé.

### Fichiers de cette passe

- `catalog.py`, `fuzzy.py`, `test_catalog.py`, `test_fuzzy.py` : schéma v3, vocabulaire,
  trigrammes, coût OSA borné, langue, budgets disque/RAM, compatibilité et interruptions.
- `worker.py`, `worker.test.mjs`, `Dockerfile.worker`,
  `Dockerfile.worker.dockerignore` : argument langue optionnel et copie du module fuzzy.
- `preflight.py`, `test_preflight.py`, `fuzzy-benchmark.py` : HEAD seul, dimensionnement
  conservateur et mesures reproductibles sans réseau ni publication applicative.
- `api/nutrition/food-catalog.js`, `catalog-local.js`, `api/openapi.yaml` : capacités
  publiques, suggestions local-only, validation staging, propagation de la langue.
- `api/test/food-catalog.test.js`, `catalog-local.test.js`, `catalog-local-http.test.js` :
  aucune consommation OFF pour capacité/suggestion locale, rollback et HTTP réel.
- `frontend/src/lib/nutrition/catalog/client.js`, `client.test.js`, `public-relay.js`,
  `public-relay.test.js` : capacité strictement validée, annulation/remplacement du
  contrôleur, cache local distinct, transport public mobile appairé sans secrets.
- `frontend/src/lib/nutrition/ui-session.js` : origine serveur et transport de capacité.
- `frontend/src/views/nutrition/FoodCatalog.jsx`, `FoodCatalog.test.jsx`,
  `frontend/src/nutrition.css` : combobox locale, saisie/clavier/focus/IME/pagination,
  parcours Journal durable et maintien du mode distant explicite.
- `docs/dev/NUTRITION_UI.md`, `NUTRITION_FOOD_CATALOG.md`, le présent document :
  architecture réellement livrée, limites, commandes et décisions.
- Les neuf rapports JSON `fuzzy-*` et `preflight-validation.json` listés plus haut
  contiennent les mesures de cette passe. Aucun rapport de la passe précédente,
  capture brute, génération précédente ou changement préexistant n'a été supprimé.

Les autres fichiers déjà modifiés dans Git au démarrage (traductions, scanner,
serveur, formulaires...) appartiennent aux passes antérieures et sont préservés.
Aucun commit, push, déploiement, service supplémentaire, installation, changement
natif, migration personnelle ni tâche planifiée de cette passe.

### Résultat final des relances

Dernière suite frontend complète : **5 796 réussites / 7 échecs / zéro ignoré**, total
5 803 cas, 438 fichiers (437 réussis / 1 échoué), 389,92 s. Les sept échecs sont les
cas de `scripts/check-locales.test.mjs`, tous `spawnSync Node EPERM`. Le contrôle
exécuté directement a réussi 18 langues / 2 464 clés. Aucun échec catalogue/UI dans
cette relance. Ce résultat remplace, sans les additionner, les exécutions précédentes
5 787/7 et 5 793/9 (deux échecs de sélecteur de pagination maintenant corrigés).

Dernières ciblées : 154 frontend / 81 Python / 60 Node prototype / 175 API réussis,
zéro échec ou ignoré. Ne pas additionner ces groupes à la suite complète frontend.
HTTP réels : neuf cas, zéro réussi, neuf setup bloqués EPERM, zéro ignoré. Docker
non exécuté faute de permission. API complète : 43/42 groupes de fichiers comme
détaillé plus haut ; pas de validation globale revendiquée. Builds web/mobile
réussis (1,8 s environ), `git diff --check` réussi.

Post-validation : 54 420 332 544 octets libres (~50,68 Gio), RAM disponible
4 111 454 208 octets (~3,83 Gio). Les suites CPU temporaires ont augmenté le load
average (2,20 / 2,69 / 2,29 au relevé final). La mesure RAM précédente de préflight
sous tests était plus basse (~2,93 Gio disponibles) ; aucune importation volumineuse
n'a été exécutée dans cet intervalle. Aucun bilan d'impact sur des services non
visibles n'est prétendu. Refaire les relevés SSH avant acquisition représentative.

`search-validation.json` regroupe les résultats finaux sans addition de relances.
État Git final : branche feature/nutrition, HEAD 6610d192, 34 fichiers suivis modifiés
(926 insertions / 26 suppressions), 75 fichiers non suivis au total, incluant les
travaux préexistants. Aucun fichier indexé, aucun commit/push/déploiement.

## Faisabilité TSV avant acquisition complète (2026-10-12)

Le propriétaire a mesuré depuis SSH, après redirection officielle S3 : JSONL gzip
13 132 516 914 octets (12,23 Gio), TSV gzip 1 275 171 186 octets (1,19 Gio). Ces tailles
sont **fournies par le propriétaire**, pas mesurées dans la sandbox. Relevé local de
cette passe : 54 420 148 224 octets libres, RAM disponible 3 935 Mio, quatre CPU,
pas de swap. Un seul HEAD curl a encore échoué DNS ; aucune nouvelle tentative de
capture réseau ni téléchargement complet n'est lancé.

### Découvertes déterminantes avant choix nutritionnel

Lecture des sources primaires actuelles :
[configuration OFF](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/lib/ProductOpener/Config_off.pm)
(`@export_fields`) et
[exporteur TSV](https://github.com/openfoodfacts/openfoodfacts-server/blob/main/scripts/export_database.pl).
Ce n'est pas la preuve du header actuellement déployé : il faudra le lire dans
l'extrait officiel. Ne pas confondre source `main` et version du fichier S3.

- Champs d'identité prévus : code, product_name, generic_name, brands, countries_tags,
  last_modified_t ; colonnes de contributeurs existent mais ne sont pas conservées.
- Export en/fr : même catalogue mondial, noms localisés lorsque disponibles, sinon
  nom de repli. Ce n'est **pas** un catalogue limité aux produits vendus en France.
  `product_name_fr`/toutes les variantes/langue explicite ne figurent pas dans cette
  liste ; importer un fichier en ne permet pas de reconstruire les traductions.
- `energy-kcal_100g`, `energy-kj_100g`/`energy_100g`, `proteins_100g`,
  `carbohydrates_100g`, `fat_100g` sont projetés. Le code actuel lit les valeurs de
  `nutrition.aggregated_set`, pour **100g OU 100ml**, en gardant le suffixe `_100g`.
- `nutrition_data_per`, `product_quantity_unit`, `serving_quantity_unit`, la référence
  `nutrition.aggregated_set.per` et les qualificatifs/source des nutriments ne sont
  pas dans la liste actuelle. `quantity`, `product_quantity` ou `serving_size` ne
  prouvent pas le référentiel de la table nutritive. Aucune conversion eau/ml/g.
- `data_quality_errors_tags`, `no_nutrition_data`, `completeness`, `states_tags`
  sont prévus ; les erreurs qualité ne sont donc **pas toutes perdues**. Les
  qualificatifs `<`, `>`, estimations par nutriment, warnings complets et historique
  des observations sont absents. Completeness n'est pas une garantie de nutrition.
- Source exporteur incluant produits courants et obsolètes, sans drapeau obsolete
  explicite dans cette liste : doublons divergents ne pourront pas être choisis
  arbitrairement au seul motif qu'une ligne arrive après une autre.
- Exporteur concaténant les cellules avec des tabulations, après nettoyage des
  caractères de contrôle. Aucun échappement CSV de guillemets : ils sont littéraux.

### Corrections déjà opérationnelles, limites inchangées

`export_http.py` suit au plus trois redirections vers l'objet exact demandé,
uniquement HTTPS et le bucket public `openfoodfacts-ds` sur les endpoints S3 connus.
Aucun domaine AWS générique ni chemin libre. Refus des ports inattendus, credentials,
fragments, downgrade HTTP, autre objet/bucket, boucle et query non versionId.
HEAD reste HEAD, cookies/Authorization ne sont pas transmis ; contexte TLS normal
avec vérification de certificat et hostname. Pas de retry. Nouveau fournisseur ou
URL signée non reconnue exige une revue de la liste, pas une ouverture globale.

Le préflight rapporte finalUrl/chaîne/Content-Length/ETag/Last-Modified/VersionId/
checksums S3 éventuels. Un ETag multipart n'est pas un SHA-256 ; un checksum S3
COMPOSITE ne doit pas être comparé comme un SHA-256 FULL_OBJECT. Aucun contenu
n'est téléchargé par un HEAD. Taille/digest manquant restent inconnus.

`tsv.py` est maintenant un parseur TSV **littéral**, avec lignes complètes 1 Mio,
cellules 64 Kcaractères, UTF-8 strict, colonnes uniques et sûres ; seules les colonnes
utiles sont émises vers Node. L'ancien csv.reader pouvait avaler plusieurs lignes
si un nom commençait par un guillemet isolé. Régression corrigée et testée.

`projectTsv` vérifie les propriétés propres sans invoquer de getters. Les unités
nutritionnelles restent nécessaires ; une masse/portion de paquet ne remplace plus
une base manquante. L'identité est conservée, mais macros/portions sont neutralisées
**avant** le moteur si la référence est ambiguë ou si une erreur nutritionnelle OFF
est déclarée. Les valeurs absentes ne deviennent jamais zéro. Les champs explicites
100g/100ml utilisent le moteur existant ; qualificatifs perdus signalés par le
warning de catalogue existant `export-qualifiers-unavailable`. Aucun contrat
personnel, route applicative ou ancien snapshot n'est modifié.

L'import gzip existant fonctionne en chaîne source → gunzip → parseur TSV →
projection/moteur JS → writer SQLite, avec backpressure et CRC/EOF complets avant
seal/publication. Il n'extrait pas le dump complet sur disque ou en RAM. Les plafonds
100k lignes / source 256 Mio / base 512 Mio restent **actifs**, donc l'export entier
1,19 Gio ne sera pas accepté par la commande actuelle.

Un autre ajustement confirmé dans le source 2026 : `brands` est un champ de tags,
donc le header peut contenir **brands_tags et brands_en/fr**, plutôt que `brands`.
Le convertisseur conserve ces colonnes et choisit le libellé explicite disponible,
sinon les tags de marque tels que fournis, sans inventer une casse/une traduction.
L'audit affiche les colonnes réelles de marque. Les noms ne sont pas forcés en
français sur la seule base d'un pays ou du préfixe du nom de fichier.

### Comparaison avec JSONL et conséquences pour le parcours

| Information | TSV prévu par le source actuel | JSONL brut |
|---|---|---|
| Identité, marques, pays | Oui, certaines colonnes localisées/tags | Oui, formes structurées |
| Toutes les traductions et langue | Non ; un libellé localisé/repli | Variantes et métadonnées disponibles |
| Macros standardisées | Colonnes plates, valeurs parfois absentes | Tables/observations structurées |
| 100 g versus 100 ml | Pas reconstruit du seul suffixe `_100g` | Référence explicite quand renseignée |
| Portions | Texte/quantité, unités parfois absentes | Structures plus riches |
| Qualificatif et source de chaque valeur | Perdus dans la projection standard | Connaissables si renseignés |
| Qualité | erreurs/tags/completeness partiels | Diagnostics et warnings plus complets |
| Versions/obsolete | Informations réduites | Plus d'éléments pour départager |

Si l'extrait confirme l'absence de référence, **un TSV seul ne permet pas un catalogue
nutritionnel entièrement ajoutable hors ligne**. Il demeure un bon index public de
recherche. Il faut une consultation OFF v3 ciblée et validée au moment de choisir
une fiche ambiguë, puis persister seulement le produit utilisé dans savedFoods et
les snapshots habituels. Les produits déjà enregistrés restent hors ligne.

Ce parcours de réhydratation n'est pas activé ici : le relais local actuel retourne
une identité trouvée sans nutrition, sans consulter v3 ; l'UI affiche donc non
ajoutable. Il faudra un ajout explicite, testé, avant intégration d'un index TSV
majoritairement identitaire. Pas d'appel v3 pour chaque suggestion ni enrichissement
massif du catalogue. Si l'ajout immédiat hors ligne de produits jamais consultés est
indispensable, source JSONL ou projection officielle enrichie avec références et
qualificatifs nécessaire ; ce choix ne peut pas être remplacé par une heuristique.

### Extrait officiel borné : commandes SSH exactes

La sandbox ne résout toujours pas static.openfoodfacts.org : **aucun extrait TSV
réel n'a été récupéré ou importé dans cette passe**. Les tests portent sur fixtures
OFF-shaped, pas sur des données TSV authentiques. Procédure à lancer sur SSH :

```bash
set -e
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
python3 scripts/nutrition-local-catalog/preflight.py --head tsv
CATALOG_TSV_SAMPLE="tsv-sample-$(date -u +%Y%m%dT%H%M%S)"
# HEAD uniquement ci-dessus ; plan sans réseau avant acquisition du petit préfixe.
python3 scripts/nutrition-local-catalog/tsv-sample.py \
  --workspace "$CATALOG_TSV_SAMPLE" --rows 5000
python3 scripts/nutrition-local-catalog/tsv-sample.py \
  --workspace "$CATALOG_TSV_SAMPLE" --rows 5000 --fetch
node --max-old-space-size=128 scripts/nutrition-local-catalog/audit-tsv.mjs \
  "scripts/nutrition-local-catalog/artifacts/$CATALOG_TSV_SAMPLE/sample-manifest.json" \
  > "scripts/nutrition-local-catalog/artifacts/$CATALOG_TSV_SAMPLE/audit.json"
CATALOG_TSV_BUILD="tsv-build-$(date -u +%Y%m%dT%H%M%S)"
CATALOG_TSV_SHA=$(node --input-type=module -e 'import fs from "node:fs";const m=JSON.parse(fs.readFileSync(process.argv[1]));if(!m.complete)process.exit(1);process.stdout.write(m.sampleSha256);' \
  "scripts/nutrition-local-catalog/artifacts/$CATALOG_TSV_SAMPLE/sample-manifest.json")
nice -n 10 python3 scripts/nutrition-local-catalog/measure.py \
  node --max-old-space-size=128 scripts/nutrition-local-catalog/build.mjs \
  --format tsv --source off-tsv --version "$CATALOG_TSV_SAMPLE" \
  --workspace "$CATALOG_TSV_BUILD" \
  --input "scripts/nutrition-local-catalog/artifacts/$CATALOG_TSV_SAMPLE/sample.tsv" \
  --expected-input-sha256 "$CATALOG_TSV_SHA" --skip-invalid \
  > "scripts/nutrition-local-catalog/artifacts/$CATALOG_TSV_SAMPLE/import.json" \
  2> "scripts/nutrition-local-catalog/artifacts/$CATALOG_TSV_SAMPLE/import-resources.log"
python3 scripts/nutrition-local-catalog/fuzzy-benchmark.py \
  --workspace "$CATALOG_TSV_BUILD" --iterations 30 \
  > "scripts/nutrition-local-catalog/artifacts/$CATALOG_TSV_SAMPLE/search.json"
```

Le script ne demande que le Range **0..16 Mio-1** du gzip ; un HTTP 200 ignorant
Range est refusé avant lecture. Au plus 128 Mio décompressés, 64 Mio de TSV stockés,
20k lignes maximum (5k ici), 120 secondes, RLIMIT_AS 256 Mio. Streaming avec zlib
borné, arrêt après lignes complètes. Seul le petit TSV est écrit, pas un gzip
incomplet présenté comme archive valable. Pas de retry ni de reprise agressive.

La capture décrit explicitement préfixe **non représentatif**, CRC du gzip complet
**non vérifié**, ETag/VersionId source, chaîne HTTPS, taille totale indiquée par
Content-Range, octets effectivement lus, SHA-256 du préfixe lu et de l'extrait TSV.
Ne pas assimiler ces SHA à celui du dump entier. Un échec laisse un reçu complete=false,
pas de TSV importable. Après succès, audit valide taille/hash/header/nombre de lignes,
colonnes réellement présentes, marques, unités, valeurs brutes de diagnostic,
proportion France et macros utilisables. Ces valeurs brutes ne sont pas des Food et
ne sont pas stockées dans le catalogue si leur référence reste ambiguë.

Le header brut du reçu est la réponse aux questions de colonnes déployées. Examiner
`audit.json` et `import.json`, notamment rejets, doublons, nutrition inconnue, qualité,
macro présentes mais non utilisables. Vérifier des fiches françaises/internationales
et liquides si elles sont réellement dans l'extrait ; aucune réponse n'est fabriquée
pour Nutella ou lait si absents. Un préfixe trié par code ne dimensionne pas toute la
diversité OFF ; le corpus HF distribué peut compléter le contrôle qualitatif, mais
ne remplace pas une mesure représentative du TSV.

### Budget et profil complet proposé, non activé

Deux générations en régime stable (active + rollback). Pendant reconstruction :
**trois fichiers SQLite** (les deux conservés + candidate), puis temporaires d'index/
journal et source compressée. Ne pas compter le fichier renommé comme une quatrième
copie, ni omettre l'ancre précédente lors d'une actualisation.

Pour **5 millions de produits retenus supposés**, TSV 1,188 Gio, 2 Gio de temporaires
et 1 Gio de marge supplémentaire, catalogue+FTS+fuzzy inclus dans le coût par produit :

| Octets SQLite/produit supposés | Une base | Deux bases stables | Pic 3 bases + source + temp/marge | Libre sur 50,7 Gio |
|---:|---:|---:|---:|---:|
| 750 | 3,49 Gio | 6,98 Gio | 14,66 Gio | 36,04 Gio |
| 1 000 | 4,66 Gio | 9,31 Gio | 18,16 Gio | 32,54 Gio |
| 1 600 | 7,45 Gio | 14,90 Gio | 26,54 Gio | 24,16 Gio |
| 2 000 | 9,31 Gio | 18,63 Gio | 32,13 Gio | **18,57 Gio : refus** |

Ce tableau est une **analyse de sensibilité**, pas une mesure OFF. Vocabulaire,
langues, marques, longueur des noms et aliases fuzzy changent fortement les index.
La taille gzip ne donne ni le nombre de lignes ni la taille SQLite. Les coûts fixes
sur vingt lignes et les six familles synthétiques de 50k ne suffisent pas. À mesurer
sur l'extrait : taille products/FTS/search_terms/search_grams/barcode via dbstat,
termes/postings, octets par fiche et import CPU/RSS/temp. Garder une marge de diversité.

`full-tsv-import-plan.json` contient un **profil inerte** proposé : source gzip 2 Gio,
entrée décompressée streaming 24 Gio, lignes scannées 8M, base 8 Gio, espace prototype
28 Gio, temporaires 2 Gio, caches SQLite 8 Mio, Node heap 128 Mio, Python AS 256 Mio,
réserve disque 20 Gio et RAM disponible 2 Gio. Ce sont des plafonds de refus : huit
millions de lignes à 1 600 octets n'entrent pas dans huit Gio de SQLite. Une ligne
1 Mio et un record normalisé 16 Kio restent plafonnés. Aucune constante active n'est
relevée ; aucun import entier n'est lancé. Recalcul après mesure réelle et croissance
concurrente des autres services, pas seulement après succès du HEAD.

Changements nécessaires avant d'activer ce profil :

1. Profil explicite opt-in validé côté Node/Python, seal/source/manifest/read/rollback ;
   conserver lecture des générations v1-v3 et contrat utilisateur v1. Un simple
   changement de MAX_PRODUCTS serait insuffisant.
2. Séparer limites compressed/expanded/scanned/stored ; backpressure et CRC intégral,
   hash des octets gzip téléchargés **et** hash actuel de l'entrée décompressée.
3. Adapter limites de compte API/lecteur (actuellement 100k), budgets workspace et
   max_page_count (8 Gio / 4096), temporaires dans l'espace de catalogue contrôlé.
4. Arrêt sur quota/disque/RAM avant publication, aucune purge automatique des anchors.
   Résoudre ou mettre en quarantaine les doublons divergents, jamais les choisir par
   ordre de fichier ; aucune policy nouvelle appliquée dans cette passe.
5. Préparation du lecteur à grande génération : le timeout actuel du worker de 10 s
   peut tuer le calcul SHA initial de plusieurs Gio et boucler en redémarrages.
   Prévoir une phase de préparation/readiness distincte, bornée et supervisée,
   avant exposition, **sans supprimer la vérification du hash**. Mesurer le débit I/O.
6. Hydratation v3 ciblée et explicite pour une identité ambiguë, testée avant activation
   de la base TSV ; aucune lecture v3 pour les suggestions ou toutes les fiches.

### Plan du futur téléchargement/import entier (pas exécuté, pas encore activable)

- Vérifier source officielle HEAD HTTPS→S3, Content-Length actuel, Last-Modified,
  ETag, VersionId et Accept-Ranges ; mesurer les services visibles sur SSH.
- Après accord et gates ci-dessus, créer un nouveau répertoire isolé ; télécharger
  l'objet exact/version pinée en `.partial`, limite 2 Gio, deadline et débit raisonnables,
  vérification espace toutes les tranches. Reprise Range/If-Match/versionId uniquement
  si objet et Content-Range correspondent ; refuser concaténation de versions/HTTP200.
- Taille égale à HEAD pinée ; checksum FULL_OBJECT si disponible, sinon SHA local
  conservé et gzip CRC/EOF (intégrité accidentelle, pas signature). ETag multipart
  seul ne valide pas cryptographiquement les octets.
- Import streaming low-priority dans une candidate neuve ; métriques et journal
  rejets/ambiguïtés/doublons bornés, pas de dump extrait sur disque. Indexation et
  integrity_check/FTS/record hashes/scellage, recherches/codes-barres/valeurs réellement
  présentes, puis essai readiness du worker.
- Validation humaine et activation séparée du manifeste/catalogue expérimental ;
  conserver active et précédente, rollback atomique. Pas d'automatisation/deltas tant
  que leur continuité et leurs suppressions ne sont pas validées.

Les commandes ci-dessus pour **l'extrait** sont exécutables dès maintenant. La commande
complète ne l'est pas : le profil est volontairement inerte et le fichier 1,19 Gio
serait refusé par l'importateur actuel. Ne pas lancer un curl du dump entier ni donner
une commande fictive `--profile full` comme si elle existait. Décision recommandée :
valider d'abord le header/extrait et choisir explicitement index TSV + v3 ciblée si
la référence manque, puis activer les plafonds justifiés et le downloader supervisé.

### Résultats et fichiers de la passe TSV

Commandes effectivement exécutées (sans acquisition Internet) :

```bash
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
TMPDIR="$PWD/scripts/nutrition-local-catalog/artifacts/test-tmp" \
  python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py' -q
node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs
npm --prefix frontend test -- --maxWorkers=2 src/lib/nutrition/catalog src/views/nutrition/FoodCatalog.test.jsx
node --test --experimental-test-isolation=none \
  api/test/catalog-local.test.js api/test/food-catalog.test.js api/test/nutrition-packaging.test.js
node frontend/scripts/check-locales.mjs
npm --prefix frontend run build
git diff --check
```

Dernières exécutions : **96 tests Python**, **68 tests Node prototype**, **154 tests
frontend ciblés sur huit fichiers**, **90 tests API ciblés** réussis ; zéro échoué ou
ignoré. Build web réussi en 1,76 s avec avertissements de bundle préexistants. Locales
18 × 2 464 cohérentes. Vérifications syntaxiques Node/Python et git diff --check OK.
La suite complète n'a pas été relancée pour ces changements confinés au prototype ;
les chiffres complets de la section précédente restent ceux de cette ancienne passe.
Aucun test HTTP/Docker réel dans cette passe ; leurs restrictions restent connues.

Tests ajoutés : redirection HTTPS→bucket exact, méthode HEAD, credentials non transmis,
URL étrangère/HTTP/autre objet/port/query/boucle/deadline refusés et TLS cert/hostname
actifs ; parse TSV littéral/guillemets/Unicode/limites/header/EOF ; portions/quantité de
paquet ne prouvent pas 100g, macros absentes et zéro, décimales/qualificatifs, marques
localisées et erreurs nutritionnelles ; Range respecté, 200 refusé, DNS/timeout/503
sans retry, gzip/UTF-8/colonnes invalides, quota/partial préexistant conservé ; audit
hash/count/header/receipt et chaîne gzip→SQLite réelle sur fixture synthétique.
Un défaut de construction de l'objet neutralisé (propriétés undefined non JSON) a
été corrigé avec nulls avant les dernières relances, sans relâcher inspectExternal.

Fichiers modifiés : `preflight.py`, `test_preflight.py`, `tsv.py`, `normalize.mjs`,
`normalize.test.mjs`, `build.test.mjs`, le présent document.
Fichiers créés : `export_http.py`, `tsv-sample.py`, `test_tsv.py`, `test_tsv_sample.py`,
`audit-tsv.mjs`, `audit-tsv.test.mjs`, `full-tsv-import-plan.json`,
`tsv-sizing-validation.json`, `tsv-validation.json`.
Tous les scripts/rapports sont sous `scripts/nutrition-local-catalog/`.
Aucune route API, UI, dépendance, production, donnée personnelle ou limite active
modifiée. Worktree préexistant préservé, branche feature/nutrition / HEAD 6610d192,
aucun commit ni push. Le rapport est prêt pour revue, **l'import complet n'est pas
encore autorisable techniquement sans header/extrait réel et readiness à grand volume**.

## V1 : voie ciblée, ressources et validation réelle du 12 octobre 2026

L’import direct de l’extrait officiel reçu (5 000 lignes, 12 565 365 octets) conserve
4 196 produits et rejette 804 lignes : 3 codes invalides, 751 descriptions invalides,
50 valeurs de `no_nutrition_data` non reconnues. Les données ne sont pas corrigées
arbitrairement. Audit : 1 068 lignes indiquent France, 1 191 ont les quatre cellules
nutritionnelles brutes, **aucune référence explicite** : 0 produit directement ajoutable
sur la seule base TSV. Le taux de fiches utilisables après v3 reste à mesurer sur VPS.

Import direct mesuré : 1,534 s total Node ; 1,479 s constructeur Python ; CPU Node
0,892 s + Python 1,350 s. Pic RSS Node 75 532 Kio, Python 27 776 Kio (pics séparés,
pas une mesure du pic simultané de l’arbre). SQLite 4 231 168 octets ; FTS5 323 584,
index code 94 208 ; vocabulaire/grammes fuzzy 2 703 360. Ouverture avec vérification
SHA complète : 6,861 ms. Benchmark 30 répétitions, Python 3.13.5 / SQLite 3.46.1,
Linux Debian, cache chaud, aucune latence réseau : `artifacts/v1-tsv-5000/benchmark-real.json`.

| Requête | Moyenne ms | p95 ms | Couverture observée |
|---|---:|---:|---|
| Nutella | 0,443 | 0,680 | 2 résultats, biscuit en premier, pot classique absent |
| Coca-Cola | 1,117 | 1,393 | 15 résultats |
| lait | 1,361 | 1,521 | 21 résultats |
| riz | 0,815 | 0,943 | 10 résultats |
| pâtes | 0,311 | 0,366 | 1 pâte à gaufre, insuffisant |
| yaort | 1,004 | 1,195 | 7 résultats fuzzy |
| lait amande | 0,312 | 0,402 | aucun résultat |
| Code exact | 0,065 | 0,094 | clé texte avec zéros initiaux |

Ces premières lignes ne prouvent ni couverture V1 ni taille d’un index mondial.
Environ 1 008 octets SQLite/identité sur cet extrait : projection linéaire 100 000
identités ≈96 Mio, facteur de prudence ×4 ≈384 Mio ; le plafond effectif reste
512 Mio et peut arrêter proprement l’import. Le vocabulaire international est plus
varié : aucune garantie de linéarité. Aucun dump complet n’a été téléchargé ici.

### Outils de catalogue ciblé (aucune activation automatique)

`download-tsv.py` utilise uniquement la source TSV officielle et son allowlist
HTTPS/S3, suit au plus trois redirections validées et garde la vérification TLS.
Un HEAD précède le transfert. Source ≤2 Gio, ETag/version S3 fixés, taille exacte,
SHA-256 local, délais bornés, pas de retry. Les reprises exigent le même objet et
un Content-Range exact ; un objet modifié impose un nouveau workspace. Une source
partielle n’est jamais publiée comme complète. Le SHA local ne prouve pas à lui seul
l’authenticité de la source ; TLS et provenance documentée restent nécessaires.

`select-tsv.py` lit le gzip local en streaming jusqu’à EOF et vérifie son CRC,
sans extraction intégrale. ≤8 millions de lignes scannées, ≤24 Gio décompressés,
≤100 000 identités retenues, ≤256 Mio de TSV projeté, mémoire virtuelle ≤256 Mio,
délai quatre heures. Par défaut 80 000 codes nommés France +20 000 internationaux, choisis sur
tout le fichier par hash déterministe et indice de champs bruts complets (sélection v2). C’est une sélection géographique bornée, sans prétention de popularité
ni d’échantillonnage représentatif. Les nutriments sont conservés sans inventer leur
base, avec colonnes qualité/provenance publiques ; les contributeurs/ingrédients
inutiles sont exclus. Les conflits de codes retenus arrêtent la sélection.

Budgets distincts : scan de source élevé autorisé seulement dans le sélecteur ;
les plafonds existants constructeur/manifestes/lecteurs (100 000 lignes, SQLite
512 Mio, workspace 2 Gio) restent cohérents et inchangés. Réserve avant transfert :
**28 Gio libres**, soit 20 Gio intouchables +8 Gio : source 2 Gio, projection 256 Mio,
trois générations ×512 Mio, temporaires 2 Gio, registre de sélection 1 Gio, cache v3 environ 640 Mio, arrondi.
Disponible mesuré ≈50,67 Gio : cette voie ciblée tient arithmétiquement ; le catalogue
mondial complet n’est pas dimensionné ni autorisé par cette démonstration. RAM
available ≥2 Gio et disque ≥20 Gio contrôlés pendant le sélecteur et la construction.
Ces contrôles ne réservent pas des ressources contre d’autres services.

Essai supplémentaire isolé : recompression **locale du préfixe TSV reçu**, puis
sélection streaming : 5 000 scannées, 4 217 identités retenues avant validation métier,
1 070 France +3 147 internationales, projection 631 767 octets, 0,209 s, RSS 20 404
Kio. Le CRC valide ici la recompression locale, pas le dump officiel complet.
`v1-selected-5000/selection-manifest.json` et `import.json` conservent les détails.
Un reçu de sélection complet et le SHA du TSV sont requis dans la procédure
opérateur avant l’import ; une sélection interrompue reste diagnostiquable dans
son workspace exclusif et ne remplace jamais une génération.

### Commandes SSH — catalogue ciblé et essai Firefox isolé

Aucun de ces scripts n’active un service ni ne touche au stockage personnel. Ne pas
réutiliser un workspace existant. Avant le téléchargement, inspecter sur SSH les
services visibles et confirmer ≥27 Gio libres, ≥2 Gio MemAvailable. La source
entière (~1,19 Gio actuellement) sert ici à une **projection ciblée**, pas à la
construction de toute la base mondiale. Le script refait un HEAD et refuse une
source modifiée/oversize. Si ces mesures ne sont pas satisfaisantes, arrêter.

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
free -h
df -h .
docker stats --no-stream
python3 scripts/nutrition-local-catalog/preflight.py --head tsv

# Nouveau workspace ; garder sa valeur pour reprendre un transfert interrompu.
export OFF_V1_RUN="off-v1-$(date -u +%Y%m%dT%H%M%SZ)"
export OFF_V1_SOURCE="$PWD/scripts/nutrition-local-catalog/artifacts/$OFF_V1_RUN"
export OFF_V1_SELECTION="$PWD/scripts/nutrition-local-catalog/artifacts/${OFF_V1_RUN}-select"
# Plan + HEAD ; ne télécharge encore rien.
python3 scripts/nutrition-local-catalog/download-tsv.py --destination "$OFF_V1_SOURCE"
# Après vérification du budget ciblé : transfert unique, reprenable sans retry.
nice -n 10 python3 scripts/nutrition-local-catalog/download-tsv.py \
  --destination "$OFF_V1_SOURCE" --fetch --ack-targeted-budget
nice -n 10 ionice -c 2 -n 7 python3 scripts/nutrition-local-catalog/select-tsv.py \
  --source "$OFF_V1_SOURCE/source.tsv.gz" --destination "$OFF_V1_SELECTION" \
  --france 80000 --international 20000
# Le reçu doit être complet. Le checksum protège la projection remise au constructeur.
export OFF_V1_HASH="$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); assert m["complete"] and m["gzipCrcVerified"]; print(m["selectedSha256"])' "$OFF_V1_SELECTION/selection-manifest.json")"
nice -n 10 ionice -c 2 -n 7 node --max-old-space-size=128 \
  scripts/nutrition-local-catalog/build.mjs --input "$OFF_V1_SELECTION/selected.tsv" \
  --format tsv --source off-tsv --workspace "${OFF_V1_RUN}-db" \
  --version "$OFF_V1_RUN" --expected-input-sha256 "$OFF_V1_HASH" --skip-invalid \
  > "$OFF_V1_SELECTION/import.json"
cat "$OFF_V1_SELECTION/import.json"
python3 scripts/nutrition-local-catalog/fuzzy-benchmark.py \
  --workspace "${OFF_V1_RUN}-db" --iterations 30 \
  > "$OFF_V1_SELECTION/benchmark.json"
cat "$OFF_V1_SELECTION/benchmark.json"
```

La déduplication métier/refus des incohérences reste active après la sélection ;
le nombre accepté peut être inférieur au nombre retenu. Vérifier les recherches
Nutella, Coca-Cola, lait, riz, pâtes, yaourt, lait amande et leurs fautes, noms/marques,
pays et codes exacts avant toute publication applicative. Si la couverture est
insuffisante, ne pas lever les plafonds : examiner une sélection par mots/catégories
ou par cohortes géographiques plus diversifiées. Ne pas multiplier les requêtes v3
pour analyser en masse les 100 000 produits ; les lectures v3 restent ciblées et
plafonnées 15/min/IP. Le taux réellement ajoutable après v3 doit être mesuré sur
quelques sélections usuelles et ne peut pas être extrapolé depuis les cellules TSV.

Pour essayer **l’extrait déjà disponible**, sans téléchargement :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
export OPENGYM_V1_DATA="$(mktemp -d /tmp/opengym-v1-data.XXXXXX)"
NODE_ENV=development DATA_DIR="$OPENGYM_V1_DATA" PORT=3002 \
  ORIGIN=http://localhost:8080 NUTRITION_LOCAL_CATALOG=1 \
  NUTRITION_LOCAL_CATALOG_WORKSPACE=v1-tsv-5000 npm --prefix api start
# Autre terminal : remplacer v1-tsv-5000 par le nouveau workspace après ses tests.
API_TARGET=http://127.0.0.1:3002 API_ORIGIN=http://localhost:8080 \
  npm --prefix frontend run dev -- --host 127.0.0.1 --port 5174 --strictPort
# Depuis le poste client (remplacer utilisateur@VPS) :
ssh -N -L 5174:127.0.0.1:5174 -L 3002:127.0.0.1:3002 utilisateur@VPS
```

Firefox `http://localhost:5174` → invité → Nutrition → ajouter → OFF → saisir
`nutela`, sélectionner, attendre la fiche v3, choisir quantité et repas, enregistrer.
Le port 5174 isole l’IndexedDB du test de celui de 5173. Vérifier actualisation des
totaux, modification/suppression, rechargement, recette/objectifs et réutilisation
hors ligne d’un produit déjà enregistré. Une sélection peut échouer si OFF v3
n’est pas joignable et aucune fiche fiable n’existe dans le cache ; ce n’est pas un
succès ni une raison d’inventer des nutriments. Arrêter les deux processus pour
quitter le labo, sans suppression de données ni modification des services existants.

### Docker API de développement et Android

`Dockerfile.api-lab` est une image isolée supplémentaire : aucun changement du
Dockerfile API de production. Node 22 + Python + SQLite FTS5 + flock, dépendances
API du lockfile sans Coach optionnel, utilisateur UID/GID 65534, catalogue monté RO,
filesystem image RO, DATA_DIR de test tmpfs, cache public séparé sur disque hôte.
Le serveur expérimental reste sur loopback **dans le conteneur** : pas de `-p`
prétendant le rendre accessible. Les vérifications HTTP s’effectuent par `docker exec`.
L’essai Firefox/Android ci-dessus utilise le serveur Node isolé sur l’hôte.

```bash
cd /home/codex/openGym
python3 scripts/nutrition-local-catalog/docker-lab.py --help
# Prépare une copie publique lisible UID 65534 (commandes exactes dans --help).
# Exemple du helper existant :
python3 scripts/nutrition-local-catalog/docker-lab.py --source v1-tsv-5000 --name v1-docker-public
# Utiliser le chemin publié par le helper comme OFF_V1_DOCKER_CATALOG ci-dessous.
export OFF_V1_DOCKER_CATALOG="$PWD/scripts/nutrition-local-catalog/artifacts/v1-docker-public"
export OFF_V1_DOCKER_CACHE="$(mktemp -d "$PWD/scripts/nutrition-local-catalog/artifacts/docker-cache.XXXXXX")"
chmod 1777 "$OFF_V1_DOCKER_CACHE" # Répertoire labo neuf, public uniquement, jamais DATA_DIR.
docker build -f scripts/nutrition-local-catalog/Dockerfile.api-lab -t opengym-api-catalog-v1-lab .
docker run --rm --name opengym-api-catalog-v1-lab --network none --read-only \
  --cpus=1 --memory=384m --pids-limit=32 \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
  --mount "type=bind,src=$OFF_V1_DOCKER_CATALOG,dst=/app/scripts/nutrition-local-catalog/artifacts/trial,readonly" \
  --mount "type=bind,src=$OFF_V1_DOCKER_CACHE,dst=/app/scripts/nutrition-local-catalog/artifacts/public-v3-cache" \
  opengym-api-catalog-v1-lab
# Autre terminal : pas de réseau fournisseur dans cette vérification.
docker exec opengym-api-catalog-v1-lab node -e \
  'fetch("http://127.0.0.1:3002/api/nutrition/catalog/search?q=lait&lc=fr&local=1").then(async r=>{console.log(r.status,await r.text());if(r.status!==200)process.exitCode=1})'
docker stats --no-stream opengym-api-catalog-v1-lab
docker stop opengym-api-catalog-v1-lab
```

Tester aussi avec copie corrompue et catalogue absent : API démarrée, recherche
503 sans faux quota, autres fonctions accessibles. Ne pas modifier la génération
source pour ces essais. L’image complète, Alpine et les permissions n’ont pas pu
être exécutées ici (socket Docker refusé), et un test textuel du Dockerfile ne vaut
pas cette validation. Le cache limité à ~640 Mio requiert un montage disque dédié ;
un petit tmpfs ne peut pas satisfaire sa réserve de 20 Gio.

Android : Java 21 et Android SDK selon `docs/MOBILE.md`, puis :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
# Via tunnel SSH ci-dessus + USB depuis le poste qui dispose de l’Android SDK :
VITE_NUTRITION_CATALOG_ORIGIN=http://127.0.0.1:3002 npm --prefix frontend run build:mobile
cd frontend/android
./gradlew assembleDebug
# Sur le poste relié au téléphone, où le tunnel 3002 est ouvert :
adb reverse tcp:3002 tcp:3002
# Tester dans un émulateur/profil de test, sans désinstaller l’application existante.
# APK : app/build/outputs/apk/debug/app-debug.apk (signature debug, pas une release).
```

Ce build de développement configure explicitement le catalogue invité. Pour une
version distribuable, remplacer par l’origine HTTPS réelle validée et signer selon
MOBILE.md ; ne pas publier un APK contenant l’URL loopback. Ici le build web mobile,
la copie Capacitor et le contrôle du bundle passent ; aucun APK n’est produit,
Java/SDK étant absents. Aucun navigateur réel ni appareil Android n’est testé.

### Revue finale et mesures complémentaires

- Fonctionnel : une sélection d’identité TSV sans nutrition passe par une vraie
  consultation produit avant ouverture de quantité. Régressions sur Journal réel,
  annulation après changement de texte, erreur fournisseur et conservation locale.
- Concurrence : déduplication cache avant budget OFF, annulation d’un lecteur sans
  annulation d’un autre lecteur, réponses tardives et contrôle de session inchangés.
  Correction d’une double instance de budget dans le chargeur expérimental.
- Fiabilité : ancien `nutrition_data_per=100g` insuffisant pour distinguer g/ml.
  Cache V1 validateur 2 avec agrégat OFF **v3.5** explicite. Ancien mode distant et
  snapshots inchangés. Refus d’unité contradictoire, macros inconnues jamais zéro.
- Disque : lecture cache bornée par buffer même si le fichier change après stat ;
  fsync/rename, résidus ignorés, quota et réserve disque contrôlés. Pas de purge de
  l’historique ni de modification de la file d’opérations.
- Import : budgets scan/rétention séparés, CRC jusqu’à EOF, champs publics projetés,
  source/ETag/tailles/hashes consignés, reprise réseau contrôlée, workspace exclusif.
  `full-tsv-import-plan.json` reste une ancienne proposition **inerte**, pas le profil
  V1 autorisé : seul le catalogue ciblé à plafond 100 000/512 Mio est proposé ici.

Benchmark cache sur **fixture v3.5 et fournisseur simulé**, distinct des mesures OFF
réelles : `node scripts/nutrition-local-catalog/v3-cache-benchmark.mjs`. Résultat
Node 22.23.3 : première validation+écriture durable 12,826 ms ; 100 lectures après
recréation du service, moyenne 1,196 ms, p95 4,651 ms ; un seul appel fournisseur
simulé ; fichier 768 octets ; RSS process 62 432 Kio ; CPU total 122,115 ms. Ces
mesures sont faites pendant les suites de tests et ne mesurent pas la latence OFF.
Artefact `artifacts/v3-benchmark-eAby3M/benchmark.json`.

Supervisor Python réel sur la génération des 4 196 produits : démarrage, inspection,
arrêt/redémarrage et lecture seule réussis. Copie Docker publique isolée préparée,
source inchangée ; copie corrompue refusée avec `corrupt-generation` (sortie négative
attendue). Docker/Alpine restent non exécutés. Aucun crash simulé n’est présenté
comme une coupure électrique réelle.

### Commandes de validation complètes sur SSH

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
mkdir -p scripts/nutrition-local-catalog/artifacts/test-tmp
TMPDIR="$PWD/scripts/nutrition-local-catalog/artifacts/test-tmp" \
  python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py' -q
node --test scripts/nutrition-local-catalog/*.test.mjs
npm --prefix frontend test -- --maxWorkers=2
node frontend/scripts/check-locales.mjs
npm --prefix api test
# Tests HTTP isolés, puis enregistrement sur le vrai serveur :
node --test api/test/catalog-local-http.test.js api/test/food-catalog-http.test.js \
  api/test/server-local-catalog.test.js api/test/server-food-catalog.test.js
npm --prefix frontend run build
VITE_NUTRITION_CATALOG_ORIGIN=http://127.0.0.1:3002 npm --prefix frontend run build:mobile
git diff --check
```

En sandbox, les tests Node sans socket sont exécutés avec
`--experimental-test-isolation=none` pour éviter la restriction des sous-processus
Node ; aucun cas de test n’est désactivé. Ne pas employer ce contournement pour
combiner toute l’API dans un même processus : plusieurs suites règlent DATA_DIR
et requièrent l’isolation normale. Sur SSH, employer les commandes normales ci-dessus.
Les tests HTTP ayant `listen EPERM` sont **non validés**, pas ignorés/succès.
Les suites complètes doivent repasser hors sandbox ; le check direct des locales
n’est pas équivalent aux sept tests qui construisent des fixtures de locales.

Une vérification fournisseur **ciblée** à exécuter sur SSH, une seule fois, après
vérification de disponibilité et en dehors d’un incident 429/503 :

```bash
curl --fail-with-body --max-time 20 --proto '=https' \
  -H 'User-Agent: openGym/1.4.1 (https://github.com/solhren/openGym)' \
  'https://world.openfoodfacts.org/api/v3.5/product/3017620422003?fields=code,product_name,brands,nutrition,data_quality_errors_tags,no_nutrition_data' \
  -o scripts/nutrition-local-catalog/artifacts/v3-nutella-check.json
```

Inspecter `nutrition.aggregated_set.per`, `preparation`, sources et valeurs ; ne pas
conclure qu’une réponse 200 implique une fiche ajoutable. Ne pas relancer en boucle.
Le DNS Codex a échoué sur l’unique probe OFF de ce tour ; un accès réussi depuis
SSH n’est pas automatiquement un accès réussi depuis la sandbox.

### Dernier durcissement des temporaires et bilan des exécutions

Sur cet environnement `/tmp` est un tmpfs. Le driver Node passe désormais
`SQLITE_TMPDIR=<workspace>` au **seul constructeur Python**, pour mettre les tris
SQLite sur le disque de la génération et ne pas transformer un budget disque en
consommation RAM. Aucune configuration globale du VPS n’est modifiée. Le rapport
`temporaryStorage` expose ce choix ; le test d’import complet le vérifie. Nouvelle
construction isolée du même TSV projeté : 4 196 produits, 4 231 168 octets,
1,575 s total, RSS Node 70 448 Kio / Python 27 924 Kio (pics distincts), temporaires
`workspace`. Artefact `v1-selected-5000/import-disk-temp2.json`.

Le téléchargeur possède maintenant le verrou noyau non bloquant existant du
prototype : deux opérateurs ne peuvent pas ajouter en parallèle au même `.partial`.
Un SIGKILL libère le verrou ; la reprise revalide objet/ETag/range/taille. Les
fichiers préexistants sont conservés. Le diagnostic DNS du HEAD n’est plus masqué
par un message générique. Les refus d’écriture/disque plein sont distincts des
incidents réseau. Tests dédiés de concurrence et diagnostic ajoutés.

Dernières exécutions, sans sommer les relances ni les groupes qui se recouvrent :

| Groupe | Commande (voir variantes complètes ci-dessus) | Résultat |
|---|---|---|
| Prototype Python | `TMPDIR=... python3 -m unittest discover ... -q` | 114 réussis, 0 échec, 0 ignoré |
| Prototype Node | `node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs` | 68 réussis, 0 échec, 0 ignoré |
| Frontend catalogue + Journal réel | `npm --prefix frontend test -- --maxWorkers=2 src/lib/nutrition/catalog src/views/nutrition/FoodCatalog.test.jsx` | 163 réussis / 9 fichiers, 0 échec, 0 ignoré |
| API catalogue/cache/packaging | `node --test --experimental-test-isolation=none api/test/catalog-product-cache.test.js api/test/catalog-local.test.js api/test/food-catalog.test.js api/test/nutrition-packaging.test.js` | 105 réussis, 0 échec, 0 ignoré |
| API persistance/backup/protocole/volumes | `node --test --experimental-test-isolation=none api/test/nutrition-backup-history.test.js api/test/nutrition-files.test.js api/test/nutrition-protocol.test.js api/test/nutrition-store.test.js api/test/nutrition-volume.test.js` | 60 réussis, 0 échec, 0 ignoré |
| Frontend complet | `npm --prefix frontend test -- --maxWorkers=2` | 5 805 réussis, 7 échecs `spawnSync ... EPERM`, 0 ignoré ; 438 fichiers passent / 1 échoue |
| API complète | `npm --prefix api test` | sortie en **groupes de fichiers** : 44 passent, 42 échouent, 0 ignoré ; pas un total de cas métier ; HTTP/sous-processus à revalider sur SSH |
| HTTP catalogue isolé | `node --test --experimental-test-isolation=none api/test/catalog-local-http.test.js api/test/food-catalog-http.test.js` | 0 réussi, 11 échecs de hook `listen EPERM` ; non validés |
| Locales directes | `node frontend/scripts/check-locales.mjs` | 18 langues / 2 464 clés, synchronisées |
| Web + mobile bundle | `npm --prefix frontend run build`, puis `VITE_NUTRITION_CATALOG_ORIGIN=http://127.0.0.1:3002 npm --prefix frontend run build:mobile` | réussis ; CocoaPods/Xcode absents, aucune compilation iOS revendiquée |
| Android APK | `./gradlew --offline assembleDebug` | bloqué : Java absent, SDK non configuré ; aucun APK produit |
| Docker | `docker info` | socket daemon refusé ; aucune image construite/exécutée |

Les dernières retouches exclusives au prototype/cache ont leurs suites ciblées
relancées après correction. Une suite complète doit encore réussir sur SSH, surtout
les 42 groupes API dont le résumé sandbox ne donne pas les assertions internes ;
ils ne sont pas tous décrétés problèmes d’environnement sans cette revalidation.
Aucun test n’est désactivé et aucun échec n’est assimilé à un succès. Les outils de
vérification visuelle/physique n’ont pas été exécutés.

État de livraison : socle ciblé et parcours validé sur fixtures prêt pour revue,
**V1 pas finalisée**. Conditions avant activation : échantillon/catalogue ciblé
suffisamment couvrant sur données réelles, validation réelle v3.5, tests HTTP/suites
complètes hors sandbox, Docker/permissions, APK debug et parcours physique Android.
Le mode production demeure désactivé ; sa levée et son packaging de production
nécessitent cette validation. La restauration globale reste bloquée comme auparavant.

## Procédure V1 actuelle : sélection sans biais de premières lignes

La procédure actuelle utilise `select-tsv.py` **v2**. Elle remplace le premier
échantillonnage de tête de fichier décrit dans les résultats historiques ci-dessus.
Chaque code valide est examiné jusqu’à EOF, puis retenu selon un rang stable :
présence de quatre champs nutritionnels bruts plausibles sans erreur nutritionnelle
déclarée, puis SHA-256 fixe du code canonique. Les quotas France/international sont
indépendants ; les données nutritionnelles restent non validées pour le journal.
Aucune popularité n’est inventée. Le TSV final est ordonné par code ; inverser
l’ordre des lignes sources produit exactement le même checksum de sélection.

Les seules clés de classement restent en RAM (≤100 000). Descriptions retenues et
registre complet de déduplication sont en SQLite de préparation, plafonnée à 1 Gio,
cache 8 Mio. Les doublons contradictoires sont détectés même après éviction d’un
candidat. Cette base n’est pas celle exposée par l’API. Un manque de candidats
France ne se compense pas silencieusement par des candidats internationaux.
Le budget initial passe à **28 Gio libres** (20 réserve +8 enveloppe incluant ce
registre) ; minimum 2 Gio RAM disponible. La reprise du téléchargement ne réserve
pas deux fois les octets déjà présents dans un partial vérifié. Après changement
d’ETag/version, arrêter et préparer un nouveau workspace, sans supprimer l’ancien.

Tests de préparation : 122 Python réussis, 68 Node réussis ; 105 tests API catalogue
réussis. Les nouveaux cas couvrent l’invariance d’ordre, les candidats tardifs,
les quotas séparés, les doublons après éviction et le budget de reprise. Essai
borné sur les 5 000 vraies lignes déjà reçues : sélection 200 France +50 internationales,
250 retenues puis **250 acceptées, 0 rejet** au constructeur existant. Sélection
0,408 s / RSS 20 764 Kio / staging 315 392 octets. Import 0,208 s. Ce préfixe reste
non représentatif ; il prouve le fonctionnement, pas la couverture du catalogue.

`check-off-journal.mjs fichier.json code` vérifie une capture OFF v3.5 ou de la route
openGym : normalisation stricte, référence as-sold 100g/100ml, quatre macros connues,
ajout de 50g/ml via les vraies commandes UI, persistance sur fichiers temporaires
propres au test, fermeture/réouverture, calcul et conservation de la file offline.
Aucune synchronisation réseau ni donnée de compte n’est utilisée. Un JSON trop gros,
un code différent, une référence ambiguë ou une macro absente fait échouer le test.
Le test local du mécanisme utilise une fixture et ne certifie pas OFF. L’unique
probe réel v3.5 Nutella de ce tour a échoué DNS ; les captures réelles sont à faire
sur SSH, sans retry agressif, puis à passer à ce vérificateur. Les valeurs restituées
sont celles renvoyées par OFF et ne constituent pas une garantie d’exactitude du
contributeur. Le parcours visuel se vérifie ensuite dans Firefox / Android `.test`.

### Critères d’arrêt opérateur

- Moins de 28 Gio libres avant lancement, moins de 2 Gio RAM disponible, plafond
  de taille/pages/temps atteint, source modifiée : arrêter, ne pas relever les plafonds.
- Reçu de sélection incomplet, checksum source/projection incohérent, mauvaise
  répartition 80 000/20 000 ou conflit de code : ne pas construire/activer.
- Après validation métier, distribution inférieure au quota ou recherches courantes
  absentes/manifestement inadaptées : pas d’activation ; examiner le rapport.
- v3.5 429/503/timeout : ne pas répéter automatiquement ; respecter Retry-After.
  Pas de référence fiable : aucun ajout automatique, aucune valeur inventée.
- Tests HTTP/API/frontend en échec, worker Docker non privilégié invalide, APK
  non compilé ou non essayé : V1 non validée.

Les commandes SSH opérationnelles figurent dans le compte rendu de cette passe.
L’image de production, les routes et les contrats personnels sont inchangés.

## Évaluation wger — 25 octobre 2026 (isolée, V1 sans requête alimentaire externe)

Nouvelles décisions : recherche SQLite littérale (accents/préfixes autorisés), sans
correction orthographique, aucune API alimentaire appelée pendant l’utilisation.
Cette passe évalue une source ; elle ne met pas en production les anciens chemins
expérimentaux qui comportent encore un fallback v3.5 et du fuzzy. Leur suppression
est une condition explicite de l’intégration V1 ultérieure.

Préflight : 53 482 102 784 octets libres, RAM disponible 4 607 877 120 octets, quatre
CPU, pas de swap. Réserves de 20 Gio / 2 Gio inchangées. HEAD unique vers le dump
wger : échec DNS `Could not resolve host: wger.de`. Les accès web à la documentation
et au code officiel fonctionnent, pas ceux au dump et aux API wger. Aucun dump
complet téléchargé ; taille, nombre exact de lignes et couverture réels inconnus.
La documentation annonce environ 1 GB **en base wger**, pas la taille du gzip ni
la taille future SQLite : ne pas substituer cette annonce à une mesure.

Constats du code officiel : `export_ingredient_dump` écrit chaque IngredientSerializer
comme ligne JSON ; langue et licence sont des clés étrangères numériques, les
portions sont incluses. Le modèle déclare kcal/100g, macros g/100g et portions en
**grammes entiers**. Les ingrédients peuvent n’avoir aucun code-barres, et plusieurs
UUID/langues peuvent partager un code. La base contient des sources wger/OFF/USDA.
`extract_info/off.py` lit les anciens champs `_100g` et ne conserve pas leur base
100g/100ml : wger ne résout donc pas automatiquement notre problème de référence
pour les fiches issues d’OFF. Énergie entière et macros à trois décimales dans le
modèle : les valeurs sources plus précises ne sont pas restituables depuis ce dump.

Le prototype OFF courant exige un GTIN et attribue globalement ODbL ; il n’est pas
une représentation universelle de ces ingrédients. Aucun faux code-barres ni
attribution OFF ne sera fabriqué pour le faire entrer dans ce contrat. L’évaluation
conserve identité wger UUID, code optionnel et licence/provenance par entrée dans
une SQLite de laboratoire séparée, avec le même SQLite/FTS5, et réutilise le moteur
Food v1 pour vérifier les valeurs. Les contrats et données utilisateur restent inchangés.

`wger-sample.py` prépare la capture publique bornée (HEAD par défaut, `--fetch` opt-in,
4 Mio gzip lus maximum /32 Mio décompressés /16 Mio JSONL /2 000 lignes). Pas de
redirection implicite ni retry. Il conserve registres réels langue/licence, taille,
ETag, checksums et caractère non représentatif du préfixe. `--coverage` collecte
seulement des candidats de neuf requêtes françaises, dix par requête ; le serveur
wger peut faire du trigramme mais les mesures locales les filtrent **littéralement**.
Le compte fournisseur de candidats n’est jamais une couverture exacte. Aucun filtre
`code` n’est utilisé : le code officiel peut appeler OFF pour un barcode manquant,
ce qui fausserait l’examen du catalogue déjà présent sur wger.

### Résultats et limites de cette évaluation wger

- **Aucune fiche réelle wger reçue**, taille gzip et population inconnues : le DNS
  du contexte d’exécution bloque wger.de. Cela ne prouve pas une panne du fournisseur.
- Tests offline : **130 Python et 80 Node réussis**, sans échec ni ignoré lors des
  suites du prototype (inclut 8 tests de capture/recherche wger et 12 tests Node wger).
  Pas de Django, PostgreSQL, dépendance npm ou service installé.
- Smoke test SQLite sur deux fixtures explicitement synthétiques : un générique
  wger natif directement ajoutable et un produit OFF dérivé conservé comme identité
  mais non ajoutable. Vraies commandes de l’UI + vrais fichiers temporaires : ajout
  50 g, fermeture/réouverture, snapshots/calculs et file offline conservés, zéro réseau.
  Ce test ne remplace PAS l’import d’un échantillon wger réel ni un essai Android.
- Les Foods du laboratoire utilisent le contrat v1 existant : `source.kind=custom`
  avec provenance explicite `publicCatalogImport.provider=wger`, **collection savedFoods**.
  Cela ne signifie pas « créé par l’utilisateur ». Avant intégration, les filtres UI
  actuels limités à OFF et l’affichage des attributions doivent être généralisés :
  `FoodSource` et « Previously used products » ne rendent pas encore ces origines.
  La recette copie déjà les sources dans les snapshots. Aucun utilisateur réel ni
  collection customFoods de l’application n’est modifié par les tests.
- Le prototype OFF v3 n’accepte que des GTIN et une attribution globale OFF/ODbL.
  La SQLite d’évaluation UUID/code nullable/licence par entrée est un laboratoire
  isolé, pas une génération activable par les routes existantes. La sélection de
  source implique donc une petite généralisation du DTO catalogue, pas une migration
  de l’historique utilisateur. Aucun faux GTIN n’est créé.

Nouvelle comparaison **sans fuzzy**, vraie génération OFF `v1-tsv-5000` :
4 196 produits, 4 231 168 octets, RSS Python 20 652 Kio sur le premier relevé (varie
selon exécution), 30 répétitions par requête, aucun réseau. Résultats première page
(plafond 20), pas des totaux du catalogue :

| Requête | Résultats/page | Référence +4 macros/page | p95 ms (relevé) |
|---|---:|---:|---:|
| Nutella | 2 | 0 | 0,097 |
| Coca-Cola | 15 | 0 | 0,217 |
| lait | 20 | 0 | 0,297 |
| riz | 10 | 0 | 0,154 |
| pâtes | 1 | 0 | 0,053 |
| yaourt | 6 | 0 | 0,111 |
| œuf | 5 | 0 | 0,076 |
| banane | 6 | 0 | 0,101 |
| poulet | 20 | 0 | 0,295 |

Exemples : « Nutella biscuits », pas le pot classique ; « pâtes » → « Pâtes à gaufre ».
Le titre d’un produit et l’existence d’un résultat ne prouvent pas sa pertinence.
Ce préfixe n’est ni toute la base OFF ni la sélection 80k/20k (non importée).
Pas de comparaison chiffrée wger/OFF à populations comparables tant que la capture
réelle wger n’est pas fournie. Les résultats ne justifient aucune extrapolation à
plusieurs millions de produits. Artefact : `artifacts/off-literal-oct25.json`.

### Licences et provenance (à conserver par entrée)

- Code wger : AGPL-3.0-or-later ; notre analyse ne copie pas son importateur Django.
  Les droits des données ne sont pas déduits de cette licence logicielle.
- Données natives : wger indique « Creative Commons, see individual entries ».
  Le modèle propose CC BY-SA 4 par défaut mais cela ne licence pas uniformément le dump.
  Le registre de licences du dépôt contient CC BY-SA 3/4, CC0, CC BY 4 et ODbL ;
  les IDs ne sont pas universels : la capture exige le registre réel du serveur.
- Données OFF réexportées : le code d’import indique ODbL et garde les auteurs/
  URLs d’origine. Les conditions de la base OFF et des contenus DbCL subsistent ;
  ni le passage par wger ni la licence du code ne les remplacent.
- USDA : source distincte dans le modèle. Ne pas attribuer automatiquement CC0
  à toutes ces lignes ; résoudre la licence fournie et examiner les droits de
  l’éventuelle adaptation/compilation et la source originale.
- Images : absentes du sérialiseur bulk d’ingrédients consulté ; les objets Image
  possèdent leurs propres licences/auteurs. L’import d’images OFF de wger utilise
  CC BY-SA 3.0. Aucune image n’est téléchargée par cette évaluation.
- Métadonnées de licence absentes/inconnues ou provenance incohérente : non ajoutable,
  conservée uniquement pour audit local. Les champs TASL (titre/auteur/source/licence)
  et la source dérivée restent dans le Food de test et ses snapshots.

Avant une diffusion, conserver les avis et attributions, signaler les transformations
et appliquer les obligations ShareAlike pertinentes. Une recherche commune ne donne
pas le droit de déclarer toutes les lignes sous une même licence. Recommandation
prudente : catalogues publiés séparément par provenance et droits, avec recherche
fédérée et aucune inclusion des données personnelles dans ces bases. La séparation
technique seule n’est pas une garantie juridique ; les droits de compilation et la
compatibilité d’un assemblage redistribué demandent une vérification avant publication.

Sources officielles consultées :
- https://wger.readthedocs.io/en/latest/administration/sync-data.html
- https://github.com/wger-project/wger/blob/master/wger/nutrition/sync.py
- https://github.com/wger-project/wger/blob/master/wger/nutrition/api/serializers.py
- https://github.com/wger-project/wger/blob/master/wger/nutrition/models/ingredient.py
- https://github.com/wger-project/wger/blob/master/wger/nutrition/extract_info/off.py
- https://github.com/wger-project/wger/blob/master/wger/nutrition/api/filtersets.py
- https://github.com/wger-project/wger/blob/master/wger/core/fixtures/licenses.json
- https://github.com/wger-project/wger/blob/master/README.md#license
- https://creativecommons.org/licenses/by-sa/4.0/
- https://opendatacommons.org/licenses/odbl/1-0/

### Commandes SSH : petit échantillon, pas le dump complet

HEAD seul, pas de téléchargement des ingrédients :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
python3 scripts/nutrition-local-catalog/wger-sample.py \
  --workspace "wger-head-$(date -u +%Y%m%dT%H%M%SZ)"
```

Puis capture bornée avec registres langue/licence, préfixe et neuf sondes de noms
français pour la **maintenance seulement**, jamais à la frappe dans l’application :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
export WGER_CAPTURE="wger-real-$(date -u +%Y%m%dT%H%M%SZ)"
python3 scripts/nutrition-local-catalog/wger-sample.py \
  --workspace "$WGER_CAPTURE" --fetch --rows 1000 --coverage
node --max-old-space-size=256 scripts/nutrition-local-catalog/wger-evaluate.mjs \
  "$WGER_CAPTURE" "${WGER_CAPTURE}-eval"
python3 scripts/nutrition-local-catalog/off-literal-compare.py --workspace v1-tsv-5000
```

Le rapport JSON de la nouvelle évaluation contient distribution des langues/sources/
licences, barcodes absents, macros complètes/partielles, refus motivés, temps/RSS/SQLite/
FTS5, résultats littéraux français et jusqu’à trois preuves d’ajout/réouverture sans
réseau. Il ne présente pas le count API comme le nombre de lignes du dump, ni les
candidats d’une recherche distante comme une couverture exacte. La capture refuse
les redirections non examinées et s’arrête sur 429/503/timeout sans retry. Réutiliser
un nouveau workspace après un échec, ne pas effacer les captures précédentes.

### Recommandation à ce stade

**Les deux en complément**, sans requête fournisseur à l’usage : wger pour les
aliments génériques natifs/USDA dont unités et droits sont établis ; OFF pour les
produits de marques avec référence originale explicitement conservée dans un
import hors ligne. Dédupliquer par source/identité, pas par fusion automatique de
macros partageant un code. Ne pas assimiler le dump wger à une source indépendante
d’OFF ni additionner leurs nombres de produits.

**Wger seul n’est pas validé comme source principale V1** : couverture réelle non
mesurée, pas de pays de distribution dans le sérialiseur, et référence originale
perdue pour les entrées dérivées d’OFF. **OFF TSV seul n’est pas suffisant** non plus :
il donne actuellement des identités recherchables sans base nutritionnelle fiable.
L’ancien parcours TSV → API v3.5 à la sélection n’est plus retenu avec la nouvelle
interdiction d’API alimentaires à l’usage. Un import OFF enrichi/validé lors de la
maintenance (export contenant les références), puis restitution locale, est nécessaire.
Aucune intégration ni téléchargement complet autorisé implicitement par ce rapport.

## Import intégral wger fourni — 25 octobre 2026 (terminé, activation bloquée)

L'archive fournie par l'utilisateur est conservée intacte dans
`artifacts/wger-full-source/ingredients.jsonl.gz` (408 284 008 octets).
`wger-full-audit.py` a lu le gzip jusqu'à EOF et vérifié son CRC : 3 058 469 lignes,
3 067 782 911 octets décompressés, 11 lignes rejetées par le parseur strict.
SHA-256 : `6f48843618db46841a02cb963ae1ab3a2cc3d7571e97709715d7afca8b0569bc`.
Audit : 149,26 s, 149,21 s CPU, pic RSS Python 20 984 Kio. Aucun fichier
source décompressé n'est créé. Les champs des lignes valides correspondent au
sérialiseur analysé. Les 962 125 lignes de langue ID 12 contiennent 962 122
fiches OFF et seulement trois fiches sans source explicite ; le problème de base
g/ml ne peut donc pas être résolu simplement en choisissant la langue française.
Ces IDs de langue doivent encore être confirmés par le registre du serveur.

La voie `wger-full.mjs` → `wger-generation.py` est distincte des plafonds OFF
expérimentaux : source gzip <=1 Gio, expansion <=12 Gio, <=5 millions de lignes,
ligne <=256 Kio, SQLite <=8 Gio, mémoire virtuelle Python <=512 Mio ; Node est
lancé avec un heap de 256 Mio. Ces plafonds couvrent l'archive mesurée (maximum
17 655 octets par ligne) sans rendre les limites du prototype OFF permissives.
Deux générations de 8 Gio + source <17 Gio restent dans le budget disponible
avant la réserve de 20 Gio. Cette estimation est un plafond, pas la taille mesurée.
Les ressources sont contrôlées tous les 1 000 enregistrements et pendant les
opérations SQL longues. Un contrôle n'est pas une réservation contre les autres
services : l'import s'arrête si les marges 20 Gio disque /2 Gio RAM disparaissent.

L'import n'accumule ni toutes les fiches ni un JSONL normalisé sur disque : une
ligne normalisée circule à la fois dans un pipe avec contre-pression. SQLite
valide les lots et construit FTS5 sur disque. Pas de trigramme, de distance d'édition
ou de fallback fournisseur dans cette génération V1. Une collision UUID divergente
est archivée dans `collisions`, rend l'identité non ajoutable et n'écrase pas
arbitrairement la version initiale. Plusieurs UUID partageant un code-barres restent
distincts, notamment pour les langues ; ils ne sont pas fusionnés par macros.

Le manifeste `opengym-wger-full-generation` est volontairement incompatible avec
l'ancien DTO OFF : on ne maquille pas un UUID sans code-barres en produit OFF.
La génération est créée dans un nouveau workspace exclusivement. SQLite, FTS et
comptages doivent être vérifiés, le fichier fermé, fsync et hashé avant la bascule
atomique de son `current.json`. Une interruption ne crée aucun manifeste complet.
Les fichiers partiels restent inspectables ; aucun ancien catalogue n'est supprimé.
Ce manifeste local n'est pas branché aux routes actives et ne constitue pas un
accord de publication ou de déploiement.

### Registres et distinction entre éligibilité technique et publication

Le dump contient des clés étrangères numériques pour langues et licences, pas leurs
définitions. Le DNS bloque l'accès à wger.de ici. Sans `--metadata`, seuls les IDs
1/de, 2/en, 12/fr et les cinq licences explicitement examinés dans les fixtures
publiques sont utilisés comme **hypothèse provisoire**. Les autres langues restent
inconnues. `technicallyAddableComplete/Partial` décrit le résultat du moteur sous
cette hypothèse ; `directlyAddable=0`, `registryVerified=false` et
`publicationBlocked=true` empêchent de présenter ces hypothèses comme validées.
Le lecteur masque toujours `food` tant que le registre n'est pas confirmé. Une
capture serveur complète de `language.json` et `license.json`, fournie via
`--metadata`, résout ces clés et en conserve les hashes. La conformité juridique
d'une redistribution reste à examiner indépendamment de cette vérification.

Les valeurs inconnues restent nulles, les décimales ne sont pas arrondies. Les
règles métier de cohérence sucre/glucides et saturés/lipides sont aussi appliquées
aux fiches OFF ambiguës sans fabriquer une référence. Les longs crédits d'auteurs
présents dans le dump sont conservés jusqu'à la limite externe existante de
10 000 caractères ; ils ne sont ni tronqués ni remplacés par un auteur inventé.

### Commandes de la voie complète (aucune activation de l'application)

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
# Choisir des noms neufs : ces commandes ne remplacent pas de génération existante.
python3 scripts/nutrition-local-catalog/wger-full-audit.py \
  --output wger-full-audit-20261025.json
nice -n 10 node --max-old-space-size=256 \
  scripts/nutrition-local-catalog/wger-full.mjs \
  --workspace wger-full-20261025 --audit wger-full-audit-20261025.json
# Une fois current.json présent et complete=true seulement :
python3 scripts/nutrition-local-catalog/wger-generation.py search \
  wger-full-20261025 --query 'lait'
node scripts/nutrition-local-catalog/wger-journal-proof.mjs wger-full-20261025
```

Si le registre serveur n'a pas été fourni, la commande d'import effectue une
construction provisoire et le lecteur ne retourne aucun Food ajoutable. Depuis
SSH, capturer les deux petits registres, sans écraser de fichier préexistant :

```bash
WGER_META=$(mktemp -d scripts/nutrition-local-catalog/artifacts/wger-meta.XXXXXX)
curl --fail --show-error --max-time 30 'https://wger.de/api/v2/license/?limit=100' \
  -o "$WGER_META/license.json" && \
curl --fail --show-error --max-time 30 'https://wger.de/api/v2/language/?limit=100' \
  -o "$WGER_META/language.json"
printf '%s\n' "$WGER_META"
```

Réimporter dans un **nouveau** workspace avec `--metadata "$(basename "$WGER_META")"`
pour utiliser ces mappings (pagination `next=null` exigée). Le rapport garde les
checksums des registres. Ne pas éditer manuellement les flags du manifeste pour
transformer les mappings provisoires en mappings vérifiés.

`wger-worker-client.mjs` réutilise la supervision Node existante (queue, annulation,
deadline, redémarrages bornés), mais lance un lecteur sans aucun transport réseau.
`wger-api-adapter.mjs` prépare un DTO public avec UUID, code-barres facultatif,
Food v1 ou null et statut explicite. La consultation d'une fiche manquante retourne
null ; elle ne déclenche ni OFF ni wger. Aucun handler n'est enregistré dans l'API
existante. Le futur frontend devra accepter ce DTO et rendre les attributions
CC/USDA/wger : l'ancien normaliseur exclusivement OFF/GTIN ne peut pas être réutilisé
sans cette adaptation explicite. Le lecteur épingle une génération ; un nouveau
worker permet la bascule ou le rollback vers un ancien workspace conservé. Il ne
recharge pas automatiquement un catalogue pendant une sélection utilisateur.

Tests reproductibles :

```bash
mkdir -p scripts/nutrition-local-catalog/artifacts/test-tmp
TMPDIR="$PWD/scripts/nutrition-local-catalog/artifacts/test-tmp" \
  python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py'
node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs
cd frontend
npm test -- src/lib/nutrition/catalog/normalize.test.js \
  src/lib/nutrition/validate.test.js src/lib/nutrition/ui-session.test.js \
  src/lib/nutrition/backup-restore.test.js src/lib/nutrition/sync-merge.test.js
```

Les simulations d'interruption/échec disque ne constituent pas des coupures
électriques physiques. Les tests du worker et du DTO ne constituent pas un essai
HTTP dans Firefox ni un essai Android. Les anciennes routes expérimentales conservent
leur comportement tant qu'un raccordement V1 explicite n'a pas été examiné.

### Revue de sûreté de la voie complète

- Une erreur du writer pouvait être masquée par un deuxième `interrupted.json`
  créé par Node : le reçu Python est désormais conservé et l'erreur initiale remonte.
- Les crédits auteurs réels atteignent 9 701 caractères dans les lignes acceptées
  par l'audit ; le plafond arbitraire antérieur de 3 500 les perdait. Le nouveau
  plafond suit celui du validateur externe existant, sans tronquer les crédits.
- Les règles transversales des nutriments étaient exécutées seulement pour les
  Foods ajoutables : elles s'appliquent maintenant aussi aux identités ambiguës,
  pour ne pas appeler « valides » des valeurs contradictoires sucre/glucides.
- Les doublons UUID divergents conservent leurs payloads et deviennent non
  ajoutables ; les compteurs finaux sont recalculés après ces collisions.
- Le drapeau `publicationBlocked` reste toujours vrai dans ce laboratoire : la
  résolution des registres n'est pas une validation juridique ou une autorisation
  de déploiement. `registryVerified` et `directlyAddable` décrivent séparément la
  possibilité technique de construire un Food dans les tests isolés.
- Test SIGKILL réel ajouté au writer de la voie complète : aucun manifeste scellé
  n'apparaît après l'arrêt. Cela ne simule pas une coupure d'alimentation physique.

Premières preuves sur deux **vraies fiches de l'archive**, exécutées sans réseau
avant la fin de l'indexation : `Berry Nut Blend Breakfast In The Go!` (USDA) et
`100 pindakaas` (source vide, modèle wger). Pour 50 g, les résultats conservés après
réouverture sont respectivement 223,5 kcal /4,705 g protéines /29,4 g glucides /
10,6 g lipides et 305,5 kcal /13,25 g protéines /5,8 g glucides /24,55 g lipides.
Snapshots identiques et opérations hors ligne toujours présentes. Les mappings de
licence restent provisoires : ceci vérifie le moteur et la durabilité technique,
pas une autorisation de publication. Artefact :
`artifacts/wger-real-archive-journal-proof.json`. Aucun profil utilisateur réel
n'est ouvert, et aucun appareil Android physique n'est testé par cette preuve.

### Incident réel à pleine échelle et correction du classement

La première tentative `wger-full-20261025` a parcouru les 3 058 469 lignes,
conservé 3 058 354 enregistrements et construit les index, mais **n'a pas été
publiée** : le benchmark final a rencontré une interruption SQLite à la deadline
de recherche de 2 s. Le diagnostic sur la copie en lecture seule retrouve des
recherches par marque beaucoup plus lentes que les recherches par nom (exemple
Auchan : 1 655 ms sur un relevé, avec cache OS non contrôlé). Il ne s'agit pas
ici d'une erreur du fournisseur ni d'un dépassement de quota réseau.

Cause : le classement joignait la table contenant les payloads complets, y compris
les longs crédits auteurs, avant de limiter la page. Le nouveau classement utilise
un index B-tree couvrant compact (`search_rank_idx`), une CTE matérialisée des seuls
IDs/scores, puis récupère les payloads des vingt résultats finaux seulement. La
correspondance exacte reste prioritaire ; à qualité textuelle égale, un aliment
ajoutable précède une fiche inutilisable, avant la préférence de langue. Pas de
fuzzy, pas de modification des nutriments et pas de suppression de deadline.

Le premier workspace reste intact, avec `interrupted.json` et sans `current.json`.
La deuxième tentative travaille dans `wger-full-checked-20261025` : copie bornée
contrôlant disque/RAM tous les 64 Mio, **relecture intégrale du gzip et renormalisation
de chaque fiche**, comparaison du digest canonique avec chaque ligne SQLite et
contrôle de l'ordre des identités et du nombre final. Une ligne différente,
manquante ou surnuméraire empêche la publication. Les mappings de registres doivent
être identiques. Ce n'est pas une simple approbation d'une base partielle existante.
Les contrôles gzip/hash/SQLite/FTS sont réexécutés ; seul le contenu déjà construit
est réutilisé. Le reçu de fin et les compteurs sont désormais conservés durablement
dans `meta` avant l'indexation, pour mieux diagnostiquer les futures interruptions.

Commande de reprise vérifiée, avec un nom de sortie neuf (pas une reprise append) :

```bash
nice -n 10 node --max-old-space-size=256 \
  scripts/nutrition-local-catalog/wger-full.mjs \
  --workspace wger-full-checked-20261025 \
  --audit wger-full-audit-20261025.json --reuse wger-full-20261025
```

Benchmarks reproductibles sur les deux copies du même corpus ; choisir des
workspaces ne contenant pas déjà ces rapports, qui ne sont jamais écrasés :

```bash
python3 scripts/nutrition-local-catalog/wger-rank-benchmark.py \
  wger-full-20261025 --mode baseline
python3 scripts/nutrition-local-catalog/wger-rank-benchmark.py \
  wger-full-checked-20261025 --mode optimized
```

Quinze essais par requête, première mesure incluse, sans purger le cache système.
Une requête interrompue n'est pas comptée comme réussie et n'est pas réessayée
quinze fois ; l'outil mesure le code local uniquement, sans réseau. Le cache OS
n'étant pas contrôlé, les comparaisons ne sont pas des mesures de disque froid.

Le benchmark de diagnostic a reproduit précisément la coupure sur **Carrefour** :
`SQLITE_INTERRUPT`, 2 003,77 ms, aucun résultat annoncé comme réussi. Sur la même
première base, Auchan atteint 1 928,48 ms au p95, Nestlé 1 036,55 ms. Ces mesures
incluent les premières lectures avec cache OS non maîtrisé. Artefact conservé :
`wger-full-20261025/rank-baseline.json`. La limite de 2 s reste en place ; elle n'est
pas augmentée pour faire passer le benchmark. L'index couvrant ajoute un coût disque
qui sera indiqué séparément dans le rapport de la deuxième génération.

### Résultats finaux : génération complète vérifiée

**Workspace final : `wger-full-checked-20261025`**, `current.json` complet et hash
SQLite vérifié. La première tentative reste non scellée dans `wger-full-20261025` ;
elle ne doit pas être activée. Aucun catalogue préexistant n'est remplacé.

| Classification | Nombre |
|---|---:|
| Lignes gzip parcourues jusqu'à EOF | 3 058 469 |
| Produits indexés (UUID distincts) | 3 058 354 |
| Exclusions de lignes | 115 |
| Doublons UUID / collisions incompatibles | 0 /0 |
| Quatre macros numériques présentes | 3 057 936 (99,986 %) |
| Valeurs satisfaisant les contrôles de nutriments | 3 053 735 (99,849 %) |
| Foods techniquement ajoutables, quatre macros | 124 031 (4,055 %) |
| Foods ajoutables avec macros partielles | 0 |
| Identités nécessitant une vérification | 2 934 323 (95,945 %) |
| Foods exposés par le lecteur avant confirmation des registres | **0** |

Les contrôles de valeurs ne prouvent ni leur exactitude chez le fournisseur ni la
référence g/ml. Le filtre de référence bloque encore 2 933 184 fiches dérivées d'OFF.
Les 124 031 Foods candidats se répartissent en 123 878 anglais, 150 allemands et
3 français, avec les mappings provisoires examinés. 586 198 fiches d'autres IDs
linguistiques sont conservées mais non résolues ; il faut le registre réel pour
les nommer. Les 115 exclusions sont 11 entrées refusées par le contrôle de structure
externe et 104 champs textuels non conformes. 88 969 codes non conformes au format
retenu sont remplacés par une identité UUID sans faux GTIN, avec un avertissement.
Les fichiers sources et leurs crédits restent disponibles pour l'audit.

Les comptes de provenance normalisés : 2 933 184 OFF, 115 808 USDA, 9 362 natifs
wger (source vide sans barcode externe, d'après le modèle). Les sources/licences
restent distinctes par entrée : ODbL 2 933 196, CC0 115 814, CC BY-SA 3 8 320,
CC BY-SA 4 1 021, CC BY 4 3. Il ne s'agit pas d'une licence uniforme du catalogue.
Le [guide officiel USDA](https://fdc.nal.usda.gov/api-guide/#bkmk-6) confirme CC0 pour
FoodData Central et demande de citer la source. Les champs source/URL/licence de
chaque entrée et de ses snapshots sont conservés. Avant publication, vérifier les
registres, rendre les attributions nécessaires et examiner les obligations CC/ODbL
de la compilation. Aucune image n'est importée ni redistribuée.

### Taille, ressources et latences réelles

Environnement : Node 22.23.3, Python 3.13.5, SQLite 3.46.1, 4 vCPU, 7,6 Gio RAM,
sans swap. Processus de maintenance en priorité CPU réduite (`nice -n 10`).

- SQLite finale : **5 350 760 448 octets, 4,983 Gio**.
- FTS5 : **219 181 056 octets, 209,03 Mio** ; index couvrant de classement :
  **307 191 808 octets, 292,96 Mio**. Aucun index fuzzy/trigramme.
- Relecture/normalisation vérifiée : 453,74 s ; pipeline Python jusqu'à la fin
  des vérifications/benchmarks : 831,32 s. Copie incluse, création du workspace
  jusqu'au manifeste : **844,13 s (14 min 04)**. Ce résultat est une reprise avec
  validation intégrale, pas le temps d'un import neuf sans base préconstruite.
- CPU de la reprise : Node 374,04 s ; Python 566,69 s (processus partiellement
  simultanés, ne pas confondre la somme CPU avec le temps mural).
- Pics mesurés séparément : Node **131,96 Mio RSS**, Python **37,11 Mio RSS**.
- Minimum MemAvailable observé pendant la reprise : **4,367 Gio** ; minimum disque
  libre **39,114 Gio**, final environ **39,32 Gio**. Réserves 2/20 Gio respectées.
- Ancienne tentative et génération complète sont toutes deux conservées ; aucune
  suppression n'a été nécessaire. Les tailles temporaires ont été contrôlées par
  les gardes disque ; le fichier décompressé de 2,86 Gio n'a jamais été écrit.

Quinze mesures par recherche dans la validation finale, cache OS non contrôlé,
aucun trafic fournisseur :

| Recherche | Correspondances littérales | Candidats techniquement ajoutables dans toute la recherche | p95 ms |
|---|---:|---:|---:|
| Nutella | 656 | 7 | 13,52 |
| Coca-Cola | 2 902 | 20 | 18,61 |
| lait | 22 518 | 4 | 97,21 |
| riz | 10 924 | 4 | 52,43 |
| pâtes | 4 167 | 1 | 24,74 |
| yaourt | 8 061 | 0 | 35,05 |
| œufs | 1 479 | 0 | 7,70 |
| banane | 4 742 | 2 | 28,93 |
| poulet | 25 996 | 3 | 100,38 |
| Carrefour | 21 718 | 0 | 112,49 |
| Auchan | 12 584 | 0 | 85,63 |
| Nestlé | 13 004 | 48 | 64,21 |
| Bonne Maman | 1 457 | 16 | 11,80 |

Ces nombres ne prouvent pas la pertinence de tous les candidats : « pâtes » n'a
qu'une sauce ajoutable, « lait » retrouve notamment du chocolat au lait et du
café, « riz » inclut des correspondances de marque et un dessert. Les références
Nutella et certaines boissons disposent de candidats fiables, mais les produits
français usuels ne sont pas suffisamment couverts par les seuls Foods ajoutables.
Le raccordement V1 devrait privilégier les Foods validés sans masquer la possibilité
de consulter les identités non validées. Il ne peut pas présenter les millions de
fiches ambiguës comme immédiatement ajoutables.

Les recherches exactes des codes `3017620422003` et `5449000000996` retournent
chacune une fiche (Nutella /Coke Original Taste), avec p95 respectivement **0,107 ms**
et **0,103 ms** sur 30 essais. Ces fiches OFF restent non ajoutables faute de base.
Anomalie fournisseur observée : `00000000` existe comme « erytritol » ; ce n'est
pas un bon code de test « inexistant ». Une forme numérique valide n'est pas une
certification d'identité GTIN. Les quatre correspondances pour `nutela` sont des
noms littéraux du dump, pas une correction vers Nutella.

Benchmark ancien/nouveau séparé sur le même corpus (15 essais, sans cache OS imposé) :
Carrefour interrompu à 2 003,77 ms → p95 **123,70 ms** ; Auchan **1 928,48 →74,92 ms** ;
Nestlé **1 036,55 →75,92 ms** ; lait **269,37 →90,79 ms**. Tous les essais de la
nouvelle série passent. Ne pas assimiler ces relevés à une garantie sous charge
ni à un benchmark à disque froid. Artefacts `rank-baseline.json` /`rank-optimized.json`.

### Démarrage du worker, preuves journal et validation restante

Le véritable worker supervisé et le DTO préparé passent recherche, sélection par
UUID et arrêt. Le premier démarrage +hash de 4,98 Gio +recherche a pris **12,79 s**.
Le budget hérité de 10 s aurait tué un lecteur sain : le worker **wger seulement**
utilise maintenant 30 s, dans la borne déjà autorisée par le superviseur. Les
recherches SQL gardent leur deadline indépendante de 2 s. Précharger ce worker au
démarrage de la future intégration est nécessaire pour éviter cette attente à la
première frappe ; ne pas supprimer le contrôle d'intégrité. Une machine plus lente
peut encore dépasser ce délai : échec explicite et redémarrages bornés.

Les deux preuves journal sur les lignes réellement indexées sont enregistrées dans
`journal-proof.json`. Une troisième preuve `nutella-journal-proof.json` utilise le
candidat wger natif « Nutella », et non la fiche OFF ambiguë du même nom :
100 g =547 kcal, 6,6 g protéines, 56,8 g glucides, 31,8 g lipides ; 50 g =273,5 kcal,
3,3 g protéines, 28,4 g glucides, 15,9 g lipides. Réouverture et snapshots identiques,
opérations non acquittées conservées, aucune requête réseau. Les registres restent
provisoires dans ces tests ; il ne s'agit pas d'une autorisation de publication.

Commandes supplémentaires de validation locale (les rapports ne sont pas écrasés) :

```bash
python3 scripts/nutrition-local-catalog/wger-coverage.py wger-full-checked-20261025
node scripts/nutrition-local-catalog/wger-journal-proof.mjs wger-full-checked-20261025
```

Dernières suites : **149 tests Python**, **87 tests Node**, **128 tests Vitest sur
5 fichiers**, aucun échec ni ignoré. Les relances de la même suite ne sont pas
additionnées. `git diff --check` passe. Aucun changement de route serveur, de
contrat utilisateur, de compte, recette, journal existant ou sauvegarde ; aucune
API alimentaire externe à l'usage dans le nouveau lecteur. Le mode wger n'est pas
activé dans l'application ; pas de test physique Android ni de test Firefox de ce
raccordement inexistant. La confirmation des registres, la revue des attributions,
la couverture française utile et l'adaptation explicite du DTO/UI restent les
conditions avant une intégration V1 et une validation humaine.

Le nouveau délai par défaut a été éprouvé sur la base complète, sans override :
deux recherches concurrentes placées dans la file du même worker (« Nutella » et
« lait ») terminent en **13 034,74 ms**, avec 656 et 22 518 correspondances, zéro
appel externe. Le worker s'arrête proprement. Artefact `default-worker-proof.json`.
Le raccordement doit conserver ce worker persistant/préchargé, plutôt que le lancer
à chaque requête HTTP.

Fichiers ajoutés pour l'import complet et sa validation :

- `wger-full-audit.py` : inventaire complet gzip/CRC/SHA et limites d'expansion.
- `wger-full.mjs` : normalisation streaming et copie/relecture vérifiée.
- `wger-generation.py` : génération SQLite scellée, lecteur et protocole worker.
- `wger-registry.mjs` : mappings de fixtures explicitement provisoires.
- `wger_sqlite_loader.py` : tokenizer littéral borné, sans fuzzy.
- `wger-worker-client.mjs` : supervision réutilisée, délai de démarrage adapté.
- `wger-api-adapter.mjs` : DTO local UUID/validation/provenance, aucune route active.
- `wger-rank-benchmark.py` : comparaison de classement sur le corpus réel.
- `wger-coverage.py` : couverture utile, candidats et latences code-barres.
- `wger-journal-proof.mjs` : preuve durable sur les Foods de la génération complète.
- `wger-full.test.mjs`, `test_wger_generation.py` : non-régression, sécurité,
  concurrence, corruption, SIGKILL et relecture refusant les divergences.

`wger-normalize.mjs` est adapté pour les crédits longs et les règles métier communes ;
`NUTRITION_FOOD_CATALOG.md` renvoie vers cette voie V1 encore non activée. Les artefacts
SQLite, archives et rapports restent ignorés par Git. Aucun fichier applicatif ni
aucune configuration de production n'a été modifié dans cette passe.

## Confirmation des registres serveur wger — après la capture SSH sBYDUs

L'utilisateur a fourni `artifacts/wger-meta.sBYDUs/license.json` (761 octets) et
`language.json` (2 729 octets). Les réponses sont complètes (`next=null`, nombres
annoncés égaux aux tableaux) : cinq licences, 33 langues. Les 31 IDs de langue et
les cinq IDs de licence effectivement présents dans le dump sont tous résolus.
Aucune divergence sémantique avec les mappings provisoires précédemment examinés
(de/en/fr, licences 1–5) n'a été trouvée. Les checksums sont conservés dans le
rapport de la nouvelle génération : licence
`5c0f35f4f321c53a6865f1e8052b001ac051c73d29266102192a51434ec16bdf`, langues
`b55ad84b1956cda7182dae3fbfe5b52f0bc0c9e7fe4e291d8dccfdbad37adcef`.

Une génération **neuve**, `wger-full-registered-20261025`, est reconstruite à partir
du gzip fourni et de ces registres. Les anciennes générations ne sont pas modifiées.
Une simple bascule de `registryVerified` sur l'ancienne SQLite serait incorrecte :
les langues auparavant inconnues doivent aussi être renormalisées, avec leurs
provenances et IDs de Food recalculés. Les fiches OFF ambiguës restent non ajoutables.
La confirmation des registres ne constitue pas une validation juridique ni une
activation dans l'application ; `publicationBlocked` reste vrai.

L'import répétait inutilement l'inspection complète des tableaux de registres pour
chaque ligne. Avec 33 langues, cela multipliait les validations d'une même donnée
immuable. `createWgerNormalizer` valide le contexte une fois et capture une copie
privée gelée ; chaque produit conserve l'intégralité des contrôles externes et
métier antérieurs. Les tests comparent les résultats à la normalisation individuelle,
vérifient l'isolation face aux mutations du contexte et le rejet des accesseurs
sans les exécuter. Le chargement des registres refuse désormais aussi les comptes
incomplets, codes de langue invalides et codes/IDs dupliqués.

Commande de cette reconstruction isolée :

```bash
nice -n 10 node --max-old-space-size=256 scripts/nutrition-local-catalog/wger-full.mjs \
  --workspace wger-full-registered-20261025 \
  --audit wger-full-audit-20261025.json --metadata wger-meta.sBYDUs
```

La réserve est vérifiée avant et pendant les opérations ; les quelque 39,3 Gio
libres au départ couvrent même le plafond de 8 Gio de cette génération sans réduire
la réserve disque de 20 Gio. Aucun nouveau téléchargement de produits n'est effectué.

Les trois premières fiches réelles de sources OFF, USDA et native wger ont été
comparées avec les anciens mappings et le registre serveur complet : mêmes objets
normalisés et mêmes IDs de Food. La nouvelle voie bulk produit également les mêmes
résultats que les appels individuels. Artefact `registry-comparison.json` du nouveau
workspace. Il s'agit de trois contrôles ciblés, pas d'une comparaison exhaustive
avec les payloads de l'ancienne génération pour les 3 millions de lignes.

Les trois fiches déclarées françaises et candidates dans l'ancienne génération
sont « Aubergine unité », « Laitue » et « multivitamines cocktail 12 fruits
concentrés », sous CC BY-SA 4. La capture confirme bien que l'ID 12 signifie français ;
le faible nombre de fiches natives françaises ne provenait pas d'une erreur de
mapping. Les produits OFF français restent recherchables mais leur base perdue
ne peut pas être réparée par ces seuls registres.

Régressions après cette adaptation : 149 tests Python et 91 tests Node réussis,
aucun échec ni ignoré. Les quatre nouveaux tests Node couvrent équivalence bulk,
protection contre les mutations de contexte, refus des accesseurs et intégrité des
registres paginés. Aucun nouveau test frontend/API n'est nécessaire pour ces seuls
scripts de maintenance ; aucun fichier applicatif n'est modifié.

Le contrôle de couverture des IDs du dump est aussi exécuté automatiquement avant
la création d'un workspace vérifié : un registre paginé complet mais ne couvrant
pas les clés du dump est refusé. Les métadonnées sBYDUs passent ce contrôle. Le test
supplémentaire porte la suite Node à 92 tests réussis (Python : 149).

La preuve de journal est complétée pour les générations vérifiées : si la sélection
réelle par le worker et l'adaptateur retourne un Food, celui-ci passe également dans
les commandes durables puis est rouvert. La preuve ne dépend donc plus seulement
des Foods conservés comme échantillons dans le rapport d'import. Pour une génération
provisoire, ce sous-test reste explicitement absent (`selectedFoodJournalProof=null`).

### Résultat de la génération avec registres confirmés

`wger-full-registered-20261025` est **complète et scellée** : 3 058 469 lignes lues,
3 058 354 produits indexés, 115 exclusions, aucune collision UUID. CRC gzip,
SHA-256 source, intégrité SQLite et cohérence FTS ont passé. `registryVerified=true`,
aucun ID de langue/licence non résolu ; les 31 langues réellement présentes sont
identifiées. Les anciennes générations restent intactes.

Le lecteur restitue désormais **124 943 Foods directement ajoutables**, tous avec
les quatre macros (4,085 % des produits indexés), soit 912 candidats supplémentaires
par rapport aux anciens mappings partiels. 2 933 411 identités restent à vérifier,
dont les 2 933 184 fiches OFF à base ambiguë. `publicationBlocked=true` reste une
barrière volontaire d'activation/revue de publication, pas une indication que les
registres seraient encore inconnus. Aucun paramètre applicatif n'est modifié.

Répartition des Foods ajoutables : en 123 878, nl 883, de 150, es 14, pt 7,
el 3, fr 3, it 2, pl 2, cs 1. Les résultats restent donc très majoritairement
anglais. Sur les recherches françaises : Nutella 8 candidats, Coca-Cola 20,
Carrefour 2, lait 4, riz 4, pâtes 1, banane 2, poulet 3 ; yaourt, œufs et Auchan
n'en ont aucun. Les réserves de pertinence expliquées plus haut restent applicables :
un candidat pour « lait » peut être du chocolat, une sauce pour « pâtes » n'est
pas un aliment de base. La confirmation des registres ne résout pas à elle seule
la couverture utile française.

Mesures de cette **reconstruction neuve**, et non de la reprise précédente :

- durée jusqu'au rapport final : **1 226,69 s (20 min 27)** ; lecture/normalisation
  et écritures par lots 734,18 s, puis indexation et contrôles complets ;
- CPU Node 392,18 s, Python 742,56 s ; pics RSS séparés **130,19 Mio /41,53 Mio** ;
- SQLite **5 351 129 088 octets (4,984 Gio)**, FTS5 209,03 Mio ;
- minimum observé : **34,15 Gio disque libre et 4,456 Gio MemAvailable** ;
  environ 34,33 Gio disque libre après import, réserves respectées ;
- recherches : p95 **6,33 à 107,45 ms**, 15 essais par requête, cache OS non
  contrôlé, aucun transport fournisseur. Ces valeurs ne sont pas des mesures HTTP.

La sélection réelle via le worker et le DTO de « Nutella » renvoie maintenant
`validationStatus=validated` et un Food : celui-ci a été ajouté au journal de test
pour 50 g (273,5 kcal, 3,3 g protéines, 28,4 g glucides, 15,9 g lipides), puis rouvert
avec snapshot identique et opérations hors ligne conservées. Les deux autres
preuves sur les échantillons USDA/wger passent aussi. Aucun appel réseau ni appareil
physique dans ces tests. Démarrage du worker +hash complet +première recherche :
**13,99 s** ; conserver la préparation du worker avant la saisie utilisateur.

Rapports : `report.json`, `coverage.json`, `journal-proof.json` et
`registry-comparison.json` dans le nouveau workspace. Tests de cette passe :
**149 Python /92 Node**, aucun échec ni ignoré ; `git diff --check` passe.
Les fichiers modifiés sont `wger-full.mjs`, `wger-normalize.mjs`,
`wger-full.test.mjs`, `wger-journal-proof.mjs` et ce document.
Pas de migration utilisateur, de route activée, de déploiement, de commit ou de push.

## Complément OFF sans reconstruction wger — 26 octobre 2026

### Audit réel du rapprochement

`off-overlay-audit.py` ouvre la génération wger scellée en lecture seule, vérifie
son hash, parcourt les fiches françaises en streaming et construit un petit index
de cibles **dans un nouveau workspace**. Aucun fichier de la génération wger
n'est modifié. Résultat dans `off-overlay-audit-20261026/report.json` :

- 962 089 fiches françaises, dont 962 086 dérivées d'OFF ;
- 951 664 références avec code utilisable, soit **951 641 codes exacts distincts** ;
- tous ces codes correspondent exactement au code de l'URL OFF d'origine : aucune
  contradiction détectée ; 127 339 références conservent des zéros initiaux ;
- 19 codes exacts répétés, 272 groupes d'alias de représentation GTIN, 10 670
  références dont la clé de contrôle GTIN est incorrecte ;
- 10 421 références sans code stocké utilisable, un code entièrement nul écarté ;
- index de correspondance **80 457 728 octets (76,73 Mio)**, audit 134,59 s,
  CPU 102,00 s, pic RSS 44,88 Mio, aucun réseau.

L'égalité exacte prime. Le remplissage GS1 à 14 chiffres n'est qu'une clé d'alias
pour les codes à clé de contrôle valide ; les chaînes originales sont conservées.
Un numéro qui échoue au checksum reste en rapprochement exact seulement. Même une
clé correcte ne certifie pas que les contributeurs ont identifié le bon produit.
Une collision de valeurs OFF derrière un même alias exige une résolution explicite,
pas la fusion des macros. Source :
https://support.gs1.org/support/solutions/articles/43000734355-what-is-the-required-format-of-gtin-in-gs1-edi-standards-

### Référence nutritionnelle : ce qui est établi, ce qui ne l'est pas

Le schéma historique décrit `_100g` comme 100 g **ou 100 ml**. Son enum
`nutrition_data_per` est `100g`/`serving`, et ne suffit pas à certifier masse/volume.
Ni le poids du paquet, ni le nom du produit, ni la catégorie ne deviennent une
preuve de base pour openGym. L'extrait TSV réel existant ne contient ni le nouveau
champ `nutrition`, ni `nutrition_data_per`, ni l'unité de portion ; il ne résout pas
ce problème. Les vingt lignes HF simplifiées contiennent neuf `100g`, neuf `serving`
et deux valeurs absentes, mais **aucun objet `nutrition`**. Elles ne constituent pas
un échantillon du schéma JSONL brut actuel. Le fichier du benchmark v3 contient une
fixture nommée « Fixture spread » ; il n'est pas une capture OFF réelle et ne doit
jamais être promu au catalogue.

Les champs pertinents du nouveau schéma sont :

- `nutrition.aggregated_set.per` (`100g`/`100ml`), `preparation=as_sold` ;
- les valeurs, unités normalisées, sources et modificateurs de chaque nutriment ;
- `nutrition.input_sets[].per`, `per_quantity`, `per_unit`, `preparation`, `source`,
  et `nutrients`, pour les tables d'entrée explicites ;
- portions avec quantité et unité interprétables, et qualité/absence de nutrition.

Le code officiel stocke l'agrégat dans l'objet produit. Cela rend son utilisation
hors ligne possible **si l'export effectif le conserve**, ce qui reste à vérifier
sur une capture brute. Certaines tables sont `prepared` plutôt qu'`as_sold` ; les
sources estimées, modificateurs et valeurs `value_computed` ne doivent pas être
promus comme valeurs déclarées. Un agrégat préparé ne remplace pas une table vendue.
Des tables par portion peuvent être exploitables si quantité/unité sont explicites
et les quatre valeurs cohérentes d'une même table ; conversions via le moteur,
sans densité inventée. Le support des input_sets/portions nécessitera une projection
stricte séparée ; ne pas les déguiser directement en agrégat normalisé.

Les preuves viennent des schémas et de `Nutrition.pm`, pas d'un taux observé dans
le dump : **aucune proportion de fiches françaises débloquées n'est connue**.
Sources primaires :
- https://github.com/openfoodfacts/openfoodfacts-server/blob/main/docs/api/ref/schemas/product_nutrition.yaml
- https://github.com/openfoodfacts/openfoodfacts-server/blob/main/docs/api/ref/schemas/product_nutrition_v3.yaml
- https://github.com/openfoodfacts/openfoodfacts-server/blob/main/docs/api/ref/schemas/product_nutrition_properties.yaml
- https://github.com/openfoodfacts/openfoodfacts-server/blob/main/lib/ProductOpener/Nutrition.pm
- https://github.com/openfoodfacts/openfoodfacts-exports

### Petite capture reproductible, sans autoriser le gros téléchargement

`off-jsonl-sample.py` demande un préfixe HTTP Range de **4 Mio maximum**, expansion
32 Mio, ligne 8 Mio, durée 90 s, pas de retry et refus d'un HTTP 200 ignorant Range.
Il réutilise la liste de redirections HTTPS officielle déjà vérifiée. L'échantillon
n'est pas représentatif et ne vérifie pas le CRC du dump entier. La tentative ici
a échoué une fois à la résolution DNS (`jsonl-dns-error`) ; aucun produit téléchargé.
`off-jsonl-inspect.py` vérifie compte/hash et recense les champs sans créer de Foods.
Un candidat de schéma n'est jamais annoncé comme un Food validé par le moteur.

Commande SSH préparée, à faible volume :

```bash
cd /home/codex/openGym
OFF_PROBE="off-raw-$(date -u +%Y%m%dT%H%M%SZ)"
python3 scripts/nutrition-local-catalog/off-jsonl-sample.py \
  --workspace "$OFF_PROBE" --rows 200 --fetch && \
python3 scripts/nutrition-local-catalog/off-jsonl-inspect.py "$OFF_PROBE"
printf '%s\n' "$OFF_PROBE"
```

Le taux du préfixe sera seulement un signal de présence de schéma. Une extraction
française diversifiée sera nécessaire avant toute estimation de couverture.

### Architecture et budget proposés

Conserver wger immuable et produire un complément SQLite indépendant contenant les
Foods OFF validés, un FTS littéral et les correspondances par code/UUID. Une nouvelle
sélection utilise **tout le nouveau tableau OFF**, pas ses unités greffées aux anciens
nutriments wger d'une autre révision. Sources, crédits ODbL/DbCL, version, checksum,
état de validation et référence sont conservés ; anciennes consommations et leurs
snapshots ne changent jamais. Les images restent exclues.

La lecture fédérée doit épingler un bundle `(hash wger, hash complément, hash aliases)`.
Le bundle ne bascule qu'après vérification des fichiers complets, fsync et renommage
atomique ; les lecteurs actifs gardent leur version. Une interruption conserve
l'ancien bundle et les générations. L'outbox personnelle et ses reçus n'entrent pas
dans le catalogue. La recherche et la sélection ne disposent d'aucun fallback API.
Les nouveaux Foods peuvent être stockés dans le contrat utilisateur v1 existant.
Le DTO catalogue devra accepter les deux identités wger/OFF, avec attribution propre.

Budget prudent, **sans supprimer les fichiers existants** : environ 34,3 Gio libres
au début de cette passe. Taille JSONL connue du 12 octobre seulement : 12,23 Gio,
à revérifier. Pour 100 000 produits sélectionnés, prévoir deux générations plafonnées
à 1 Gio chacune, 0,5 Gio de temporaires, 0,25 Gio d'index de cibles et 1 Gio de marge
opérationnelle, en plus de la source : environ **15,98 Gio supplémentaires**, ce qui
laisserait seulement **18,3 Gio**. **Le dump compressé complet sur ce VPS n'est donc
pas autorisé par ce dimensionnement.** `.partial` → source par renommage évite une
deuxième copie du même téléchargement, mais ne suffit pas à rendre ce budget prudent.

Solution recommandée après validation de l'échantillon et accord de transfert :
filtrer sur une autre machine disposant du dump, puis transférer une projection
française bornée. Alternative : un seul passage HTTP/gzip en streaming sur le VPS,
sans conserver les 12,23 Gio compressés ni la source décompressée. Ce dernier cas
reste **un téléchargement massif nécessitant un accord explicite**, même si le disque
reste borné. Budget local cible : projection plafonnée 0,5 Gio + deux générations
1 Gio + temporaires 0,5 Gio + cibles 0,25 Gio + marge 1 Gio = **4,25 Gio**, laissant
environ 30 Gio. Les valeurs sont des plafonds à confirmer sur un vrai extrait,
pas une taille mesurée du futur complément.

Un flux gzip interrompu n'est pas reprenable à un octet arbitraire sans état/index
de décompression : garder le staging invalide et relire le flux source, ou faire
la réduction depuis un gzip complet téléchargé/reprenable sur l'autre machine.
Aucune publication avant EOF/CRC/hash. Déduplication sur disque, lots bornés,
cache SQLite et processus plafonnés, garde 20 Gio/2 Gio pendant toute l'opération.
Sélection par quotas et hash stable des codes sur **tout** le flux (réemploi du
principe `select-tsv.py`), pas les cent mille premières lignes.

Le gain chiffrable aujourd'hui est une borne : 951 641 codes français exacts à
rapprocher, pas 951 641 Foods garantis. Pour remplir un complément de 100 000 fiches,
il faut au moins 10,51 % de correspondances réellement présentes, à référence
explicite, complètes et cohérentes. À 50 000 fiches, il faut 5,25 %. Le taux réel et
la pertinence des grandes marques restent inconnus tant que le JSONL n'est pas reçu.

### Génériques : une voie immédiatement réalisable sans OFF

L'audit a retrouvé les vrais Foods connus derrière des noms anglais. Sept libellés
français candidats ont été préparés, avec IDs, noms d'origine et préparation exacts :
banane crue, œuf cru frais, lait entier enrichi vitamine D (en g), riz blanc cru à
grain moyen, pâtes sèches non enrichies, yaourt nature entier, poulet cru sans peau
ni os. Le lait reste en g : aucune conversion arbitraire en ml. Les libellés sont
des traductions proposées par openGym, pas des noms français fournis par wger.
Les sources CC BY-SA/CC0 et les snapshots originaux restent inchangés.

`off-overlay-benchmark.mjs` + `off-alias-index.py` ont construit un index d'alias
séparé **28 672 octets** et validé les sept résultats cibles contre leur UID attendu.
Chaque Food a réellement passé les commandes journal, puis une réouverture avec
snapshots et opérations non acquittées conservés. Zéro réseau ; pas de UI ni appareil
physique. p95 0,064–0,264 ms pour cet index de **sept lignes seulement**, sans
extrapolation aux trois millions. Artefact final `off-alias-proof-20261026-v3`.
Deux premières tentatives de micro-benchmark sont conservées : le terme « lait »
apparaissait aussi dans le libellé du yaourt. Un poids plus fort des termes d'alias
explicites et une vérification du premier UID attendu corrigent la confusion.
Il s'agit d'un test top-1 sur des cas curatés, pas de 100 % de couverture nationale.

Commandes reproductibles (workspaces neufs uniquement) :

```bash
python3 scripts/nutrition-local-catalog/off-overlay-audit.py --workspace off-overlay-audit-20261026
node scripts/nutrition-local-catalog/off-overlay-benchmark.mjs \
  off-overlay-audit-20261026 off-alias-proof-20261026-v3
python3 -m unittest discover -s scripts/nutrition-local-catalog -p test_off_overlay.py -v
node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/off-overlay.test.mjs
```

Les tests isolés ajoutés passent : 12 Python, 3 Node. Ils couvrent bornes/capture,
DNS/timeout/429/503 sans retry, Range obligatoire, gzip invalide, bases g/ml, champs
legacy insuffisants, préparé/estimé/calculé, identités et aliases sans mutation des
Foods. Le complément OFF n'est pas construit et le catalogue actif est inchangé.


### Mission de nuit — complément français isolé (26 octobre 2026, en cours)

Le complément `wger-complement.py` contient uniquement des libellés de recherche français curatés et les UUID de fiches existantes. Il ne fabrique ni nutriments ni références OFF. `wger-fr-curation.json` épingle le SHA de la génération avec registres confirmés, le nom original exact et 21 sélections génériques (préparation précisée). Une sélection n’est acceptée que si sa fiche originale est complète, ajoutable, sans marque et de source USDA ou wger. Le lait entier enrichi et l’huile restent pour 100 g, jamais pour 100 ml. Aucun lait américain à 2 % n’est rebaptisé lait demi-écrémé français. Le pain blanc n’est pas automatiquement considéré comme du pain de mie.

Le Food retourné reste exactement celui de la base, y compris son nom original, son ID et ses attributions. Le libellé français appartient à la recherche et est marqué comme traduction proposée par openGym. Conséquence visible : le journal conserve actuellement le nom original, souvent anglais. Ce compromis évite de modifier les instantanés ou de présenter une traduction comme un libellé fabricant. Une traduction persistante future devra être une nouvelle fiche avec crédit de modification et ID distinct.

Le lecteur V1 (`wger-v1-reader.py`) épingle la base et le complément immuables ; il filtre les fiches ajoutables avant le classement. Les identités ambiguës restent consultables par code-barres/UUID avec Food absent. Les recherches sont littérales, accentuées/préfixées, sans fuzzy et sans module HTTP. Le complément est publié par un manifeste atomique après fsync, intégrité SQLite/FTS et contrôle du lien au contenu original. Un verrou de maintenance interdit deux écrivains ; les anciens fichiers ne sont jamais supprimés ; `previous.json` permet un rollback. Les lecteurs ouverts gardent leur génération. Plafonds : 1 000 alias, 1 Mio d’entrée, 16 Mio par base et 64 Mio par workspace.

Les tests et mesures de cette extension sont en cours. Ces fichiers ne constituent ni une activation applicative ni un enrichissement OFF validé. Les fiches de marques françaises restent un blocage à mesurer, pas une couverture acquise.

#### Raccordement V1 en développement, désactivé par défaut

`NUTRITION_LOCAL_CATALOG_KIND=wger-v1` sélectionne maintenant un relais local distinct, uniquement avec `NODE_ENV=development`, `NUTRITION_LOCAL_CATALOG=1` et un `DATA_DIR` isolé explicite. `NUTRITION_LOCAL_CATALOG_WORKSPACE` désigne la base et `NUTRITION_LOCAL_CATALOG_COMPLEMENT` le complément optionnel. Les chemins sont des noms de workspace stricts, pas des chemins clients. Le relais ne construit aucun client OFF ni cache v3 ; un manque/échec reste local. Les doublons de codes-barres avec plusieurs Foods ajoutables nécessitent une sélection explicite par nom, plutôt qu’un choix arbitraire. Les gardes d’origine et de surcharge HTTP existants restent appliqués.

La capacité HTTP v2 identifie `provider:wger`, `selection:local-only`, `productIds:true`. Le corps de données a sa propre enveloppe `opengym-local-food-catalog` v1, sans déguiser une fiche USDA/wger en réponse OFF. Les clients anciens conservent leur protocole v1 hors de ce mode expérimental. `VITE_NUTRITION_LOCAL_V1=1` impose côté Web/Android une fermeture sûre : sans capacité locale v2 valide, aucune consultation alimentaire distante n’est tentée. Sur Android invité, `VITE_NUTRITION_CATALOG_ORIGIN` fournit l’origine publique openGym, sans jeton ni cookie. Les recherches/sélections utilisent les mêmes routes publiques openGym, pas les APIs des fournisseurs.

Le frontend conserve sa combobox et le debounce existant. Une sélection relit l’UUID local, valide le Food et l’égalité de sa provenance/référence, puis utilise la commande durable du journal déjà existante. Les produits wger utilisés sont inclus dans la bibliothèque locale et les crédits suivent les snapshots, y compris dans les recettes. Les deux nouvelles clés i18n ont des traductions proposées dans les 18 locales ; elles n’ont pas reçu de relecture humaine dans chaque langue. Aucun identifiant Android, service de production ou contrat utilisateur n’est modifié. Validation automatisée de ce raccordement : en cours.


### Durcissement final de nuit et benchmark public

**État de données :** aucune fiche OFF originale n’a été enrichie sans preuve. Le petit JSONL brut reste manquant. Le rapprochement préparé identifie 951 641 codes-barres français exacts ; ce nombre n’est pas un gain d’aliments validés. Aucun nouveau dump n’a été téléchargé. Le complément final est `wger-fr-quality-20261026`, format interne `opengym-wger-french-complement` version **2**, lié au SHA de la base. L’ancien complément d’alias version 1 est conservé dans son workspace mais n’est pas accepté par ce lecteur V1 durci. Le contrat utilisateur Nutrition v1 n’a pas changé.

**Qualité :** une fiche USDA « Coca-Cola Can, 12 Fl Oz » déclare quatre zéros. Un audit streaming des 124 943 candidats a relevé 3 943 profils de ce type, dont des produits possiblement légitimes comme l’eau ou le thé. Il est impossible d’établir leur exactitude à partir des seuls zéros importés. Ils restent consultables, marqués `zero-only-nutrition-needs-verification`, sans Food ajoutable. Ils ne sont ni supprimés ni déclarés faux. Les zéros explicites des aliments personnels restent autorisés selon le moteur. La liste de revue est un petit index séparé, joint en lecture seule avant le classement. Aucun scan JSON global n’est exécuté par recherche. Le mode V1 requiert désormais ce complément vérifié ; son absence/corruption est une indisponibilité locale sans repli distant.

Le complément contient 22 libellés, dont un Coca-Cola USDA explicitement qualifié « bouteille 1,75 litre, pour 100 g », avec 39 kcal/10,8 g de glucides déclarés dans cette fiche. Il n’est pas affirmé qu’il s’agit de la recette française actuelle et aucune conversion en ml n’est faite. Cela corrige le résultat « bonbons Coca-Cola » devant une boisson sans prétendre résoudre les marques françaises. Construction : 34,64 s dont intégrité de base, 23,58 s CPU, pic Python 29 744 Kio, 434 176 octets SQLite. Pas de copie ni réimport des 4,984 Gio wger.

**Preuves de parcours :** `wger-v1-proof.mjs` a relu les 22 fiches réelles via le worker et le relais API de service, puis le normaliseur frontend et le vrai service de commandes Nutrition. Les 22 ajouts à 50 g, réouvertures du pont FS de laboratoire, totaux et files non acquittées sont vérifiés. Six recherches simultanées ont réussi. Intégrité initiale : 12,45 s ; parcours total : 14,06 s ; RSS Node 71 064 Kio et worker 29 644 Kio. Le code-barres français Nutella `3017620422003` est présent mais reste non ajoutable, car sa référence OFF originale manque. Aucun HTTP fournisseur, vrai navigateur ou appareil n’est utilisé dans cette preuve.

**Benchmark :** les 18 requêtes génériques curatées restent des tests de non-régression. Elles ne prouvent aucune couverture de marché. Le nouveau [protocole public](NUTRITION_CATALOG_BENCHMARK.md) fige 1 000 produits issus du véritable préfixe TSV OFF, sans sélectionner les cas selon leurs résultats. Il distingue identité exacte, ajoutabilité, titres inexploitables et pertinence humaine. Les sources Open Prices/OFF/ESCI, leurs limites, licences et commandes de capture sont documentées dans cette référence. Le premier résultat public est défavorable : 311 codes présents, zéro produit attendu ajoutable dans cet échantillon. Ne pas transformer les 111 recherches ayant retourné *un autre* Food utilisable en 111 succès. Le préfixe source est biaisé et ne mesure pas la France entière.

**Corrections de revue :**

- Fonctionnelle : le premier parcours UI wger enregistrait l’entrée mais pas l’aliment, car `EntryEditor` ne reconnaissait que OFF. Les produits wger reconnus sont maintenant publiés avec `savedFoods` dans la même commande atomique ; le test vérifie modification, réouverture, suppression puis réajout sans fournisseur.
- Données/classement : filtres avant classement, profils à quatre zéros mis en revue, identités ambiguës jamais promues par un nom ou une portion. Les sélections conservent Food, ID, nutrition et crédits d’origine ; les traductions sont seulement des libellés de recherche crédités openGym.
- Concurrence/sécurité : UUID stricts, routes publiques bornées, suppression des chemins arbitraires dans le transport natif local ; réponses tardives, fermeture de session, cache borné et commandes durables réutilisent les barrières existantes. Le lecteur épingle deux fichiers immuables et reste indépendant des changements de comptes.
- Packaging : les imports du prototype sont calculés puis chargés uniquement sous le garde de développement. Les imports littéraux externes au contexte API ont été corrigés après échec du test de packaging ; le Dockerfile de production ne dépend pas de Python.
- UX/crédits : URI et attributions conservés en texte, seuls liens de licences fixes navigables, chaînes de métadonnées vérifiées avant rendu, retour à la ligne des URI longues. Une erreur de syntaxe du pack pt-BR a été corrigée dans son véritable objet d’overrides, sans affaiblir le contrôle des locales.

Les manifestes v2, fichiers anciens et bases initiales sont conservés. Le rollback ne supprime rien ; seuls des compléments v2 validés et liés à la même base sont compatibles avec le lecteur durci. Une génération v1 d’alias n’est pas un retour arrière nutritionnel validé. Aucune version expérimentale n’est devenue catalogue officiel.


#### Mesures finales et validations reproductibles

Le contrôle final des 22 fiches réelles est dans `artifacts/wger-v1-proof-final-20261026/report.json` : 22/22 publications/réouvertures, six lectures concurrentes, profil à quatre zéros bloqué, Nutella français présent mais non ajoutable. Démarrage intègre 10,57 s ; redémarrage après SIGKILL 12,03 s ; totalité 24,05 s ; Node 71 056 Kio RSS maximal, worker 29 704 Kio. Il s’agit d’un vrai processus Python/SQLite et d’un pont FS de laboratoire ; pas d’un test HTTP réel, d’un navigateur, d’un Android/iOS physique ou d’une coupure électrique.

La comparaison appariée de dix lectures par requête, corpus identique, est conservée dans `artifacts/wger-v1-final-coverage-20261026/coverage.json`. Exemples p95 avant/après : riz 45,24 → 26,23 ms ; lait 111,11 → 52,58 ms ; poulet 116,10 → 58,53 ms ; Coca-Cola 20,93 → 9,52 ms. Les 18 sélections génériques attendues apparaissent dans les cinq premiers résultats. Cela reste une régression curatée. Le benchmark public de 1 000 cas et sa méthode séparée sont la référence de couverture, avec leurs limites de préfixe et l’absence actuelle d’annotations humaines.

Le chargement V1 refuse un complément absent/incompatible **avant** le hash de la grosse base. Une erreur d’initialisation émet une erreur cadrée puis ferme le processus ; le superviseur limite les reprises à trois par minute. Une configuration de développement V1 invalide ou un module Python/prototype manquant conserve un relais local indisponible, jamais un relais fournisseur. Une première sonde de capacités échouée peut être reprise lors d’une vraie recherche ultérieure ; aucune boucle réseau de fond n’est ajoutée. Un résultat de code-barres atteignant le plafond de variantes exige un choix explicite, car l’unicité n’est plus démontrée.

Tests finaux du prototype : **181 Python et 95 Node réussis**, zéro échec/ignoré. Incluent budgets, données réelles anormales, doublons, FTS littéral, injection, corruptions, génération immuable, écrivain concurrent refusé, SIGKILL après scellement mais avant manifeste, publication répétée et retour arrière. Les onze tests de benchmark public et de jointure font partie des 181, ils ne s’y ajoutent pas.

Frontend complet : **5 815 réussites, 7 échecs EPERM** de `spawnSync node` dans `scripts/check-locales.test.mjs`, zéro ignoré (440 fichiers, 5 822 tests). La commande a été exécutée avec un seul worker pour préserver la RAM. Le contrôle direct des locales passe : 18 packs × 2 466 clés. La passe ciblée finale du catalogue/UI est rapportée séparément ; ne pas additionner ses tests à la suite complète. Les dernières petites corrections de reprise de capacités et de transport borné sont couvertes par cette passe ciblée et les builds finaux.

API : tous les **88 fichiers** du glob du dépôt ont été exécutés séparément avec `node --test --experimental-test-isolation=none` et `NUTRITION_REQUIRE_HTTP_TESTS=1`. Le dernier passage rapporte **574 réussites, 222 échecs, zéro ignoré**, sur 796 tests comptabilisés ; `e2e-apikey.test.js` s’interrompt aussi sur EPERM avant de produire un compteur. Les sockets sont refusés (`listen EPERM`) ; la CLI fixture Coach retourne une sortie vide dans cette sandbox (un probe indépendant de `spawnSync node` confirme EPERM). Ces résultats ne sont pas une validation API complète et n’excluent pas des défauts masqués à contrôler en SSH. Les tests unitaires du relais V1 et le packaging passent. Les derniers gardes V1 sont également relancés dans le groupe ciblé final.

Quatre autres échecs réels des premiers passages venaient de fixtures Coach datées juillet/août 2026, désormais hors fenêtre de 12 semaines. Le diagnostic à date fixe a confirmé la cause. Les quatre tests concernés disposent maintenant d’une horloge `Date` limitée à leur contexte de test ; assertions, fixtures et code des entraînements inchangés. Le défaut de syntaxe pt-BR et l’import expérimental échappant au contexte de packaging ont également été corrigés, puis retestés. Les totaux ci-dessus sont ceux du passage final, pas un cumul de relances.

Build Web et bundle Web mobile : réussis dans des sorties isolées, sans remplacer `frontend/dist` ni synchroniser automatiquement les projets natifs. Le contrôle `checkCopy` mobile passe. Les avertissements de chunks volumineux/imports dynamiques restent ceux du build existant. `./gradlew --offline --version` échoue car `JAVA_HOME`/Java sont absents : aucun APK construit. Docker est installé mais son socket refuse l’accès : aucune image construite ni conteneur lancé ici. Le Dockerfile **de laboratoire uniquement** embarque les fichiers wger/Python nécessaires ; le Dockerfile de production est inchangé.

Reproduction des groupes (pas d’Internet nécessaire pour les tests) :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
mkdir -p scripts/nutrition-local-catalog/artifacts/test-tmp
TMPDIR="$PWD/scripts/nutrition-local-catalog/artifacts/test-tmp" \
  python3 -m unittest discover -s scripts/nutrition-local-catalog -p 'test_*.py'
node --test --experimental-test-isolation=none scripts/nutrition-local-catalog/*.test.mjs
cd frontend
npm test -- --maxWorkers=1
npm test -- src/lib/nutrition/catalog src/views/nutrition/FoodCatalog.test.jsx src/lib/pt-br-locale.test.js
node scripts/check-locales.mjs
cd ../api
# Hors sandbox : commande complète prévue par package.json, HTTP strict.
NUTRITION_REQUIRE_HTTP_TESTS=1 npm test
# HTTP ciblé réellement nécessaire, fournisseur simulé :
NUTRITION_REQUIRE_HTTP_TESTS=1 node --test test/catalog-wger-http.test.js test/catalog-local-http.test.js test/food-catalog-http.test.js test/server-food-catalog.test.js test/server-local-catalog.test.js test/nutrition-http.test.js test/server-nutrition.test.js
```

#### Laboratoire Web et Android — aucun déploiement

Vérifier d’abord que les ports 3002 et 5180 sont libres. Ne pas arrêter un service existant pour les libérer. Terminal SSH 1, source checkout et DATA_DIR neuf :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
NUT_V1_DATA=$(mktemp -d /tmp/opengym-nutrition-v1.XXXXXX)
NODE_ENV=development DATA_DIR="$NUT_V1_DATA" PORT=3002 ORIGIN=http://localhost:5180 \
NUTRITION_LOCAL_CATALOG=1 NUTRITION_LOCAL_CATALOG_KIND=wger-v1 \
NUTRITION_LOCAL_CATALOG_WORKSPACE=wger-full-registered-20261025 \
NUTRITION_LOCAL_CATALOG_COMPLEMENT=wger-fr-quality-20261026 \
OFF_CATALOG_TRACE=1 npm --prefix api start
```

Attendre le démarrage effectif de l’API (le hash complet prend environ 12–14 s). Terminal SSH 2 :

```bash
cd /home/codex/openGym/frontend
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
API_TARGET=http://127.0.0.1:3002 API_ORIGIN=http://localhost:5180 \
VITE_NUTRITION_LOCAL_V1=1 npm run dev -- --host 127.0.0.1 --port 5180 --strictPort
```

Depuis le poste de travail : `ssh -N -L 5180:127.0.0.1:5180 -L 3002:127.0.0.1:3002 codex@debian-serv`, puis Firefox `http://localhost:5180` avec un profil de test. Continuer sans compte ; tester riz/œufs/yaourt, sélection, g, ajout, modification, suppression, réouverture. Vérifier le cache local sans fournisseur et les états de sauvegarde locale ; ne pas les confondre avec une synchronisation serveur. Les enseignes Auchan/Leclerc/Lidl/Intermarché et les variantes lait demi-écrémé/riz basmati/pain de mie/lait d’amande restent des lacunes constatées. Le Nutella français par code-barres reste bloqué, même si une autre fiche nommée Nutella est techniquement ajoutable.

Pour Android, utiliser un émulateur ou appareil de test sans données réelles. Après installation locale d’un JDK compatible et du SDK Android, sans changer l’application de production :

```bash
cd /home/codex/openGym/frontend
# Exemple pour USB/émulateur avec un tunnel 3002 sur le poste ADB.
VITE_NUTRITION_LOCAL_V1=1 VITE_NUTRITION_CATALOG_ORIGIN=http://127.0.0.1:3002 npm run build:mobile
cd android
./gradlew --no-daemon assembleDebug
# Sur le poste ADB : adb reverse tcp:3002 tcp:3002
```

APK attendu : `frontend/android/app/build/outputs/apk/debug/app-debug.apk`. Le HTTP loopback doit être permis dans l’environnement de debug ; sinon employer une origine HTTPS de laboratoire. Ne pas modifier la politique de sécurité de production, l’applicationId ou désinstaller/remplacer une application contenant des données réelles. La construction effective et l’installation ne sont pas validées ici. Le Vite local et le catalogue peuvent être désactivés en arrêtant ces seuls processus de laboratoire ; le mode V1 côté client refuse alors le catalogue distant et conserve les aliments sauvegardés.

#### Docker isolé — commandes à exécuter hors sandbox

Le montage se fait **fichier par fichier en lecture seule** : aucun chmod du catalogue existant et aucune copie supplémentaire de 5 Gio. Les répertoires parents privés de l’hôte ne sont pas exposés. Garder le réseau coupé démontre l’absence de dépendance fournisseur. Ne continuer qu’avec un accès Docker déjà autorisé ; aucune modification des groupes/services n’est prévue.

```bash
cd /home/codex/openGym
NUT_BASE="$PWD/scripts/nutrition-local-catalog/artifacts/wger-full-registered-20261025"
NUT_COMP="$PWD/scripts/nutrition-local-catalog/artifacts/wger-fr-quality-20261026"
NUT_BASE_FILE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["file"])' "$NUT_BASE/current.json")
NUT_COMP_FILE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["file"])' "$NUT_COMP/current.json")
NUT_LAB_NAME="opengym-nutrition-v1-$(date -u +%Y%m%dT%H%M%SZ)"
docker build -f scripts/nutrition-local-catalog/Dockerfile.api-lab -t opengym-nutrition-v1-lab .
docker run -d --rm --name "$NUT_LAB_NAME" --network none --read-only \
  --memory 384m --cpus 1 --pids-limit 32 --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -e NUTRITION_LOCAL_CATALOG_KIND=wger-v1 \
  -e NUTRITION_LOCAL_CATALOG_WORKSPACE=wger-full-registered-20261025 \
  -e NUTRITION_LOCAL_CATALOG_COMPLEMENT=wger-fr-quality-20261026 \
  --mount "type=bind,src=$NUT_BASE/current.json,dst=/app/scripts/nutrition-local-catalog/artifacts/wger-full-registered-20261025/current.json,readonly" \
  --mount "type=bind,src=$NUT_BASE/$NUT_BASE_FILE,dst=/app/scripts/nutrition-local-catalog/artifacts/wger-full-registered-20261025/$NUT_BASE_FILE,readonly" \
  --mount "type=bind,src=$NUT_COMP/current.json,dst=/app/scripts/nutrition-local-catalog/artifacts/wger-fr-quality-20261026/current.json,readonly" \
  --mount "type=bind,src=$NUT_COMP/$NUT_COMP_FILE,dst=/app/scripts/nutrition-local-catalog/artifacts/wger-fr-quality-20261026/$NUT_COMP_FILE,readonly" \
  opengym-nutrition-v1-lab
docker logs -f "$NUT_LAB_NAME"
# Après annonce du démarrage, quitter seulement le suivi de logs, puis :
docker exec "$NUT_LAB_NAME" node -e "fetch('http://127.0.0.1:3002/api/nutrition/catalog/capabilities').then(r=>r.json()).then(console.log)"
docker exec "$NUT_LAB_NAME" node -e "fetch('http://127.0.0.1:3002/api/nutrition/catalog/search?q=riz&local=1').then(r=>r.json()).then(v=>console.log(v.products.map(p=>({name:p.name,reference:p.reference}))))"
# Arrêter uniquement ce nouveau conteneur de laboratoire.
docker stop "$NUT_LAB_NAME"
```

Ressources/disponibilité/permissions en Docker restent à vérifier réellement. Les tests de corruption et rollback ont été exécutés sur fichiers/worker isolés, pas dans un conteneur fonctionnel ici.


#### Traçabilité des fichiers de cette passe

Ces 68 fichiers ont été créés ou retouchés pendant l’étude OFF et la mission de nuit. Certains contenaient déjà des changements antérieurs : cette liste ne revendique pas tout leur diff depuis HEAD. Les archives, bases et mesures dans `artifacts/` sont ignorées par Git et ne sont pas des données utilisateur. Aucun fichier préexistant n’a été réinitialisé.

**Audit OFF, complément, benchmark, worker et image de laboratoire**

- `scripts/nutrition-local-catalog/off-overlay-audit.py`
- `scripts/nutrition-local-catalog/off-jsonl-sample.py`
- `scripts/nutrition-local-catalog/off-jsonl-inspect.py`
- `scripts/nutrition-local-catalog/off-overlay-benchmark.mjs`
- `scripts/nutrition-local-catalog/off-alias-index.py`
- `scripts/nutrition-local-catalog/off-overlay.test.mjs`
- `scripts/nutrition-local-catalog/test_off_overlay.py`
- `scripts/nutrition-local-catalog/wger-complement.py`
- `scripts/nutrition-local-catalog/wger-v1-reader.py`
- `scripts/nutrition-local-catalog/wger-fr-curation.json`
- `scripts/nutrition-local-catalog/wger-v1-coverage.py`
- `scripts/nutrition-local-catalog/wger-v1-proof.mjs`
- `scripts/nutrition-local-catalog/test_wger_complement.py`
- `scripts/nutrition-local-catalog/public-benchmark-sample.py`
- `scripts/nutrition-local-catalog/public-benchmark.py`
- `scripts/nutrition-local-catalog/test_public_benchmark.py`
- `scripts/nutrition-local-catalog/public-benchmark-labels.py`
- `scripts/nutrition-local-catalog/test_public_labels.py`
- `scripts/nutrition-local-catalog/wger-generation.py`
- `scripts/nutrition-local-catalog/wger-worker-client.mjs`
- `scripts/nutrition-local-catalog/wger-api-adapter.mjs`
- `scripts/nutrition-local-catalog/wger-full.test.mjs`
- `scripts/nutrition-local-catalog/Dockerfile.api-lab`
- `scripts/nutrition-local-catalog/Dockerfile.api-lab.dockerignore`

**API expérimentale, OpenAPI et tests**

- `api/openapi.yaml`
- `api/nutrition/catalog-wger.js`
- `api/nutrition/catalog-local.js`
- `api/nutrition/food-catalog.js`
- `api/test/catalog-wger.test.js`
- `api/test/catalog-wger-http.test.js`
- `api/test/payload.test.js`
- `api/test/payload-bounds.test.js`
- `api/test/prompt-split.test.js`

**Adaptation frontend, provenance, cache et parcours réels**

- `frontend/src/lib/nutrition/catalog/local-product.js`
- `frontend/src/lib/nutrition/catalog/local-fixtures.test-util.js`
- `frontend/src/lib/nutrition/catalog/local-product.test.js`
- `frontend/src/lib/nutrition/catalog/client.js`
- `frontend/src/lib/nutrition/catalog/public-relay.js`
- `frontend/src/lib/nutrition/catalog/public-relay.test.js`
- `frontend/src/lib/nutrition/ui-session.js`
- `frontend/src/views/nutrition/FoodCatalog.jsx`
- `frontend/src/views/nutrition/FoodCatalog.test.jsx`
- `frontend/src/views/nutrition/Journal.jsx`
- `frontend/src/views/nutrition/Library.jsx`
- `frontend/src/views/nutrition/common.jsx`
- `frontend/src/nutrition.css`

**Deux clés de traduction, avec overrides pt-BR explicites**

- `frontend/src/locales/ar.js`
- `frontend/src/locales/bn.js`
- `frontend/src/locales/de.js`
- `frontend/src/locales/es.js`
- `frontend/src/locales/fr.js`
- `frontend/src/locales/hi.js`
- `frontend/src/locales/hu.js`
- `frontend/src/locales/it.js`
- `frontend/src/locales/ko.js`
- `frontend/src/locales/pl.js`
- `frontend/src/locales/pt-BR.js`
- `frontend/src/locales/pt.js`
- `frontend/src/locales/ru.js`
- `frontend/src/locales/th.js`
- `frontend/src/locales/tr.js`
- `frontend/src/locales/uk.js`
- `frontend/src/locales/zh-TW.js`
- `frontend/src/locales/zh.js`

**Documentation**

- `docs/dev/NUTRITION_LOCAL_CATALOG_PROTOTYPE.md`
- `docs/dev/NUTRITION_FOOD_CATALOG.md`
- `docs/dev/NUTRITION_UI.md`
- `docs/dev/NUTRITION_CATALOG_BENCHMARK.md`

Les modules publics ont leurs invariants documentés en tête/JSDoc. Le contrat de complément et ses raisons sont décrits ci-dessus ; les cas publics, graines, coupures de source et métriques sont dans `NUTRITION_CATALOG_BENCHMARK.md`. La sélection locale relit toujours le descripteur SQLite courant : pas de cache de fiche à 24 h capable de masquer une nouvelle mise en revue après redémarrage. Le cache mémoire borné porte sur la recherche ; les produits consommés restent durables dans `savedFoods`.

Validation ciblée finale frontend : **180 tests / 11 fichiers réussis**, zéro ignoré, selon le log `night-frontend-final.log` ; les builds finaux correspondants sont `night-web-release-check` et `night-mobile-release-check`. Le groupe API ciblé relais/packaging rapporte 22 tests réussis ; le contrôle OpenAPI séparé conserve ses propres compteurs. Ne pas additionner ces relances au passage complet de 796 tests API ou aux 5 822 tests frontend. Les sorties détaillées restent dans `artifacts/night-*.log` et les résultats API par fichier dans `artifacts/night-api-final-files/results.json`.

**Décision de livraison :** prototype expérimental testable, V1 française non prête. Le défaut principal reste l’absence de références OFF originales validées, et le benchmark indépendant n’établit pas une couverture satisfaisante. Les captures publiques bornées et les tests HTTP/physiques doivent précéder toute activation. Aucune tâche automatique, installation globale, modification de services, commit, push ou suppression de catalogue n’a été effectuée.


La collecte préférée pour la prochaine validation utilise maintenant Open Prices France puis une projection OFF par lots des codes retenus, et non deux captures aléatoires dont la jointure serait presque vide. Voir les commandes et limites dans `NUTRITION_CATALOG_BENCHMARK.md`. Ce collecteur n’a pas fait de nouvel appel réseau ici. L’OpenAPI décrit la capacité v2, l’alternative UUID/code et les conflits de variantes ; son YAML a été parsé avec l’outil déjà disponible, sans ajout de dépendance.

Clôture de cette passe : les builds Web et bundle Web mobile finaux passent respectivement en 1,91 s et 1,80 s, avec les avertissements de découpage des bundles conservés. Ce second résultat ne constitue ni `cap sync`, ni une compilation APK, ni un essai Android. Le contrôle OpenAPI séparé passe ses trois tests. Le dernier relevé indique 34,11 Gio de disque libre et 4 683 668 Kio de RAM disponible, au-dessus des réserves demandées. `git diff --check` passe ; branche `feature/nutrition`, HEAD `6610d192`, 38 fichiers suivis modifiés et 139 fichiers non suivis, incluant le travail antérieur préservé. Aucune mise en index, aucun commit ou push.

### Open Prices benchmark: direct Parquet supersedes the failing price Viewer

The reported SSH `sample-http-error-500` changes the **benchmark acquisition**, not the nutrition catalogue. `public-benchmark-parquet.py` downloads the official `prices.parquet` at a pinned Hub revision with publisher LFS SHA-256/size verification and bounded HTTPS redirects. A separate maintenance-only Arrow scan performs the complete France observation census, deduplicates on private SQLite disk, preserves unresolved names and freezes seeded cases without consulting wger. The existing `public-benchmark.py`, OFF label-batch tool and local evaluation rules are reused. No claim about OFF 100 g/100 ml can be derived from price data.

Changed/created in this focused pass: `public-benchmark-parquet.py`, `public-benchmark.py`, `test_public_parquet.py`, `check-public-parquet.py`, `requirements-benchmark.txt`, this document and `NUTRITION_CATALOG_BENCHMARK.md`. No runtime application file or active catalogue changed. The reader is installed only in an ignored isolated tools venv, not in the API/frontend dependency manifests.

Latest full prototype result: 192 Python tests and 95 Node tests pass, zero skipped. The four real-codec checks remain blocked by missing PyArrow, and the actual download stops once on `parquet-dns-error`; no new real price benchmark results are available. The earlier `/tmp` reserve failures and their disk-backed rerun are reported separately in [the benchmark reference](NUTRITION_CATALOG_BENCHMARK.md), together with exact SSH setup/collection/projection/evaluation commands, stop conditions and privacy rules. No deployment, commit, push or user-data modification.

### Network-enabled continuation: completed Open Prices Parquet benchmark

The direct official capture is now complete and reused after the interrupted session: 34,456,811 bytes, revision `6b75f0ba63ca5673bc1cdfba47af941a47341b53`, verified SHA `622e8abb9bfb181d8d0c58c0eb5721fd54950e8ea79c6de9c612cf46239378c4`. DNS and HTTPS work with the expanded session permissions, without changing VPS configuration. PyArrow 26.0.0 is installed only in the ignored tools workspace.

Full scan: 335,600 price observations, 215,926 FR; 77,894 distinct supported-barcode identities plus 8,263 unresolved no-barcode observation cases. Frozen sample: 1,000 cases (913 barcodes), independent of catalogue hits. Real evaluation against the unchanged sealed wger + quality complement finds 600 expected barcodes with numerical macros, **zero** with a reference usable for the journal. All 600 are OFF-derived with the original 100 g/100 ml reference lost. Warm mean/p95 1.010/2.507 ms for 506 executable title queries; no external calls during evaluation. This does not measure national purchasing coverage or human semantic relevance.

The optional independent OFF label join stopped on provider 422; one diagnostic yielded provider 500/auth-check timeout. No retries or large OFF download. Labels remain unresolved. See [the benchmark reference](NUTRITION_CATALOG_BENCHMARK.md#completed-real-parquet-run--network-enabled-session-26-october-2026) for exact source hashes, counters, workspaces, limitations, test commands and reports.

Small corrections from real validation: use Linux per-executable VmHWM rather than inherited `ru_maxrss` for the unchanged 512 MiB memory ceiling; key independent label batches by product code; correct the pip bootstrap URL. Latest suites: 194 Python, 5 real-codec and 95 Node tests pass, zero skipped. Changed in this continuation: `public-benchmark-parquet.py`, `public-benchmark.py`, `public-benchmark-labels.py`, `test_public_parquet.py`, `test_public_labels.py`, `check-public-parquet.py` and these two documents. Previous captures, reports, catalogue generations and user data are preserved. No runtime routes, production configuration, commit, push or deployment changed.

### Original OFF references — coherent input-set proof, no bulk transfer

See [NUTRITION_OFF_REFERENCE.md](NUTRITION_OFF_REFERENCE.md) for the new source proof,
code, sample workspaces, exact macros, checkpoint/locking protocol and the **7.25 GiB
streaming disk budget**. The current original source is 13,262,350,813 compressed
bytes (12.35 GiB); a version-specific conditional HEAD passed, but the full transfer
has **not** been authorized or started.

Critical real finding: Coca-Cola's aggregate can be labelled 100g while its actual
macro/energy sources are the packaging 100ml input. The adapter therefore validates
a complete coherent `nutrition.input_sets` entry, source-scoped quality flags and
units; it never pastes a new unit onto old wger values or derives mass from volume.
The 1,000-row original prefix supplies 130 valid input-set Foods (126 g / 4 ml),
with 776 lacking original input sets. This is not representative French prevalence.
Five extra API probe Foods validate known examples, but API schema conversion is
not evidence of original-dump coverage.

The target union is 980,963 identities (49.6 MB), without rebuilding wger. Final
sample complement: **93 valid targeted Foods**, 88 from actual original rows and
five from maintenance API probes. All 93 pass journal add/close/reopen/snapshot/
pending-operation checks offline. In the fixed 913-barcode Prices frame, **three**
expected products become reference-valid in the isolated complement. No 90% claim,
no active API/UI switch, no user-data update; fuzzy/ranking remain untouched.

The prepared stdin-gzip extractor pins source/target identity, commits checkpoints,
replays ordinary gzip from byte zero, refuses concurrent writers, validates CRC/
length and keeps incomplete work non-publishable. A small locally recompressed real
prefix and SIGKILL simulations validate wiring/recovery, not full-source throughput
or a physical outage. Staged normalization reuses the same core and is restarted
offline into a new workspace if interrupted. Full import, publication and any
cleanup remain separate decisions; no old generation or source is deleted.

### First authorized full OFF stream: interrupted, not a completed import

The single authorized GET stopped on `invalid-stream-code` after 698.23 s.
The last durable checkpoint contains 1,351,000 source lines and 550,833 target
identities; SQLite integrity is correct, but full gzip EOF/CRC was not reached.
No second GET/replay, activation or previous-generation modification occurred.
The original global numeric-code check incorrectly halted on an unrelated malformed
public identity. The prepared explicit non-target-exclusion policy is regression
tested and leaves strict/default admission, target protection, nutrition rules and
resource caps intact. It has not been used for another network pass.

Read-only local checkpoint analysis found 494,560 coherent references (470,099 g /
24,461 ml), including 30,658 observed-France codes. These are **partial-source
laboratory eligibility counts**, not a published complement or full-dump coverage.
The fixed 913-barcode benchmark has 356 coherent matches in that prefix; 396
laboratory journal paths pass with an explicit incomplete-source marker. Full-source
readers still refuse the incomplete staging. See [NUTRITION_OFF_REFERENCE.md](NUTRITION_OFF_REFERENCE.md)
for the complete metrics, source-integrity limitations, rejection reasons, tests,
file list and the renewed decision needed for another ~13.26 GB replay.

## Completed second OFF reference pass (26 October 2026)

The original pinned 13,262,350,813-byte JSONL gzip was completely streamed and
CRC/length checked, without saving the archive. 4,837,307 rows scanned; 956,487
target identities retained; 835,231 strict coherent Foods (803,100 per 100 g,
32,131 per 100 ml). Final complement 1,762,095,104 bytes, separate from the
unchanged wger database. The source/normalizer and old partial workspaces remain.
Source conflict and ambiguous nutrition rejection are unchanged.

The full independent barcode frame has 744/913 captured and 544/913 validated
references, up from 356 in the interrupted prefix and zero in the original wger
baseline. This is not 90% national coverage or proof of text ranking. 48,357
accepted identities were actually observed in France by Open Prices, distinguished
from 829,044 in the wger French-language target cohort. 586 offline journal paths
(510 mass / 76 volume) pass, with immutable snapshots and pending operations.

Final prototype tests: 223 Python / 109 Node passed, no failures or skips. Review
fixed test address-space limit leakage and added parent-directory fsync for new
workspaces. Audit memory uses actual Linux VmHWM, not an inherited rusage peak.
All limits remain; end disk ~30.60 GiB free, available RAM ~4.2 GiB. No application
activation or API/client source changes. The authoritative evidence, commands,
resource details and remaining integration gates are in
[NUTRITION_OFF_REFERENCE.md](NUTRITION_OFF_REFERENCE.md#final-second-pass-validation--authoritative-results).

### Tests depuis un clone neuf (3 novembre 2026)

Les captures et répertoires `artifacts/` / `runtime/` sont volontairement absents
Git. Les fixtures API et le test de SIGKILL créent maintenant leurs parents avant
`mkdtemp` : un clone neuf ne doit pas dépendre des essais antérieurs du VPS.
Les tests ne téléchargent aucun catalogue et ne réutilisent aucune génération
réelle. Les limites de ressources du moteur restent inchangées.

Sur Debian, `/tmp` peut être un tmpfs de moins de 20 Gio : le garde disque refuse
alors correctement les imports de fixtures. Utiliser un dossier temporaire neuf
sur le disque du projet, sans abaisser la réserve :

```bash
mkdir -p scripts/nutrition-local-catalog/runtime
CATALOG_TEST_TMP=$(mktemp -d scripts/nutrition-local-catalog/runtime/test-tmp.XXXXXX)
chmod 700 "$CATALOG_TEST_TMP"
TMPDIR="$(realpath "$CATALOG_TEST_TMP")" python3 -m unittest discover \
  -s scripts/nutrition-local-catalog -p 'test_*.py' -q
```

La première tentative sur le tmpfs a produit des refus `insufficient-free-disk` ;
la relance sur disque a réussi **230 tests**, sans neutraliser le garde. Le test
de SIGKILL vérifie aussi la création de son dossier `artifacts` depuis un clone
neuf. Aucun catalogue réel n'est reconstruit par cette validation.
