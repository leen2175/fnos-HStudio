import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'

process.env.HSTUDIO_MANAGER_TEST_ONLY = '1'
const managerTestData=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-manager-data-'))
process.env.DATA_DIR=managerTestData
const managerTestLifecycle=path.join(managerTestData,'lifecycle')
fs.mkdirSync(path.join(managerTestLifecycle,'cmd'),{recursive:true})
fs.writeFileSync(path.join(managerTestLifecycle,'cmd','main'),'#!/bin/sh\nexit 1\n',{mode:0o755})
process.env.LIFECYCLE_ROOT=managerTestLifecycle
const {apiPermissionError, authSnapshot, beginStudioPublish, bootstrapInProgress, bootstrapProcessMatches, captureCommand, cleanupStudioGarbage, cleanupStudioStaging, compareSemver, controlStudio, csrfOk, drainStudioUpdateForShutdown, fpkCacheForRepository, hermesAgentEnvironment, hermesAgentVersionPolicy, hermesInstallDirectory, npmProcessGroupAlive, npmProcessMatches, parseSemver, persistentNpmOperation, pythonVersionFromText, readStudioRecoveryJournal, recoverStudioPublish, redacted, restoreStudioPublish, rollbackStudioAfterStop, runningNpmOperation, stopStudioForRecoverySync, studioUpdatePolicy, supportedPythonVersion, terminateCommand, trustedHermesAgentOrigin, updateStudio, validateHermesAgentRelease, validateStudioPackage, verifiedStudioPid, verifiedStudioProcess, versionFromText} = await import('../manager/backend/server.mjs')

const request = (headers={}) => ({headers})
const admin = request({'x-trim-userid':'1000','x-trim-isadmin':'true','x-trim-username':'admin',host:'nas.example'})

assert.equal(authSnapshot(admin).isAdmin, true)
assert.equal(apiPermissionError(admin, '/api/status'), null)
assert.equal(apiPermissionError(request({host:'nas.example'}), '/api/status').error, 'admin_required')
assert.equal(apiPermissionError(request({host:'nas.example'}), '/api/runtime/update').error, 'admin_required')
assert.equal(apiPermissionError(request({host:'nas.example'}), '/api/auth'), null)
assert.equal(csrfOk({...admin,headers:{...admin.headers,origin:'https://nas.example'}}), true)
assert.equal(csrfOk({...admin,headers:{...admin.headers,host:'manager.internal',origin:'https://nas.example','sec-fetch-site':'same-origin'}}), true)
assert.equal(csrfOk({...admin,headers:{...admin.headers,origin:'https://evil.example','sec-fetch-site':'same-site'}}), false)
assert.equal(csrfOk({...admin,headers:{...admin.headers,origin:'https://evil.example','sec-fetch-site':'cross-site'}}), false)

const sensitive = [
  'Authorization: Bearer top-secret-token',
  'Bearer naked-secret',
  '{"token":"json-secret","session":"session-secret"}',
  'api_key=api-secret cookie=cookie-secret password=password-secret secret=plain-secret',
]
const clean = redacted(sensitive.join('\n'))
for (const value of ['top-secret-token','naked-secret','json-secret','session-secret','api-secret','cookie-secret','password-secret','plain-secret']) {
  assert.equal(clean.includes(value), false, `secret leaked: ${value}`)
}
assert.match(clean, /\[REDACTED\]/)

assert.equal(parseSemver('v0.7.16').value, '0.7.16')
assert.equal(parseSemver('0.7.016'), null)
assert.equal(parseSemver('0.7.16-01'), null)
assert.equal(compareSemver('0.7.16', '0.7.15'), 1)
assert.equal(compareSemver('0.7.15', '0.7.16'), -1)
assert.equal(compareSemver('9007199254740993.0.0', '9007199254740992.0.0'), 1)
assert.equal(compareSemver('1.0.0', '1.0.0+build.2'), 0)
assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1)
assert.equal(compareSemver('1.0.0', '1.0.0-rc.10'), 1)
assert.throws(()=>compareSemver('latest', '0.7.16'), /invalid_semver/)
assert.equal(versionFromText('hermes-web-ui v0.7.16\n'), '0.7.16')
assert.equal(pythonVersionFromText('Python 3.12.11'), '3.12.11')
assert.equal(pythonVersionFromText('Python 3.11'), '3.11.0')
assert.equal(supportedPythonVersion('Python 3.12.11'), true)
assert.equal(supportedPythonVersion('Python 3.14.0'), false)
assert.equal(supportedPythonVersion('Python 2.7.18'), false)
assert.equal(trustedHermesAgentOrigin('https://github.com/NousResearch/hermes-agent.git'),true)
assert.equal(trustedHermesAgentOrigin('https://github.com/NousResearch/hermes-agent'),true)
assert.equal(trustedHermesAgentOrigin('https://github.com/example/hermes-agent.git'),false)
const hermesRelease={version:'0.20.6',source:'EKKOLearnAI/hermes-studio@v0.7.16',repository:'https://github.com/NousResearch/hermes-agent.git',ref:'v2026.8.27',commit:'5fc308a70719a83cccdbba4c0e39c23f5a8239d5',installMethod:'git',extras:['all'],requirements:{path:'hermes-agent/requirements.txt',sha256:'a'.repeat(64),size:1}}
assert.equal(validateHermesAgentRelease(hermesRelease).commit,hermesRelease.commit)
assert.throws(()=>validateHermesAgentRelease({...hermesRelease,source:'NousResearch/hermes-agent'}),/release_source_invalid/)
assert.throws(()=>validateHermesAgentRelease({...hermesRelease,commit:'main'}),/git_pin_invalid/)
assert.equal(hermesAgentVersionPolicy('Hermes Agent v0.20.6','0.20.6'),'recommended')
assert.equal(hermesAgentVersionPolicy('Hermes Agent v0.21.0','0.20.6'),'ahead')
assert.equal(hermesAgentVersionPolicy('Hermes Agent v0.19.0','0.20.6'),'behind')
const stage=hermesInstallDirectory('stage','11111111-1111-4111-8111-111111111111'),stageEnv=hermesAgentEnvironment(stage)
assert.equal(stageEnv.HERMES_AGENT_ROOT,stage)
assert.equal(stageEnv.VIRTUAL_ENV,path.join(stage,'venv'))
assert.equal(stageEnv.UV_PROJECT_ENVIRONMENT,path.join(stage,'venv'))
assert.equal(runningNpmOperation([{kind:'agent-install',status:'running',target:'codex'}]).target,'codex')
assert.equal(runningNpmOperation([{kind:'hermes-agent-install',status:'running',target:'hermes-agent'}]).target,'hermes-agent')
assert.equal(runningNpmOperation([{kind:'studio-update',status:'success',target:'studio'}]),undefined)
assert.equal(runningNpmOperation([{kind:'other',status:'running',target:'other'}]),undefined)

const npmProcRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-npm-proc-'))
try{
  const pid=13579,procDir=path.join(npmProcRoot,String(pid)),expectedDataDir=path.join(npmProcRoot,'data'),lockFile=path.join(npmProcRoot,'npm-operation.json')
  fs.mkdirSync(procDir)
  const fields=Array(40).fill('0');fields[0]='S';fields[19]='246810'
  fs.writeFileSync(path.join(procDir,'stat'),`${pid} (node) ${fields.join(' ')}\n`)
  fs.writeFileSync(path.join(procDir,'environ'),`DATA_DIR=${expectedDataDir}\0HSTUDIO_NPM_OPERATION=1\0HSTUDIO_NPM_OPERATION_ID=operation-1\0`)
  const lock={status:'running',claimToken:'claim-1',operationId:'operation-1',kind:'studio-update',target:'studio',dataDir:expectedDataDir,childPid:pid,childStartTime:'246810',startedAt:'2026-09-02T00:00:00.000Z'}
  fs.writeFileSync(lockFile,JSON.stringify(lock))
  const options={lockFile,procRoot:npmProcRoot,signal:()=>{},expectedDataDir}
  assert.equal(npmProcessMatches(lock,options),true)
  assert.equal(persistentNpmOperation({...options,pruneStale:false}).id,'operation-1')
  fs.writeFileSync(path.join(procDir,'environ'),`DATA_DIR=${expectedDataDir}\0HSTUDIO_NPM_OPERATION=1\0HSTUDIO_NPM_OPERATION_ID=other\0`)
  assert.equal(npmProcessMatches(lock,options),false)
  assert.equal(persistentNpmOperation({...options,pruneStale:false}),null)
  assert.equal(fs.existsSync(lockFile),true)
  assert.equal(persistentNpmOperation(options),null)
  assert.equal(fs.existsSync(lockFile),false)
}finally{fs.rmSync(npmProcRoot,{recursive:true,force:true})}

const npmRecoveryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-npm-recovery-'))
try{
  const lockFile=path.join(npmRecoveryRoot,'npm-operation.json'),expectedDataDir=path.join(npmRecoveryRoot,'data')
  fs.writeFileSync(lockFile,'{"status":')
  const invalid=persistentNpmOperation({lockFile,expectedDataDir,signal:()=>{throw new Error('not_running')}})
  assert.equal(invalid.recoveryRequired,true)
  assert.equal(invalid.message,'invalid_npm_operation_lock_recovery_required')
  assert.equal(fs.existsSync(lockFile),true)

  const unknownClaim={status:'claiming',claimToken:'claim-unknown',operationId:'operation-unknown',kind:'studio-update',target:'studio',dataDir:expectedDataDir,managerPid:44444,managerStartTime:'123',createdAt:'2026-09-02T00:00:00.000Z'}
  fs.writeFileSync(lockFile,JSON.stringify(unknownClaim))
  const claimed=persistentNpmOperation({lockFile,procRoot:npmRecoveryRoot,signal:()=>{throw new Error('not_running')},expectedDataDir})
  assert.equal(claimed.recoveryRequired,true)
  assert.equal(claimed.message,'unknown_npm_claim_recovery_required')
  assert.equal(fs.existsSync(lockFile),true)

  const orphaned={status:'running',claimToken:'claim-orphan',operationId:'operation-orphan',kind:'studio-update',target:'studio',dataDir:expectedDataDir,childPid:55555,childStartTime:'123',processGroupId:55555,detached:true,startedAt:'2026-09-02T00:00:00.000Z'}
  fs.writeFileSync(lockFile,JSON.stringify(orphaned))
  const groupSignal=(pid)=>{if(pid===-55555)return;throw new Error('not_running')}
  assert.equal(npmProcessGroupAlive(orphaned,{signal:groupSignal}),true)
  const blocked=persistentNpmOperation({lockFile,procRoot:npmRecoveryRoot,signal:groupSignal,expectedDataDir})
  assert.equal(blocked.recoveryRequired,true)
  assert.equal(blocked.message,'orphaned_npm_process_group_recovery_required')
  assert.equal(fs.existsSync(lockFile),true)
}finally{fs.rmSync(npmRecoveryRoot,{recursive:true,force:true})}

const studioProcRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-studio-proc-'))
try{
  const pid=24680,pidFile=path.join(studioProcRoot,'server.pid'),procDir=path.join(studioProcRoot,String(pid)),expectedDataDir=path.join(studioProcRoot,'data')
  fs.mkdirSync(procDir);fs.writeFileSync(pidFile,String(pid))
  const userServer=path.join(expectedDataDir,'.npm-global','lib','node_modules','hermes-web-ui','dist','server','index.js')
  fs.writeFileSync(path.join(procDir,'cmdline'),`${process.execPath}\0${userServer}\0`)
  fs.writeFileSync(path.join(procDir,'environ'),`HERMES_WEB_UI_HOME=${path.join(expectedDataDir,'hermes-home')}\0`)
  const options={procRoot:studioProcRoot,signal:()=>{},expectedDataDir}
  assert.equal(verifiedStudioPid(pidFile,options),pid)
  assert.deepEqual(verifiedStudioProcess(pidFile,options),{pid,source:'user-global',serverPath:userServer,runtimePath:path.join(expectedDataDir,'.npm-global','lib','node_modules','hermes-web-ui','bin','hermes-web-ui')})
  fs.writeFileSync(path.join(procDir,'environ'),`HERMES_WEB_UI_HOME=${path.join(studioProcRoot,'other-home')}\0`)
  assert.equal(verifiedStudioPid(pidFile,options),null)
  fs.writeFileSync(path.join(procDir,'environ'),`HERMES_WEB_UI_HOME=${path.join(expectedDataDir,'hermes-home')}\0`)
  fs.writeFileSync(path.join(procDir,'cmdline'),`${process.execPath}\0${path.join(studioProcRoot,'other','dist','server','index.js')}\0`)
  assert.equal(verifiedStudioPid(pidFile,options),null)
  fs.writeFileSync(path.join(procDir,'cmdline'),`${process.execPath}\0${path.join(expectedDataDir,'runtime','studio','0.7.16','dist','server','index.js')}\0`)
  assert.equal(verifiedStudioPid(pidFile,options),pid)
  assert.equal(verifiedStudioProcess(pidFile,options).source,'bundled')
  fs.writeFileSync(path.join(procDir,'cmdline'),`${process.execPath}\0${path.join(expectedDataDir,'node','lib','node_modules','hermes-web-ui','dist','server','index.js')}\0`)
  assert.equal(verifiedStudioProcess(pidFile,options).source,'bundled')

  const fields=Array(40).fill('0');fields[0]='S';fields[19]='97531'
  fs.writeFileSync(path.join(procDir,'stat'),`${pid} (node) ${fields.join(' ')}\n`)
  fs.writeFileSync(path.join(procDir,'cmdline'),`${process.execPath}\0${userServer}\0`)
  const signals=[];let alive=true
  stopStudioForRecoverySync({pidFile,procRoot:studioProcRoot,expectedDataDir,termAttempts:1,killAttempts:1,pause:()=>{},signal:(target,signal)=>{
    if(signal===0){if(!alive)throw new Error('not_running');return}
    signals.push([target,signal])
    if(signal==='SIGTERM')fs.unlinkSync(pidFile)
    if(signal==='SIGKILL')alive=false
  }})
  assert.deepEqual(signals,[[pid,'SIGTERM'],[pid,'SIGKILL']])
  assert.equal(fs.existsSync(pidFile),false)
}finally{fs.rmSync(studioProcRoot,{recursive:true,force:true})}

const procRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-proc-'))
try{
  const pid=43210,callback='/var/apps/HStudio/cmd/install_callback',procDir=path.join(procRoot,String(pid)),expectedDataDir=path.join(procRoot,'data')
  fs.mkdirSync(procDir)
  const fields=Array(40).fill('0');fields[0]='S';fields[19]='778899'
  fs.writeFileSync(path.join(procDir,'stat'),`${pid} (bash) ${fields.join(' ')}\n`)
  fs.writeFileSync(path.join(procDir,'cmdline'),`/bin/bash\0${callback}\0`)
  fs.writeFileSync(path.join(procDir,'environ'),`DATA_DIR=${expectedDataDir}\0HSTUDIO_RUNTIME_BOOTSTRAP=1\0`)
  const processState={status:'running',callbackPid:pid,callbackStartTime:'778899',callbackDataDir:expectedDataDir}
  const processOptions={procRoot,signal:()=>{},expectedDataDir}
  assert.equal(bootstrapProcessMatches(processState,callback,processOptions),true)
  assert.equal(bootstrapProcessMatches({...processState,callbackStartTime:'1'},callback,processOptions),false)
  assert.equal(bootstrapProcessMatches({...processState,callbackDataDir:'wrong'},callback,processOptions),false)
  fs.writeFileSync(path.join(procDir,'environ'),`DATA_DIR=${expectedDataDir}\0`)
  assert.equal(bootstrapProcessMatches(processState,callback,processOptions),false)
  assert.equal(bootstrapProcessMatches({status:'running'},callback,processOptions),false)
}finally{fs.rmSync(procRoot,{recursive:true,force:true})}

assert.equal(bootstrapInProgress({localChild:{exitCode:null}}),true)

{
  let eventLoopAdvanced=false
  const pulse=setTimeout(()=>{eventLoopAdvanced=true},10)
  const testNode=process.platform==='win32'?'node':process.execPath
  await assert.rejects(captureCommand(testNode,['-e','setTimeout(()=>{}, 1000)'],{cwd:os.tmpdir(),timeoutMs:100}),/command_timeout/)
  clearTimeout(pulse)
  assert.equal(eventLoopAdvanced,true)
}

{
  const firstUpdate=updateStudio()
  assert.equal(controlStudio('start').error,'operation_running')
  assert.equal((await updateStudio()).error,'operation_running')
  assert.equal((await firstUpdate).error,'runtime_not_ready')
}

