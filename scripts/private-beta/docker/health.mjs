// Startup hashes every pinned generation before the HTTP listener is opened.
// This health probe stays local and contains no user identity or auth token.
try{
 const response=await fetch('http://127.0.0.1:3307/api/config',{signal:AbortSignal.timeout(3000)});
 const config=await response.json();
 if(response.status!==200||config.personal_beta!==true||config.allow_guest!==false||config.invite_only!==true)throw Error('not-ready');
 const health=await fetch('http://127.0.0.1:3307/api/health',{signal:AbortSignal.timeout(3000)});
 if(health.status!==200||(await health.json()).writable!==true)throw Error('storage-not-ready');
}catch{process.exitCode=1;}
