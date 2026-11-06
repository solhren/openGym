# Bêta personnelle Docker — préparation du 2 novembre 2026

## Correctif du laboratoire installé : nginx sur racine readonly

L'essai réel sous le propriétaire du déploiement a révélé `mkdir() "/var/cache/nginx/fastcgi_temp"
failed (30: Read-only file system)`. Le `/tmp` inscriptible ne couvre pas les
répertoires par défaut FastCGI/uWSGI/SCGI que nginx initialise au démarrage,
même si l'application utilise uniquement le reverse proxy HTTP. Le TimeoutError
du smoke test intervient alors avant que le frontend puisse répondre.

Correctif commun aux deux profils : tmpfs supplémentaire
`/var/cache/nginx:rw,nosuid,nodev,noexec,size=4m,uid=101,gid=101,mode=0700`.
La racine reste readonly, l'UID 101 et la limite mémoire **128 Mio** sont conservés,
ainsi que CPU, PID, capacités supprimées, no-new-privileges et SQLite readonly.
Le tmpfs compte dans cette limite mémoire, ne la relève pas. Aucun changement
de Dockerfile, d'image ou de configuration applicative n'est nécessaire.

Si `/srv/opengym` appartient à un autre utilisateur, le propriétaire du déploiement
doit copier l'outil de correction puis l'exécuter sans sudo. L'outil sauvegarde les deux Compose et leur checksum,
ajoute seulement le montage frontend dans chacun, et actualise
`deployment.sha256`. Il ne touche pas au contexte source figé, aux images,
catalogues, données, volumes ou services Docker. Il refuse des changements
Compose non enregistrés et une identité non autorisée ; une seconde exécution est neutre.

```bash
DEPLOY_OWNER=$(id -un)
DEPLOY_GROUP=$(id -gn)
sudo install -o "$DEPLOY_OWNER" -g "$DEPLOY_GROUP" -m 0755 \
 /home/codex/openGym/scripts/private-beta/docker/fix-nginx-tmpfs.py \
 /srv/opengym/fix-nginx-tmpfs.py
cd /srv/opengym
python3 ./fix-nginx-tmpfs.py .
docker compose --env-file images.conf -f compose.json config --quiet
docker compose --env-file images.conf -f compose.lab.json config --quiet
# Pas de build : recréer uniquement le frontend du laboratoire.
docker compose --env-file images.conf -f compose.lab.json up -d \
 --no-deps --no-build --force-recreate --wait --wait-timeout 60 frontend
docker compose --env-file images.conf -f compose.lab.json exec -T frontend nginx -t
docker compose --env-file images.conf -f compose.lab.json exec -T backend \
 node /app/scripts/private-beta/docker/smoke.mjs
```

Aucune activation du Compose de production ; son fichier est corrigé pour son
utilisation future seulement. Aucun `down`, initialisation, suppression de volume
ou redémarrage du backend. Les copies originales restent dans un dossier privé
`nginx-tmpfs-backup-*` de l'installation ; en cas d'interruption ou de refus,
examiner ces petits fichiers, jamais réinitialiser les données.

Validation locale du correctif : **14 tests réussis**, aucun échec/ignoré
(`node --test api/test/personal-docker.test.js`), dont les deux profils, les limites,
l'application sur une installation synthétique, les checksums, l'idempotence et
le refus des modifications locales non enregistrées. Deux configurations Compose
générées corrigées passent `config --quiet`. `git diff --check` passe. Aucun
conteneur nginx n'a été exécuté par codex : validation réelle à effectuer avec
les commandes ci-dessus. Le plafond SQL sur « lait » mentionné plus bas reste
un problème séparé ; le smoke test le conserve et peut encore le signaler après
le rétablissement du frontend.

Référence : [tmpfs Docker et limite mémoire](https://docs.docker.com/engine/storage/tmpfs/).

## Correctif du préchargement — recherche « lait »

Le correctif moteur remplace uniquement COUNT(*) par COUNT(id) pour le
préchargement de `search_rank_idx`. Le COUNT(*) était optimisé vers
`language_idx` dans le plan local observé, laissant froid le gros index couvrant.
La recherche, son classement et son délai de **2 secondes** ne changent pas ;
le budget optionnel de préchargement de 3 s n'est pas relevé. Voir le diagnostic
et les mesures dans [NUTRITION_LOCAL_CATALOG_PROTOTYPE.md](NUTRITION_LOCAL_CATALOG_PROTOTYPE.md).

L'installation réelle reste privée au propriétaire du déploiement. Le helper lit les deux Compose
résolus pour trouver leur véritable contexte backend (y compris SOURCE_CONTEXT),
puis sauvegarde et met à jour seulement `wger-off-reference.py` et ses métadonnées
`source-inventory.json`, `source.sha256`, `prepared.json`. Les checksums restent
cohérents pour `manage.sh`. Il refuse modifications non enregistrées, changement
de deadline, exécution root ou contextes divergents. Relance neutre si déjà appliqué.
Les Compose, dont le correctif tmpfs nginx, les catalogues et volumes ne sont pas
modifiés. OPENGYM_RELEASE est conservé pour garder aussi le **même nom de volume
du laboratoire** et ne pas imposer de reconstruire le frontend ; le reçu consigne
l'ancienne et la nouvelle empreinte source.

Depuis SSH **le propriétaire du déploiement**, sans aucun déploiement public :

```bash
sudo install -o "$DEPLOY_OWNER" -g "$DEPLOY_GROUP" -m 0644 -t /srv/opengym \
 /home/codex/openGym/scripts/private-beta/docker/fix-catalog-warmup.py \
 /home/codex/openGym/scripts/nutrition-local-catalog/profile-reference-search.py