const packageFixture=(root,version,{name='hermes-web-ui',bin={"hermes-web-ui":"./bin/hermes-web-ui.mjs","hermes-web-ui-mcp":"./bin/hermes-studio-mcp.mjs","hermes-studio-mcp":"./bin/hermes-studio-mcp.mjs"}}={})=>{
  fs.mkdirSync(path.join(root,'bin'),{recursive:true});fs.mkdirSync(path.join(root,'dist','server'),{recursive:true})
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name,version,bin}))
  fs.writeFileSync(path.join(root,'bin','hermes-web-ui.mjs'),'#!/usr/bin/env node\n')
  fs.writeFileSync(path.join(root,'bin','hermes-studio-mcp.mjs'),'#!/usr/bin/env node\n')
  fs.writeFileSync(path.join(root,'dist','server','index.js'),'export {}\n')
}
const packageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-package-'))
try{
  packageFixture(packageRoot,'0.7.16')
  const info=validateStudioPackage(packageRoot,'0.7.16',{readVersion:()=> '0.7.16'})
  assert.equal(info.version,'0.7.16')
  assert.equal(Object.keys(info.binTargets).length,3)
  assert.throws(()=>validateStudioPackage(packageRoot,'0.7.17',{readVersion:()=> '0.7.16'}),/studio_package_version_mismatch/)
  assert.throws(()=>validateStudioPackage(packageRoot,'0.7.16',{readVersion:()=> '0.7.15'}),/studio_package_cli_version_mismatch/)
  packageFixture(packageRoot,'0.7.16',{bin:{"hermes-web-ui":"./bin/hermes-web-ui.mjs","codex":"./bin/hermes-studio-mcp.mjs"}})
  assert.throws(()=>validateStudioPackage(packageRoot,'0.7.16',{readVersion:()=> '0.7.16'}),/studio_package_bins_invalid/)
}finally{fs.rmSync(packageRoot,{recursive:true,force:true})}

const publishRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-publish-'))
try{
  const globalRoot=path.join(publishRoot,'global'),stateFile=path.join(publishRoot,'state.json')
  const oldPackage=path.join(globalRoot,'lib','node_modules','hermes-web-ui'),newPackage=path.join(publishRoot,'new-package'),binDir=path.join(globalRoot,'bin')
  fs.mkdirSync(oldPackage,{recursive:true});fs.mkdirSync(binDir,{recursive:true})
  fs.writeFileSync(path.join(oldPackage,'old-marker'),'old')
  fs.writeFileSync(path.join(binDir,'hermes-web-ui'),'old-bin')
  fs.writeFileSync(stateFile,JSON.stringify({preferredRuntime:'bundled',preserved:true})+'\n')
  packageFixture(newPackage,'0.7.16')
  const info=validateStudioPackage(newPackage,'0.7.16',{readVersion:()=> '0.7.16'})
  const transaction=beginStudioPublish(newPackage,info,{globalRoot,stateFile,validateOwnedBin:()=>true,createLink:(_relative,file)=>fs.writeFileSync(file,'new-bin')})
  assert.equal(fs.existsSync(path.join(oldPackage,'old-marker')),false)
  assert.equal(JSON.parse(fs.readFileSync(stateFile,'utf8')).preferredRuntime,'user-global')
  assert.equal(fs.readFileSync(path.join(binDir,'hermes-web-ui'),'utf8'),'new-bin')
  restoreStudioPublish(transaction)
  assert.equal(fs.readFileSync(path.join(oldPackage,'old-marker'),'utf8'),'old')
  assert.equal(fs.readFileSync(path.join(binDir,'hermes-web-ui'),'utf8'),'old-bin')
  assert.equal(fs.existsSync(path.join(binDir,'hermes-web-ui-mcp')),false)
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),{preferredRuntime:'bundled',preserved:true})
}finally{fs.rmSync(publishRoot,{recursive:true,force:true})}

const failedPublishRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-publish-failure-'))
try{
  const globalRoot=path.join(failedPublishRoot,'global'),stateFile=path.join(failedPublishRoot,'state.json')
  const oldPackage=path.join(globalRoot,'lib','node_modules','hermes-web-ui'),newPackage=path.join(failedPublishRoot,'new-package')
  fs.mkdirSync(oldPackage,{recursive:true});fs.writeFileSync(path.join(oldPackage,'old-marker'),'old')
  fs.writeFileSync(stateFile,JSON.stringify({preferredRuntime:'bundled'})+'\n')
  packageFixture(newPackage,'0.7.16')
  const info=validateStudioPackage(newPackage,'0.7.16',{readVersion:()=> '0.7.16'})
  let links=0
  let publishError
  try{
    beginStudioPublish(newPackage,info,{globalRoot,stateFile,createLink:(_relative,file)=>{
      if(++links===2)throw new Error('injected_link_failure')
      fs.writeFileSync(file,'new-bin')
    }})
  }catch(error){publishError=error}
  assert.match(publishError?.message||'',/injected_link_failure/)
  assert.equal(publishError.cleanupPending,true)
  assert.equal(fs.readFileSync(path.join(oldPackage,'old-marker'),'utf8'),'old')
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),{preferredRuntime:'bundled'})
  assert.equal(fs.existsSync(path.join(globalRoot,'bin','hermes-web-ui')),false)
  await cleanupStudioGarbage({globalRoot,journalFile:path.join(failedPublishRoot,'studio-update-recovery-required')})
}finally{fs.rmSync(failedPublishRoot,{recursive:true,force:true})}

for(let faultStep=1;faultStep<=7;faultStep++){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-publish-step-'))
  try{
    const globalRoot=path.join(root,'global'),stateFile=path.join(root,'state.json'),oldPackage=path.join(globalRoot,'lib','node_modules','hermes-web-ui'),newPackage=path.join(root,'new-package'),oldBin=path.join(globalRoot,'bin','hermes-web-ui')
    fs.mkdirSync(oldPackage,{recursive:true});fs.mkdirSync(path.dirname(oldBin),{recursive:true})
    fs.writeFileSync(path.join(oldPackage,'old-marker'),'old');fs.writeFileSync(oldBin,'old-bin');fs.writeFileSync(stateFile,JSON.stringify({preferredRuntime:'bundled'})+'\n')
    packageFixture(newPackage,'0.7.16')
    const info=validateStudioPackage(newPackage,'0.7.16',{readVersion:()=> '0.7.16'})
    let step=0
    assert.throws(()=>beginStudioPublish(newPackage,info,{globalRoot,stateFile,validateOwnedBin:()=>true,createLink:(_relative,file)=>fs.writeFileSync(file,'new-bin'),afterStep:()=>{if(++step===faultStep)throw new Error(`fault_${faultStep}`)}}),new RegExp(`fault_${faultStep}`))
    assert.equal(fs.readFileSync(path.join(oldPackage,'old-marker'),'utf8'),'old')
    assert.equal(fs.readFileSync(oldBin,'utf8'),'old-bin')
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),{preferredRuntime:'bundled'})
  }finally{fs.rmSync(root,{recursive:true,force:true})}
}

