# Bêta Android privée — préparation, 27 octobre 2026

> **Compilation et installation Android actuelles :** suivre
> [ANDROID_APK_GITHUB.md](ANDROID_APK_GITHUB.md). Le guide distingue la compilation
> GitHub, la signature stable pour les mises à jour et les essais physiques restants.
> Le déploiement actuel est Docker ; les anciennes préparations systemd ci-dessous
> restent historiques et ne doivent pas être appliquées à la stack en service.


**Profil définitif du 2 novembre :** pour `gym.example.com`, suivre
[PERSONAL_BETA.md](PERSONAL_BETA.md). Ce profil impose un compte unique, interdit
le mode invité et conserve l'appairage dans le stockage natif sécurisé. Les
anciens exemples invités et l'archive source d'octobre ci-dessous ne conviennent
pas à cette bêta personnelle ; ils restent des références de laboratoire.

## État et périmètre

Préparation locale, **aucune activation ni modification du proxy de production**.
Le scanner et le catalogue sont raccordés. Le profil serveur bêta dispose d'une
configuration explicite, d'un DATA_DIR neuf, de logs bornés et de modèles de
service/proxy. Le domaine HTTPS réel et la topologie du reverse proxy restent à
confirmer avant installation/activation. Aucun APK n'est revendiqué à ce stade :
Java/adb sont indisponibles ici, et aucun domaine fictif ne doit être distribué.

Audit en lecture seule : nginx et Traefik sont présents ; 80/443 sont écoutés,
Docker est actif mais son socket est interdit à cette session. Aucune configuration
proxy hôte n'est accessible dans les chemins habituels. Les processus existants
sur 3301/5175 appartiennent à l'essai utilisateur et sont conservés. Le compose et
le nginx du dépôt ont été lus, sans les assimiler à la configuration réelle du VPS.

## Scanner réutilisé

`@capacitor-mlkit/barcode-scanning` **7.5.0**, déjà installé, Capacitor 7 : aucune
dépendance ajoutée. Le bouton Nutrition appelle `scanCode({product:true})`, limité
à EAN-13, EAN-8, UPC-A et UPC-E. Le code reste une chaîne ; UPC-E est développé
seulement avec son format explicite, jamais en prenant un EAN-8 pour un UPC-E.
Le résultat passe par la route locale produit puis les commandes existantes du
journal, avec unité, provenance, licences et snapshot immuable. Aucune image ne
passe dans cette route ou dans l'API. Les recettes/comptes/historiques existants
ne sont pas migrés ou modifiés automatiquement.

Corrections : le plugin Android rejette l'annulation avec le message exact
`scan canceled.` ; elle retourne maintenant `null`, sans faux échec. Un verrou
évite deux scans natifs simultanés et se libère après erreur/annulation. La vue
affiche la traduction existante demandant d'autoriser la caméra dans les réglages
en cas de refus. Les réponses tardives restent protégées par les epochs de session.