cd /srv/opengym
python3 fix-catalog-warmup.py .
# Garde une référence à l'image précédente, sans copie de couche ni de données :
docker image tag "$(docker compose --env-file images.conf -f compose.lab.json images -q backend)" \
 "opengym-personal-api:before-warmup-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose --env-file images.conf -f compose.lab.json build backend
docker compose --env-file images.conf -f compose.lab.json up -d \
 --no-deps --no-build --force-recreate --wait --wait-timeout 180 backend
docker compose --env-file images.conf -f compose.lab.json exec -T backend \
 node /app/scripts/private-beta/docker/smoke.mjs
```

Conserver les réserves de 20 Gio libres et 2 Gio de RAM ; arrêter sur manque de
ressources, erreur de checksum, build ou healthcheck. Aucun `down -v`, reset,
initialisation, suppression de génération ou reconstruction des SQLite. Ne pas
recréer le frontend : nginx résout dynamiquement le nom `backend`. Le rollback de
code reste possible avec le tag conservé et les petits fichiers du dossier
`catalog-warmup-backup-*`, sans rollback automatique des données.

Pour mesurer dans **l'image effectivement reconstruite**, même version de SQLite
et mêmes contraintes Docker (optionnel après le smoke test) :

```bash
docker compose --env-file images.conf -f compose.lab.json exec -T backend \
 python3 - --scripts /app/scripts/nutrition-local-catalog \
 < profile-reference-search.py
