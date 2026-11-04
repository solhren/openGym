// Public self-hosted web images require an account even when configuration cannot
// be fetched. Legacy web builds and native local-only use remain independent.
export const MANAGED_WEB = import.meta.env.VITE_OPENGYM_MANAGED_WEB === '1' && import.meta.env.VITE_MOBILE !== '1'