Le manifeste contient déjà CAMERA et la préinstallation du module `barcode_ui`.
Le scanner Google peut télécharger son module Play Services lors de la première
utilisation ; ce n'est pas un appel à une API alimentaire. Les traitements d'image
restent sur l'appareil selon la [documentation Google](https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner).
La [documentation du plugin](https://capawesome.io/docs/sdks/capacitor/mlkit/barcode-scanning/)
et surtout les sources Java installées 7.5.0 ont été vérifiées. La lecture physique,
les permissions constructeur et l'annulation matérielle restent à tester sur téléphone.

## Profil serveur bêta et protections

`OPENGYM_PRIVATE_BETA=1` est un opt-in séparé de l'ancien mode développement.
Il fonctionne avec `NODE_ENV=production`, exige un ORIGIN HTTPS sans identifiants,
RP_ID égal à son hostname, les quatre générations et un marqueur d'état dédié.
Le marqueur lie le DATA_DIR au domaine : le même état ne peut pas être adopté
silencieusement par une autre origine. `init-state.mjs` refuse un dossier non
vide ; aucun `db.json` utilisateur existant n'est lu ou écrasé par l'initialisation.
La configuration est vérifiée **avant** le chargement d'état du serveur.

Le catalogue reste en lecture seule et le serveur écoute sur **127.0.0.1:3307**.
Le worker doit réussir les contrôles au démarrage ; sinon la bêta s'arrête sans
activer le relais fournisseur. Les profils ordinaires, sans flag bêta, conservent
leur comportement. Le proxy doit rester l'unique entrée HTTPS. CORS/origin et
authentification existants sont conservés ; les cookies deviennent Secure grâce
à l'ORIGIN HTTPS. Le pont natif public n'embarque ni cookie, ni token, ni secret.

Par défaut de cette préparation : invité autorisé, inscription sur invitation,
aucun compte/admin créé automatiquement. La première bêta peut utiliser les
données privées sur le téléphone sans compte ; comptes, invitations et appairage
nécessitent une préparation propriétaire séparée si souhaités. **Les routes du
catalogue public restent anonymes et bornées** : distribution privée de l'APK ne
signifie pas contrôle d'accès privé au catalogue. Si un filtrage réseau strict est
exigé, il faut valider un mécanisme compatible mobile avant exposition. Les
données personnelles serveur restent authentifiées et séparées.

Le modèle systemd utilise un utilisateur non root `codex`, un état 0700 dédié
`/var/lib/opengym-beta`, le code/générations montés en lecture seule, un home masqué,
aucune capacité, 768 Mio maximum, 150 % CPU, redémarrages bornés et readiness locale.
Le filtrage IP proposé n'autorise que loopback, donc interdit aussi les sorties
fournisseur du processus ; support du sandbox et compatibilité réseau à confirmer
lors de l'activation. La réserve système est vérifiée au départ (21 Gio disque,
3 Gio disponibles), puis toutes les cinq secondes (20,25/2,25 Gio), sans hausse
automatique. Les logs applicatifs sont limités à **3 × 2 Mio**, lignes et débit
bornés ; le journal systemd ne reçoit que les diagnostics du superviseur, à débit
limité. La durée de rétention globale journald reste celle du système existant.

## Préparer les fichiers pour le domaine approuvé

Ces commandes créent uniquement un nouveau dossier de revue dans le projet :

```bash
cd /home/codex/openGym
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
# Remplacer par le véritable domaine choisi ; ne pas conserver cet exemple.
BETA_ORIGIN=https://beta.votre-domaine.fr
BETA_REVIEW=/home/codex/openGym/scripts/nutrition-local-catalog/runtime/private-beta-review-final
node scripts/private-beta/prepare.mjs "$BETA_ORIGIN" "$BETA_REVIEW"
```

Sorties : `opengym-beta.conf`, `opengym-beta.service`,
`nginx-location.review.conf`, `review.json`. Aucun de ces fichiers n'est installé.
Le domaine `beta.example.org` n'a servi qu'aux fixtures locales et ne doit pas être
compilé dans une bêta utilisateur. Aucune requête n'a été envoyée à ce domaine.

### Audit proxy restant avant toute exposition

Depuis un terminal disposant déjà des permissions Docker, **sans sudo** :

```bash
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
# Remplacer NOM_PROXY ; sorties de topologie seulement, sans variables/secrets.
docker inspect --format '{{.Name}} network={{.HostConfig.NetworkMode}}{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' NOM_PROXY
```

Identifier ensuite les seuls fichiers de routage nécessaires et les règles de
domaine/certificat. Ne pas afficher les variables d'environnement, clés privées,
fichiers ACME ou mots de passe. Le fragment nginx proposé est utilisable **seulement
si nginx partage le namespace réseau de l'hôte**. Un Traefik conteneurisé en bridge
ne peut pas atteindre le loopback hôte : ne pas appliquer le fragment, ne pas
remplacer 127.0.0.1 par 0.0.0.0 pour contourner ce problème. La topologie doit être
confirmée et la route concrète approuvée ; aucun port interne ne doit être publié.
Le certificat doit couvrir le vrai hostname et être vérifié depuis le téléphone.