```

Attendu : `passed: true`, `warmupPlan` mentionne `search_rank_idx`, 20 résultats
pour chacune des six recherches, références g/ml correctes et chaque recherche
sous 2 s. L'initialisation et les hashes sont mesurés séparément, pas assimilés à
la latence SQL. Les tests locaux passent (43 wger, 4 installer, 17 Node/API), mais
le correctif n'a pas été appliqué ni compilé dans le répertoire privé par le compte de développement : accès privé
et accès au moteur Docker non disponibles. La validation dans la stack réelle
reste nécessaire avant de considérer le timeout Docker résolu.

Cette préparation remplace les unités systemd proposées dans PERSONAL_BETA.md.
Aucun service systemd openGym n'est créé. Aucun conteneur, réseau partagé, DNS ou
proxy existant n'est modifié pendant la préparation. Activation après accord.

Invariants : `gym.example.com`, compte unique avec invitation initiale privée puis
inscriptions closes, aucun invité même en panne, appairage natif sécurisé,
catalogue entièrement local et readonly, contrats Nutrition et données conservés.

## Topologie et isolation

Traefik v3.6 existant → frontend nginx :8080 sur `net` → backend Node 22 :3307
sur un réseau privé `internal: true`. Seul nginx rejoint `net` ; aucun port hôte
publié. L'option explicite `OPENGYM_BETA_DOCKER=1` autorise l'écoute conteneur
0.0.0.0 uniquement pour le profil personnel. Les autres modes restent loopback.
Aucun middleware Authelia ajouté. L'API réutilise son authentification existante.

Code et build dans les images, volume personnel indépendant, catalogue monté
depuis `/srv/opengym/catalogues` : aucun chemin `/home/codex`
n'est utilisé à l'exécution. UID backend 1000, nginx 101, tous deux non root.
Les fichiers de déploiement sont administrés par le propriétaire choisi.

## Instantané de catalogue sans reconstruction

On ne copie que `current.json` et son fichier SQLite pour chacune des quatre
générations validées. Les SHA-256 attendus sont épinglés et vérifiés. Les deux
SQLite déjà 0444 sont liés physiquement sur le même système de fichiers ; leurs
permissions et propriétaires ne sont jamais changés. Les deux SQLite 0600 sont
copiés en streaming dans de nouveaux fichiers 0444, soit environ 1,92 Gio ajoutés,
sans rendre les originaux lisibles. Les petits manifestes sont copiés.

Les liens restent valides si les chemins de développement sont supprimés, mais
partagent l'inode : ne jamais modifier une génération scellée en place, ni faire
un chown/chmod récursif des fichiers du catalogue. Une indépendance physique
totale nécessiterait une copie supplémentaire des 4,984 Gio (ou un reflink sur un
stockage compatible). Les lecteurs vérifient toujours les empreintes au démarrage.

Préflight : au moins 20 Gio libres + copies estimées + contexte + 4 Gio de budget
images/cache, au moins 3 Gio disponibles au départ. Contrôles continus pendant la
préparation ; arrêt avant les réserves 20,25 Gio et 2,25 Gio. Aucun quota relevé.

Les commandes, tests et limites de validation sont complétés au fil du travail.

## Préparation locale et transfert unique

Le générateur inclut les sources modifiées/non suivies par Git, mais exclut les
fichiers ignorés, `.env*`, données, caches, clés, tests et artefacts. Il produit
un contexte filtré de build, un inventaire SHA-256, deux Compose et un reçu final.
`source.sha256`, `catalogues.sha256` et `deployment.sha256` permettent les contrôles
avec les outils Debian existants. `manage.sh` les vérifie avant build,
initialisation et démarrage, y compris le contexte source d'une mise à jour.
Si la préparation est interrompue, conserver son dossier pour diagnostic et
utiliser un **nouveau** nom, jamais reprendre un instantané partiel comme valide.

Les images parentes sont résolues par petites requêtes de métadonnées Docker
Registry (pas de pull) puis épinglées par digest dans `images.conf`. `npm ci`
réutilise les lockfiles. Le registre refuse/limite → arrêt sans retry automatique.
Les paquets Alpine Python/flock/tar sont nécessaires au lecteur, aux verrous et à
la sauvegarde ; leur résolution à la construction n'est pas une reproductibilité
bit à bit. Conserver les images finales, leurs IDs et les digests de base pour
rejouer exactement un déploiement ou revenir en arrière. Aucune installation hôte.

L'instantané initial est préparé sous :
`/home/codex/openGym/scripts/nutrition-local-catalog/runtime/private-beta-compose-20261102`.
Après examen et accord, depuis SSH **le propriétaire du déploiement**, ce transfert nécessite sudo car
le dossier de codex est privé. Il déplace uniquement le nouvel instantané, pas les
générations d'origine. Vérifier auparavant le même système de fichiers, l'espace
libre, l'absence d'une stack openGym existante et la validité de `prepared.json`.

```bash
set -e
DEPLOY_OWNER=$(id -un)
DEPLOY_GROUP=$(id -gn)
STAGE=/home/codex/openGym/scripts/nutrition-local-catalog/runtime/private-beta-compose-20261102
DEST=/srv/opengym
sudo test -f "$STAGE/prepared.json"
sudo test ! -e "$DEST"
sudo install -d -m 0755 -o "$DEPLOY_OWNER" -g "$DEPLOY_GROUP" /srv
# Les deux chemins doivent être sur le même volume ; sinon arrêter.
sudo stat -c '%d %n' "$STAGE" /srv
test "$(sudo stat -c %d "$STAGE")" = "$(stat -c %d /srv)"
sudo mv -T -- "$STAGE" "$DEST"
sudo chown "$DEPLOY_OWNER:$DEPLOY_GROUP" "$DEST" "$DEST/backups"
sudo chown -R "$DEPLOY_OWNER:$DEPLOY_GROUP" "$DEST/source"
sudo find "$DEST" -maxdepth 1 -type f -exec chown "$DEPLOY_OWNER:$DEPLOY_GROUP" {} +
sudo find "$DEST/catalogues" -type d -exec chown "$DEPLOY_OWNER:$DEPLOY_GROUP" {} +
# NE PAS faire de chown/chmod récursif des fichiers SQLite.
cd "$DEST"
# Confirmer aussi le disque utilisé par Docker avant tout build.
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}')
df -h . "$DOCKER_ROOT"
test "$(stat -c %d .)" = "$(stat -c %d "$DOCKER_ROOT")"
./manage.sh check
```

Aucun sudo nécessaire ensuite si le propriétaire a déjà accès au moteur Docker, comme
pour ses autres stacks. Ne pas changer les groupes ou permissions du socket pour
contourner un refus. La réservation du réseau `net` est réutilisée, jamais recréée.
Si Docker stocke ses images sur un autre système de fichiers, arrêter : son
budget et ses réserves doivent être vérifiés séparément avant le build. Si seule
la lecture des métadonnées de DockerRootDir est refusée, un administrateur peut
effectuer ce contrôle en lecture seule ; ne pas changer ses permissions.

## Construire et essayer sans exposer la bêta

Ces commandes ne publient aucun port et ne modifient aucune autre stack. Ne pas
les considérer comme déjà exécutées si le moteur Docker n'était pas accessible.

```bash
cd /srv/opengym
./manage.sh build
# Nouveau volume et réseau de laboratoire ; aucune route Traefik dans ce Compose.
docker compose --env-file images.conf -f compose.lab.json run --rm --no-deps initialize
docker compose --env-file images.conf -f compose.lab.json up -d --no-build backend frontend
docker compose --env-file images.conf -f compose.lab.json ps
docker compose --env-file images.conf -f compose.lab.json exec -T backend \
 node /app/scripts/private-beta/docker/smoke.mjs
