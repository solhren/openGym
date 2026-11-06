// Produces reviewable configuration only. Never installs/enables/reloads anything.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {betaOrigin} from '../../api/nutrition/catalog-beta.js';
export function prepare(origin,output,{personal=process.env.OPENGYM_PERSONAL_BETA==='1'}={}){
 const u=betaOrigin(origin);if(!path.isAbsolute(output)||fs.existsSync(output))throw Error('new-absolute-review-directory-required');
 const parent=path.dirname(output),root=fileURLToPath(new URL('../../scripts/nutrition-local-catalog/runtime/',import.meta.url));
 if(!output.startsWith(root+'private-beta-')||fs.realpathSync(parent)!==parent)throw Error('isolated-beta-workspace-required');
 fs.mkdirSync(output,{mode:0o700});
 const env={PATH:'/opt/opengym-node22/bin:/usr/bin:/bin',NODE_ENV:'production',OPENGYM_PRIVATE_BETA:'1',PORT:'3307',DATA_DIR:'/var/lib/opengym-beta',ORIGIN:u.origin,RP_ID:u.hostname,RP_NAME:'openGym Beta',TRUST_PROXY:'0',ALLOW_GUEST:'1',INVITE_ONLY:'1',FIRST_USER_ADMIN:'0',NUTRITION_LOCAL_CATALOG:'1',NUTRITION_LOCAL_CATALOG_KIND:'wger-v1',NUTRITION_LOCAL_CATALOG_WORKSPACE:'wger-full-registered-20261025',NUTRITION_LOCAL_CATALOG_COMPLEMENT:'wger-fr-quality-20261026',NUTRITION_LOCAL_CATALOG_REFERENCE:'off-reference-full2-20261026',NUTRITION_LOCAL_CATALOG_REFERENCE_INDEX:'wger-off-search-20261026'};
 if(personal&&(!process.getuid?.()||!process.getgid?.()))throw Error('prepare-personal-beta-as-unprivileged-service-owner');
 if(personal)Object.assign(env,{OPENGYM_PERSONAL_BETA:'1',BETA_MAX_USERS:'1',ALLOW_GUEST:'0',FIRST_USER_ADMIN:'1',PASSWORD_LOGIN:'0'});
 const write=(name,text)=>fs.writeFileSync(path.join(output,name),text,{mode:0o600,flag:'wx'});
 write('opengym-beta.conf',Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
 write('opengym-beta.service',fs.readFileSync(new URL('./opengym-beta.service.in',import.meta.url)));
 write('nginx-location.review.conf',`# Only if nginx shares the host network namespace. NOT auto-installed.\n# Inside the existing TLS server for ${u.hostname}; preserve its certificate configuration.\nlocation /api/ {\n proxy_pass http://127.0.0.1:3307;\n proxy_set_header Host $host;\n proxy_set_header X-Forwarded-Proto https;\n proxy_set_header X-Real-IP $remote_addr;\n proxy_set_header X-Forwarded-For $remote_addr;\n client_max_body_size 48m;\n proxy_read_timeout 120s;\n}\n`);
 if(personal){
  for(const n of ['opengym-beta-proxy.socket','opengym-beta-proxy.service'])write(n,fs.readFileSync(new URL('./'+n+'.in',import.meta.url)));
  write('nginx.conf',fs.readFileSync(new URL('./nginx-personal.conf',import.meta.url),'utf8').replace('server_name _;',`server_name ${u.hostname};`));
  const labels={'traefik.enable':'true','traefik.docker.network':'${TRAEFIK_NETWORK:?set audited existing network}','traefik.http.routers.opengym-personal.rule':`Host(\`${u.hostname}\`)`,'traefik.http.routers.opengym-personal.entrypoints':'${TRAEFIK_HTTPS_ENTRYPOINT:?set audited HTTPS entrypoint}','traefik.http.routers.opengym-personal.tls':'true','traefik.http.routers.opengym-personal.tls.certresolver':'${TRAEFIK_CERT_RESOLVER:?set audited certificate resolver}','traefik.http.services.opengym-personal.loadbalancer.server.port':'8080','traefik.http.routers.opengym-personal.service':'opengym-personal'};
  write('compose.personal.json',JSON.stringify({name:'opengym-personal-beta',services:{web:{image:'${BETA_NGINX_IMAGE:?set approved image with immutable digest}',user:process.getuid()+':'+process.getgid(),entrypoint:['nginx','-c','/etc/nginx/nginx.conf','-g','daemon off;'],restart:'unless-stopped',read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],tmpfs:['/tmp:rw,nosuid,nodev,size=128m,mode=1777'],volumes:[{type:'bind',source:output+'/nginx.conf',target:'/etc/nginx/nginx.conf',read_only:true},{type:'bind',source:'${BETA_WEB_ROOT:?set dedicated built web directory}',target:'/usr/share/nginx/html',read_only:true},{type:'bind',source:'/run/opengym-beta',target:'/run/opengym-beta',read_only:true}],labels,networks:['edge'],logging:{driver:'json-file',options:{'max-size':'1m','max-file':'3'}},mem_limit:'128m',cpus:0.25,pids_limit:32}},networks:{edge:{external:true,name:'${TRAEFIK_NETWORK:?set audited existing network}'}}},null,2));
 }
 write('review.json',JSON.stringify({schemaVersion:1,origin:u.origin,rpId:u.hostname,enabled:false,requiresApproval:true,proxyNamespaceVerified:false,tlsVerified:false,apiBind:'127.0.0.1:3307',dataDir:env.DATA_DIR,noExternalFoodApi:true,accounts:personal?'one owner; private bootstrap invitation; public signup and guest disabled':'invite-only; no admin/account auto-provisioned',androidApplicationId:'ch.duartesantos.opengym.test',...(personal?{initializationFlag:'--personal',catalogueAuthenticationRequired:true,proxyTransport:'Unix socket; no host TCP port for sidecar'}:{})},null,2));
 return {output,origin:u.origin,enabled:false};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(![4,5].includes(process.argv.length)||(process.argv[4]&&process.argv[4]!=='--personal'))throw Error('Usage: node prepare.mjs https://beta.your-domain.fr NEW_ABSOLUTE_PRIVATE_BETA_REVIEW_DIR [--personal]');console.log(JSON.stringify(prepare(process.argv[2],process.argv[3],{personal:process.argv[4]==='--personal'||process.env.OPENGYM_PERSONAL_BETA==='1'})));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