### Installation système : arrêt obligatoire avant accord explicite

Commandes préparées pour un terminal administrateur, **non exécutées ici** :

```bash
# Vérifier toutes les préconditions : ne jamais remplacer un état/unité existant.
test ! -e /etc/systemd/system/opengym-beta.service
test ! -e /etc/opengym-beta.conf
test ! -e /var/lib/opengym-beta
install -d -m 0700 -o codex -g codex /var/lib/opengym-beta
runuser -u codex -- /home/codex/.local/opt/node22/bin/node \
 /home/codex/openGym/scripts/private-beta/init-state.mjs \
 /var/lib/opengym-beta "$BETA_ORIGIN"
install -m 0600 "$BETA_REVIEW/opengym-beta.conf" /etc/opengym-beta.conf
install -m 0644 "$BETA_REVIEW/opengym-beta.service" /etc/systemd/system/opengym-beta.service
systemd-analyze verify /etc/systemd/system/opengym-beta.service
systemctl daemon-reload
systemctl enable --now opengym-beta.service
systemctl status opengym-beta.service --no-pager
curl --fail http://127.0.0.1:3307/api/nutrition/catalog/capabilities
```

Ces opérations et la modification/recharge du proxy nécessitent l'accord utilisateur.
Ne pas lancer de reboot pour tester le démarrage automatique. Ensuite seulement,
appliquer la route TLS précisément revue et vérifier :

```bash
curl --fail --show-error "$BETA_ORIGIN/api/nutrition/catalog/capabilities"
curl --fail --show-error "$BETA_ORIGIN/api/nutrition/catalog/product?code=5449000000996"
```

Attendus : certificat valide sans `-k`, sélection local-only, fiche pour 100 ml.
Pas d'activation générale de production ni de modification des anciens services.

## APK sur poste équipé, sans installation système sur le VPS

