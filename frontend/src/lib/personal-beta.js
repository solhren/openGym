// Public build configuration only; credentials are entered/persisted at runtime.
export const PERSONAL_BETA=import.meta.env?.VITE_OPENGYM_PERSONAL_BETA==='1'
// The generic distribution has no default server, including the personal host.
export const PERSONAL_ORIGIN=!PERSONAL_BETA&&import.meta.env?.VITE_OPENGYM_PUBLIC_ANDROID==='1'?'':import.meta.env?.VITE_NUTRITION_CATALOG_ORIGIN||'https://gym.solhren.fr'
if(PERSONAL_BETA){const u=new URL(PERSONAL_ORIGIN);if(u.protocol!=='https:'||u.origin!==PERSONAL_ORIGIN)throw Error('Invalid personal beta HTTPS origin')}