docker compose --env-file images.conf -f compose.lab.json stop frontend backend
```

Le volume de laboratoire a un nom distinct lié à la release. L'initialisation
exige qu'il soit vide ; ne pas la répéter sur un état existant. Le test vérifie le
trajet HTTP nginx→API, les refus anonymes et les recherches/codes-barres locaux.
Il ne crée pas de compte réel. Les SQLite sont montées readonly ; tester aussi
l'échec d'une tentative d'écriture **dans le conteneur**, jamais sur l'hôte.

```bash
docker compose --env-file images.conf -f compose.lab.json exec -T backend \
 node -e 'const f=require("fs");try{f.writeFileSync("/app/scripts/nutrition-local-catalog/artifacts/forbidden-test", "x");process.exit(1)}catch(e){if(e.code!=="EROFS")throw e;console.log("catalogue readonly")}'
```

Exécuter ce dernier contrôle avant l'arrêt, ou redémarrer seulement le laboratoire.
Si build, healthcheck, permissions, empreintes ou tests échouent : **arrêter ici**,
ne pas activer la route réelle. Pas de `prune`, `down -v`, suppression de données
ou élévation des plafonds. Le superviseur applicatif cesse sa propre activité
avant les réserves de ressources ; le script surveille aussi builds/sauvegardes.

## Activation personnelle — après autorisation explicite uniquement

Vérifier l'absence de route concurrente `Host(gym.example.com)` et les métadonnées
du réseau `net` avant cette opération. Les labels définissent `websecure`, TLS
`letsencrypt`, port conteneur 8080 ; aucun middleware Authelia. Pas de modification
du DNS nécessaire pour l'IPv4 constatée. Aucun fichier ACME/secret n'est affiché.

```bash
cd /srv/opengym
./manage.sh initialize
./manage.sh start
./manage.sh status
curl --fail --head --max-time 20 https://gym.example.com
```

La première activation crée uniquement `opengym-personal-data-v1`. Docker peuple
le volume neuf avec le répertoire 0700/UID 1000 préparé dans l'image. Une erreur de
permissions ou un dossier déjà rempli provoque un refus, jamais un chown/reset
automatique. Le profil ne démarre pas sans marqueur personnel valide. Le volume
contient comptes, secret de session, fichiers d'entraînement, données Nutrition,
opérations en attente et logs bornés. Il n'est pas partagé avec nginx.

Lire l'invitation uniquement dans votre terminal privé (ne pas la transmettre au
modèle ou l'embarquer dans l'APK) :

```bash
docker compose --env-file images.conf -f compose.json exec backend \
 cat /var/lib/opengym-beta/bootstrap-invite.txt