Installer Android Studio depuis le [site officiel](https://developer.android.com/studio),
puis SDK Manager : Android API 35, build tools et platform-tools. Configurer le JDK
**21**, vérifier `java -version`, installer Node **22**, définir `ANDROID_HOME`.
Le dépôt utilise Gradle 8.11.1 / plugin Android 8.7.2. Utiliser le worktree complet
actuel, **pas seulement HEAD**, qui ne contient pas les changements non commités.
Les catalogues SQLite et états serveur ne sont pas nécessaires à la compilation.

```bash
# Sur un poste contenant ce même code, avec la toolchain déjà installée :
npm --prefix frontend ci
node scripts/private-beta/build-android.mjs "$BETA_ORIGIN"
```

Le script refuse localhost/HTTP et l'absence de Java 21 ou SDK 35. Il ne télécharge
pas de toolchain. Le build impose local-only et la vraie origine HTTPS, synchronise
Capacitor, compile assembleDebug puis produit un nouveau dossier
`scripts/nutrition-local-catalog/artifacts/private-beta-apk-<timestamp>/`
contenant `opengym-beta-debug.apk` et `build.json`. Aucun secret n'y figure.
Ne pas redistribuer un build précédent portant l'origine de laboratoire.

L'identifiant reste **ch.duartesantos.opengym.test**, nom existant **OpenGymTest**,
distinct de l'application principale. Installer l'APK depuis le téléphone en
autorisant cette source, ou `adb install -r CHEMIN_APK` ; ne pas désinstaller/effacer
les données d'une application existante. Après installation et backend HTTPS
activé, ni ordinateur, ni tunnel SSH/adb reverse n'est nécessaire. Une première
connexion Google Play peut être nécessaire au module scanner.

## Essais physiques et rollback

Sur le téléphone : lancement invité, entraînement, recherche Nutella/lait, scan
EAN/UPC, refus/autorisation caméra, Retour, produit absent/ambigu/non ajoutable,
quantité dans l'unité proposée, ajout/modification/suppression, fermeture et
réouverture. Vérifier les macros, provenance, licences et réutilisation locale
après coupure réseau. Une recherche nouvelle nécessite le VPS ; les Foods déjà
enregistrés et snapshots restent sur le téléphone. Aucun appel alimentaire tiers.

Rollback après activation autorisée : désactiver uniquement la nouvelle route
bêta (configuration identifiée, puis validation du proxy avant recharge), puis
`systemctl disable --now opengym-beta.service`. **Conserver** `/var/lib/opengym-beta`,
l'APK précédent et toutes les générations. Un ancien état ne doit pas être restauré
automatiquement à la place de nouvelles opérations locales non acquittées.
Ne modifier/supprimer aucune route, donnée ou génération de production.

## Tests et limites

Les tests du scanner simulent uniquement le plugin matériel ; les écrans React,
le moteur, le client local et la persistance sont réels. Ils ne prouvent pas une
lecture optique sur appareil. Les tests API bêta utilisent de vraies connexions
HTTP loopback, des mini-générations de fixtures et un DATA_DIR neuf ; ils couvrent
le profil production explicite, les unités, les erreurs, les origines et un
arrêt/redémarrage. Les fichiers de configuration générés ne sont pas un déploiement
et le TLS public n'est pas validé tant que le domaine/proxy n'a pas été approuvé.
Les résultats exacts de suites et le contrôle du véritable catalogue sont ajoutés
ici après validation. Aucun commit/push/merge effectué.

### Résultats de cette préparation

Journaux nouveaux : `scripts/nutrition-local-catalog/artifacts/private-beta-20261027/`.
Node 22.23.3 / npm 10.9.9, Python 3.13.5 / SQLite 3.46.1.

| Groupe final | Résultat |
| --- | --- |
| Frontend complet, `npm test -- --maxWorkers=2` | **5 844 réussis, 443 fichiers**, 399,07 s |
| API complète, `node --test --test-concurrency=2 test/*.test.js` | **813 réussis**, 126,10 s |
| Catalogue Python, unittest discover `test_*.py` | **227 réussis**, 10,32 s |
| Catalogue Node, `node --test --test-concurrency=1 scripts/nutrition-local-catalog/*.test.mjs` | **110 réussis**, 8,88 s |
| Locales | **18 × 2 466 clés** synchronisées |
| Web / Capacitor mobile | réussis ; les trois copies du bundle mobile sont contrôlées |
| Modèle systemd | `systemd-analyze verify --man=no` réussi sur une copie aux chemins exécutables locaux ; aucune installation |
| Git | `git diff --check` réussi |

Aucun échec, annulation ou test ignoré dans les suites finales. Les 11 tests
scanner/parcours natif ciblés et les tests API ciblés sont déjà inclus ; ne pas
additionner les relances. Les avertissements de chunks/imports du build, de
listeners Vitest et d'absence de xcodebuild restent visibles. Le build mobile
utilise un domaine de **fixture** pour contrôler l'injection HTTPS ; ce bundle
ne doit pas être emballé/distribué. Le script APK refuse maintenant les domaines
example.org/com/net. Le contrôle JDK a confirmé l'absence d'outil Java disponible,
sans téléchargement/installation. Aucun APK n'a été produit.

Le superviseur réel a été démarré, arrêté et redémarré sur **3307 loopback** avec
les quatre vraies générations, un état neuf lié à `https://beta.example.org`
(valeur de fixture locale, sans DNS/HTTPS externe). Nutella, Coca-Cola, lait, riz,
pâtes, yaourt et œufs retournent 20 résultats dont 20 ajoutables dans ces contrôles.
Les deux codes de contrôle conservent explicitement g et ml, les routes privées
refusent l'invité (401) et les origines étrangères sont refusées (403). Les logs
restent utilisables après redémarrage. Le test système de supervision couvre
aussi l'arrêt pendant la préparation avec un véritable groupe de processus et
son descendant Python : pas de worker vivant abandonné.

Ces contrôles ne valident **ni certificat public, ni reboot systemd, ni reverse
proxy réel, ni caméra physique**. Le serveur bêta de contrôle est arrêté. Les
processus 3301/5175 préexistants de l'utilisateur sont conservés. Les générations
et leurs références/licences n'ont pas changé ; aucun gros catalogue n'a été
téléchargé ou reconstruit. Les mêmes 835 231 références OFF restent disponibles,
le benchmark indépendant de la passe précédente reste à 544/913 ; cette mission
ne revendique pas de gain de couverture.

### Code prêt à transférer sur un poste de compilation

Une archive du **worktree actuel**, sans catalogue SQLite, données/états, .env,
clés de signature, node_modules ni caches de build, est préparée dans le workspace
des résultats : `opengym-beta-source.tar.gz` et son fichier `.sha256`. Elle inclut
le code partagé API/frontend nécessaire ainsi que les médias d'exercices déjà
présents. Elle n'est pas un APK. Le checksum détecte la corruption du transfert,
ce n'est pas une signature d'authenticité.

```bash
# Depuis le poste de compilation, après transfert des deux fichiers :
sha256sum -c opengym-beta-source.tar.gz.sha256
mkdir opengym-beta-source
tar -xzf opengym-beta-source.tar.gz -C opengym-beta-source
cd opengym-beta-source
npm --prefix frontend ci
# Java 21 et SDK 35 installés ; ANDROID_HOME et le vrai domaine approuvé définis.
node scripts/private-beta/build-android.mjs "$BETA_ORIGIN"
```

Pour Windows, utiliser Android Studio et son terminal/outillage adapté ; la
commande gradlew Unix ci-dessus est prévue pour Linux/macOS. Conserver la même
clé debug pour les mises à jour de cette bêta. Si une ancienne application `.test`
porte une autre signature, **ne pas la désinstaller pour contourner l'erreur** :
réutiliser sa clé de build ou décider d'un transfert explicite via les sauvegardes
validées. La clé privée de signature n'est jamais copiée dans l'archive source.

### Fichiers de cette mission et conditions d'activation

- `frontend/src/lib/scan.js`, nouveau `scan-native.test.js` : annulation/verrou
  natif et tests des formats, zéros initiaux, permissions, échecs et concurrence.
- `frontend/src/views/nutrition/FoodCatalog.jsx`, nouveau
  `FoodCatalog.native.test.jsx` : message caméra et véritables parcours React de
  journal avec plugin matériel simulé, persistance réelle de laboratoire.
- Nouveau `api/nutrition/catalog-beta.js`, raccordement dans `catalog-local.js`
  et `api/server.js` : garde explicite et refus du repli fournisseur.
- Nouveaux `api/test/private-beta.test.js`, `private-beta-http.test.js` : marqueur,
  isolation, origines, logs, refus d'initialisation/corruption et redémarrage HTTP.
- Nouveaux `scripts/private-beta/{init-state.mjs,entry.mjs,run.mjs,ready.mjs,prepare.mjs,build-android.mjs,opengym-beta.service.in}` :
  outils locaux, garde de build et modèles de déploiement non activés.
- Documentation : ce fichier, `docs/MOBILE.md` et renvoi dans
  `NUTRITION_FOOD_CATALOG.md`. Les autres modifications préexistantes sont préservées.

Pour une mise en service : **domaine approuvé et topologie proxy confirmée**,
revue des fichiers rendus pour ce vrai domaine, **accord explicite** avant
installation/activation du service et du routage TLS, vérification du certificat,
puis compilation APK avec la toolchain équipée et essai réel sur téléphone.
Le modèle monte le worktree en lecture seule pour le processus ; les futures
modifications faites par son propriétaire hôte restent visibles. Figer la source
de build et coordonner les changements/restarts pendant l'essai privé ; ce modèle
n'est pas une chaîne de releases immuables pour une publication générale.