const serverModuleUrl=new URL('../manager/backend/server.mjs',import.meta.url).href
for(let faultStep=1;faultStep<=7;faultStep++){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-publish-crash-'))
  try{
    const globalRoot=path.join(root,'global'),stateFile=path.join(root,'state.json'),journalFile=path.join(root,'studio-update-recovery-required'),oldPackage=path.join(globalRoot,'lib','node_modules','hermes-web-ui'),newPackage=path.join(root,'new-package'),binDir=path.join(globalRoot,'bin'),oldBin=path.join(binDir,'hermes-web-ui')
    fs.mkdirSync(oldPackage,{recursive:true});fs.mkdirSync(binDir,{recursive:true})
    fs.writeFileSync(path.join(oldPackage,'old-marker'),'old');fs.writeFileSync(oldBin,'old-bin');fs.writeFileSync(stateFile,JSON.stringify({preferredRuntime:'bundled',preserved:true})+'\n')
    packageFixture(newPackage,'0.7.16')
    const childSource=`
      import fs from 'node:fs';
      import path from 'node:path';
      const {beginStudioPublish}=await import(${JSON.stringify(serverModuleUrl)});
      const packageRoot=${JSON.stringify(newPackage)};
      const info={packageRoot:path.resolve(packageRoot),version:'0.7.16',binTargets:{
        'hermes-web-ui':{relative:'bin/hermes-web-ui.mjs'},
        'hermes-web-ui-mcp':{relative:'bin/hermes-studio-mcp.mjs'},
        'hermes-studio-mcp':{relative:'bin/hermes-studio-mcp.mjs'}
      }};
      let step=0;
      beginStudioPublish(packageRoot,info,{globalRoot:${JSON.stringify(globalRoot)},stateFile:${JSON.stringify(stateFile)},journalFile:${JSON.stringify(journalFile)},operationId:'crash-${faultStep}',beforeVersion:'0.7.15',validateOwnedBin:()=>true,createLink:(_relative,file)=>fs.writeFileSync(file,'new-bin'),afterStep:()=>{if(++step===${faultStep})process.exit(73)}});
    `
    const child=spawnSync(process.execPath,['--input-type=module','--eval',childSource],{env:{...process.env,HSTUDIO_MANAGER_TEST_ONLY:'1'},encoding:'utf8',timeout:10000})
    assert.equal(child.status,73,`hard-exit stage ${faultStep}: ${child.stderr}`)
    const journal=readStudioRecoveryJournal(journalFile)
    assert.equal(journal.operationId,`crash-${faultStep}`)
    assert.equal(journal.targetVersion,'0.7.16')
    const recovery=recoverStudioPublish({globalRoot,stateFile,journalFile})
    assert.equal(recovery.action,'rollback')
    assert.equal(recovery.cleanupPending,faultStep>=3)
    assert.equal(fs.readFileSync(path.join(oldPackage,'old-marker'),'utf8'),'old')
    assert.equal(fs.readFileSync(oldBin,'utf8'),'old-bin')
    assert.equal(fs.existsSync(path.join(binDir,'hermes-web-ui-mcp')),false)
    assert.equal(fs.existsSync(path.join(binDir,'hermes-studio-mcp')),false)
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),{preferredRuntime:'bundled',preserved:true})
    assert.equal(fs.existsSync(journalFile),false)
    assert.equal(fs.readdirSync(path.dirname(oldPackage)).some(name=>name.includes('.backup.')),false)
    assert.equal(fs.readdirSync(path.dirname(oldPackage)).some(name=>name.includes('.failed.')),faultStep>=3)
    const cleanup=await cleanupStudioGarbage({globalRoot,journalFile})
    assert.equal(cleanup.deferred,false)
    assert.deepEqual(cleanup.errors,[])
    assert.equal(fs.readdirSync(path.dirname(oldPackage)).some(name=>name.includes('.backup.')||name.includes('.failed.')||name.includes('.cleanup.')),false)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
}

const committedRecoveryRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-publish-committed-'))
try{
  const globalRoot=path.join(committedRecoveryRoot,'global'),stateFile=path.join(committedRecoveryRoot,'state.json'),journalFile=path.join(committedRecoveryRoot,'studio-update-recovery-required'),oldPackage=path.join(globalRoot,'lib','node_modules','hermes-web-ui'),newPackage=path.join(committedRecoveryRoot,'new-package'),binDir=path.join(globalRoot,'bin')
  fs.mkdirSync(oldPackage,{recursive:true});fs.mkdirSync(binDir,{recursive:true});fs.writeFileSync(path.join(oldPackage,'old-marker'),'old');fs.writeFileSync(path.join(binDir,'hermes-web-ui'),'old-bin');fs.writeFileSync(stateFile,JSON.stringify({preferredRuntime:'bundled'})+'\n')
  packageFixture(newPackage,'0.7.16')
  const info=validateStudioPackage(newPackage,'0.7.16',{readVersion:()=> '0.7.16'})
  beginStudioPublish(newPackage,info,{globalRoot,stateFile,journalFile,operationId:'committed-recovery',beforeVersion:'0.7.15',validateOwnedBin:()=>true,createLink:(_relative,file)=>fs.writeFileSync(file,'new-bin')})
  const committed=JSON.parse(fs.readFileSync(journalFile,'utf8'));delete committed.checksum;committed.phase='committed';committed.status='committed';committed.checksum=createHash('sha256').update(JSON.stringify(committed)).digest('hex');fs.writeFileSync(journalFile,JSON.stringify(committed)+'\n')
  const recovery=recoverStudioPublish({globalRoot,stateFile,journalFile})
  assert.equal(recovery.action,'commit')
  assert.equal(recovery.cleanupPending,true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(oldPackage,'package.json'),'utf8')).version,'0.7.16')
  assert.equal(fs.readFileSync(path.join(binDir,'hermes-web-ui'),'utf8'),'new-bin')
  assert.equal(JSON.parse(fs.readFileSync(stateFile,'utf8')).preferredRuntime,'user-global')
  assert.equal(fs.existsSync(journalFile),false)
  assert.equal(fs.readdirSync(path.dirname(oldPackage)).some(name=>name.includes('.backup.')),true)
  const cleanup=await cleanupStudioGarbage({globalRoot,journalFile})
  assert.deepEqual(cleanup.errors,[])
  assert.equal(fs.readdirSync(path.dirname(oldPackage)).some(name=>name.includes('.backup.')||name.includes('.failed.')),false)
}finally{fs.rmSync(committedRecoveryRoot,{recursive:true,force:true})}

const malformedJournalRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-publish-malformed-'))
try{
  const globalRoot=path.join(malformedJournalRoot,'global'),stateFile=path.join(malformedJournalRoot,'state.json'),journalFile=path.join(malformedJournalRoot,'studio-update-recovery-required'),sentinel=path.join(globalRoot,'lib','node_modules','hermes-web-ui','sentinel')
  fs.mkdirSync(path.dirname(sentinel),{recursive:true});fs.writeFileSync(sentinel,'untouched');fs.writeFileSync(stateFile,JSON.stringify({preferredRuntime:'bundled'})+'\n');fs.writeFileSync(journalFile,'{"schema":')
  let stopCalls=0
  assert.throws(()=>recoverStudioPublish({globalRoot,stateFile,journalFile,stopStudio:()=>{stopCalls++}}),/studio_update_journal_invalid/)
  assert.equal(stopCalls,0)
  assert.equal(fs.existsSync(journalFile),true)
  assert.equal(fs.readFileSync(sentinel,'utf8'),'untouched')
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),{preferredRuntime:'bundled'})
}finally{fs.rmSync(malformedJournalRoot,{recursive:true,force:true})}

const shutdownRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-shutdown-'))
try{
  const stagingId='11111111-1111-4111-8111-111111111111',stagingBase=path.join(shutdownRoot,'studio-update'),stagingRoot=path.join(stagingBase,stagingId),stagingCleanup=path.join(stagingBase,`.cleanup.${stagingId}`)
  const globalRoot=path.join(shutdownRoot,'global'),stateFile=path.join(shutdownRoot,'state.json'),oldPackage=path.join(globalRoot,'lib','node_modules','hermes-web-ui'),newPackage=path.join(shutdownRoot,'new-package')
  fs.mkdirSync(oldPackage,{recursive:true});fs.mkdirSync(stagingRoot,{recursive:true});fs.writeFileSync(path.join(oldPackage,'old-marker'),'old');fs.writeFileSync(stateFile,JSON.stringify({preferredRuntime:'bundled'})+'\n')
  fs.writeFileSync(path.join(stagingRoot,'partial-package'),'partial')
  packageFixture(newPackage,'0.7.16')
  const info=validateStudioPackage(newPackage,'0.7.16',{readVersion:()=> '0.7.16'})
  const transaction=beginStudioPublish(newPackage,info,{globalRoot,stateFile,createLink:(_relative,file)=>fs.writeFileSync(file,'new-bin')})
  let stopped=0,terminated=0
  assert.deepEqual(drainStudioUpdateForShutdown({transaction,child:{pid:123,exitCode:null},stagingRoot,stagingBase,stopStudio:()=>{stopped++;assert.equal(fs.existsSync(path.join(oldPackage,'old-marker')),false)},terminate:()=>{terminated++;return true}}),{ok:true,errors:[]})
  assert.equal(stopped,1);assert.equal(terminated,1)
  assert.equal(fs.readFileSync(path.join(oldPackage,'old-marker'),'utf8'),'old')
  assert.equal(fs.existsSync(path.join(shutdownRoot,'studio-update-recovery-required')),false)
  assert.equal(fs.readdirSync(path.dirname(oldPackage)).some(name=>name.includes('.failed.')),true)
  assert.equal(fs.existsSync(stagingRoot),false)
  assert.equal(fs.existsSync(stagingCleanup),true)
  const cleanup=await cleanupStudioGarbage({globalRoot,journalFile:path.join(shutdownRoot,'studio-update-recovery-required')})
  assert.deepEqual(cleanup.errors,[])
  const stagingSweep=await cleanupStudioStaging({stagingBase,journalFile:path.join(shutdownRoot,'studio-update-recovery-required'),npmOperation:()=>null})
  assert.deepEqual(stagingSweep,{removed:1,deferred:false,errors:[]})
  assert.equal(fs.existsSync(stagingCleanup),false)
}finally{fs.rmSync(shutdownRoot,{recursive:true,force:true})}

const unconfirmedStagingRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-staging-unconfirmed-'))
try{
  const stagingBase=path.join(unconfirmedStagingRoot,'studio-update'),stagingId='44444444-4444-4444-8444-444444444444',stagingRoot=path.join(stagingBase,stagingId)
  fs.mkdirSync(stagingRoot,{recursive:true})
  const result=drainStudioUpdateForShutdown({child:{pid:456,exitCode:null},stagingRoot,stagingBase,terminate:()=>false})
  assert.equal(result.ok,false);assert.deepEqual(result.errors,['owned_child_stop_failed'])
  assert.equal(fs.existsSync(stagingRoot),true)
  assert.equal(fs.existsSync(path.join(stagingBase,`.cleanup.${stagingId}`)),false)
}finally{fs.rmSync(unconfirmedStagingRoot,{recursive:true,force:true})}

const stagingSweepRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-staging-sweep-'))
try{
  const activeId='22222222-2222-4222-8222-222222222222',cleanupId='33333333-3333-4333-8333-333333333333',stagingBase=path.join(stagingSweepRoot,'studio-update'),journalFile=path.join(stagingSweepRoot,'studio-update-recovery-required')
  const active=path.join(stagingBase,activeId),cleanup=path.join(stagingBase,`.cleanup.${cleanupId}`),lookalike=path.join(stagingBase,`${activeId}.tmp`),cleanupLookalike=path.join(stagingBase,`xcleanupX${cleanupId}`),other=path.join(stagingBase,'manual-files')
  for(const directory of [active,cleanup,lookalike,cleanupLookalike,other]){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'sentinel'),'keep')}
  fs.writeFileSync(journalFile,'recovery pending')
  const journalDeferred=await cleanupStudioStaging({stagingBase,journalFile,npmOperation:()=>null})
  assert.equal(journalDeferred.deferred,true)
  for(const directory of [active,cleanup,lookalike,cleanupLookalike,other])assert.equal(fs.existsSync(directory),true)
  fs.unlinkSync(journalFile)
  const deferred=await cleanupStudioStaging({stagingBase,journalFile,npmOperation:()=>({id:'live-operation'})})
  assert.equal(deferred.deferred,true)
  for(const directory of [active,cleanup,lookalike,cleanupLookalike,other])assert.equal(fs.existsSync(directory),true)
  const swept=await cleanupStudioStaging({stagingBase,journalFile,npmOperation:()=>null})
  assert.equal(swept.removed,2);assert.deepEqual(swept.errors,[])
  assert.equal(fs.existsSync(active),false);assert.equal(fs.existsSync(cleanup),false)
  assert.equal(fs.existsSync(lookalike),true);assert.equal(fs.existsSync(cleanupLookalike),true);assert.equal(fs.existsSync(other),true)
}finally{fs.rmSync(stagingSweepRoot,{recursive:true,force:true})}

const blockedShutdownRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-shutdown-stop-failed-'))
try{
  const globalRoot=path.join(blockedShutdownRoot,'global'),stateFile=path.join(blockedShutdownRoot,'state.json'),journalFile=path.join(blockedShutdownRoot,'studio-update-recovery-required'),oldPackage=path.join(globalRoot,'lib','node_modules','hermes-web-ui'),newPackage=path.join(blockedShutdownRoot,'new-package')
  fs.mkdirSync(oldPackage,{recursive:true});fs.writeFileSync(path.join(oldPackage,'old-marker'),'old');fs.writeFileSync(stateFile,JSON.stringify({preferredRuntime:'bundled'})+'\n');packageFixture(newPackage,'0.7.16')
  const info=validateStudioPackage(newPackage,'0.7.16',{readVersion:()=> '0.7.16'}),transaction=beginStudioPublish(newPackage,info,{globalRoot,stateFile,journalFile,createLink:(_relative,file)=>fs.writeFileSync(file,'new-bin')})
  const result=drainStudioUpdateForShutdown({transaction,stopStudio:()=>{throw new Error('still_running')}})
  assert.equal(result.ok,false);assert.deepEqual(result.errors,['studio_stop_failed'])
  assert.equal(fs.existsSync(path.join(oldPackage,'old-marker')),false)
  assert.equal(fs.existsSync(journalFile),true)
  const recovery=recoverStudioPublish({globalRoot,stateFile,journalFile})
  assert.equal(recovery.action,'rollback');assert.equal(recovery.cleanupPending,true)
  assert.equal(fs.readFileSync(path.join(oldPackage,'old-marker'),'utf8'),'old')
  await cleanupStudioGarbage({globalRoot,journalFile})
}finally{fs.rmSync(blockedShutdownRoot,{recursive:true,force:true})}

const guardedRollbackRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hstudio-rollback-stop-guard-'))
try{
  const globalRoot=path.join(guardedRollbackRoot,'global'),stateFile=path.join(guardedRollbackRoot,'state.json'),journalFile=path.join(guardedRollbackRoot,'studio-update-recovery-required'),oldPackage=path.join(globalRoot,'lib','node_modules','hermes-web-ui'),newPackage=path.join(guardedRollbackRoot,'new-package')
  fs.mkdirSync(oldPackage,{recursive:true});fs.writeFileSync(path.join(oldPackage,'old-marker'),'old');fs.writeFileSync(stateFile,JSON.stringify({preferredRuntime:'bundled'})+'\n');packageFixture(newPackage,'0.7.16')
  const info=validateStudioPackage(newPackage,'0.7.16',{readVersion:()=> '0.7.16'}),transaction=beginStudioPublish(newPackage,info,{globalRoot,stateFile,journalFile,createLink:(_relative,file)=>fs.writeFileSync(file,'new-bin')})
  const stopFailed=await rollbackStudioAfterStop(transaction,{stopStudio:()=>{throw new Error('stop_failed')},waitStopped:()=>true})
  assert.deepEqual(stopFailed,{restored:false,error:'new_runtime_stop_failed'})
  assert.equal(fs.existsSync(journalFile),true);assert.equal(fs.existsSync(path.join(oldPackage,'old-marker')),false)
  const waitFailed=await rollbackStudioAfterStop(transaction,{stopStudio:()=>{},waitStopped:()=>false})
  assert.deepEqual(waitFailed,{restored:false,error:'new_runtime_stop_timeout'})
  assert.equal(fs.existsSync(journalFile),true);assert.equal(fs.existsSync(path.join(oldPackage,'old-marker')),false)
  assert.equal(recoverStudioPublish({globalRoot,stateFile,journalFile}).action,'rollback')
  await cleanupStudioGarbage({globalRoot,journalFile})
}finally{fs.rmSync(guardedRollbackRoot,{recursive:true,force:true})}