```

Créer votre passkey depuis Chrome Android sur `https://gym.example.com`, avec le
nom que vous choisissez et cette invitation. Les inscriptions sont alors closes.
Dans Paramètres → Compte, demander le code d'appairage mobile à usage unique,
puis le saisir dans l'APK. L'APK n'utilise ni localhost comme backend ni un tunnel
SSH. Ne jamais accepter un avertissement TLS ou ajouter `curl -k`.

## Sauvegarde, mise à jour, arrêt et rollback

```bash
./manage.sh status
./manage.sh logs                 # borné à 100 lignes ; ne pas publier les logs privés
./manage.sh backup               # arrêt du backend, tar+gzip vérifié, puis redémarrage
./manage.sh stop                 # conserve volume et catalogues
./manage.sh start
```

La sauvegarde physique n'est pas une restauration globale depuis l'interface.
Backend arrêté, elle couvre l'état personnel entier à un point cohérent, y compris
secret, reçus et opérations non acquittées. Le catalogue reconstructible est
exclu. Le helper refuse un volume non initialisé. Avant archivage, il mesure les
tailles et l'overhead sans lire les contenus, refuse liens/fichiers spéciaux et
impose le budget disque correspondant ; les réserves restent surveillées pendant
la compression. Les archives sont 0600, conservées dans `backups`, avec checksum SHA-256
(corruption, pas signature). Sauvegarder aussi `images.conf`, `prepared.json` et
les sources ; conserver une copie privée hors VPS. Pas de purge automatique.
Une erreur laisse un `.partial`, jamais annoncé comme sauvegarde réussie, puis
le backend précédemment actif est relancé. Une restauration physique doit cibler
un **nouveau volume isolé**, après vérification de l'archive et des chemins, sans
écraser le volume actuel ; aucune commande de restauration destructrice fournie.

Pour une prochaine mise à jour de code, préparer avec `prepare.mjs NOUVEAU_DOSSIER
--source-only` : aucune nouvelle copie des SQLite. Faire transférer ce paquet
source vers `releases/RELEASE` par la même procédure d'administration, puis créer
un nouveau fichier `images-NOUVELLE_RELEASE.conf` épinglé. Ajouter dedans :
`SOURCE_CONTEXT=./releases/RELEASE/source`. Ne pas écraser les sources précédentes.

```bash
./manage.sh backup images.conf
./manage.sh build images-NOUVELLE_RELEASE.conf
# Après examen et autorisation de cette mise à jour seulement :
./manage.sh start images-NOUVELLE_RELEASE.conf
# Rollback de code, sans rollback automatique des données :
./manage.sh start images.conf
```

Les deux tags d'images précédents et les configurations sont conservés. Aucun
schéma utilisateur n'a été migré par cette adaptation Docker. En cas de panne du
nouveau frontal, `./manage.sh stop` retire uniquement cette route en arrêtant ce
conteneur ; tous les autres services continuent. Ne jamais redémarrer Traefik,
Authelia, Vaultwarden ou le moteur Docker pour cette installation.

## Android et limites

Depuis le paquet source sur un poste avec Node 22, JDK 21 et SDK 35 :

```bash
cd source
(cd frontend && npm ci)
node scripts/private-beta/build-android.mjs https://gym.example.com
```

Le script produit le debug `ch.duartesantos.opengym.test` séparé de l'application
principale, sans secret embarqué. Scanner MLKit déjà intégré, permissions caméra
à l'action de l'utilisateur, aucun envoi de photo et aucune API alimentaire.
Appairage conservé via le plugin natif sécurisé ; hors ligne, les produits déjà
enregistrés et opérations durables restent locaux. Ne pas désinstaller une
ancienne application `.test` contenant des données ; suivre PERSONAL_BETA.md
pour l'export préalable des anciennes données invitées.

Java/SDK, APK, caméra et persistance physique ne sont pas réputés validés sans
compilation et essai sur téléphone. L'API personnelle nécessite un certificat
valide ; la préparation seule n'en émet pas.

