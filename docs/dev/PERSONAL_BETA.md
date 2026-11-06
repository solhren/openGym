# Bêta personnelle — gym.example.com, 2 novembre 2026

> **Compilation et installation Android actuelles :** suivre
> [ANDROID_APK_GITHUB.md](ANDROID_APK_GITHUB.md). Le guide distingue la compilation
> GitHub, la signature stable pour les mises à jour et les essais physiques restants.
> Le déploiement actuel est Docker ; les anciennes préparations systemd ci-dessous
> restent historiques et ne doivent pas être appliquées à la stack en service.


**Déploiement retenu : Docker Compose.** Suivre désormais
[PERSONAL_BETA_DOCKER.md](PERSONAL_BETA_DOCKER.md). Les unités systemd et le socket
Unix ci-dessous restent des préparations historiques non installées. Le profil
de compte unique et l'appairage Android décrits ici sont réutilisés par Docker.

Ce document remplace les réglages invités de la préparation d'octobre pour **ce
profil personnel seulement**. Aucun service, proxy, DNS ou compte réel n'a été
modifié/activé pendant la préparation. Le worktree non commité est conservé.

## Constats réseau et opérations en attente d'autorisation

La résolution observée de `gym.example.com` donne **89.167.10.27**, adresse IPv4 de
ce VPS. `curl -I https://gym.example.com` refuse actuellement TLS : le certificat
présenté est **TRAEFIK DEFAULT CERT**, autosigné, avec un nom alternatif ne couvrant
pas le domaine. Aucun `-k` ni désactivation du contrôle de certificat n'est utilisé.
Le DNS IPv4 fonctionne ; ne pas le changer sans raison. La route et le certificat
restent à configurer après revue. La résolution AF_INET6 ne retourne actuellement
aucune adresse pour ce nom ; les essais Wi-Fi et réseau mobile restent à faire.

Traefik et nginx sont présents, mais Docker refuse l'accès à son socket et les
configurations montées ne sont pas lisibles depuis cette session. Les arguments
du processus Traefik actif (PID 3847837) ont toutefois pu être lus en filtrant
seulement les noms : réseau Docker configuré **net**, entrypoints **web :80** et
**websecure :443**, résolveur **letsencrypt**. Le compose du dépôt n'est pas utilisé
comme preuve de la topologie. Il manque encore la confirmation de l'attachement
réel au réseau, l'absence de règle concurrente pour le domaine et le digest de
l'image nginx approuvée. Aucune donnée utilisateur, fichier ACME,
clé de certificat ou variable secrète du proxy ne doit être lu/affiché.

## Solution réseau préparée

```text
Téléphone / navigateur HTTPS :443
  -> Traefik existant (règle Host gym.example.com + certificat valide)
  -> nouveau nginx bêta, réseau Docker existant, port 8080 INTERNE seulement
  -> /run/opengym-beta/api.sock (montage Unix en lecture seule)
  -> systemd-socket-proxyd sur l'hôte
  -> API 127.0.0.1:3307
```

Le frontal sert aussi le build Web isolé pour créer la passkey et demander le
code d'appairage depuis le navigateur du téléphone. Aucun changement de réseau
des conteneurs existants n'est requis : seul le nouveau frontal rejoint le réseau
audité. Aucun `ports:` Compose, aucune écoute API sur `0.0.0.0`, aucun accès aux
données privées dans le frontal. Ses montages portent sur la configuration nginx,
le build Web et le socket, jamais `/var/lib/opengym-beta` ou les catalogues SQLite.

