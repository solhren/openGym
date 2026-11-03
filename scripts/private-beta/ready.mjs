// Local readiness only: never contacts the public domain or a food provider.
import {setTimeout} from 'node:timers/promises';
const port=Number(process.env.PORT||3307),until=Date.now()+110000;
while(true){
 try{const personal=process.env.OPENGYM_PERSONAL_BETA==='1';const r=await fetch(`http://127.0.0.1:${port}${personal?'/api/config':'/api/nutrition/catalog/capabilities'}`,{signal:AbortSignal.timeout(2000)});const b=await r.json();if(r.status===200&&(personal?b.personal_beta===true&&b.allow_guest===false:b.selection==='local-only')){console.log('Private beta local catalogue ready');break;}}
 catch{}
 if(Date.now()>until)throw Error('private-beta-not-ready');await setTimeout(500);
}
