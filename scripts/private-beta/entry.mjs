import {privateBetaConfig} from '../../api/nutrition/catalog-beta.js';
if(!privateBetaConfig())throw Error('explicit-private-beta-profile-required');
await import('../../api/server.js');