{
  const signals=[];let alive=true
  terminateCommand({pid:12345,exitCode:null,hstudioDetached:true},{signal:(pid,signal)=>{signals.push([pid,signal]);if(signal==='SIGTERM')alive=false;if(signal===0&&!alive)throw new Error('not_running')},pause:()=>{}})
  assert.equal(signals.some(([pid,signal])=>pid===(process.platform==='win32'?12345:-12345)&&signal==='SIGTERM'),true)
  assert.equal(signals.some(([,signal])=>signal==='SIGKILL'),false)
}
{
  const signals=[];let alive=true
  terminateCommand({pid:12346,exitCode:null,hstudioDetached:true},{signal:(pid,signal)=>{signals.push([pid,signal]);if(signal==='SIGKILL')alive=false;if(signal===0&&!alive)throw new Error('not_running')},pause:()=>{},attempts:1})
  const target=process.platform==='win32'?12346:-12346
  assert.equal(signals.some(([pid,signal])=>pid===target&&signal==='SIGKILL'),true)
}
{
  // A detached npm leader may exit before its postinstall descendants. The
  // process group still has to be drained even when child.exitCode is set.
  const signals=[];let groupAlive=true
  terminateCommand({pid:12347,exitCode:0,hstudioDetached:true},{signal:(pid,signal)=>{signals.push([pid,signal]);if(signal==='SIGTERM')groupAlive=false;if(signal===0&&!groupAlive)throw new Error('not_running')},pause:()=>{}})
  const target=process.platform==='win32'?12347:-12347
  assert.equal(signals.some(([pid,signal])=>pid===target&&signal==='SIGTERM'),process.platform!=='win32')
}

assert.deepEqual(studioUpdatePolicy('0.7.16','0.7.15'), {currentVersion:'0.7.16',latestVersion:'0.7.15',updateAvailable:false,reason:'ahead-of-registry'})
assert.deepEqual(studioUpdatePolicy('0.7.15','0.7.16'), {currentVersion:'0.7.15',latestVersion:'0.7.16',updateAvailable:true,reason:'update-available'})
assert.deepEqual(studioUpdatePolicy('0.7.16','0.7.16'), {currentVersion:'0.7.16',latestVersion:'0.7.16',updateAvailable:false,reason:'current'})
assert.deepEqual(fpkCacheForRepository({latestVersion:'0.7.15-1',releaseUrl:'https://github.com/old/repository'},'leen2175/fnos-HStudio'), {})
assert.deepEqual(fpkCacheForRepository({repository:'old/repository',releaseUrl:'https://github.com/old/repository'},'leen2175/fnos-HStudio'), {})
assert.deepEqual(fpkCacheForRepository({repository:'leen2175/fnos-HStudio',latestVersion:'0.0.50'},'leen2175/fnos-HStudio'), {repository:'leen2175/fnos-HStudio',latestVersion:'0.0.50'})

const frontend=fs.readFileSync(new URL('../manager/frontend/index.html',import.meta.url),'utf8')
const backend=fs.readFileSync(new URL('../manager/backend/server.mjs',import.meta.url),'utf8')
assert.match(backend, /leen2175\/fnos-HStudio/)
assert.match(frontend, /id="runtimeAction"[^>]*hidden/)
assert.match(frontend, /id="runtimeReadySummary"[^>]*hidden/)
assert.match(frontend, /id="bootstrapWork"/)
assert.match(frontend, /ahead-of-registry/)
assert.match(frontend, /data-tab="agents"><span[^>]*>⌘<\/span>Agents<\/button>/)
assert.match(frontend, /agents:'Agents'/)
assert.match(frontend, /Hermes 已安装':'Hermes 未安装'/)
assert.match(frontend, /id="installHermesAgent"/)
assert.match(frontend, /installAgent\('hermes-agent'/)
assert.match(frontend, /fnOS python312/)
assert.match(backend, /\/api\/agents\/hermes-agent\/install/)
assert.match(backend, /\['update','--yes','--keep-stash'\]/)
assert.match(backend, /'--require-hashes','--no-deps','--requirement',release\.requirementsPath/)
assert.match(backend, /'--no-build-isolation','--no-deps','--editable','\.'/)
assert.match(backend, /\['fetch','--depth=1','origin',release\.ref\]/)
assert.match(backend, /fetched!==release\.commit/)
assert.match(backend, /durableRename\(stageRoot,hermesAgentRoot\)/)
assert.match(backend, /hermesEditableRelocationScript/)
assert.match(frontend, /id="hermesAgentUpdateMethod"/)
assert.match(frontend, /id="hermesAgentRecommendedVersion"/)
assert.match(frontend, /id="hermesAgentBrowser"/)
assert.match(frontend, /hermes update/)
assert.doesNotMatch(frontend, /data-tab="agents"[^>]*>[^<]*Coding Agents/)
assert.doesNotMatch(frontend, /data-tab="runtime"/)
assert.doesNotMatch(frontend, /id="runtimePanel"/)
assert.match(frontend, /id="overviewPanel"[\s\S]*id="runtimeAction"/)
assert.match(frontend, /if\(tab==='runtime'\)tab='overview'/)
assert.match(frontend, /\.tab-panel > \.card \+ \.card \{ margin-top:14px \}/)
assert.match(frontend, /LIFECYCLE_POLL_LIMIT=180/)
assert.match(frontend, /op\.kind==='studio-update'/)
assert.match(frontend, /x\.kind==='studio-lifecycle'&&x\.id===id/)
assert.doesNotMatch(frontend, /setTimeout\(r,700\)/)
assert.doesNotMatch(frontend, /Web UI Runtime 与 Hermes Agent 是两个组件/)
assert.doesNotMatch(frontend, /外部 Agent/)
assert.doesNotMatch(frontend, /Runtime 回退安装/)

fs.rmSync(managerTestData,{recursive:true,force:true})
console.log('PASS Manager authorization, redaction, update guard and ready-state UI')