Cette méthode réutilise les mécanismes standards de
[systemd-socket-proxyd](https://www.freedesktop.org/software/systemd/man/latest/systemd-socket-proxyd.html),
du [proxy Unix nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)
et des [labels Docker Traefik](https://doc.traefik.io/traefik/reference/routing-configuration/other-providers/docker/).
Le binaire socket-proxyd est déjà installé. Le certificat reste géré par le
résolveur Traefik existant, pas par l'API. Aucun secret TLS n'entre dans l'APK.

## Un seul compte et première création

Profil rendu pour `https://gym.example.com` :

```text
NODE_ENV=production
OPENGYM_PRIVATE_BETA=1
OPENGYM_PERSONAL_BETA=1
BETA_MAX_USERS=1
ORIGIN=https://gym.example.com
RP_ID=gym.example.com
ALLOW_GUEST=0
INVITE_ONLY=1
FIRST_USER_ADMIN=1
PASSWORD_LOGIN=0
DATA_DIR=/var/lib/opengym-beta
```

L'initialisation `--personal` exige un répertoire neuf ou vide et privé. Elle
produit un marqueur v2 lié au domaine, un état vide et une **invitation aléatoire
128 bits** (32 caractères compatibles avec le formulaire existant), enregistrée
dans `bootstrap-invite.txt` en 0600. Elle ne choisit ni nom, ni mot de passe et
ne crée aucun compte. Le marqueur est écrit en dernier après fsync des fichiers :
un état incomplet n'est pas adopté silencieusement. En cas d'interruption, arrêter
et examiner le dossier ; ne pas réinitialiser un état contenant des données.

Vous ouvrez ensuite le site HTTPS dans Chrome Android ou un navigateur compatible,
entrez l'invitation et le nom **que vous choisissez**, puis créez votre passkey.
Cette seule création vous attribue le rôle administrateur. Le serveur revérifie
le verrou juste avant chaque insertion, après les opérations asynchrones : deux
cérémonies concurrentes ne peuvent pas créer deux comptes. `personalOwner` est
persisté dans la même publication de db.json. Les inscriptions passkey/mot de
passe et les nouvelles invitations sont ensuite refusées ; créer une autre
passkey/appairer un appareil sur ce même compte reste possible. Le bouton de
création disparaît une fois le compte créé. Perdre/supprimer l'identité ne réouvre
pas automatiquement les inscriptions : une incohérence d'état bloque le démarrage.

Le marqueur v2 refuse un démarrage avec l'ancien profil invité v1. Le profil
personnel exige explicitement guest=0, invitations=1, max_users=1. Hors de ce
profil opt-in, les autres instances et les parcours d'entraînement restent inchangés.

## Authentification et persistance Android

L'application ne tente pas WebAuthn dans sa WebView : son origine locale ne
correspond pas à `gym.example.com`. Elle réutilise l'appairage openGym existant :

1. Depuis le navigateur du téléphone, se connecter à `https://gym.example.com` avec
   votre passkey, puis Paramètres → Compte → « Pair the mobile app ».
2. Dans l'APK personnel, « Connect to my server » : origine préremplie
   `https://gym.example.com`, entrer le code de cinq minutes à usage unique.
3. Le serveur fournit un Bearer propre à votre compte ; renouvellement `/api/me`
   et révocation existants restent utilisés. Aucun token n'est compilé dans l'APK.

Le build personnel n'offre pas le choix invité/local, même si `/api/config` ne
répond pas ou retourne une ancienne configuration autorisant les invités. Cette
exception explicite corrige le fallback invité habituel d'openGym en cas de panne,
sans changer le comportement des autres builds. Il ne donne accès aux écrans
qu'après appairage au bon serveur. Le chargement initial reste un écran de connexion,
pas un journal invité. Une session précédemment authentifiée peut consulter son
cache local hors ligne ; cela n'autorise aucun accès serveur sans authentification.
Les données et opérations non acquittées restent conservées après expiration ou
déconnexion et suivent les mécanismes d'adoption déjà existants.

Une ancienne bibliothèque Nutrition d'essai en mode invité conserve son espace
séparé : ce profil ne la transfère pas automatiquement à l'identité du nouveau
compte. Si l'APK `.test` a déjà servi, exporter ses essais avant la mise à jour
et utiliser ensuite la restauration Nutrition explicite dans le compte voulu.
Ne pas désinstaller ni effacer les données de l'application pour réappairer.

Le token et les métadonnées d'appairage du profil personnel sont stockés avec le
plugin natif sécurisé déjà installé. Les écritures sont relues pour confirmer le
succès, sans fallback mémoire/localStorage ; un échec ne devient pas une connexion
réussie. Les anciens fichiers d'appairage des essais ne sont pas importés ou
supprimés automatiquement. Le catalogue utilise la même session que les
entraînements, avec requêtes annulables et sans redirection externe. Ses trois
routes exigent désormais un utilisateur en mode personnel. Les requêtes WebView
avec Bearer valide sont acceptées depuis les origines natives connues ; les
requêtes anonymes ou avec token forgé restent refusées. Les autres modes gardent
le relais public existant. Aucune API alimentaire externe à l'exécution.

## Fichiers préparés pour revue

`scripts/nutrition-local-catalog/runtime/private-beta-gym-final-20261102/` contient la
configuration avec le vrai domaine, l'unité API et les deux unités socket/proxy,
`nginx.conf`, `compose.personal.json` et `review.json` (enabled=false). Ces fichiers
ne sont pas installés. Les paramètres Docker manquants utilisent des substitutions
obligatoires : Compose doit refuser de continuer tant qu'ils ne sont pas renseignés.
L'image doit être un digest approuvé, pas un tag flottant.
Le frontal reprend l'UID/GID réel du compte de préparation (`codex` : 1003:1003
sur ce VPS), pour accéder au socket 0660 et à sa configuration 0600. Une hypothèse
1000:1000 aurait causé un refus de permissions ; elle a été corrigée et testée.
Les préparations plus anciennes `private-beta-gym-20261102` et
`private-beta-gym-reviewed-20261102` sont conservées pour traçabilité, mais ne
doivent pas être installées. Le modèle final passe directement `systemd-analyze
verify`, sans modifier les chemins : `/usr/bin/env` lance Node depuis son bind
mount readonly au démarrage. Utiliser ce lanceur évite que la vérification avant
installation échoue sur le chemin `/opt` qui n'existe que dans le service.

### Audit en lecture seule depuis un terminal autorisé

```bash
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
# Remplacer NOM_TRAEFIK ; ne pas afficher .Config.Env ou acme.json.
docker inspect --format '{{.Name}} network={{.HostConfig.NetworkMode}}{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' NOM_TRAEFIK
docker inspect --format '{{json .NetworkSettings.Networks}}' NOM_TRAEFIK
```

Les seuls éléments de configuration à transmettre ensuite sont les noms de
réseau/entrypoints/résolveur et la règle éventuelle existante de ce hostname.
Aucun secret n'est nécessaire. Ne pas créer une seconde route conflictuelle.

## Opérations exactes à autoriser — NON exécutées

Après validation du réseau, du digest image, du certificat et des fichiers rendus,
dans un terminal administrateur :

```bash
set -e
REVIEW=/home/codex/openGym/scripts/nutrition-local-catalog/runtime/private-beta-gym-final-20261102
test ! -e /var/lib/opengym-beta
test ! -e /etc/opengym-beta.conf
test ! -e /etc/systemd/system/opengym-beta.service
test ! -e /etc/systemd/system/opengym-beta-proxy.socket
test ! -e /etc/systemd/system/opengym-beta-proxy.service
install -d -m 0700 -o codex -g codex /var/lib/opengym-beta
runuser -u codex -- /home/codex/.local/opt/node22/bin/node \
 /home/codex/openGym/scripts/private-beta/init-state.mjs \
 /var/lib/opengym-beta https://gym.example.com --personal
install -m 0600 "$REVIEW/opengym-beta.conf" /etc/opengym-beta.conf
for UNIT in opengym-beta.service opengym-beta-proxy.socket opengym-beta-proxy.service; do
 install -m 0644 "$REVIEW/$UNIT" "/etc/systemd/system/$UNIT"
done
systemd-analyze verify /etc/systemd/system/opengym-beta.service \
 /etc/systemd/system/opengym-beta-proxy.socket /etc/systemd/system/opengym-beta-proxy.service
systemctl daemon-reload
systemctl enable --now opengym-beta.service opengym-beta-proxy.socket
```

Seul le propriétaire lit l'invitation localement (ne pas la transmettre au modèle,
la publier dans les logs ou l'embarquer dans l'APK). Avant tout frontal Internet,
vérifier localement : `/api/config` indique allow_guest=false, personal_beta=true ;
`/api/nutrition/catalog/capabilities` répond 401 sans session. Ce 401 est voulu.