## Résultats réellement obtenus — 2 novembre 2026

Paquet préparé : `private-beta-compose-20261102`, release
`beta-20261102-e39dff2911ed`. Sources figées : **217,39 Mio**, empreinte
`e39dff2911edbe572d20485df85c9f27ec2db7749107d4aa9456079ce9a48cf2`.
Préparation terminée en **18,02 s**, CPU enfants **11,39 s**, pic RSS enfant
**114,64 Mio**. Minimum mesuré pendant la préparation : **3,97 Gio de RAM
disponible**, **26,96 Gio libres**. Copie physique supplémentaire : **1,923 Gio**,
liens scellés : **4,984 Gio**, aucun original modifié ou supprimé.

Les métadonnées Docker Registry ont été réellement accessibles. Digests enregistrés
dans `images.conf` (sans token de registre) :

```text
node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
nginxinc/nginx-unprivileged:alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
```

| Vérification | Résultat de cette mission |
| --- | --- |
| `cd api && npm test` | **826 réussis**, 0 échec/annulé/ignoré ; 87,25 s |
| Nouveaux tests `node --test api/test/personal-docker.test.js` | **11 réussis**, 0 échec/ignoré ; inclus dans les 826, pas additionnés |
| Frontend auth/session/invités/vrai App + trois suites scanner | **34 réussis / 7 fichiers**, 0 échec/ignoré ; 8,77 s |
| Contrôle locales | **18 langues, 2466 clés**, synchronisées |
| Build Web, trois flags personnels | **Réussi**, 2,35 s |
| Build mobile, mêmes flags | **Réussi**, Vite + cap sync + contrôle du bundle ; aucun APK |
| Deux `docker compose ... config --quiet` | **Réussis**, syntaxe réelle avec les digests résolus |
| `sha256sum --check --status source.sha256 catalogues.sha256 deployment.sha256` | **Réussi**, code 0 |
| `bash -n .../manage.sh`, `git diff --check` | **Réussis** |
| Build/healthcheck/redémarrage de conteneurs | **Bloqués**, accès au socket Docker refusé ; aucun conteneur lancé |
| APK et tests physiques Android | **Non exécutés**, JDK 21/adb absents, SDK non configuré |

La suite frontend complète 5853/444 de la préparation précédente n'a pas été
relancée dans cette adaptation d'infrastructure ; les composants React n'ont pas
été changés ici. Les avertissements Vite de taille de chunks/import mixte du
scanner restent présents, sans échec du build.

### Diagnostic réel du catalogue préparé : blocage à conserver

Le lecteur du **code figé**, lancé localement avec seulement son chemin de
catalogues redirigé vers l'instantané (aucun assouplissement des hashes), a vérifié
les **3 058 354 références** et retrouve la version
`468716ae3687ff0edb99b6cc3fb5013ac47a750b90769d208a5ce620f760e1b8`.
Démarrage complet mesuré : **29,35 s**. Recherches initiales : Nutella **177,66 ms**,
Coca-Cola **361,40 ms**, résultats exacts ajoutables en premier.

**La recherche « lait » échoue réellement sur le plafond SQL de 2 s** : diagnostic
direct `sqlite3.OperationalError: interrupted`, **2003,43 ms**. Les octets de la
base et du code du lecteur sont inchangés ; il ne s'agit pas d'une corruption
de copie ou d'une erreur CORS. Le parcours n'est donc pas entièrement validé.
Ce cas reste dans `smoke.mjs` : ne pas supprimer le test, augmenter le délai ou
modifier les données pour obtenir un succès de déploiement.

Le diagnostic suivant, séparé de la mesure initiale et avec caches réchauffés,
réussit pour riz (**1039,39 ms**), pâtes (**392,78 ms**), yaourt (**378,45 ms**).
Ce sont des lectures ponctuelles, pas un benchmark p95 ni une mesure en Docker.
Codes-barres réels contrôlés sans réseau fournisseur :

- Nutella `3017620422003` : **100 g**, 539 kcal, protéines 6,3 g, glucides 57,5 g,
  lipides 30,9 g.
- Coca-Cola `5449000000996` : **100 ml**, énergie d'origine convertie de kJ selon
  le moteur existant, **43,021032504780116 kcal**, protéines 0 g, glucides 10,6 g,
  lipides 0 g. Valeur conservée, pas arrondie dans le stockage.

