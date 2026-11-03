// Small anonymous Docker Registry metadata requests, not image downloads.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
export async function resolveImage(repository,tag,{fetchImpl=fetch}={}){
 if(!((repository==='library/node'&&tag==='22-alpine')||(repository==='nginxinc/nginx-unprivileged'&&tag==='alpine')))throw Error('unsupported-base-image');
 const options={redirect:'error',signal:AbortSignal.timeout(15000)};
 const auth=await fetchImpl('https://auth.docker.io/token?service=registry.docker.io&scope=repository:'+repository+':pull',options);
 if(auth.status!==200||Number(auth.headers.get('content-length')||0)>16384)throw Error('registry-auth-unavailable');
 let text='';const reader=auth.body?.getReader();if(!reader)throw Error('registry-auth-empty');
 try{for(;;){const{done,value}=await reader.read();if(done)break;if(text.length+value.byteLength>16384)throw Error('registry-auth-too-large');text+=new TextDecoder().decode(value);}}finally{await reader.cancel();}
 const token=JSON.parse(text).token;
 if(typeof token!=='string'||token.length>8192)throw Error('invalid-registry-token');
 const response=await fetchImpl('https://registry-1.docker.io/v2/'+repository+'/manifests/'+tag,{...options,signal:AbortSignal.timeout(15000),method:'HEAD',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'}});
 const digest=response.headers.get('docker-content-digest');
 if(response.status!==200||!/^sha256:[a-f0-9]{64}$/.test(digest??''))throw Error('registry-manifest-unavailable-'+response.status);
 return (repository==='library/node'?'node':repository)+':'+tag+'@'+digest;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{
  const [target,release]=process.argv.slice(2);if(!target||!/^beta-[0-9]{8}-[a-f0-9]{12}$/.test(release??''))throw Error('Usage: node resolve-images.mjs NEW_IMAGES_CONF beta-YYYYMMDD-SOURCEHASH12');
  const node=await resolveImage('library/node','22-alpine'),nginx=await resolveImage('nginxinc/nginx-unprivileged','alpine');
  fs.writeFileSync(target,`NODE_IMAGE=${node}\nNGINX_IMAGE=${nginx}\nOPENGYM_RELEASE=${release}\n`,{flag:'wx',mode:0o600});console.log('Pinned base image digests recorded; no image pulled.');
 }catch(e){console.error(e.message);process.exitCode=1;}
}