Depuis le dépôt, préparer le build Web dans un **nouveau** répertoire dédié :

```bash
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym/frontend
VITE_OPENGYM_PERSONAL_BETA=1 VITE_NUTRITION_LOCAL_V1=1 \
 VITE_NUTRITION_CATALOG_ORIGIN=https://gym.example.com npm run build \
 -- --outDir ../scripts/nutrition-local-catalog/artifacts/personal-beta-20261102/web
```

Puis, **uniquement après accord d'exposition de cette route**, avec les valeurs
auditées (aucune valeur de réseau/résolveur n'est supposée ici) :

```bash
# Noms observés dans le processus actif ; confirmer réseau/règles avec Docker.
export TRAEFIK_NETWORK=net
export TRAEFIK_HTTPS_ENTRYPOINT=websecure
export TRAEFIK_CERT_RESOLVER=letsencrypt
export BETA_NGINX_IMAGE='IMAGE_APPROUVEE@sha256:DIGEST_VERIFIE'
export BETA_WEB_ROOT=/home/codex/openGym/scripts/nutrition-local-catalog/artifacts/personal-beta-20261102/web
docker compose -f "$REVIEW/compose.personal.json" config --quiet
docker compose -f "$REVIEW/compose.personal.json" up -d web
```

Cette dernière commande crée seulement le nouveau frontal et sa règle Traefik,
sans redémarrer les conteneurs existants. Elle n'est pas autorisée implicitement
par la préparation. Vérifier `curl -I https://gym.example.com` sans `-k`, puis
vérifier sur Wi-Fi et réseau mobile : pas d'avertissement TLS, interface de
connexion, pas de bouton invité, aucune donnée accessible anonymement. Le DNS
ne doit être modifié que si l'audit révèle une divergence réelle.

## APK et retour arrière

```bash
# Poste avec Node 22, JDK 21, SDK 35 ; le script impose le profil personnel.
node scripts/private-beta/build-android.mjs https://gym.example.com
```

Le paquet reste `ch.duartesantos.opengym.test`, distinct de la version principale.
Aucun mot de passe ou token dans le build. L'ancienne archive source d'octobre ne
contient pas cette sécurisation personnelle : ne pas l'utiliser pour ce build.
Java/SDK et caméra physique restent à valider ; un bundle Capacitor n'est pas un
APK. Après configuration et installation, le téléphone fonctionne directement
avec HTTPS sur Wi-Fi/4G/5G, sans tunnel SSH ni ordinateur en fonctionnement.

Rollback : arrêter uniquement le nouveau frontal (`docker compose ... stop web`),
puis désactiver `opengym-beta-proxy.socket` et arrêter `opengym-beta-proxy.service`
et `opengym-beta.service`. Garder `/var/lib/opengym-beta`, les clés de signature
et toutes les générations. Ne pas réinitialiser l'état pour rouvrir les
inscriptions et ne pas restaurer automatiquement une ancienne sauvegarde sur
des opérations non acquittées. Aucun autre service/route/DNS ne doit être changé.

## Vérifications reproductibles sans activation

```bash
export PATH="/home/codex/.local/opt/node22/bin:$PATH"
cd /home/codex/openGym
node scripts/private-beta/check-bridge.mjs
cd api
node --test test/private-beta.test.js test/private-beta-http.test.js test/personal-beta.test.js
npm test
cd ../frontend
npm test -- --maxWorkers=2
node scripts/check-locales.mjs
```

`check-bridge.mjs` a réellement traversé un socket Unix avec les binaires installés
socket-activate/socket-proxyd, jusqu'à un serveur HTTP temporaire écoutant sur
loopback. Les en-têtes Origin et Authorization de test sont conservés. Aucun
service systemd installé/activé, aucun accès Docker, aucun compte réel impliqué.
Ce test n'atteste pas encore du trajet nginx conteneurisé → Traefik → TLS public.

Le test HTTP `personal-beta.test.js` utilise un authentificateur logiciel pour
deux inscriptions concurrentes, puis vérifie le compte unique après redémarrage,
les refus invités/inscriptions, les tokens forgés, la protection CSRF et
l'appairage depuis l'origine native avec son précontrôle CORS. Les fixtures
SQLite sont synthétiques et jetables. Leur génération est coordonnée par un
verrou de tests avec attente bornée à cinq secondes ; le vrai verrou d'import
reste utilisé et inchangé. Une collision entre générateurs de fixtures a ainsi
été corrigée, sans retry d'un import réel et sans toucher aux générations validées.

### Résultats finaux du 2 novembre 2026

Node 22.23.3 / npm 10.9.9. Journaux dans
`scripts/nutrition-local-catalog/artifacts/personal-beta-20261102/`.
Les lignes de ce tableau sont des exécutions distinctes qui se recouvrent :
ne pas additionner les tests ciblés et complets.

| Vérification | Résultat réellement obtenu |
| --- | --- |
| Frontend complet `npm test -- --maxWorkers=2` | **5853 réussis / 444 fichiers**, 0 échec, 0 ignoré ; 404,06 s (`frontend-full-final.log`) |
| API complète `npm test` | **815 réussis**, 0 échec/annulé/ignoré ; 85,50 s (`api-full-final.log`) |
| Frontend ciblé Login, session personnelle, invités, vrai App | **20 réussis / 4 fichiers**, 0 échec/ignoré ; 7,87 s (`frontend-target-final.log`) |
| API ciblée, fixture parallèle et profils bêta | **10 réussis**, 0 échec/ignoré ; 2,06 s (`api-target-serialized.log`) |
| Locales `node scripts/check-locales.mjs` | 18 langues, 2466 clés chacune, synchronisées |
| Build Web avec les trois flags personnels | Réussi ; 2,42 s (`build-web-final.log`) |
| `npm run build:mobile` avec les mêmes flags | Réussi, cap sync Android/iOS et contrôle du bundle ; aucun APK compilé (`build-mobile-final.log`) |
| `node scripts/private-beta/check-bridge.mjs` | HTTP réel par socket Unix réussi, en-têtes de test conservés |
| `systemd-analyze verify` des trois fichiers rendus finaux | Code 0, sans substitution de chemins ; aucun service démarré |
| `docker compose ... config --quiet` | Syntaxe valide avec valeurs de test ; aucun conteneur lancé, réseau/image réels non attestés |
| HTTPS public `curl --head ... https://gym.example.com` | **Bloqué TLS, code 60**, certificat autosigné par défaut ; sécurité non contournée |
| Compilation APK personnelle | **Bloquée**, JDK 21 absent, adb absent, SDK non configuré ; aucun téléchargement/installation |
| `git diff --check` | Réussi |

Les essais intermédiaires ont identifié une collision du verrou entre fixtures
SQLite, puis un retry inadapté car le reconstructeur crée son dossier avant le
verrou. La correction finale sérialise les fixtures avant une unique construction,
sans changer le code d'import. Une première suite frontend lancée pendant les
corrections a eu un échec sur le fallback invité ; la relance ciblée puis la suite
complète sur le code final réussissent. Ces essais intermédiaires ne sont pas
présentés comme des validations réussies et leurs logs sont conservés.

Les builds signalent toujours des chunks volumineux et un import mixte
statique/dynamique de `scan-web.js`. Vitest signale un avertissement de nombre
d'écouteurs dans la suite complète ; pas d'erreur non gérée ni de test ignoré.
Ces avertissements ne sont pas traités par une refonte hors périmètre.

Réserves mesurées en fin de validation : **29,63 Gio libres / 4,26 Gio de RAM
disponible**. Pendant la dernière suite frontend, le garde de ressources a mesuré
au minimum **2,56 Gio disponibles et 29,50 Gio libres**, sans arrêt de sécurité.
Les tests ont fini et leurs processus temporaires sont arrêtés. Aucun service
bêta ne reste actif sur 3307.

La préparation est prête à être examinée ; la bêta n'est **pas encore installable
et validée sur téléphone**. Il faut encore confirmer le réseau Docker et l'image,
autoriser/installer uniquement les nouveaux services et le frontal, obtenir un
certificat valide, compiler avec JDK 21/SDK 35 puis tester passkey, appairage,
persistance du Keystore, scanner et journal sur l'appareil réel.

## Inventaire de cette adaptation personnelle

- API : `api/server.js`, `api/nutrition/catalog-beta.js`,
  `api/nutrition/food-catalog.js` (profil, verrou du propriétaire et contrôle de
  session du catalogue ; synchronisation des entraînements inchangée).
- Tests API : `api/test/personal-beta.test.js`, `api/test/private-beta.test.js`,
  `api/test/catalog-reference.test-util.js` et
  `api/test/catalog-reference-fixture.test.js` (authentification, concurrence,
  reprise, configuration et coordination des fixtures uniquement).
- Frontend : `frontend/src/App.jsx`, `lib/api.js`, `lib/remote.js`,
  `lib/coach-secrets.js`, `lib/guest.js`, `lib/personal-beta.js`,
  `lib/nutrition/catalog/client.js`, `views/Login.jsx`,
  `views/MobileOnboarding.jsx` (ces chemins courts sont sous `frontend/src/`).
- Tests frontend : `frontend/src/lib/personal-beta.test.js` et
  `frontend/src/views/Login.device-link.test.jsx`.
- Préparation : `scripts/private-beta/prepare.mjs`, `init-state.mjs`,
  `ready.mjs`, `build-android.mjs`, `opengym-beta.service.in`,
  `opengym-beta-proxy.socket.in`, `opengym-beta-proxy.service.in`,
  `nginx-personal.conf`, `check-bridge.mjs` (même répertoire).
- Documentation : ce document, le renvoi dans `docs/MOBILE.md` et l'avertissement
  de remplacement du profil d'octobre dans `docs/dev/ANDROID_PRIVATE_BETA.md`.

Les autres modifications du worktree étaient déjà présentes ; elles ne sont ni
réinitialisées ni attribuées à cette adaptation. Pas de nouvelle dépendance, pas
de modification des contrats portables Nutrition, pas de catalogue reconstruit,
pas de compte réel, de service installé ou de modification du DNS/proxy.


### Explicit preparation profile

`prepare.mjs ORIGIN OUTPUT --personal` (or `OPENGYM_PERSONAL_BETA=1`) explicitly
selects the one-owner configuration. The mode is never inferred from a particular
hostname. The configuration generator remains review-only and installs no service.