Journaux reproductibles :
`scripts/nutrition-local-catalog/artifacts/personal-compose-20261102/`.
Les tests de copie vérifient inode/permissions, copie indépendante des fichiers
inscriptibles, refus de corruption/manifeste non approuvé/symlinks, arrêt sur
réserves et sauvegarde tar vérifiée d'un état **synthétique** seulement. Aucun
compte ou repas réel utilisé.

### Conditions avant activation

1. Exécuter le laboratoire Docker depuis le terminal du propriétaire autorisé : build,
   droits du volume neuf, HTTP via nginx, refus anonymes, egress interne isolé,
   redémarrage du backend/worker et montage readonly doivent réussir.
2. Appliquer et valider dans Docker le correctif COUNT(id) du préchargement
   décrit plus haut ; pas de reconstruction des catalogues ni modification des
   références. Le timeout historique ci-dessus reste le résultat avant correctif.
3. Confirmer qu'aucune règle existante ni middleware global Authelia n'intercepte
   ce domaine. Aucun middleware de ce type n'a été trouvé dans les arguments du
   processus Traefik ; sa configuration de fichiers n'a pas été inspectée.
4. Obtenir l'accord d'activation puis vérifier certificat réel, création de votre
   compte, appairage, compilation APK et essais Wi-Fi/4G/5G sur téléphone.

Le paquet est prêt pour **revue/transfert et essais isolés**, pas réputé validé
en conteneur ou prêt à une activation définitive.

## Fichiers de cette adaptation

- `scripts/private-beta/docker/` : Dockerfiles API/Web, configuration nginx,
  générateur Compose et laboratoire, préparation source/catalogue, résolution
  des digests, healthcheck, smoke test, sauvegarde et outil `manage.sh`.
- `api/nutrition/catalog-beta.js`, `api/server.js` : option explicite d'écoute
  réseau pour Docker, sans modification des modes existants.
- `api/test/personal-docker.test.js` : 11 tests de configuration, isolement,
  copie/intégrité, erreurs réseau de registre et sauvegarde.
- Ce document, le renvoi dans `PERSONAL_BETA.md` et `docs/MOBILE.md`.

Tous les changements précédents sont conservés ; aucun service systemd créé,
aucun port publié, aucun déploiement, aucun commit/push ni nouvelle donnée
utilisateur.

Références : [réseaux Compose](https://docs.docker.com/reference/compose-file/networks/),
[volumes Docker](https://docs.docker.com/engine/storage/volumes/),
[images épinglées](https://docs.docker.com/build/building/best-practices/#pin-base-image-versions).


## Portable deployment origin

Examples use `https://gym.example.com`; replace it with your approved HTTPS origin.
There is no personal-domain fallback. Set `OPENGYM_ORIGIN=https://gym.example.com`
and `OPENGYM_RP_ID=gym.example.com` in the reviewed Compose environment file
(e.g. `images.conf`). The latter must match the origin hostname. Compose supplies
`OPENGYM_ORIGIN` to the frontend build and initialization; API startup validates its
origin/RP ID against the isolated data marker. Reuse the same values for updates.
The frontend nginx default virtual host accepts traffic routed by your existing proxy;
the backend's origin checks and authentication remain authoritative.

No running installation or previously prepared package is modified by source edits.
Do not replace an existing instance's origin/data binding to rename a server.


## Deployment owner and root CI

Run offline patch tools as the owner of the deployment files, without sudo.
`OPENGYM_DEPLOY_OWNER` defaults to the current OS identity; set it explicitly when
reviewing a different ownership configuration. The tools still require that identity
to match the invoking UID and every file's ownership and still reject sudo/setuid,
symlinks, unrecorded changes and concurrent edits.

In isolated root-owned CI fixtures only, `OPENGYM_DEPLOY_OWNER=root` is an explicit
opt-in. It does not allow patching files owned by other users or make generated
containers privileged. Configuration generation uses nonzero
`OPENGYM_RUNTIME_UID`/`OPENGYM_RUNTIME_GID` (defaults: invoking nonzero IDs, or
1000:1000 in root CI). Prefer an unprivileged deployment owner on a real host.
For administrative transfer examples above, first set:

```sh
export DEPLOY_OWNER="$(id -un)"
export DEPLOY_GROUP="$(id -gn)"
```
