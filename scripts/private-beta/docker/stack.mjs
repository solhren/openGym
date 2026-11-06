import {betaOrigin} from '../../../api/nutrition/catalog-beta.js';
const logs={driver:'json-file',options:{'max-size':'2m','max-file':'3'}};
const locked={read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],init:true,logging:logs};
const data={type:'volume',source:'data',target:'/var/lib/opengym-beta'};
export function stack({lab=false,origin=process.env.OPENGYM_ORIGIN}={}){
 const target=origin?betaOrigin(origin):null;
 const site=target?.origin||'${OPENGYM_ORIGIN:?set approved HTTPS origin}';
 const hostname=target?.hostname||'${OPENGYM_RP_ID:?set matching HTTPS hostname}';
 const image='opengym-personal-api:${OPENGYM_RELEASE:?set unique reviewed release}';
 const backend={...locked,image,build:{context:'${SOURCE_CONTEXT:-./source}',dockerfile:'scripts/private-beta/docker/Dockerfile.api',args:{NODE_IMAGE:'${NODE_IMAGE:?set pinned Node 22 image}'}},
  user:'1000:1000',restart:'unless-stopped',stop_grace_period:'25s',mem_limit:'1g',cpus:1.5,pids_limit:64,tmpfs:['/tmp:rw,nosuid,nodev,size=128m,mode=1777'],networks:['private'],
  environment:{NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=384',OPENGYM_PRIVATE_BETA:'1',OPENGYM_PERSONAL_BETA:'1',OPENGYM_BETA_DOCKER:'1',BETA_MAX_USERS:'1',PORT:'3307',DATA_DIR:'/var/lib/opengym-beta',ORIGIN:site,RP_ID:hostname,RP_NAME:'openGym personnel',ALLOW_GUEST:'0',INVITE_ONLY:'1',FIRST_USER_ADMIN:'1',PASSWORD_LOGIN:'0',TRUST_PROXY:'0',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_KIND:'wger-v1',NUTRITION_LOCAL_CATALOG_WORKSPACE:'wger-full-registered-20261025',NUTRITION_LOCAL_CATALOG_COMPLEMENT:'wger-fr-quality-20261026',NUTRITION_LOCAL_CATALOG_REFERENCE:'off-reference-full2-20261026',NUTRITION_LOCAL_CATALOG_REFERENCE_INDEX:'wger-off-search-20261026'},
  volumes:[data,{type:'bind',source:'./catalogues',target:'/app/scripts/nutrition-local-catalog/artifacts',read_only:true,bind:{create_host_path:false}}],
  healthcheck:{test:['CMD','node','/app/scripts/private-beta/docker/health.mjs'],interval:'15s',timeout:'8s',start_period:'150s',retries:3}};
 const frontend={...locked,image:'opengym-personal-web:${OPENGYM_RELEASE:?set unique reviewed release}',
  build:{context:'${SOURCE_CONTEXT:-./source}',dockerfile:'scripts/private-beta/docker/Dockerfile.web',args:{NODE_IMAGE:'${NODE_IMAGE:?set pinned Node 22 image}',NGINX_IMAGE:'${NGINX_IMAGE:?set pinned nginx image}',OPENGYM_ORIGIN:site}},
  user:'101:101',restart:'unless-stopped',mem_limit:'128m',cpus:0.5,pids_limit:32,tmpfs:['/tmp:rw,nosuid,nodev,size=64m,mode=1777','/var/cache/nginx:rw,nosuid,nodev,noexec,size=4m,uid=101,gid=101,mode=0700'],networks:lab?['private']:['private','edge'],
  depends_on:{backend:{condition:'service_healthy'}},healthcheck:{test:['CMD','wget','-q','-O','-','http://127.0.0.1:8080/healthz'],interval:'30s',timeout:'5s',retries:3},
  ...(lab?{}:{labels:{'traefik.enable':'true','traefik.docker.network':'net','traefik.http.routers.opengym-personal.rule':`Host(\`${hostname}\`)`,'traefik.http.routers.opengym-personal.entrypoints':'websecure','traefik.http.routers.opengym-personal.tls':'true','traefik.http.routers.opengym-personal.tls.certresolver':'letsencrypt','traefik.http.routers.opengym-personal.service':'opengym-personal','traefik.http.services.opengym-personal.loadbalancer.server.port':'8080'}})};
 const tool={...locked,image,user:'1000:1000',profiles:['tools'],network_mode:'none',mem_limit:'128m',pids_limit:16,tmpfs:['/tmp:rw,nosuid,nodev,size=16m,mode=1777']};
 return {name:lab?'opengym-personal-lab':'opengym-personal',services:{backend,frontend,
  initialize:{...tool,volumes:[data],entrypoint:['node','/app/scripts/private-beta/init-state.mjs'],command:['/var/lib/opengym-beta',site,'--personal']},
  backup:{...tool,environment:backend.environment,volumes:[{...data,read_only:true}],entrypoint:['node','/app/scripts/private-beta/docker/backup.mjs'],command:[]}},
  networks:{private:{internal:true},...(lab?{}:{edge:{external:true,name:'net'}})},
  volumes:{data:{name:lab?'opengym-personal-lab-${OPENGYM_RELEASE:?set unique reviewed release}':'opengym-personal-data-v1',labels:{'org.opengym.profile':'personal','org.opengym.origin':site}}}};
}
