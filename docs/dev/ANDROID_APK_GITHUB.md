# APK Android personnel avec GitHub Actions

## Parcours utilisateur

La bêta utilise **https://gym.solhren.fr**, le compte unique existant et le
catalogue du VPS. Aucun catalogue, mot de passe, invitation ou jeton personnel
n'est embarqué dans l'APK. Le build ne contacte pas le VPS. L'application porte
l'identifiant `ch.duartesantos.opengym.test`, distinct de l'application principale.

1. Télécharger directement [opengym-beta-debug.apk](https://github.com/solhren/openGym/releases/download/android-personal-beta/opengym-beta-debug.apk)
   depuis la [préversion personnelle](https://github.com/solhren/openGym/releases/tag/android-personal-beta).
   Aucun ZIP à extraire. Le dépôt étant public, l'APK est téléchargeable publiquement ;
   l'accès aux données du compte reste authentifié.
2. Sur Android, ouvrir ce fichier et autoriser temporairement l'installation depuis
   le navigateur/gestionnaire utilisé. Ne pas désinstaller une version existante
   pour contourner un problème de signature. Une alerte Play Protect est possible
   pour une application debug privée. Aucun Google Play ni tunnel SSH nécessaire.
3. Depuis une session authentifiée dans l'application Web sur gym.solhren.fr,
   ouvrir **Paramètres → Compte → Associer l’application mobile**, générer un code et le
   saisir dans l'écran d'appairage Android avant son expiration. Ne jamais
   publier ce code. La passkey reste celle du compte existant ; le jeton
   d'appareil est conservé dans le stockage natif sécurisé.
4. Dans Nutrition, rechercher un produit, vérifier la référence **100 g / 100 ml**,
   choisir une quantité, ajouter puis modifier/supprimer une entrée de test.
   Fermer et rouvrir pour vérifier la persistance. Essayer **Scanner**, accorder
   la permission au moment de l'action, lire un EAN/UPC puis vérifier le produit.
   Tester aussi annulation, caméra refusée et code absent. Une fiche non validée
   ne doit pas être présentée comme ajoutable. Aucun appel fournisseur alimentaire
   n'est requis ; le module scanner Google peut nécessiter son premier téléchargement.

Les tests automatisés simulent le matériel caméra ; ils ne valident pas une
lecture physique, le Keystore constructeur ou la conservation réelle de session
sur téléphone. Les produits déjà enregistrés et le journal restent utilisables
hors ligne ; une nouvelle recherche catalogue nécessite le backend.

## Mises à jour sans perdre les données

Une mise à jour exige **le même identifiant ET la même clé de signature**.
Installer le nouvel APK par-dessus l'ancien ; **ne pas désinstaller**, effacer les
stockages ni réinitialiser les données pour contourner une erreur de signature.
Faire aussi une sauvegarde Nutrition vérifiée avant un changement sensible.

Les runners GitHub sont éphémères : leur clé debug automatique ne constitue pas
une clé stable. Avant la première compilation, enregistrer une clé debug
stable dans le secret du dépôt `ANDROID_BETA_DEBUG_KEYSTORE_BASE64`. Réutiliser la
clé existante si une version `.test` est déjà installée. Ne pas générer une nouvelle
clé pour remplacer silencieusement celle d'une installation existante.

Sur un poste équipé du JDK, **seulement si aucune clé précédente n'est à conserver** :

```bash
# Dossier privé choisi par le propriétaire, en dehors des fichiers Git.
umask 077
mkdir -p "$HOME/.local/share/opengym-signing"
test ! -e "$HOME/.local/share/opengym-signing/debug.keystore" && \
keytool -genkeypair -keystore "$HOME/.local/share/opengym-signing/debug.keystore" \
  -storepass android -keypass android -alias androiddebugkey \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname 'CN=Android Debug,O=Android,C=US'
# Vérifier d'abord que le compte CLI est bien solhren ; ne jamais afficher la clé.
test "$(gh api user --jq .login)" = solhren && \
base64 -w0 "$HOME/.local/share/opengym-signing/debug.keystore" | \
  gh secret set ANDROID_BETA_DEBUG_KEYSTORE_BASE64 --repo solhren/openGym
```

`android` est le mot de passe conventionnel de la clé **debug**, pas un mot de
passe utilisateur. Garder une copie privée de cette clé ; ne jamais la committer,
la partager dans les artefacts ou l'inclure dans l'APK. Le workflow vérifie la clé,
la restaure sur le runner et la retire en fin de job. En son absence, le workflow **échoue avant la compilation** : il ne distribue
pas une clé éphémère qui empêcherait les mises à jour suivantes. Une clé de
développement stable a été préparée dans le workspace privé ignoré sur le VPS ;
elle attend son enregistrement dans ce secret avec le compte GitHub solhren.

## Compilation et authentification GitHub

Le workflow réutilisable est `.github/workflows/android-personal-beta.yml` :
checkout du commit sélectionné, Node 22, Temurin 21, plateforme/build-tools Android
35, `npm ci`, puis :

```bash
node scripts/private-beta/build-android.mjs https://gym.solhren.fr
```

Il vérifie signature APK, identifiant, origine HTTPS et flags d'authentification /
catalogue local ; seuls APK, checksum et `build.json` public sont téléversés. Les
actions sont fixées à leurs commits ; permissions `contents: read`, aucun droit
Play Store, de déploiement ou d'écriture du dépôt. L'exécution APK est limitée au
fork solhren/openGym, à feature/nutrition et à l'acteur solhren, manuellement.
La signature prouve l'identité de la clé de build, pas la sécurité de l'application.
Le SHA-256 fourni détecte la corruption, ce n'est pas une signature d'authenticité.

GitHub exige qu'un workflow dispatchable existe sur la branche par défaut pour
son lancement initial. `test.yml` existe déjà sur main : son sélecteur de branche
charge la version feature/nutrition qui appelle le nouveau workflow au même
commit. Cette entrée évite de modifier main. Le nouveau workflow dédié pourra
également être lancé directement lorsqu'il sera enregistré par GitHub.

Avant publication, vérifier `gh auth status`, `gh api user --jq .login`, le remote
origin et le propriétaire du dépôt. Si l'identité diffère de **solhren** ou si
aucune authentification n'existe, ne pas pousser et ne pas lancer de workflow.
Le dépôt est public : le code et les métadonnées publiques du build ne doivent
jamais contenir de données personnelles, secrets ni sauvegardes.

```bash
gh workflow run test.yml --repo solhren/openGym --ref feature/nutrition
gh run list --repo solhren/openGym --workflow test.yml --branch feature/nutrition --limit 5
# Remplacer RUN_ID par le run créé, puis surveiller et télécharger :
gh run watch RUN_ID --repo solhren/openGym --exit-status
gh run download RUN_ID --repo solhren/openGym --pattern 'opengym-personal-debug-*'
```

Les autres jobs Tests restent actifs : un APK réussi ne doit pas être confondu
avec le succès de toute la suite. Aucun workflow APK n'est déclaré exécuté tant
que GitHub n'en a pas fourni le résultat réel.

## Maintenance et validation locale

Les catalogues/données Docker sont exclus de Git et ne sont pas nécessaires au
build. `npm ci` doit fonctionner depuis les lockfiles d'un clone neuf ; les tests
créent eux-mêmes leurs répertoires temporaires. Les copies natives des ressources
Web sont régénérées par `npm run build:mobile`, pas ajoutées au commit.

```bash
npm --prefix frontend ci
npm --prefix api ci --omit=optional
npm --prefix frontend test -- --maxWorkers=2
npm --prefix api test
(cd frontend && node scripts/check-locales.mjs)
(cd frontend && VITE_OPENGYM_PERSONAL_BETA=1 VITE_NUTRITION_LOCAL_V1=1 \
  VITE_NUTRITION_CATALOG_ORIGIN=https://gym.solhren.fr npm run build:mobile)
git diff --check
```

Le bundle Capacitor n'est pas l'APK : `assembleDebug` exige JDK 21 et SDK 35.
Une compilation GitHub réussie doit encore être suivie des essais physiques
(scanner, appairage, fermeture, réseau coupé puis reprise). Aucun service déployé
n'est modifié par ces commandes de validation du code.

## Audit de publication du 3 novembre 2026

L'inventaire Git exclut bases SQLite, captures Parquet/export, états et sauvegardes
Docker, fichiers `.env` privés, signatures, APK, dépendances et bundles générés.
Ces fichiers ne sont pas effacés du VPS. Le code source natif, tests, scripts et
modèles Docker restent suivis. Les copies générées de Capacitor sont reconstruites.
Le scanner de secrets a signalé une seule chaîne : une fixture synthétique
préexistante de clé publique push, non un secret confirmé ; aucune règle globale
n'a été ajoutée pour masquer ses alertes.

`npm audit` sur les lockfiles actuels signale **9 dépendances frontend** (7 moderate,
2 high, outils de développement) et **1 dépendance API high (`undici`)**. Le frontend
`--omit=dev` en signale **0**. Aucun `audit fix --force`, changement de lockfile ou
mise à jour de production n'a été effectué. Ces avis doivent être traités/revus
avant une publication déclarée durcie ; la compilation réussie ne les résout pas.
Les rapports détaillés locaux restent dans le workspace ignoré d'audit.

Deux corrections de portabilité des tests et une régénération documentaire ont
été nécessaires : parents des dossiers temporaires absents d'un clone neuf,
`TMPDIR` sur tmpfs inférieur à la réserve disque, et référence API générée périmée
par rapport aux nouvelles routes. Les contrôles d'intégrité, nutrition, concurrence
et ressources du produit n'ont pas été affaiblis.

### Validation locale finale

Exécutée depuis une **copie des seuls fichiers Git**, sans réutiliser les captures,
les bases ni les dépendances de la bêta déployée. Node 22.23.3 / npm 10.9.9,
Python 3.13.5, SQLite 3.46.1. Les installations `npm ci` frontend, API
(`--omit=optional`), racine et MCP ont réussi depuis leurs lockfiles.

| Contrôle | Résultat de la dernière exécution |
| --- | --- |
| Frontend `npm test -- --maxWorkers=2` | **5853 tests, 444 fichiers**, 0 échec/ignoré, 397,33 s |
| API `npm test` (HTTP localhost réels compris) | **829 tests**, 0 échec/annulé/ignoré, 87,27 s |
| Catalogue Python `unittest discover`, TMPDIR sur disque | **230 tests**, 0 échec, 11,16 s |
| Catalogue Node `node --test --test-concurrency=1 scripts/nutrition-local-catalog/*.test.mjs` | **110 tests**, 0 échec/annulé/ignoré, 8,80 s |
| Correctif Docker, `unittest discover -s scripts/private-beta/docker -p 'test_*.py' -q` | **4 tests**, 0 échec |
| MCP `npm test -- --maxWorkers=1` | **95 tests**, 3 fichiers, 0 échec/ignoré |
| Probe fatigue existant | **108000 + 1800 comparaisons**, PASS |
| Locales | **18 langues × 2466 clés**, synchronisées |
| Build Web personnel | Réussi |
| `npm run build:mobile`, profil personnel | Réussi, copies dist/Android/iOS vérifiées, ML Kit 7.5.0 détecté |
| Documentation API / assets Coach générés | Synchronisés après régénération API |
| Graphes API core et MCP sous Node brut | Chargés correctement |
| `actionlint` sur les deux workflows concernés | Réussi |
| Étape réelle de restauration de signature du workflow | **4 cas** : secret absent, base64 invalide, faux keystore refusés ; clé stable acceptée et fichier 0600 |
| `git diff --cached --check` | Réussi |

Les relances ciblées ne sont pas additionnées aux suites complètes. Une première
suite Python a échoué sur le garde disque du tmpfs et sur le parent de fixture
absent ; ces causes et leur correction sont décrites dans la documentation du
prototype. Aucun test n'a été ignoré pour obtenir ces résultats finaux.

Avertissements conservés : listeners Vitest, chunks volumineux et imports mixtes
statiques/dynamiques Vite ; CocoaPods/Xcode absents, donc aucune compilation iOS.
Le bundle mobile est contrôlé, **pas un APK compilé**. Un JRE temporaire vérifié
par SHA-256 a servi uniquement à préparer/vérifier la clé debug dans un dossier
privé ignoré ; aucune installation système, JDK complet ou SDK Android ajouté.
La CLI GitHub locale n'est pas authentifiée comme solhren : **aucun push ni run
GitHub Actions n'est revendiqué**. Les essais caméra/Keystore sur appareil restent
nécessaires après la première compilation effectivement réussie.

Le garde externe a surveillé les validations sans abaisser les limites : minimum
observé **24,05 Gio libres et 2,61 Gio de RAM disponible**. Aucun import réel,
redémarrage de service, modification du domaine/proxy ou accès aux données de
production n'a été réalisé par cette validation.

### Stable signing correction after the first compiled artifact

Run `41664952165` compiled successfully, but independent certificate inspection
showed a newly generated Gradle debug certificate rather than the retained key.
**Do not install that intermediate artifact.** Merely decoding the key into
`$HOME/.android` did not bind the Gradle signing configuration to it on the runner.
The private retained key has not been replaced or regenerated.

The workflow now restores the key to a private file in `RUNNER_TEMP` and exports
its absolute path as `OPENGYM_ANDROID_DEBUG_KEYSTORE`. The Android module explicitly
binds its debug signing config to that file, with the conventional debug alias and
password. A configured missing file is an error. The personal build script also
requires this variable instead of accepting an automatic key. Ordinary Android
Studio debug builds without this opt-in and release signing are unchanged.
For a manual personal build, set it to the absolute path of the **existing** key:

```bash
export OPENGYM_ANDROID_DEBUG_KEYSTORE=/ABSOLUTE/PRIVATE/PATH/debug.keystore
node scripts/private-beta/build-android.mjs https://gym.solhren.fr
```

After `apksigner verify --print-certs`, keytool exports only the retained key's
public certificate. `verify-android-signature.py` compares its SHA-256 with the
single verified APK signer; a mismatch prevents artifact upload. The comparison
is additional to APK signature verification, not a substitute for it. Inputs are
bounded public metadata; neither the key nor its password is logged or uploaded
as an artifact. This uses the standard [Gradle signing configuration](https://developer.android.com/build/gradle-tips#sign-your-app).

Regression tests use synthetic **public metadata**, not new signing keys:

```bash
python3 -m unittest discover -s scripts/private-beta -p 'test_android_signature.py' -q
```

All **8 tests pass**, including rejection of the certificate observed in the
intermediate artifact, multiple signers, malformed/oversized metadata and CLI
failures. The actual restoration step was also exercised in four isolated cases
(missing, malformed, non-keystore, retained valid key). The real intermediate
certificate was independently refused against the retained public certificate.
Final distribution must use a later run whose signer comparison succeeds.


## Distribution directe et mise à jour de la préversion

Le canal est `android-personal-beta`, titre **openGym — Bêta Android personnelle**.
Son unique asset ajouté est **opengym-beta-debug.apk**. Le SHA-256, le certificat
public et le lien vers la compilation exacte figurent dans les notes, pas dans
un ZIP ou un fichier privé annexe. GitHub peut afficher ses liens automatiques
vers les archives du code public ; ce ne sont pas des assets privés téléversés.
Les artefacts Actions ZIP restent un recours temporaire, conservé 14 jours.

### Deux actions manuelles simples

1. **Compiler** : Actions → Tests → Run workflow → `feature/nutrition`, laisser
   `android_release_run` vide. Attendre le succès de tous les jobs.
2. **Distribuer** : relancer Tests depuis la CLI ci-dessous, sur cette même branche,
   en renseignant `android_release_run` avec l'identifiant du run de compilation réussi.
   La publication réutilise son APK exact, sans le recompiler. Le mode compilation
   exécute toujours les suites complètes. Le mode distribution vérifie leurs cinq
   résultats réussis dans le run source et exécute les tests des gardes de publication ;
   il ne recommence pas les suites frontend/API ni la construction APK/images déjà
   validées. Ces jobs sont explicitement ignorés dans le mode distribution uniquement.

```bash
# Compte CLI solhren, dépôt solhren/openGym :
gh workflow run test.yml --repo solhren/openGym --ref feature/nutrition
# Après succès du run de compilation, remplacer RUN_ID :
gh workflow run test.yml --repo solhren/openGym --ref feature/nutrition \
  -f android_release_run=RUN_ID
```

Le formulaire GitHub peut rester basé sur les entrées de main : si ce nouveau
champ n'y apparaît pas, utiliser la commande CLI, sans modifier main.

Le lien direct reste identique pour les mises à jour. Installer le nouveau fichier
par-dessus l'application signée avec la même clé. Aucun auto-updater n'est ajouté.
Le run source doit toujours disposer de son artefact non expiré.

### Pourquoi la publication passe par Actions

Le workflow existant `docker-publish.yml` réagit à **release: published**, y compris
une préversion : le créer directement avec un token personnel risquerait de publier
des images `latest`. Le job dédié utilise uniquement le **GITHUB_TOKEN temporaire
du dépôt**, dont les événements release/push ne déclenchent pas d'autres workflows
([règle GitHub](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)).
Aucun token personnel n'est ajouté aux secrets, aucun workflow Docker désactivé,
aucune modification de main ou de la production. Le déclenchement est limité au
compte `solhren`, à son dépôt et à `feature/nutrition` ; l'auteur technique de la
publication est le bot Actions du dépôt.

`.github/workflows/android-personal-release.yml` reçoit seulement `contents: write`
et `actions: read` pour son job de publication. Le jeton est transmis uniquement
à l'étape de distribution. Pas de permission packages, de Play Store ni de clé
privée de signature. Checkout et setup actions restent fixés à leurs commits.
Le script refuse une exécution locale habituelle : ne pas simuler l'environnement
Actions avec un token personnel.

### Contrôles et garanties

`publish-android-release.py` vérifie dépôt, acteur, branche, workflow, tentative,
réussite complète des cinq jobs source, unicité et taille de l'artefact, profil
personnel, nom exact et SHA-256 du fichier, puis signature réelle via SDK 35 et
identifiant réel via aapt. Le certificat est épinglé à l'empreinte publique :

`8c883ac845e2abd0d04e9f6230cf5362e5c61f749723b55c09fbf456881218d8`

Une modification accidentelle du secret de signature ne suffit donc pas à changer
la clé du canal publié. La distribution n'a accès à aucune clé privée. Les entrées
APK privées et les profils invités ou destinés à un autre backend sont refusés.

La première Release est créée en brouillon ; publication seulement après contrôle
du SHA-256 et de la taille calculés par GitHub pour l'asset téléversé. Les mises à
jour refusent les anciennes compilations, les autres préversions/assets et les
changements de certificat. Une répétition du même run et du même fichier réutilise
l'asset sans nouveau transfert. Une seule publication est active à la fois.

Le tag est un **canal de distribution mutable**, pas une version source immuable :
il suit la révision du workflow de publication, uniquement en avance rapide
(`force: false`). Le commit exact ayant produit l'APK est indiqué séparément dans
les notes et le run source ; les archives automatiques du tag incluent les outils
de distribution. Ce choix reste compatible avec les restrictions du jeton Actions
sur les références. Aucune branche principale ni autre tag n'est modifié.

Le remplacement d'un asset GitHub avec `--clobber` n'est pas une transaction globale :
le lien peut être temporairement indisponible pendant son transfert. Toutes les
vérifications locales précèdent ce remplacement ; l'état distant est revérifié
avant de déclarer le succès. Une panne se traite en relançant la publication du
même run. Les données installées sur téléphone, le VPS, la clé privée et les
artefacts Actions ne sont pas effacés. Aucune restauration de données utilisateur
n'est liée à cette opération.

### Tests de distribution

```bash
python3 -m unittest discover -s scripts/private-beta -p 'test_android_*.py' -q
```

**25 tests locaux réussis** : sources étrangères/échouées/incomplètes, tentative
incorrecte ou expirée, corruption, références de checksum malveillantes, symlinks,
fichiers privés, mauvais profil, ancienne version, remplacement d'une Release
étrangère, digest serveur incorrect et certificat divergent. Tests sans réseau ni
clé privée. Les nouvelles fonctions de contrôle ont aussi accepté l'APK réel du
run `41667081441` avec son SHA-256 vérifié ; la publication effective reste à
attester par le job dédié et le contrôle de la Release distante.


Correction observée sur la première publication : GitHub fournit une URL
`untagged-*` aux assets d'un brouillon dont le tag n'est pas encore publié. Le
premier contrôle de lien l'a refusée après le transfert, en conservant le
brouillon et son APK vérifié. Ce lien provisoire est désormais accepté seulement
pour un brouillon, dans le même dépôt, avec nom, digest et taille exacts ; une
Release publiée doit obligatoirement exposer l'URL définitive du canal. Le test
correspondant refuse ce lien provisoire après publication et refuse une origine
étrangère ou un digest absent. Une reprise réutilise le fichier déjà téléversé
s'il correspond ; le commit de publication d'un brouillon est remis à la révision
courante avant la création finale de son tag. Aucune suppression d'APK local,
de catalogue ou de données utilisateur n'est nécessaire.


La reprise du brouillon a également montré que GitHub peut remplacer son
`tag_name` par `untagged-*` lors d'une modification de cible ; la recherche CLI par
le nom définitif échoue alors avant publication. Le distributeur reconnaît aussi
ce brouillon via son titre et son marqueur de provenance, refuse plusieurs
candidats, puis publie **par identifiant REST de Release** avec tag, cible, notes
et statut dans la même mise à jour. Il ne dépend plus d'une recherche CLI de tag
pour publier. Deux tests supplémentaires couvrent la reconnaissance du brouillon
renommé et le parcours complet initial/reprise, avec APIs/SDK simulés : une reprise
ne crée pas de doublon et ne retéléverse pas l'APK déjà vérifié. Les véritables
contrôles de signature et de digest restent obligatoires en CI.

### Distribution attestée — 3 novembre 2026

La publication [41677952445](https://github.com/solhren/openGym/actions/runs/41677952445)
a réussi après reprise du même brouillon. Les **25 tests** des gardes ont réussi
en CI. Aucun APK n'a été recompilé ; les cinq jobs réussis de la compilation
source **41667081441** ont été contrôlés par l'API GitHub.

- [Préversion personnelle](https://github.com/solhren/openGym/releases/tag/android-personal-beta),
  identifiant 432957371, `draft: false`, `prerelease: true`, mutable.
- [Téléchargement direct APK](https://github.com/solhren/openGym/releases/download/android-personal-beta/opengym-beta-debug.apk),
  seul asset ajouté, identifiant 706313758, **238182649 octets**.
- SHA-256 local et GitHub identiques :
  `e9803c92bc495d883c6475aa5bd4c1ab75cfa29031854ebe6dbba371e9283f42`.
- Certificat vérifié contre l'empreinte stable épinglée ci-dessus. Aucune clé
  privée n'est accessible au job de distribution.
- Contrôle anonyme HTTPS du lien : **200**, taille exacte,
  `application/vnd.android.package-archive`, pièce jointe `opengym-beta-debug.apk`.
- L'asset du brouillon a été conservé : pas de doublon ni nouveau transfert lors
  de la reprise. Le tag de canal pointe sur la révision de publication ae60ae53 ;
  le commit de compilation exact 3d2f9c9f est indiqué dans les notes.
- Aucune exécution Docker déclenchée par un événement release. Main et le VPS de
  production n'ont pas été modifiés. Les suites frontend/API n'ont pas été
  relancées dans le mode distribution seul ; leurs résultats source sont requis.

Le téléchargement APK est public, conformément à la visibilité du dépôt. Cela
ne donne ni jeton ni accès aux données du compte ; l'appairage reste nécessaire.
