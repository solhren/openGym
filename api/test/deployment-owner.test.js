import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deploymentOwner} from '../../scripts/private-beta/deployment-owner.mjs';
const owner={username:'fixture-owner',uid:1234,gid:1234};
test('deployment owner defaults to the invoking identity and rejects a different owner or sudo',()=>{
 assert.deepEqual(deploymentOwner({},owner),{owner:'fixture-owner',uid:1234,gid:1234});
 for(const env of [{OPENGYM_DEPLOY_OWNER:'another-user'},{SUDO_USER:'fixture-admin'},{SUDO_UID:'1000'}])assert.throws(()=>deploymentOwner(env,owner),/without sudo/);
});
test('root fixture ownership is explicit and cannot select privileged runtime IDs',()=>{
 const root={username:'root',uid:0,gid:0};assert.throws(()=>deploymentOwner({},root),/root requires explicit/);
 assert.deepEqual(deploymentOwner({OPENGYM_DEPLOY_OWNER:'root'},root),{owner:'root',uid:1000,gid:1000});
 for(const env of [{OPENGYM_RUNTIME_UID:'0'},{OPENGYM_RUNTIME_GID:'0'},{OPENGYM_RUNTIME_UID:'1000:0'},{OPENGYM_RUNTIME_GID:'-1'}])assert.throws(()=>deploymentOwner({OPENGYM_DEPLOY_OWNER:'root',...env},root),/nonzero/);
});
