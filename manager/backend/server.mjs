import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawn} from 'node:child_process'
import https from 'node:https'
import {createHash, randomUUID} from 'node:crypto'

const data = process.env.DATA_DIR || path.join(process.env.HOME || os.tmpdir(), 'HStudio-data')
const appRoot = process.env.TRIM_APPDEST || process.cwd()
const lifecycleCandidates = [process.env.LIFECYCLE_ROOT, path.join('/var/apps', process.env.TRIM_APPNAME || 'HStudio'), path.resolve(appRoot, '..'), process.cwd()].filter(Boolean)
const lifecycleRoot = lifecycleCandidates.find(root => fs.existsSync(path.join(root, 'cmd', 'main'))) || lifecycleCandidates[0]
const socket = process.env.MANAGER_SOCKET || path.join(appRoot, 'manager.sock')
const gatewayPrefix = '/app/HStudio/manager'
const state = path.join(data, 'manager', 'state.json')
const bootstrapState = path.join(data, 'manager', 'runtime-bootstrap.json')
const npmRegistryState = path.join(data, 'manager', 'npm-registry.json')
const stoppingMarker = path.join(data,'manager','stopping')
const updateRecoveryMarker = path.join(data,'manager','studio-update-recovery-required')
const npmOperationLock = path.join(data,'manager','npm-operation.json')
const studioJournalSchema = 1
const studioJournalKind = 'hermes-studio-publish'
const studioJournalPhases = new Set(['prepared','bin-backup','package-backup','package-publish','bin-publish','state-publish','verified','rolling-back','files-restored','state-restored','committed'])
const fpkRepository = String(process.env.HSTUDIO_FPK_REPOSITORY || 'leen2175/fnos-HStudio').trim()
const studioPackage = 'hermes-web-ui'
const studioBinNames = Object.freeze(['hermes-web-ui','hermes-web-ui-mcp','hermes-studio-mcp'])
const userGlobalRoot = path.join(data,'.npm-global')
const hermesAgentRoot = process.env.HERMES_AGENT_ROOT || path.join(data,'hermes-agent')
const hermesAgentVenv = path.join(hermesAgentRoot,'venv')
const hermesAgentInstallState = path.join(data,'manager','hermes-agent.json')
const npmLatestTtlMs = 5 * 60 * 1000
const npmLatestFailureTtlMs = 30 * 1000
let npmLatestCache = null
const manifestCandidates = [process.env.TRIM_PKGETC && path.join(process.env.TRIM_PKGETC,'runtime-manifest.json'), path.join(appRoot,'config','runtime-manifest.json'), path.join(appRoot,'etc','runtime-manifest.json'), path.join(lifecycleRoot,'config','runtime-manifest.json'), path.join(lifecycleRoot,'etc','runtime-manifest.json')].filter(Boolean)
const manifest = manifestCandidates.find(file => fs.existsSync(file)) || manifestCandidates[0]
const json = (res, code, value) => { res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(JSON.stringify(value)) }
const authSnapshot = (req) => ({
  useridHeader: Boolean(req.headers['x-trim-userid']),
  isadminHeader: Boolean(req.headers['x-trim-isadmin']),
  isAdmin: ['1','true','yes'].includes(String(req.headers['x-trim-isadmin'] || '').toLowerCase()),
  usernameHeader: Boolean(req.headers['x-trim-username'])
})
const csrfOk = (req) => {
  const origin = req.headers.origin
  if (!origin) return true
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'same-origin') return true
  const directHosts = [req.headers.host].filter(Boolean)
  if (directHosts.some(host => origin === `http://${host}` || origin === `https://${host}`)) return true
  try {
    const originHost = new URL(origin).host
    return directHosts.includes(originHost)
  } catch {}
  return false
}
const permissionError = (req) => {
  const auth = authSnapshot(req)
  if (!auth.useridHeader || !auth.isAdmin) return {error:'admin_required',auth,hint:'请从 HStudio 管理入口打开，确保 fnOS 网关注入 X-Trim-Userid/X-Trim-Isadmin'}
  if (!csrfOk(req)) return {error:'csrf_failed',auth,hint:'fnOS 网关已识别管理员，但请求不是同源请求；请从 fnOS 桌面入口打开 HStudio Manager'}
  return null
}
const apiPermissionError = (req, route) => route === '/api/auth' ? null : permissionError(req)
const redacted = (s) => String(s)
  .replace(/\bBearer\s+[^\s"'<>]+/ig, 'Bearer [REDACTED]')
  .replace(/((?:"|')?(?:authorization|api[_-]?key|token|cookie|session|password|secret)(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/ig, '$1[REDACTED]')
function parseSemver(input) {
  const value=String(input||'').trim()
  const match=value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
  if(!match)return null
  const prerelease=match[4] ? match[4].split('.') : []
  if(prerelease.some(part=>/^\d+$/.test(part)&&part.length>1&&part.startsWith('0')))return null
  return {value:`${match[1]}.${match[2]}.${match[3]}${match[4]?`-${match[4]}`:''}`,numbers:match.slice(1,4),prerelease}
}
const compareNumericIdentifier=(left,right)=>left.length===right.length?(left===right?0:left>right?1:-1):left.length>right.length?1:-1
function compareSemver(left,right) {
  const a=parseSemver(left),b=parseSemver(right)
  if(!a||!b)throw new TypeError('invalid_semver')
  for(let i=0;i<3;i++){const comparison=compareNumericIdentifier(a.numbers[i],b.numbers[i]);if(comparison)return comparison}
  if(!a.prerelease.length&&!b.prerelease.length)return 0
  if(!a.prerelease.length)return 1
  if(!b.prerelease.length)return -1
  for(let i=0;i<Math.max(a.prerelease.length,b.prerelease.length);i++){
    if(a.prerelease[i]===undefined)return -1
    if(b.prerelease[i]===undefined)return 1
    if(a.prerelease[i]===b.prerelease[i])continue
    const aNumeric=/^\d+$/.test(a.prerelease[i]),bNumeric=/^\d+$/.test(b.prerelease[i])
    if(aNumeric&&bNumeric)return compareNumericIdentifier(a.prerelease[i],b.prerelease[i])
    if(aNumeric!==bNumeric)return aNumeric?-1:1
    return a.prerelease[i]>b.prerelease[i]?1:-1
  }
  return 0
}
function studioUpdatePolicy(currentVersion,latestVersion) {
  const current=parseSemver(currentVersion),latest=parseSemver(latestVersion)
  if(!current||!latest)return {currentVersion:String(currentVersion||''),latestVersion:String(latestVersion||''),updateAvailable:false,reason:'invalid-version'}
  const comparison=compareSemver(current.value,latest.value)
  return {currentVersion:current.value,latestVersion:latest.value,updateAvailable:comparison<0,reason:comparison<0?'update-available':comparison===0?'current':'ahead-of-registry'}
}
function validateHermesAgentRelease(value) {
  const release=value&&typeof value==='object'?value:null
  if(!release||!parseSemver(release.version))throw new Error('hermes_agent_release_version_invalid')
  if(!/^EKKOLearnAI\/hermes-studio@v\d+\.\d+\.\d+$/.test(String(release.source||'')))throw new Error('hermes_agent_release_source_invalid')
  if(!trustedHermesAgentOrigin(release.repository))throw new Error('hermes_agent_release_repository_invalid')
  if(!String(release.ref||'').trim()||!/^[0-9a-f]{40}$/i.test(String(release.commit||'')))throw new Error('hermes_agent_release_git_pin_invalid')
  if(release.installMethod!=='git')throw new Error('hermes_agent_release_method_invalid')
  const extras=Array.isArray(release.extras)?release.extras.map(value=>String(value).trim()):[]
  if(!extras.length||extras.some(value=>!/^[a-z0-9-]+$/.test(value)))throw new Error('hermes_agent_release_extras_invalid')
  const requirements=release.requirements
  if(!requirements||typeof requirements!=='object'||!String(requirements.path||'').trim()||!/^[0-9a-f]{64}$/i.test(String(requirements.sha256||''))||!Number.isSafeInteger(requirements.size)||requirements.size<=0)throw new Error('hermes_agent_requirements_metadata_invalid')
  return {...release,version:parseSemver(release.version).value,repository:String(release.repository),ref:String(release.ref),commit:String(release.commit).toLowerCase(),extras,requirements:{path:String(requirements.path),sha256:String(requirements.sha256).toLowerCase(),size:requirements.size}}
}
function readHermesAgentRelease() {
  let lastError
  for(const file of metadataFiles('runtime-manifest.json')){try{
    const release=validateHermesAgentRelease(JSON.parse(fs.readFileSync(file,'utf8')).hermesAgent)
    const root=path.resolve(appRoot),requirementsPath=path.resolve(root,release.requirements.path)
    if(requirementsPath!==root&&!requirementsPath.startsWith(root+path.sep))throw new Error('hermes_agent_requirements_path_invalid')
    const bytes=fs.readFileSync(requirementsPath)
    if(bytes.length!==release.requirements.size||createHash('sha256').update(bytes).digest('hex')!==release.requirements.sha256)throw new Error('hermes_agent_requirements_checksum_invalid')
    return {...release,requirementsPath}
  }catch(error){lastError=error}}
  throw lastError||new Error('hermes_agent_release_missing')
}
function hermesAgentVersionPolicy(currentVersion,recommendedVersion) {
  const current=parseSemver(versionFromText(currentVersion)),recommended=parseSemver(recommendedVersion)
  if(!current||!recommended)return 'unknown'
  const comparison=compareSemver(current.value,recommended.value)
  return comparison<0?'behind':comparison>0?'ahead':'recommended'
}
function readJsonBody(req,res,callback){let body='',tooLarge=false;req.on('data',chunk=>{if(tooLarge)return;body+=chunk;if(Buffer.byteLength(body)>4096){tooLarge=true;body=''}});req.on('end',()=>{if(tooLarge)return json(res,413,{error:'request_too_large'});try{return callback(JSON.parse(body||'{}'))}catch{return json(res,400,{error:'invalid_json'})}})}
const agentDefinitions = {
  codex: {name:'codex', label:'Codex', packageName:'@openai/codex'},
  pi: {name:'pi', label:'Pi', packageName:'@earendil-works/pi-coding-agent', adapter:'pi-mcp-adapter'},
  claude: {name:'claude', label:'Claude Code', packageName:'@anthropic-ai/claude-code'},
}
const agentNames = Object.keys(agentDefinitions)
const npmRegistries = Object.freeze({
  official: 'https://registry.npmjs.org/',
  taobao: 'https://registry.npmmirror.com/',
  npmmirror: 'https://registry.npmmirror.com/',
  tencent: 'https://mirrors.cloud.tencent.com/npm/',
})
const operations = new Map()
let bootstrapChild = null
const activeOwnedChildren = new Set()
let activeStudioStagingRoot = ''
let activeStudioTransaction = null
let shuttingDown = false
const activeCaptureChildren = new Set()
let selectedStudioPending = null
let selectedStudioPendingKey = ''
let statusPending = null
let agentInventoryPending = null
const operationView = (op) => ({id:op.id, kind:op.kind, target:op.target, status:op.status, phase:op.phase||'', message:redacted(op.message||''), output:redacted(op.output||''), beforeVersion:op.beforeVersion||'', targetVersion:op.targetVersion||'', afterVersion:op.afterVersion||'', startedAt:op.startedAt, finishedAt:op.finishedAt||null})
function createOperation(kind,target){const op={id:randomUUID(),kind,target,status:'running',output:'',startedAt:new Date().toISOString()};operations.set(op.id,op);return op}
function rememberOutput(op,chunk){op.output=redacted(`${op.output}${chunk}`).slice(-6000)}
const runningStudioOperation=()=>[...operations.values()].find(op=>op.target==='studio'&&op.status==='running')
const runningNpmOperation=(values=operations.values())=>[...values].find(op=>op.status==='running'&&['agent-install','hermes-agent-install','studio-update'].includes(op.kind))
const blockingNpmOperation=()=>runningNpmOperation()||persistentNpmOperation()
function npmBin(){return process.env.NPM_BIN || (process.env.NODE_ROOT ? path.join(process.env.NODE_ROOT,'bin','npm') : 'npm')}
function nodeBin(){return process.env.NODE_BIN || (process.env.NODE_ROOT ? path.join(process.env.NODE_ROOT,'bin','node') : process.execPath)}
function executableFile(file){try{return fs.statSync(file).isFile()&&Boolean(fs.statSync(file).mode&0o111)}catch{return false}}
function pythonBin(){const candidates=[process.env.PYTHON_BIN,process.env.PYTHON_ROOT&&path.join(process.env.PYTHON_ROOT,'bin','python3'),process.env.PYTHON_ROOT&&path.join(process.env.PYTHON_ROOT,'bin','python'),'/var/apps/python312/target/bin/python3','/var/apps/python312/target/bin/python'].filter(Boolean);return candidates.find(executableFile)||safeCommand('python3')||safeCommand('python')}
function trustedHermesAgentOrigin(value){return /^https:\/\/github\.com\/NousResearch\/hermes-agent(?:\.git)?\/?$/i.test(String(value||'').trim())}
function configuredHermesAgentOrigin(){try{const lines=fs.readFileSync(path.join(hermesAgentRoot,'.git','config'),'utf8').split(/\r?\n/);let origin=false;for(const line of lines){const section=line.trim().match(/^\[([^\]]+)\]$/)?.[1]||'';if(section){origin=/^remote\s+"origin"$/i.test(section);continue}if(origin){const value=line.match(/^\s*url\s*=\s*(.+?)\s*$/i)?.[1];if(value)return value}}}catch{}return ''}
function hermesAgentManagedByHStudio(){try{const value=JSON.parse(fs.readFileSync(hermesAgentInstallState,'utf8'));return value?.schema===1&&path.resolve(String(value.root||''))===path.resolve(hermesAgentRoot)&&trustedHermesAgentOrigin(value.repository)}catch{return false}}
function hermesAgentEnvironment(root=hermesAgentRoot){const venv=path.join(root,'venv'),venvBin=path.join(venv,'bin'),nodeRootBin=process.env.NODE_ROOT&&path.join(process.env.NODE_ROOT,'bin');return {...process.env,HOME:data,HERMES_HOME:path.join(data,'hermes-home'),HERMES_AGENT_ROOT:root,HERMES_SKIP_NODE_BOOTSTRAP:'1',PIP_CACHE_DIR:path.join(data,'.pip-cache'),PIP_DISABLE_PIP_VERSION_CHECK:'1',PIP_NO_INPUT:'1',PYTHONUNBUFFERED:'1',VIRTUAL_ENV:venv,UV_PROJECT_ENVIRONMENT:venv,PATH:[venvBin,nodeRootBin,path.join(userGlobalRoot,'bin'),process.env.PATH].filter(Boolean).join(path.delimiter)}}
function hermesInstallDirectory(kind,id=randomUUID()){
  if(!['stage','backup','failed'].includes(kind)||!/^[0-9a-f-]{36}$/i.test(id))throw new Error('invalid_hermes_install_directory')
  return path.join(path.dirname(hermesAgentRoot),`.${path.basename(hermesAgentRoot)}.${kind}.${id}`)
}
function removeHermesInstallDirectory(directory){
  const resolved=path.resolve(directory),parent=path.resolve(path.dirname(hermesAgentRoot)),name=path.basename(resolved),prefix=`.${path.basename(hermesAgentRoot)}.`
  if(path.dirname(resolved)!==parent||!name.startsWith(prefix)||!/^\.[^.]+\.(?:stage|backup|failed)\.[0-9a-f-]{36}$/i.test(name))throw new Error('unsafe_hermes_install_cleanup')
  fs.rmSync(resolved,{recursive:true,force:true})
}
function prepareHermesGitExcludes(root){
  const file=path.join(root,'.git','info','exclude'),existing=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'',lines=new Set(existing.split(/\r?\n/).filter(Boolean))
  lines.add('/venv/');lines.add('/.install_method')
  atomicWrite(file,[...lines].join('\n')+'\n',0o644)
}
function writeHermesLaunchers(root){
  const bin=path.join(root,'venv','bin')
  for(const [name,module] of [['hermes','hermes_cli.main'],['hermes-agent','run_agent'],['hermes-acp','acp_adapter.entry']])atomicWrite(path.join(bin,name),`#!/bin/sh\nVENV_BIN=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$VENV_BIN/python" -m ${module} "$@"\n`,0o755)
}
const hermesEditableRelocationScript=`from pathlib import Path\nimport os, sys\nroot = Path(sys.argv[1]).resolve()\nsite = list((root / "venv" / "lib").glob("python*/site-packages"))\nassert len(site) == 1, site\npths = list(site[0].glob("__editable__.hermes_agent-*.pth"))\nassert len(pths) == 1, pths\npths[0].write_text(os.path.relpath(root, site[0]) + "\\n", encoding="utf-8")\nfor direct_url in site[0].glob("hermes_agent-*.dist-info/direct_url.json"):\n    direct_url.unlink()\n`
function fsyncDirectory(directory){if(process.platform==='win32')return;let fd;try{fd=fs.openSync(directory,'r');fs.fsyncSync(fd)}finally{if(fd!==undefined)fs.closeSync(fd)}}
function atomicWrite(file,content,mode=0o600){const directory=path.dirname(file);fs.mkdirSync(directory,{recursive:true});const temporary=path.join(directory,`.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);let fd;try{fd=fs.openSync(temporary,'wx',mode);fs.writeFileSync(fd,content);try{fs.fchmodSync(fd,mode)}catch{}fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);fsyncDirectory(directory)}finally{if(fd!==undefined)try{fs.closeSync(fd)}catch{};try{fs.unlinkSync(temporary)}catch{}}}
function processAlive(pid,signal=process.kill){try{signal(pid,0);return true}catch{return false}}
const syncPause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)
function terminateCommand(child,{signal=process.kill,pause=syncPause,attempts=20}={}){
  const pid=Number(child?.pid)
  if(!Number.isSafeInteger(pid)||pid<=1)return true
  const detached=Boolean(child.hstudioDetached&&process.platform!=='win32')
  if(!detached&&child.exitCode!==null)return true
  const target=detached?-pid:pid
  if(!processAlive(target,signal))return true
  try{signal(target,'SIGTERM')}catch{}
  for(let attempt=0;attempt<attempts&&processAlive(target,signal);attempt++)pause(100)
  if(processAlive(target,signal))try{signal(target,'SIGKILL')}catch{}
  for(let attempt=0;attempt<attempts&&processAlive(target,signal);attempt++)pause(100)
  return !processAlive(target,signal)
}
function runCommand(op,command,args,{cwd=data,env=process.env,detached=false,timeoutMs=0,npmMutation=false}={}) {
  return new Promise((resolve,reject) => {
    let settled=false,timer,claim=null
    if(npmMutation){try{claim=claimNpmOperation(op)}catch(error){reject(error);return}}
    const childEnv=npmMutation?{...env,DATA_DIR:data,HSTUDIO_NPM_OPERATION:'1',HSTUDIO_NPM_OPERATION_ID:op.id}:{...env}
    let child
    try{child=spawn(command,args,{cwd,env:childEnv,stdio:['ignore','pipe','pipe'],detached})}catch(error){if(claim)clearNpmOperationClaim(claim);reject(error);return}
    child.hstudioDetached=detached
    op.pid=child.pid
    if(detached)activeOwnedChildren.add(child)
    const finish=error=>{
      if(settled)return
      settled=true
      if(timer)clearTimeout(timer)
      activeOwnedChildren.delete(child)
      let finalError=error
      if(claim){
        const scope=child.hstudioDetached&&process.platform!=='win32'?-Number(child.pid):Number(child.pid)
        if(processAlive(scope)){terminateCommand(child)}
        if(processAlive(scope))finalError=finalError||new Error('npm_process_group_not_stopped')
        else clearNpmOperationClaim(claim,child)
      }
      finalError?reject(finalError):resolve()
    }
    child.stdout.on('data',d=>rememberOutput(op,d))
    child.stderr.on('data',d=>rememberOutput(op,d))
    child.on('error',error=>finish(error))
    child.on('close',code=>finish(code===0?null:Object.assign(new Error(`command_exit_${code}`),{code})))
    if(claim){
      let started=processStartTime(child.pid)
      for(let attempt=0;!started&&attempt<5;attempt++){syncPause(10);started=processStartTime(child.pid)}
      if(!started){terminateCommand(child,{attempts:5});finish(new Error('npm_child_identity_unavailable'));return}
      child.hstudioStartTime=started
      try{publishNpmOperationClaim(claim,child)}catch(error){terminateCommand(child,{attempts:5});finish(error);return}
    }
    if(timeoutMs){timer=setTimeout(()=>{terminateCommand(child);finish(new Error('command_timeout'))},timeoutMs);timer.unref?.()}
  })
}
function captureCommand(command,args,{cwd=data,env=process.env,timeoutMs=15000,detached=false}={}) {
  return new Promise((resolve,reject) => {
    let stdout='',stderr='',settled=false,timer
    const child=spawn(command,args,{cwd,env:{...env},stdio:['ignore','pipe','pipe'],detached})
    child.hstudioDetached=detached
    if(detached)activeCaptureChildren.add(child)
    const finish=(error,value)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);activeCaptureChildren.delete(child);error?reject(error):resolve(value)}
    const failure=(message,extra={})=>Object.assign(new Error(message),{stdout,stderr,...extra})
    const append=(current,chunk)=>`${current}${chunk}`.slice(-65536)
    child.stdout.on('data',chunk=>{stdout=append(stdout,chunk)})
    child.stderr.on('data',chunk=>{stderr=append(stderr,chunk)})
    child.on('error',error=>finish(error))
    child.on('close',code=>code===0?finish(null,{stdout,stderr}):finish(failure(`command_exit_${code}`,{code})))
    timer=setTimeout(()=>{terminateCommand(child,{attempts:5});finish(failure('command_timeout'))},timeoutMs)
    timer.unref?.()
  })
}
function pruneOperations(){const cutoff=Date.now()-30*60*1000;for(const [id,op] of operations)if(op.finishedAt&&Date.parse(op.finishedAt)<cutoff)operations.delete(id)}
function operationsFor(target){pruneOperations();return [...operations.values()].filter(op=>op.target===target).sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)).slice(0,3).map(operationView)}
function npmRegistry(){let id='official';try{id=JSON.parse(fs.readFileSync(npmRegistryState,'utf8')).id||id}catch{};if(id==='npmmirror')id='taobao';if(!npmRegistries[id])id='official';return {id,url:npmRegistries[id],options:Object.entries(npmRegistries).filter(([key])=>key!=='npmmirror').map(([key,url])=>({id:key,url}))}}
function setNpmRegistry(id){if(id==='npmmirror')id='taobao';if(!Object.prototype.hasOwnProperty.call(npmRegistries,id))return {error:'invalid_npm_registry'};const value={id,url:npmRegistries[id],updatedAt:new Date().toISOString()};atomicWrite(npmRegistryState,JSON.stringify(value)+'\n');const npmrc=path.join(data,'.npmrc');atomicWrite(npmrc,`prefix=${path.join(data,'.npm-global')}\ncache=${path.join(data,'.npm-cache')}\nregistry=${value.url}\n`);process.env.NPM_REGISTRY=value.url;process.env.npm_config_registry=value.url;process.env.NPM_CONFIG_REGISTRY=value.url;npmLatestCache=null;return npmRegistry()}
const safeCommand = (name) => {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try { if (fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111)) return candidate } catch {}
  }
  return ''
}
async function executableVersion(command){if(!command)return '';try{const result=await captureCommand(command,['--version'],{cwd:data,env:process.env,timeoutMs:8000,detached:process.platform!=='win32'});return redacted(`${result.stdout||''}${result.stderr||''}`.trim().split(/\r?\n/)[0]||'')}catch{return ''}}
function pythonVersionFromText(value){const match=String(value||'').match(/(?:^|\s)Python\s+(3)\.(\d+)(?:\.(\d+))?/i);return match?`${match[1]}.${match[2]}.${match[3]||'0'}`:''}
function supportedPythonVersion(value){const parsed=pythonVersionFromText(value),minor=Number(parsed.split('.')[1]);return Boolean(parsed&&minor>=11&&minor<14)}
async function pythonRuntime(){const command=pythonBin(),raw=await executableVersion(command),version=pythonVersionFromText(raw);return {available:Boolean(command&&supportedPythonVersion(raw)),path:command||'',version:version||raw||'未检测到版本',required:'Python 3.11–3.13（fnOS python312）'}}
function hermesBrowserRuntime(){const agentBrowser=safeCommand('agent-browser'),chromium=[process.env.AGENT_BROWSER_EXECUTABLE_PATH,'chromium','chromium-browser','google-chrome','google-chrome-stable'].filter(Boolean).map(value=>path.isAbsolute(value)&&executableFile(value)?value:safeCommand(value)).find(Boolean)||'';const missing=[!agentBrowser&&'agent-browser',!chromium&&'Chromium'].filter(Boolean);return {available:missing.length===0,agentBrowser,chromium,status:missing.length?`缺少 ${missing.join('、')}`:'可用'}}
function adapterStatus(def){if(!def.adapter)return {};const adapterRoot=path.join(data,'hermes-home','coding-agent','pi-mcp-adapter'),metadata=path.join(adapterRoot,'node_modules',def.adapter,'package.json');try{const value=JSON.parse(fs.readFileSync(metadata,'utf8'));if(value?.name!==def.adapter||!parseSemver(value?.version))throw new Error('invalid_adapter');return {adapter:def.adapter,adapterRoot,adapterInstalled:true,adapterVersion:value.version}}catch{return {adapter:def.adapter,adapterRoot,adapterInstalled:false,adapterVersion:''}}}
async function hermesAgent(){const expected=path.join(hermesAgentVenv,'bin','hermes'),p=executableFile(expected)?expected:safeCommand('hermes'),v=await executableVersion(p),partial=fs.existsSync(hermesAgentVenv),gitManaged=hermesAgentManagedByHStudio()&&trustedHermesAgentOrigin(configuredHermesAgentOrigin())&&fs.existsSync(path.join(hermesAgentRoot,'pyproject.toml')),python=await pythonRuntime(),operation=operationsFor('hermes-agent')[0]||null,installed=Boolean(p);let release=null,releaseError='';try{release=readHermesAgentRelease()}catch(error){releaseError=error?.message||'hermes_agent_release_invalid'}return {name:'hermes-agent',label:'Hermes Agent',installed,partial,gitManaged,updateMethod:gitManaged?'hermes update':'',path:p,root:hermesAgentRoot,version:v||'未检测到版本',recommendedVersion:release?.version||'',versionPolicy:release?hermesAgentVersionPolicy(v,release.version):'unknown',sourceRef:release?.ref||'',sourceCommit:release?.commit||'',releaseError,browser:hermesBrowserRuntime(),status:operation?.status==='running'?'安装中':p?'可调用':partial?'安装不完整':'未安装',python,operation} }
async function agents(){return Promise.all(agentNames.map(async name=>{const def=agentDefinitions[name],p=safeCommand(name),version=await executableVersion(p),adapter=adapterStatus(def),installed=Boolean(p),ready=installed&&(!def.adapter||adapter.adapterInstalled);return {name,label:def.label,packageName:def.packageName,installed,ready,path:p,version,...adapter,operation:operationsFor(name)[0]||null}}))}
function agentInventory(){if(agentInventoryPending)return agentInventoryPending;const pending=Promise.all([hermesAgent(),agents()]).then(([hermesAgentValue,agentValues])=>({hermesAgent:hermesAgentValue,agents:agentValues,operations:[...operations.values()].map(operationView)}));agentInventoryPending=pending;return pending.finally(()=>{if(agentInventoryPending===pending)agentInventoryPending=null})}
function installAgent(name){
  const def=agentDefinitions[name]; if(!def) return {error:'unknown_agent'}
  if(pathExists(stoppingMarker))return {error:'application_stopping'}
  if(pathExists(updateRecoveryMarker))return {error:'update_recovery_required'}
  if(bootstrapInProgress())return {error:'runtime_bootstrap_running'}
  const existing=blockingNpmOperation(); if(existing) return {error:'operation_running',operation:operationView(existing)}
  const op=createOperation('agent-install',name)
  ;(async()=>{try{const registry=npmRegistry().url,env={...process.env,NPM_CONFIG_PREFIX:userGlobalRoot,npm_config_prefix:userGlobalRoot,NPM_CONFIG_REGISTRY:registry,npm_config_registry:registry},repairAdapterOnly=Boolean(def.adapter&&safeCommand(name)&&!adapterStatus(def).adapterInstalled);if(!repairAdapterOnly)await runCommand(op,npmBin(),['install','--global',def.packageName,`--prefix=${userGlobalRoot}`,`--registry=${registry}`,'--no-audit','--no-fund'],{env,detached:true,timeoutMs:15*60*1000,npmMutation:true});if(def.adapter){const adapterRoot=path.join(data,'hermes-home','coding-agent','pi-mcp-adapter');fs.mkdirSync(adapterRoot,{recursive:true});await runCommand(op,npmBin(),['install','--prefix',adapterRoot,`--registry=${registry}`,'--save-exact','--no-audit','--no-fund',def.adapter],{env,detached:true,timeoutMs:15*60*1000,npmMutation:true})}const installed=(await agents()).find(a=>a.name===name);op.status=installed?.ready?'success':'failed';op.message=installed?.ready?(repairAdapterOnly?'适配器修复完成':'安装完成'):'安装完成但组件状态不完整'}catch(e){op.status='failed';op.message=e.message||'install_failed'}finally{op.finishedAt=new Date().toISOString();delete op.pid}})()
  return {ok:true,operation:operationView(op)}
}
function installHermesAgent(){
  if(pathExists(stoppingMarker))return {error:'application_stopping'}
  if(pathExists(updateRecoveryMarker))return {error:'update_recovery_required'}
  if(bootstrapInProgress())return {error:'runtime_bootstrap_running'}
  const existing=blockingNpmOperation();if(existing)return {error:'operation_running',operation:operationView(existing)}
  const command=pythonBin();if(!command)return {error:'python_runtime_missing',hint:'未检测到 fnOS python312；请确认系统已安装并启用 Python 3.12 运行时'}
  const git=safeCommand('git');if(!git)return {error:'git_runtime_missing',hint:'hermes update 需要 Git；当前 fnOS 环境未检测到 git 命令'}
  let release
  try{release=readHermesAgentRelease()}catch(error){return {error:'hermes_agent_release_invalid',hint:error?.message||'Hermes Agent 固定版本或依赖锁校验失败'}}
  const op=createOperation('hermes-agent-install','hermes-agent');op.phase='preparing';op.message='正在准备可由 hermes update 管理的安装';op.targetVersion=release.version
  ;(async()=>{let stageRoot='',backupRoot='',failedRoot='',published=false,oldMoved=false;try{
    const runtime=await pythonRuntime();if(!runtime.available)throw new Error('python_version_unsupported')
    const venvPython=path.join(hermesAgentVenv,'bin','python'),hermesCommand=path.join(hermesAgentVenv,'bin','hermes')
    const env=hermesAgentEnvironment(),gitDir=path.join(hermesAgentRoot,'.git'),projectFile=path.join(hermesAgentRoot,'pyproject.toml')
    let origin=''
    if(fs.existsSync(gitDir)){try{origin=(await captureCommand(git,['remote','get-url','origin'],{cwd:hermesAgentRoot,env,timeoutMs:10000})).stdout.trim()}catch{}}
    if(origin&&!trustedHermesAgentOrigin(origin))throw new Error('hermes_agent_untrusted_origin')
    const canSelfUpdate=Boolean(hermesAgentManagedByHStudio()&&origin&&fs.existsSync(projectFile)&&executableFile(hermesCommand))
    if(canSelfUpdate){
      op.beforeVersion=versionFromText(await executableVersion(hermesCommand))
      op.phase='hermes-update';op.message='正在执行官方 hermes update'
      await runCommand(op,hermesCommand,['update','--yes','--keep-stash'],{cwd:hermesAgentRoot,env,detached:true,timeoutMs:45*60*1000,npmMutation:true})
    }else{
      const id=randomUUID();stageRoot=hermesInstallDirectory('stage',id);backupRoot=hermesInstallDirectory('backup',id);failedRoot=hermesInstallDirectory('failed',id)
      fs.mkdirSync(stageRoot,{recursive:false,mode:0o700});const stageVenv=path.join(stageRoot,'venv'),stagePython=path.join(stageVenv,'bin','python'),stageHermes=path.join(stageVenv,'bin','hermes'),stageEnv=hermesAgentEnvironment(stageRoot)
      op.phase='git';op.message=`正在获取 Hermes Agent 推荐版本 ${release.version}`
      await runCommand(op,git,['init'],{cwd:stageRoot,env:stageEnv,detached:true,timeoutMs:60000,npmMutation:true})
      await runCommand(op,git,['remote','add','origin',release.repository],{cwd:stageRoot,env:stageEnv,detached:true,timeoutMs:60000,npmMutation:true})
      await runCommand(op,git,['fetch','--depth=1','origin',release.ref],{cwd:stageRoot,env:stageEnv,detached:true,timeoutMs:15*60*1000,npmMutation:true})
      const fetched=(await captureCommand(git,['rev-parse','FETCH_HEAD^{commit}'],{cwd:stageRoot,env:stageEnv,timeoutMs:10000})).stdout.trim().toLowerCase();if(fetched!==release.commit)throw new Error('hermes_agent_commit_mismatch')
      await runCommand(op,git,['checkout','-B','main',fetched],{cwd:stageRoot,env:stageEnv,detached:true,timeoutMs:5*60*1000,npmMutation:true})
      const declared=(await captureCommand(command,['-c','import pathlib,tomllib,sys; print(tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))["project"]["version"])',path.join(stageRoot,'pyproject.toml')],{cwd:stageRoot,env:stageEnv,timeoutMs:10000})).stdout.trim();if(declared!==release.version)throw new Error('hermes_agent_source_version_mismatch')
      prepareHermesGitExcludes(stageRoot);atomicWrite(path.join(stageRoot,'.install_method'),'git\n')
      op.phase='venv';op.message='正在创建 Hermes Agent 私有 Python 环境'
      await runCommand(op,command,['-m','venv',stageVenv],{cwd:stageRoot,env:stageEnv,detached:true,timeoutMs:5*60*1000,npmMutation:true})
      op.phase='dependencies';op.message='正在安装经哈希校验的 Hermes Agent 依赖'
      await runCommand(op,stagePython,['-m','pip','install','--disable-pip-version-check','--no-input','--require-hashes','--no-deps','--requirement',release.requirementsPath],{cwd:stageRoot,env:stageEnv,detached:true,timeoutMs:45*60*1000,npmMutation:true})
      op.phase='editable-install';op.message='正在安装可由 hermes update 管理的源码'
      await runCommand(op,stagePython,['-m','pip','install','--disable-pip-version-check','--no-input','--no-build-isolation','--no-deps','--editable','.', '--config-setting','editable_mode=compat'],{cwd:stageRoot,env:stageEnv,detached:true,timeoutMs:10*60*1000,npmMutation:true})
      await runCommand(op,stagePython,['-c',hermesEditableRelocationScript,stageRoot],{cwd:stageRoot,env:stageEnv,timeoutMs:60000})
      writeHermesLaunchers(stageRoot)
      const stagedVersion=versionFromText(`${(await captureCommand(stageHermes,['--version'],{cwd:stageRoot,env:stageEnv,timeoutMs:15000})).stdout}`);if(stagedVersion!==release.version)throw new Error('hermes_agent_staged_version_mismatch')
      const stagedCommit=(await captureCommand(git,['rev-parse','HEAD'],{cwd:stageRoot,env:stageEnv,timeoutMs:10000})).stdout.trim().toLowerCase(),dirty=(await captureCommand(git,['status','--porcelain'],{cwd:stageRoot,env:stageEnv,timeoutMs:10000})).stdout.trim();if(stagedCommit!==release.commit||dirty)throw new Error('hermes_agent_staged_git_verification_failed')
      op.phase='publish';op.message='正在原子切换 Hermes Agent 安装'
      if(pathExists(hermesAgentRoot)){durableRename(hermesAgentRoot,backupRoot);oldMoved=true}
      durableRename(stageRoot,hermesAgentRoot);stageRoot='';published=true
      const finalEnv=hermesAgentEnvironment(),finalVersion=versionFromText(`${(await captureCommand(hermesCommand,['--version'],{cwd:hermesAgentRoot,env:finalEnv,timeoutMs:15000})).stdout}`);if(finalVersion!==release.version)throw new Error('hermes_agent_published_version_mismatch')
      atomicWrite(hermesAgentInstallState,JSON.stringify({schema:1,root:hermesAgentRoot,repository:release.repository,version:release.version,ref:release.ref,commit:release.commit,requirementsSha256:release.requirements.sha256,updatedAt:new Date().toISOString()})+'\n')
      if(oldMoved){removeHermesInstallDirectory(backupRoot);oldMoved=false}
    }
    const version=await executableVersion(hermesCommand);if(!executableFile(hermesCommand)||!version)throw new Error('hermes_agent_verification_failed')
    const originAfter=(await captureCommand(git,['remote','get-url','origin'],{cwd:hermesAgentRoot,env,timeoutMs:10000})).stdout.trim();if(!trustedHermesAgentOrigin(originAfter)||!fs.existsSync(path.join(hermesAgentRoot,'.git')))throw new Error('hermes_agent_git_verification_failed')
    op.status='success';op.phase='complete';op.afterVersion=version;op.message=`Hermes Agent ${version} 已完成；后续使用 hermes update 更新。请重启 Hermes Studio 使 Agent 生效`
  }catch(error){let rollbackError='';try{if(published&&pathExists(hermesAgentRoot)){durableRename(hermesAgentRoot,failedRoot);published=false}if(oldMoved&&pathExists(backupRoot)){durableRename(backupRoot,hermesAgentRoot);oldMoved=false}if(pathExists(failedRoot))removeHermesInstallDirectory(failedRoot)}catch(recovery){rollbackError=`; rollback: ${recovery?.message||'failed'}`}op.status='failed';op.phase='failed';op.message=`${error?.message||'hermes_agent_install_failed'}${rollbackError}`}finally{try{if(stageRoot&&pathExists(stageRoot))removeHermesInstallDirectory(stageRoot)}catch{};op.finishedAt=new Date().toISOString();delete op.pid}})()
  return {ok:true,operation:operationView(op)}
}
function versionFromText(value){for(const match of String(value||'').matchAll(/(?:^|[^0-9A-Za-z])((?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=$|[^0-9A-Za-z])/g)){const parsed=parseSemver(match[1]);if(parsed)return parsed.value}return ''}
async function cliStudioVersionAsync(entry){if(!entry)return '';try{const result=await captureCommand(nodeBin(),[entry,'--version'],{cwd:path.join(data,'hermes-home'),env:{...process.env},timeoutMs:8000,detached:process.platform!=='win32'});return versionFromText(`${result.stdout||''}\n${result.stderr||''}`)}catch{return ''}}
async function selectedStudioAsync(preferred='auto'){
  const key=String(preferred||'auto')
  if(selectedStudioPending&&selectedStudioPendingKey===key)return selectedStudioPending
  selectedStudioPendingKey=key
  const pending=(async()=>{try{const result=await captureCommand('/bin/bash',[path.join(lifecycleRoot,'cmd','main'),'runtime',key],{env:{...process.env,TRIM_APPDEST:appRoot,LIFECYCLE_ROOT:lifecycleRoot},timeoutMs:10000,detached:true}),selected=result.stdout.trim(),separator=selected.indexOf(':');return separator<1?{source:'',entry:''}:{source:selected.slice(0,separator),entry:selected.slice(separator+1)}}catch{return {source:'',entry:''}}})()
  selectedStudioPending=pending
  return pending.finally(()=>{if(selectedStudioPending===pending){selectedStudioPending=null;selectedStudioPendingKey=''}})
}
const pathExists=file=>{try{fs.lstatSync(file);return true}catch(error){if(error?.code==='ENOENT')return false;throw error}}
const removeFile=file=>{try{fs.unlinkSync(file);fsyncDirectory(path.dirname(file));return true}catch(error){if(error?.code!=='ENOENT')throw error;return false}}
function durableRename(source,destination){fs.renameSync(source,destination);const sourceDirectory=path.dirname(source),destinationDirectory=path.dirname(destination);fsyncDirectory(sourceDirectory);if(destinationDirectory!==sourceDirectory)fsyncDirectory(destinationDirectory)}
const studioJournalTokenPattern='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
async function cleanupStudioGarbage({globalRoot=userGlobalRoot,journalFile=updateRecoveryMarker}={}){
  if(pathExists(journalFile))return {removed:0,deferred:true,errors:[]}
  const packageParent=path.join(globalRoot,'lib','node_modules'),binDir=path.join(globalRoot,'bin'),packagePattern=new RegExp(`^\\.${studioPackage}\\.(backup|failed|cleanup)\\.(${studioJournalTokenPattern})$`,'i'),binPattern=new RegExp(`^\\.(?:${studioBinNames.join('|')})\\.backup\\.${studioJournalTokenPattern}$`,'i'),cleanup=[]
  let removed=0;const errors=[]
  try{
    for(const name of fs.readdirSync(packageParent)){
      const match=name.match(packagePattern);if(!match)continue
      const source=path.join(packageParent,name),target=match[1].toLowerCase()==='cleanup'?source:path.join(packageParent,`.${studioPackage}.cleanup.${match[2]}`)
      try{if(source!==target)durableRename(source,target);cleanup.push(target)}catch{errors.push(name)}
    }
  }catch(error){if(error?.code!=='ENOENT')errors.push('package_scan')}
  try{for(const name of fs.readdirSync(binDir)){if(!binPattern.test(name))continue;try{if(removeFile(path.join(binDir,name)))removed++}catch{errors.push(name)}}}catch(error){if(error?.code!=='ENOENT')errors.push('bin_scan')}
  await Promise.all(cleanup.map(async target=>{try{await fs.promises.rm(target,{recursive:true,force:true});fsyncDirectory(path.dirname(target));removed++}catch{errors.push(path.basename(target))}}))
  return {removed,deferred:false,errors}
}
function quarantineStudioStaging(stagingRoot,{stagingBase=path.join(data,'manager','studio-update')}={}){
  if(!stagingRoot)return {quarantined:false,path:''}
  const base=path.resolve(stagingBase),source=path.resolve(stagingRoot),name=path.basename(source),tokenPattern=new RegExp(`^${studioJournalTokenPattern}$`,'i')
  if(path.dirname(source)!==base||!tokenPattern.test(name))throw new Error('studio_staging_path_invalid')
  if(!pathExists(source))return {quarantined:false,path:''}
  const stat=fs.lstatSync(source)
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('studio_staging_path_invalid')
  const target=path.join(base,`.cleanup.${name}`)
  if(pathExists(target))throw new Error('studio_staging_cleanup_conflict')
  durableRename(source,target)
  return {quarantined:true,path:target}
}
async function cleanupStudioStaging({stagingBase=path.join(data,'manager','studio-update'),journalFile=updateRecoveryMarker,npmOperation=()=>persistentNpmOperation()}={}){
  if(pathExists(journalFile))return {removed:0,deferred:true,errors:[]}
  let active
  try{active=npmOperation()}catch{return {removed:0,deferred:true,errors:['npm_lock_check']}}
  if(active)return {removed:0,deferred:true,errors:[]}
  const base=path.resolve(stagingBase),tokenPattern=new RegExp(`^${studioJournalTokenPattern}$`,'i'),cleanupPattern=new RegExp(`^\\.cleanup\\.(${studioJournalTokenPattern})$`,'i'),cleanup=[],errors=[]
  try{
    const stat=fs.lstatSync(base)
    if(!stat.isDirectory()||stat.isSymbolicLink())return {removed:0,deferred:true,errors:['staging_root_unsafe']}
    for(const name of fs.readdirSync(base)){
      const token=name.match(tokenPattern)?.[0]||name.match(cleanupPattern)?.[1]
      if(!token)continue
      const source=path.join(base,name),target=cleanupPattern.test(name)?source:path.join(base,`.cleanup.${token}`)
      try{if(source!==target)durableRename(source,target);cleanup.push(target)}catch{errors.push(name)}
    }
  }catch(error){if(error?.code==='ENOENT')return {removed:0,deferred:false,errors:[]};errors.push('staging_scan')}
  let removed=0
  await Promise.all(cleanup.map(async target=>{try{await fs.promises.rm(target,{recursive:true,force:true});fsyncDirectory(base);removed++}catch{errors.push(path.basename(target))}}))
  return {removed,deferred:false,errors}
}
function pathInside(root,candidate){const relative=path.relative(path.resolve(root),path.resolve(candidate));return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`))}
function packageFile(root,relative,errorCode){
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative))throw new Error(errorCode)
  const file=path.resolve(root,relative)
  if(!pathInside(root,file))throw new Error(errorCode)
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||!pathInside(fs.realpathSync(root),fs.realpathSync(file)))throw new Error(errorCode);return file}catch(error){if(error?.message===errorCode)throw error;throw new Error(errorCode)}
}
function validateStudioPackage(packageRoot,targetVersion,{readVersion}={}){
  const target=parseSemver(targetVersion),rootStat=fs.lstatSync(packageRoot)
  if(!target||!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('studio_package_layout_invalid')
  if(typeof readVersion!=='function')throw new Error('studio_package_version_reader_required')
  const metadata=packageFile(packageRoot,'package.json','studio_package_metadata_invalid')
  let pkg;try{pkg=JSON.parse(fs.readFileSync(metadata,'utf8'))}catch{throw new Error('studio_package_metadata_invalid')}
  if(pkg?.name!==studioPackage)throw new Error('studio_package_name_mismatch')
  if(pkg?.version!==target.value)throw new Error('studio_package_version_mismatch')
  if(!pkg.bin||typeof pkg.bin!=='object'||Array.isArray(pkg.bin))throw new Error('studio_package_bins_invalid')
  const names=Object.keys(pkg.bin)
  if(!names.includes('hermes-web-ui')||names.some(name=>!studioBinNames.includes(name)))throw new Error('studio_package_bins_invalid')
  const binTargets={}
  for(const name of names){
    const relative=String(pkg.bin[name]||'').replace(/^\.\//,'')
    binTargets[name]={relative,file:packageFile(packageRoot,relative,'studio_package_entry_invalid')}
  }
  if(binTargets['hermes-web-ui'].relative!=='bin/hermes-web-ui.mjs')throw new Error('studio_package_entry_invalid')
  packageFile(packageRoot,'dist/server/index.js','studio_package_server_invalid')
  const cliVersion=readVersion(binTargets['hermes-web-ui'].file)
  if(!cliVersion||compareSemver(cliVersion,target.value)!==0)throw new Error('studio_package_cli_version_mismatch')
  return {packageRoot:path.resolve(packageRoot),version:target.value,entry:binTargets['hermes-web-ui'].file,binTargets}
}
function fileSnapshot(file){try{const stat=fs.statSync(file);return {exists:true,content:fs.readFileSync(file),mode:stat.mode&0o777}}catch(error){if(error?.code==='ENOENT')return {exists:false};throw error}}
function restoreFileSnapshot(file,snapshot){if(snapshot.exists)atomicWrite(file,snapshot.content,snapshot.mode);else removeFile(file)}
function snapshotForJournal(snapshot){
  if(!snapshot.exists)return {exists:false}
  const content=snapshot.content.toString('base64')
  if(content.length>131072)throw new Error('studio_update_state_too_large')
  return {exists:true,mode:snapshot.mode,content}
}
function snapshotFromJournal(snapshot){
  if(snapshot?.exists===false)return {exists:false}
  const mode=Number(snapshot?.mode),encoded=snapshot?.content
  if(snapshot?.exists!==true||!Number.isInteger(mode)||mode<0||mode>0o777||typeof encoded!=='string'||encoded.length>131072)throw new Error('studio_update_journal_invalid')
  const content=Buffer.from(encoded,'base64')
  if(content.toString('base64')!==encoded)throw new Error('studio_update_journal_invalid')
  return {exists:true,mode,content}
}
function studioBinOwnedBy(binFile,packageRoot){
  const stat=fs.lstatSync(binFile)
  if(!stat.isSymbolicLink())return false
  return pathInside(packageRoot,path.resolve(path.dirname(binFile),fs.readlinkSync(binFile)))
}
function createStudioBinLink(relative,binFile,packageRoot){
  const target=path.join(packageRoot,relative)
  try{fs.chmodSync(target,0o755)}catch{}
  fs.symlinkSync(path.relative(path.dirname(binFile),target),binFile,'file')
}
function studioJournalValue(tx,phase=tx.phase){
  const value={schema:studioJournalSchema,kind:studioJournalKind,status:phase==='committed'?'committed':'rollback-required',phase,token:tx.token,operationId:tx.operationId,beforeVersion:tx.beforeVersion||'',targetVersion:tx.targetVersion,packageHadExisting:tx.packageHadExisting,bins:tx.binBackups.map(item=>({name:item.name,hadExisting:item.exists,published:item.published})),stateSnapshot:snapshotForJournal(tx.stateSnapshot),updatedAt:new Date().toISOString()}
  return {...value,checksum:createHash('sha256').update(JSON.stringify(value)).digest('hex')}
}
function persistStudioJournal(tx,phase){
  if(!studioJournalPhases.has(phase))throw new Error('studio_update_journal_phase_invalid')
  if(tx.journalCreated){const current=readStudioRecoveryJournal(tx.journalFile);if(current?.token!==tx.token)throw new Error('studio_update_journal_lost')}
  else if(pathExists(tx.journalFile))throw new Error('studio_update_recovery_exists')
  atomicWrite(tx.journalFile,JSON.stringify(studioJournalValue(tx,phase))+'\n');tx.phase=phase;tx.journalCreated=true
}
function readStudioRecoveryJournal(journalFile=updateRecoveryMarker){
  let raw
  try{const stat=fs.lstatSync(journalFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw new Error('studio_update_journal_invalid');raw=fs.readFileSync(journalFile,'utf8')}catch(error){if(error?.code==='ENOENT')return null;if(error?.message==='studio_update_journal_invalid')throw error;throw new Error('studio_update_journal_invalid')}
  let value;try{value=JSON.parse(raw)}catch{throw new Error('studio_update_journal_invalid')}
  const checksum=String(value?.checksum||''),payload={...value};delete payload.checksum
  if(!/^[0-9a-f]{64}$/.test(checksum)||createHash('sha256').update(JSON.stringify(payload)).digest('hex')!==checksum)throw new Error('studio_update_journal_invalid')
  const phase=String(value?.phase||''),token=String(value?.token||''),operationId=String(value?.operationId||''),beforeVersion=String(value?.beforeVersion||''),targetVersion=String(value?.targetVersion||'')
  const expectedStatus=phase==='committed'?'committed':'rollback-required'
  if(value?.schema!==studioJournalSchema||value?.kind!==studioJournalKind||value?.status!==expectedStatus||!studioJournalPhases.has(phase)||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)||!/^[0-9A-Za-z._-]{1,128}$/.test(operationId)||!parseSemver(targetVersion)||(beforeVersion&&!parseSemver(beforeVersion))||typeof value?.packageHadExisting!=='boolean'||!Array.isArray(value?.bins)||value.bins.length!==studioBinNames.length)throw new Error('studio_update_journal_invalid')
  const bins=value.bins.map(item=>({name:String(item?.name||''),hadExisting:item?.hadExisting,published:item?.published}))
  if(new Set(bins.map(item=>item.name)).size!==studioBinNames.length||studioBinNames.some(name=>!bins.some(item=>item.name===name))||bins.some(item=>typeof item.hadExisting!=='boolean'||typeof item.published!=='boolean'))throw new Error('studio_update_journal_invalid')
  return {phase,token,operationId,beforeVersion,targetVersion,packageHadExisting:value.packageHadExisting,bins,stateSnapshot:snapshotFromJournal(value.stateSnapshot)}
}
function transactionFromStudioJournal(journal,{globalRoot=userGlobalRoot,stateFile=state,journalFile=updateRecoveryMarker}={}){
  const packageParent=path.join(globalRoot,'lib','node_modules'),binDir=path.join(globalRoot,'bin'),packageDestination=path.join(packageParent,studioPackage)
  return {token:journal.token,operationId:journal.operationId,beforeVersion:journal.beforeVersion,targetVersion:journal.targetVersion,phase:journal.phase,journalFile,journalCreated:true,packageHadExisting:journal.packageHadExisting,packageDestination,packageBackup:path.join(packageParent,`.${studioPackage}.backup.${journal.token}`),failedPackage:path.join(packageParent,`.${studioPackage}.failed.${journal.token}`),packagePublished:false,oldPackageMoved:false,binBackups:journal.bins.map(item=>({name:item.name,destination:path.join(binDir,item.name),backup:path.join(binDir,`.${item.name}.backup.${journal.token}`),moved:false,exists:item.hadExisting,published:item.published})),createdBins:[],stateFile,stateSnapshot:journal.stateSnapshot,stateChanged:false,restored:false,committed:journal.phase==='committed'}
}
function restoreStudioPublish(tx){
  if(tx.restored)return {cleanupPending:pathExists(tx.failedPackage)}
  if(tx.committed)throw new Error('rollback_after_commit_blocked')
  const previousPhase=tx.phase
  persistStudioJournal(tx,'rolling-back')
  const mayStillBeOriginal=['prepared','bin-backup','rolling-back','files-restored','state-restored'].includes(previousPhase)
  for(const item of tx.binBackups){
    if(pathExists(item.backup)){
      if(pathExists(item.destination))removeFile(item.destination)
      durableRename(item.backup,item.destination);item.moved=false
    }else if(item.exists){
      if(!pathExists(item.destination)||!mayStillBeOriginal)throw new Error(`rollback_failed:bin_backup_missing:${item.name}`)
    }else if(item.published&&pathExists(item.destination))removeFile(item.destination)
  }
  if(pathExists(tx.packageBackup)){
    if(pathExists(tx.packageDestination)){
      if(pathExists(tx.failedPackage))throw new Error('rollback_failed:failed_package_conflict')
      durableRename(tx.packageDestination,tx.failedPackage)
    }
    durableRename(tx.packageBackup,tx.packageDestination);tx.oldPackageMoved=false;tx.packagePublished=false
  }else if(tx.packageHadExisting){
    if(!pathExists(tx.packageDestination)||!mayStillBeOriginal)throw new Error('rollback_failed:package_backup_missing')
  }else if(pathExists(tx.packageDestination)){
    if(pathExists(tx.failedPackage))throw new Error('rollback_failed:failed_package_conflict')
    durableRename(tx.packageDestination,tx.failedPackage);tx.packagePublished=false
  }
  persistStudioJournal(tx,'files-restored')
  try{restoreFileSnapshot(tx.stateFile,tx.stateSnapshot);tx.stateChanged=false}catch{throw new Error('rollback_failed:state_restore')}
  persistStudioJournal(tx,'state-restored')
  // The old package, bins, and selection state are durable before the journal
  // is removed. Deleting a large failed package is deliberately deferred: the
  // fnOS lifecycle gives Manager only a short grace period on shutdown.
  const cleanupPending=pathExists(tx.failedPackage)
  removeFile(tx.journalFile);tx.journalCreated=false
  tx.restored=true
  return {cleanupPending}
}
function beginStudioPublish(stagedPackage,packageInfo,{globalRoot=userGlobalRoot,stateFile=state,journalFile=path.join(path.dirname(stateFile),'studio-update-recovery-required'),operationId=randomUUID(),beforeVersion='',createLink=createStudioBinLink,validateOwnedBin=studioBinOwnedBy,afterStep=()=>{}}={}){
  if(path.resolve(stagedPackage)!==packageInfo.packageRoot)throw new Error('studio_package_root_mismatch')
  if(!/^[0-9A-Za-z._-]{1,128}$/.test(operationId)||beforeVersion&&!parseSemver(beforeVersion))throw new Error('studio_update_journal_input_invalid')
  const token=randomUUID(),packageParent=path.join(globalRoot,'lib','node_modules'),binDir=path.join(globalRoot,'bin')
  const packageDestination=path.join(packageParent,studioPackage),packageBackup=path.join(packageParent,`.${studioPackage}.backup.${token}`)
  const packageHadExisting=pathExists(packageDestination)
  const tx={token,operationId,beforeVersion,targetVersion:packageInfo.version,phase:'prepared',journalFile,journalCreated:false,packageHadExisting,packageDestination,packageBackup,failedPackage:path.join(packageParent,`.${studioPackage}.failed.${token}`),packagePublished:false,oldPackageMoved:false,binBackups:[],createdBins:[],stateFile,stateSnapshot:fileSnapshot(stateFile),stateChanged:false,restored:false,committed:false}
  fs.mkdirSync(packageParent,{recursive:true});fs.mkdirSync(binDir,{recursive:true})
  if(packageHadExisting){const current=fs.lstatSync(packageDestination);if(!current.isDirectory()||current.isSymbolicLink())throw new Error('existing_studio_package_unsafe')}
  for(const name of studioBinNames){
    const destination=path.join(binDir,name),backup=path.join(binDir,`.${name}.backup.${token}`),exists=pathExists(destination)
    if(exists&&(!pathExists(packageDestination)||!validateOwnedBin(destination,packageDestination)))throw new Error(`studio_bin_conflict:${name}`)
    tx.binBackups.push({name,destination,backup,moved:false,exists,published:Boolean(packageInfo.binTargets[name])})
  }
  persistStudioJournal(tx,'prepared')
  try{
    for(const item of tx.binBackups){if(item.exists){durableRename(item.destination,item.backup);item.moved=true;afterStep('bin-backup',tx);persistStudioJournal(tx,'bin-backup')}}
    if(packageHadExisting){durableRename(packageDestination,packageBackup);tx.oldPackageMoved=true;afterStep('package-backup',tx);persistStudioJournal(tx,'package-backup')}
    durableRename(stagedPackage,packageDestination);tx.packagePublished=true;afterStep('package-publish',tx);persistStudioJournal(tx,'package-publish')
    for(const [name,target] of Object.entries(packageInfo.binTargets)){const binFile=path.join(binDir,name);createLink(target.relative,binFile,packageDestination);fsyncDirectory(binDir);tx.createdBins.push(binFile);afterStep(`bin-publish:${name}`,tx);persistStudioJournal(tx,'bin-publish')}
    let runtimeState={};try{runtimeState=JSON.parse(tx.stateSnapshot.content?.toString('utf8')||'{}')}catch{}
    atomicWrite(stateFile,JSON.stringify({...runtimeState,preferredRuntime:'user-global'})+'\n');tx.stateChanged=true;afterStep('state-publish',tx);persistStudioJournal(tx,'state-publish')
    return tx
  }catch(error){
    try{const restored=restoreStudioPublish(tx);error.cleanupPending=restored.cleanupPending}catch(rollbackError){error.rollbackError=rollbackError.message;error.transaction=tx}
    throw error
  }
}
function commitStudioPublish(tx){
  try{
    const rootStat=fs.lstatSync(tx.packageDestination)
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error()
    const metadata=JSON.parse(fs.readFileSync(packageFile(tx.packageDestination,'package.json','studio_update_committed_package_invalid'),'utf8'))
    packageFile(tx.packageDestination,'dist/server/index.js','studio_update_committed_package_invalid')
    if(metadata?.name!==studioPackage||metadata?.version!==tx.targetVersion)throw new Error()
  }catch{throw new Error('studio_update_committed_package_invalid')}
  if(!tx.committed){persistStudioJournal(tx,'committed');tx.committed=true}
  // `committed` means the new runtime was version-checked and healthy. Once
  // that fact and the installed files are durable, the recovery journal can be
  // removed. Large old-package deletion is best-effort background work.
  if(tx.journalCreated){removeFile(tx.journalFile);tx.journalCreated=false}
  const pending=[]
  if(pathExists(tx.packageBackup))pending.push('package_backup')
  if(pathExists(tx.failedPackage))pending.push('failed_package')
  for(const item of tx.binBackups)if(pathExists(item.backup))pending.push(`bin_backup:${path.basename(item.destination)}`)
  return pending
}
function recoverStudioPublish({globalRoot=userGlobalRoot,stateFile=state,journalFile=updateRecoveryMarker,stopStudio=()=>{}}={}){
  const journal=readStudioRecoveryJournal(journalFile)
  if(!journal)return {recovered:false,action:'none'}
  const tx=transactionFromStudioJournal(journal,{globalRoot,stateFile,journalFile})
  if(tx.committed){const pending=commitStudioPublish(tx);return {recovered:true,action:'commit',token:tx.token,cleanupPending:pending.length>0}}
  stopStudio()
  const restored=restoreStudioPublish(tx)
  return {recovered:true,action:'rollback',token:tx.token,cleanupPending:restored.cleanupPending}
}
async function rollbackStudioAfterStop(transaction,{stopStudio,waitStopped,restore=restoreStudioPublish}={}){
  try{await stopStudio()}catch{return {restored:false,error:'new_runtime_stop_failed'}}
  let stopped=false
  try{stopped=await waitStopped()}catch{}
  if(!stopped)return {restored:false,error:'new_runtime_stop_timeout'}
  try{const result=restore(transaction);return {restored:true,cleanupPending:result.cleanupPending,error:''}}
  catch(error){return {restored:false,error:error?.message||'rollback_failed'}}
}
function stopStudioForRecoverySync({pidFile=path.join(data,'hermes-home','server.pid'),procRoot='/proc',signal=process.kill,pause=syncPause,expectedDataDir=data,termAttempts=20,killAttempts=10}={}){
  const current=verifiedStudioProcess(pidFile,{procRoot,signal,expectedDataDir})
  if(!current)return
  const snapshot={...current,startTime:processStartTime(current.pid,procRoot)}
  if(!snapshot.startTime)throw new Error('studio_update_recovery_runtime_identity_unavailable')
  try{signal(snapshot.pid,'SIGTERM')}catch{}
  for(let attempt=0;attempt<termAttempts&&studioProcessSnapshotMatches(snapshot,{procRoot,signal,expectedDataDir});attempt++)pause(100)
  if(studioProcessSnapshotMatches(snapshot,{procRoot,signal,expectedDataDir}))try{signal(snapshot.pid,'SIGKILL')}catch{}
  for(let attempt=0;attempt<killAttempts&&studioProcessSnapshotMatches(snapshot,{procRoot,signal,expectedDataDir});attempt++)pause(100)
  if(studioProcessSnapshotMatches(snapshot,{procRoot,signal,expectedDataDir}))throw new Error('studio_update_recovery_runtime_running')
}
function drainStudioUpdateForShutdown({transaction=activeStudioTransaction,child=null,children=activeOwnedChildren,stagingRoot=activeStudioStagingRoot,stagingBase=path.join(data,'manager','studio-update'),stopStudio=stopStudioForRecoverySync,terminate=current=>terminateCommand(current,{attempts:5})}={}){
  const errors=[]
  const owned=child?[child]:[...children]
  let ownedStopped=true
  for(const current of owned){try{if(terminate(current)!==true){ownedStopped=false;errors.push('owned_child_stop_failed')}}catch{ownedStopped=false;errors.push('owned_child_stop_failed')}}
  for(const capture of [...activeCaptureChildren]){try{terminate(capture)}catch{errors.push('status_probe_stop_failed')}}
  if(stagingRoot&&ownedStopped){
    try{quarantineStudioStaging(stagingRoot,{stagingBase})}catch(error){errors.push(error?.message||'studio_staging_quarantine_failed')}
  }
  if(transaction&&!transaction.restored){
    if(transaction.committed){try{commitStudioPublish(transaction)}catch(error){errors.push(error?.message||'commit_finalize_failed')}}
    else{
      let stopped=true;try{stopStudio()}catch{stopped=false;errors.push('studio_stop_failed')}
      if(stopped)try{restoreStudioPublish(transaction)}catch(error){errors.push(error?.message||'rollback_failed')}
    }
  }
  if(transaction===activeStudioTransaction&&transaction&&!pathExists(transaction.journalFile))activeStudioTransaction=null
  for(const current of owned)activeOwnedChildren.delete(current)
  if(stagingRoot===activeStudioStagingRoot&&(!pathExists(stagingRoot)||!ownedStopped))activeStudioStagingRoot=''
  return {ok:errors.length===0,errors}
}
async function npmLatest(force=false){
  const registry=npmRegistry(),now=Date.now(),ttl=npmLatestCache?.error?npmLatestFailureTtlMs:npmLatestTtlMs
  if(!force&&npmLatestCache?.registry===registry.url&&now-npmLatestCache.checkedAtMs<ttl)return npmLatestCache
  try{
    const env={...process.env,NPM_CONFIG_REGISTRY:registry.url,npm_config_registry:registry.url}
    const result=await captureCommand(npmBin(),['view',`${studioPackage}@latest`,'version','--json',`--registry=${registry.url}`],{env,timeoutMs:15000,detached:true})
    let raw=result.stdout.trim();try{const parsed=JSON.parse(raw);raw=Array.isArray(parsed)?parsed.at(-1):parsed}catch{}
    const version=versionFromText(raw)
    if(!version)throw new Error('invalid_registry_version')
    npmLatestCache={version,registry:registry.url,checkedAt:new Date().toISOString(),checkedAtMs:now,error:''}
  }catch{
    npmLatestCache={version:'',registry:registry.url,checkedAt:new Date().toISOString(),checkedAtMs:now,error:'npm_latest_unavailable'}
  }
  return npmLatestCache
}
async function studioUpdateInfo(force=false){
  const selected=await selectedStudioAsync(),current=await cliStudioVersionAsync(selected.entry)
  if(!selected.entry||!current)return {currentVersion:current||'unknown',latestVersion:'',updateAvailable:false,reason:'runtime-not-ready',error:'runtime_not_ready',registry:npmRegistry().url,operations:operationsFor('studio')}
  const latest=await npmLatest(force)
  if(latest.error)return {currentVersion:current,latestVersion:'',updateAvailable:false,reason:'check-failed',error:latest.error,registry:latest.registry,checkedAt:latest.checkedAt,operations:operationsFor('studio')}
  return {...studioUpdatePolicy(current,latest.version),registry:latest.registry,checkedAt:latest.checkedAt,operations:operationsFor('studio')}
}
function studioHealth(){return new Promise(resolve=>{let settled=false;const finish=value=>{if(settled)return;settled=true;resolve(value)};const req=http.get({hostname:'127.0.0.1',port:Number(process.env.HERMES_PORT)||8649,path:'/health',headers:{accept:'application/json'},timeout:2500},res=>{res.resume();finish(res.statusCode>=200&&res.statusCode<300)});req.on('timeout',()=>req.destroy());req.on('error',()=>finish(false));req.on('close',()=>finish(false))})}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function waitForStudioHealth(timeoutMs=30000){
  const deadline=Date.now()+timeoutMs,pidFile=path.join(data,'hermes-home','server.pid')
  do{if(verifiedStudioProcess(pidFile)&&await studioHealth())return true;await delay(500)}while(Date.now()<deadline)
  return false
}
async function waitForStudioStopped(timeoutMs=15000){
  const deadline=Date.now()+timeoutMs,pidFile=path.join(data,'hermes-home','server.pid')
  do{if(!verifiedStudioProcess(pidFile))return true;await delay(250)}while(Date.now()<deadline)
  return false
}
async function runStudioLifecycle(op,action){
  const script=path.join(lifecycleRoot,'cmd','main')
  if(!fs.existsSync(script))throw new Error('lifecycle_script_missing')
  if(['studio-start','studio-restart'].includes(action)&&pathExists(stoppingMarker))throw new Error('application_stopping')
  if(['studio-start','studio-restart'].includes(action)&&pathExists(updateRecoveryMarker)&&op?.kind!=='studio-update')throw new Error('update_recovery_required')
  const timeoutMs=['studio-start','studio-restart'].includes(action)?120000:30000
  try{await runCommand(op,'/bin/bash',[script,action],{cwd:lifecycleRoot,env:{...process.env,HSTUDIO_MANAGER_UPDATE:'1',TRIM_APPDEST:appRoot,LIFECYCLE_ROOT:lifecycleRoot},detached:true,timeoutMs})}
  catch(error){throw new Error(`${action}_${error?.message||'failed'}`)}
}
function controlStudio(action){
  if(!['start','stop','restart'].includes(action))return {error:'invalid_lifecycle_action'}
  if(pathExists(stoppingMarker))return {error:'application_stopping'}
  if(['start','restart'].includes(action)&&pathExists(updateRecoveryMarker))return {error:'update_recovery_required'}
  if(bootstrapInProgress())return {error:'runtime_bootstrap_running'}
  const existing=runningStudioOperation()
  if(existing)return {error:'operation_running',operation:operationView(existing)}
  const op=createOperation('studio-lifecycle','studio');op.action=action
  ;(async()=>{
    try{
      await runStudioLifecycle(op,`studio-${action}`)
      const ready=action==='stop'?await waitForStudioStopped():await waitForStudioHealth()
      if(!ready)throw new Error(action==='stop'?'studio_stop_timeout':'studio_health_timeout')
      op.status='success';op.message=action==='stop'?'Hermes Studio 已停止':'Hermes Studio 已健康启动'
    }catch(error){op.status='failed';op.message=error?.message||'lifecycle_failed'}
    finally{op.finishedAt=new Date().toISOString();delete op.pid}
  })()
  return {ok:true,operation:operationView(op)}
}
async function updateStudio(){
  if(pathExists(stoppingMarker))return {error:'application_stopping'}
  if(activeStudioTransaction||pathExists(updateRecoveryMarker))return {error:'update_recovery_required'}
  const studioOperation=runningStudioOperation();if(studioOperation)return {error:'operation_running',operation:operationView(studioOperation)}
  const existing=blockingNpmOperation(); if(existing)return {error:'operation_running',operation:operationView(existing)}
  if(bootstrapInProgress())return {error:'runtime_bootstrap_running'}
  // Reserve the Studio mutation before the first await so lifecycle and a
  // second update request cannot pass preflight concurrently.
  const op=createOperation('studio-update','studio')
  let selected,beforeVersion,availability
  try{
    selected=await selectedStudioAsync();beforeVersion=await cliStudioVersionAsync(selected.entry)
    if(!selected.entry||!beforeVersion){operations.delete(op.id);return {error:'runtime_not_ready'}}
    availability=await studioUpdateInfo(true)
    if(availability.error){operations.delete(op.id);return {error:availability.error,update:availability}}
    if(!availability.updateAvailable){operations.delete(op.id);return {error:availability.reason==='ahead-of-registry'?'downgrade_blocked':'update_not_available',update:availability}}
  }catch(error){operations.delete(op.id);throw error}
  op.beforeVersion=beforeVersion;op.targetVersion=availability.latestVersion
  ;(async()=>{
    const stagingRoot=path.join(data,'manager','studio-update',op.id),stagingPrefix=path.join(stagingRoot,'prefix')
    let transaction=null,stopAttempted=false,rollbackRestored=false
    try{
      activeStudioStagingRoot=stagingRoot
      fs.mkdirSync(stagingPrefix,{recursive:true})
      const env={...process.env,NPM_CONFIG_PREFIX:stagingPrefix,npm_config_prefix:stagingPrefix,NPM_CONFIG_REGISTRY:availability.registry,npm_config_registry:availability.registry}
      await runCommand(op,npmBin(),['install','--global',`${studioPackage}@${op.targetVersion}`,`--prefix=${stagingPrefix}`,`--registry=${availability.registry}`,'--no-audit','--no-fund'],{cwd:stagingRoot,env,detached:true,timeoutMs:15*60*1000,npmMutation:true})
      const stagedPackage=path.join(stagingPrefix,'lib','node_modules',studioPackage)
      const packageInfo=validateStudioPackage(stagedPackage,op.targetVersion,{readVersion:()=>op.targetVersion})
      const stagedVersion=await cliStudioVersionAsync(packageInfo.entry)
      if(!stagedVersion||compareSemver(stagedVersion,op.targetVersion)!==0)throw new Error('studio_package_cli_version_mismatch')
      const unchanged=await selectedStudioAsync(),unchangedVersion=await cliStudioVersionAsync(unchanged.entry)
      if(unchanged.entry!==selected.entry||!unchangedVersion||compareSemver(unchangedVersion,op.beforeVersion)!==0)throw new Error('runtime_changed_during_preflight')
      stopAttempted=true
      await runStudioLifecycle(op,'studio-stop')
      if(!await waitForStudioStopped())throw new Error('studio_stop_timeout')
      transaction=beginStudioPublish(stagedPackage,packageInfo,{journalFile:updateRecoveryMarker,operationId:op.id,beforeVersion:op.beforeVersion});activeStudioTransaction=transaction
      await runStudioLifecycle(op,'studio-start')
      if(!await waitForStudioHealth())throw new Error('post_update_health_failed')
      const running=verifiedStudioProcess(path.join(data,'hermes-home','server.pid')),afterVersion=await cliStudioVersionAsync(running?.runtimePath);op.afterVersion=afterVersion
      if(running?.source!=='user-global'||!afterVersion||compareSemver(afterVersion,op.targetVersion)!==0)throw new Error('post_restart_version_mismatch')
      persistStudioJournal(transaction,'verified')
      const cleanupPending=commitStudioPublish(transaction)
      activeStudioTransaction=null
      if(cleanupPending.length)cleanupStudioGarbage().catch(()=>{})
      npmLatestCache=null;op.status='success';op.message=`Hermes Studio 已从 ${op.beforeVersion} 更新到 ${afterVersion}，并已健康重启${cleanupPending.length?'；旧版本文件将在后台清理':''}`
    }catch(error){
      const notes=[]
      if(!transaction&&error?.transaction){transaction=error.transaction;activeStudioTransaction=transaction}
      if(transaction?.committed){
        if(!pathExists(updateRecoveryMarker)){activeStudioTransaction=null;cleanupStudioGarbage().catch(()=>{})}
        op.status='success';op.message=`Hermes Studio 已从 ${op.beforeVersion} 更新到 ${op.afterVersion||op.targetVersion}${pathExists(updateRecoveryMarker)?'，但提交恢复标记仍需处理':'，旧版本文件将在后台清理'}`
        return
      }
      if(transaction){
        const rollback=await rollbackStudioAfterStop(transaction,{stopStudio:()=>runStudioLifecycle(op,'studio-stop'),waitStopped:()=>waitForStudioStopped()})
        rollbackRestored=rollback.restored
        if(rollback.restored){activeStudioTransaction=null;if(rollback.cleanupPending)cleanupStudioGarbage().catch(()=>{});notes.push(rollback.cleanupPending?'rollback_restored_cleanup_pending':'rollback_restored')}
        else{notes.push(rollback.error||'rollback_failed');notes.push('update_recovery_required')}
      }else if(error?.rollbackError)notes.push(error.rollbackError)
      else if(error?.cleanupPending)cleanupStudioGarbage().catch(()=>{})
      if(stopAttempted&&(!transaction||rollbackRestored)&&!pathExists(updateRecoveryMarker)){
        try{await runStudioLifecycle(op,'studio-start');notes.push(await waitForStudioHealth()?'old_runtime_healthy':'old_runtime_health_failed')}catch{notes.push('old_runtime_restart_failed')}
      }
      op.status='failed';op.message=`${error?.message||'update_failed'}${notes.length?`; ${notes.join('; ')}`:''}`
    }finally{
      try{fs.rmSync(stagingRoot,{recursive:true,force:true})}catch{}
      if(activeStudioStagingRoot===stagingRoot)activeStudioStagingRoot=''
      op.finishedAt=new Date().toISOString();delete op.pid
    }
  })()
  return {ok:true,operation:operationView(op)}
}
function runtimeLogTail(){ for(const file of [path.join(data,'hermes-home','server.log'),path.join(appRoot,'var','info.log'),path.join(lifecycleRoot,'var','info.log'),path.join(data,'last-error.log')]){ try { const text=fs.readFileSync(file,'utf8').trim(); if(text) return {path:file,text:redacted(text).slice(-4000)} } catch {} } return {path:'',text:''} }
function getJson(url, headers={}) { return new Promise((resolve,reject)=>{ const req=https.get(url,{headers:{'user-agent':'hermes-studio-manager',...headers}},r=>{let b=''; r.on('data',c=>b+=c); r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:b}))}); req.setTimeout(8000,()=>req.destroy(new Error('request_timeout'))); req.on('error',reject) }) }
function fpkCacheForRepository(cached,repository=fpkRepository) {
  return cached && typeof cached==='object' && cached.repository===repository ? cached : {}
}
async function fpkUpdate(force=false) {
  const f=path.join(data,'manager','update-state.json'); let cached={}; try{cached=fpkCacheForRepository(JSON.parse(fs.readFileSync(f,'utf8')))}catch{}
  if(!fpkRepository)return {configured:false,currentVersion:readPackageVersion(),latestVersion:'',updateAvailable:false,error:'repository_not_configured',lastCheckedAt:new Date().toISOString()}
  if(!force && cached.lastCheckedAt && Date.now()-Date.parse(cached.lastCheckedAt)<12*3600*1000) return cached
  const headers=cached.etag?{'if-none-match':cached.etag}:{}
  try { const r=await getJson(`https://api.github.com/repos/${fpkRepository}/releases/latest`,headers); const current=readPackageVersion(); if(r.status===304){let updateAvailable=false;try{updateAvailable=compareSemver(cached.latestVersion,current)>0}catch{};cached={...cached,repository:fpkRepository,currentVersion:current,updateAvailable,lastCheckedAt:new Date().toISOString()};atomicWrite(f,JSON.stringify(cached)+'\n');return cached} if(r.status!==200) throw Error(`HTTP ${r.status}`); const d=JSON.parse(r.body); const latest=String(d.tag_name||'').replace(/^v/,''); let updateAvailable=false;try{updateAvailable=compareSemver(latest,current)>0}catch{};cached={repository:fpkRepository,currentVersion:current,latestVersion:latest,updateAvailable,releaseUrl:d.html_url||'',releaseDate:d.published_at||'',lastCheckedAt:new Date().toISOString(),lastSuccessAt:new Date().toISOString(),etag:r.headers.etag||''}; atomicWrite(f,JSON.stringify(cached)+'\n'); return cached } catch(e) { return {...cached,repository:fpkRepository,currentVersion:readPackageVersion(),updateAvailable:false,error:'update_check_failed',lastCheckedAt:new Date().toISOString()} }
}
function verifiedPid(file,pattern){let pid=null;try{pid=Number(fs.readFileSync(file,'utf8').trim())||null;if(!pid)return null;process.kill(pid,0);const command=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').replace(/\0/g,' ');return pattern.test(command)?pid:null}catch{return null}}
function studioEntry(root,preferred='hermes-web-ui'){
  for(const name of [preferred,'hermes-web-ui.mjs']){const candidate=path.join(root,'bin',name);try{if(fs.lstatSync(candidate).isFile()||fs.lstatSync(candidate).isSymbolicLink())return candidate}catch{}}
  return path.join(root,'bin',preferred)
}
function verifiedStudioProcess(file,{procRoot='/proc',signal=process.kill,expectedDataDir=data}={}){
  try{
    const pid=Number(fs.readFileSync(file,'utf8').trim())||null
    if(!Number.isSafeInteger(pid)||pid<=1)return null
    signal(pid,0)
    const processRoot=path.join(procRoot,String(pid))
    const environment=fs.readFileSync(path.join(processRoot,'environ'),'utf8').split('\0').filter(Boolean)
    if(!environment.includes(`HERMES_WEB_UI_HOME=${path.join(expectedDataDir,'hermes-home')}`))return null
    const userRoot=path.resolve(expectedDataDir,'.npm-global','lib','node_modules',studioPackage)
    const userServer=path.join(userRoot,'dist','server','index.js')
    const bundledRoot=path.resolve(expectedDataDir,'runtime','studio')
    const legacyRoot=path.resolve(expectedDataDir,'node'),legacyPackageRoot=path.join(legacyRoot,'lib','node_modules',studioPackage)
    const match=fs.readFileSync(path.join(processRoot,'cmdline'),'utf8').split('\0').filter(Boolean).map(argument=>{
      const resolved=path.resolve(argument)
      if(resolved===userServer)return {source:'user-global',serverPath:resolved,runtimePath:studioEntry(userRoot)}
      const relative=path.relative(bundledRoot,resolved).split(path.sep)
      if(relative.length===4&&relative[0]&&!['.','..'].includes(relative[0])&&relative[1]==='dist'&&relative[2]==='server'&&relative[3]==='index.js'){
        const root=path.join(bundledRoot,relative[0]);return {source:'bundled',serverPath:resolved,runtimePath:studioEntry(root)}
      }
      if(resolved===path.join(legacyRoot,'dist','server','index.js'))return {source:'bundled',serverPath:resolved,runtimePath:studioEntry(legacyRoot)}
      if(resolved===path.join(legacyPackageRoot,'dist','server','index.js'))return {source:'bundled',serverPath:resolved,runtimePath:studioEntry(legacyPackageRoot,'hermes-web-ui.mjs')}
      return null
    }).find(Boolean)
    return match?{pid,...match}:null
  }catch{return null}
}
function studioProcessSnapshotMatches(snapshot,{procRoot='/proc',signal=process.kill,expectedDataDir=data}={}){
  const pid=Number(snapshot?.pid),startTime=String(snapshot?.startTime||''),serverPath=path.resolve(String(snapshot?.serverPath||''))
  if(!Number.isSafeInteger(pid)||pid<=1||!startTime||!snapshot?.serverPath)return false
  try{
    signal(pid,0)
    if(processStartTime(pid,procRoot)!==startTime)return false
    const processRoot=path.join(procRoot,String(pid)),environment=fs.readFileSync(path.join(processRoot,'environ'),'utf8').split('\0').filter(Boolean)
    if(!environment.includes(`HERMES_WEB_UI_HOME=${path.join(expectedDataDir,'hermes-home')}`))return false
    return fs.readFileSync(path.join(processRoot,'cmdline'),'utf8').split('\0').filter(Boolean).some(argument=>path.resolve(argument)===serverPath)
  }catch{return false}
}
const verifiedStudioPid=(file,options)=>verifiedStudioProcess(file,options)?.pid||null
function processStartTime(pid,procRoot='/proc'){try{const value=fs.readFileSync(path.join(procRoot,String(pid),'stat'),'utf8').trim(),close=value.lastIndexOf(')');if(close<0)return '';return value.slice(close+2).trim().split(/\s+/)[19]||''}catch{return ''}}
function readNpmOperationLock(lockFile=npmOperationLock){try{return JSON.parse(fs.readFileSync(lockFile,'utf8'))}catch(error){if(error?.code==='ENOENT')return null;return {status:'invalid',invalid:true}}}
function npmProcessMatches(current,{procRoot='/proc',signal=process.kill,expectedDataDir=data}={}){
  const pid=Number(current?.childPid),started=String(current?.childStartTime||''),operationId=String(current?.operationId||'')
  if(current?.status!=='running'||current?.dataDir!==expectedDataDir||!operationId||!String(current?.claimToken||'')||!Number.isSafeInteger(pid)||pid<=1||!started)return false
  try{signal(pid,0);if(processStartTime(pid,procRoot)!==started)return false;const environment=fs.readFileSync(path.join(procRoot,String(pid),'environ'),'utf8').split('\0').filter(Boolean);return environment.includes(`DATA_DIR=${expectedDataDir}`)&&environment.includes('HSTUDIO_NPM_OPERATION=1')&&environment.includes(`HSTUDIO_NPM_OPERATION_ID=${operationId}`)}catch{return false}
}
function npmClaimMatches(current,{procRoot='/proc',signal=process.kill,expectedDataDir=data}={}){
  const pid=Number(current?.managerPid),started=String(current?.managerStartTime||'')
  if(current?.status!=='claiming'||current?.dataDir!==expectedDataDir||!String(current?.operationId||'')||!String(current?.claimToken||'')||!Number.isSafeInteger(pid)||pid<=1||!started)return false
  try{signal(pid,0);return processStartTime(pid,procRoot)===started}catch{return false}
}
function npmProcessGroupAlive(current,{signal=process.kill}={}){
  const group=Number(current?.processGroupId)
  if(current?.status!=='running'||current?.detached!==true||!Number.isSafeInteger(group)||group<=1)return false
  try{signal(-group,0);return true}catch{return false}
}
function persistentNpmOperation({lockFile=npmOperationLock,procRoot='/proc',signal=process.kill,expectedDataDir=data,pruneStale=true}={}){
  const current=readNpmOperationLock(lockFile)
  if(!current)return null
  if(current.invalid)return {id:'recovery-required',kind:'npm-operation',target:'npm',status:'running',message:'invalid_npm_operation_lock_recovery_required',output:'',startedAt:new Date(0).toISOString(),persistent:true,recoveryRequired:true}
  const claimLive=npmClaimMatches(current,{procRoot,signal,expectedDataDir})
  // A Manager can be killed after spawning detached npm but before publishing
  // the child identity. A dead/unknown claiming record therefore cannot be
  // proven stale and must never be auto-pruned.
  if(current?.status==='claiming')return {id:current.operationId||'recovery-required',kind:current.kind||'npm-operation',target:current.target||'npm',status:'running',message:claimLive?'persistent_npm_operation_running':'unknown_npm_claim_recovery_required',output:'',startedAt:current.startedAt||current.createdAt||new Date(0).toISOString(),persistent:true,...(claimLive?{}:{recoveryRequired:true})}
  const leaderLive=npmProcessMatches(current,{procRoot,signal,expectedDataDir})
  if(!leaderLive&&!claimLive&&npmProcessGroupAlive(current,{signal}))return {id:current.operationId||'recovery-required',kind:current.kind||'npm-operation',target:current.target||'npm',status:'running',message:'orphaned_npm_process_group_recovery_required',output:'',startedAt:current.startedAt||current.createdAt||new Date(0).toISOString(),persistent:true,recoveryRequired:true}
  const live=leaderLive||claimLive
  if(!live){
    if(pruneStale)try{const latest=readNpmOperationLock(lockFile);if(JSON.stringify(latest)===JSON.stringify(current))removeFile(lockFile)}catch{}
    return null
  }
  return {id:current.operationId,kind:current.kind||'npm-operation',target:current.target||'npm',status:'running',message:'persistent_npm_operation_running',output:'',startedAt:current.startedAt||current.createdAt||new Date(0).toISOString(),persistent:true}
}
function claimNpmOperation(op,{lockFile=npmOperationLock}={}){
  fs.mkdirSync(path.dirname(lockFile),{recursive:true})
  for(let attempt=0;attempt<2;attempt++){
    const existing=persistentNpmOperation({lockFile})
    if(existing)throw new Error('persistent_npm_operation_running')
    const claim={status:'claiming',claimToken:randomUUID(),operationId:op.id,kind:op.kind,target:op.target,dataDir:data,managerPid:process.pid,managerStartTime:processStartTime(process.pid),createdAt:new Date().toISOString()}
    const temporary=path.join(path.dirname(lockFile),`.${path.basename(lockFile)}.${process.pid}.${claim.claimToken}.claim`)
    let fd
    try{
      fd=fs.openSync(temporary,'wx',0o600)
      fs.writeFileSync(fd,JSON.stringify(claim)+'\n')
      fs.fsyncSync(fd)
      fs.closeSync(fd);fd=undefined
      fs.linkSync(temporary,lockFile)
      fs.unlinkSync(temporary)
      fsyncDirectory(path.dirname(lockFile))
      return claim
    }catch(error){
      if(fd!==undefined)try{fs.closeSync(fd)}catch{}
      try{fs.unlinkSync(temporary)}catch{}
      if(error?.code!=='EEXIST')throw error
    }
  }
  throw new Error('persistent_npm_operation_running')
}
function publishNpmOperationClaim(claim,child,{lockFile=npmOperationLock}={}){
  const current=readNpmOperationLock(lockFile)
  if(current?.claimToken!==claim.claimToken||current?.operationId!==claim.operationId)throw new Error('npm_operation_lock_lost')
  atomicWrite(lockFile,JSON.stringify({...claim,status:'running',childPid:child.pid,childStartTime:child.hstudioStartTime,processGroupId:child.pid,detached:Boolean(child.hstudioDetached),updatedAt:new Date().toISOString()})+'\n')
}
function clearNpmOperationClaim(claim,child=null,{lockFile=npmOperationLock}={}){
  const current=readNpmOperationLock(lockFile)
  if(current?.claimToken!==claim?.claimToken||current?.operationId!==claim?.operationId)return false
  if(child&&current.status==='running'&&(current.childPid!==child.pid||current.childStartTime!==child.hstudioStartTime))return false
  removeFile(lockFile);return true
}
function bootstrapProcessMatches(current,callback,{procRoot='/proc',signal=process.kill,expectedDataDir=data}={}){const pid=Number(current?.callbackPid),started=String(current?.callbackStartTime||''),callbackDataDir=String(current?.callbackDataDir||'');if(!Number.isSafeInteger(pid)||pid<=1||!started||callbackDataDir!==expectedDataDir)return false;try{signal(pid,0);if(processStartTime(pid,procRoot)!==started)return false;const args=fs.readFileSync(path.join(procRoot,String(pid),'cmdline'),'utf8').split('\0').filter(Boolean);if(!args.includes(callback))return false;const environment=fs.readFileSync(path.join(procRoot,String(pid),'environ'),'utf8').split('\0').filter(Boolean);return environment.includes(`DATA_DIR=${expectedDataDir}`)&&environment.includes('HSTUDIO_RUNTIME_BOOTSTRAP=1')}catch{return false}}
function bootstrapInProgress({localChild=bootstrapChild}={}){if(localChild&&localChild.exitCode===null)return true;const callback=path.join(lifecycleRoot,'cmd','install_callback');try{const current=JSON.parse(fs.readFileSync(bootstrapState,'utf8'));return current.status==='running'&&bootstrapProcessMatches(current,callback)}catch{return false}}
async function computeStatus() {
  let preferred='auto'
  try{preferred=JSON.parse(fs.readFileSync(state,'utf8')).preferredRuntime||preferred}catch{}
  const selected=await selectedStudioAsync(preferred)
  const selectedRuntimeSource=selected.source||'unknown'
  const selectedRuntimePath=selected.entry||''
  const runningProcess=verifiedStudioProcess(path.join(data,'hermes-home','server.pid'))
  const pid=runningProcess?.pid||null,processRunning=Boolean(pid)
  const selectedVersionPromise=cliStudioVersionAsync(selectedRuntimePath)
  const runningVersionPromise=runningProcess?.runtimePath===selectedRuntimePath?selectedVersionPromise:cliStudioVersionAsync(runningProcess?.runtimePath||'')
  const [healthy,selectedVersion,runningVersion]=await Promise.all([processRunning?studioHealth():false,selectedVersionPromise,runningVersionPromise])
  const selectedStudioVersion=selectedVersion||'unknown'
  const studioVersion=(runningProcess?runningVersion:selectedVersion)||'unknown'
  const runtimeSource=runningProcess?.source||selectedRuntimeSource,runtimePath=runningProcess?.runtimePath||selectedRuntimePath
  const managerPid=verifiedPid(path.join(data,'manager','manager.pid'),/manager\/backend\/server\.mjs/),managerRunning=Boolean(managerPid)
  const stateName=healthy?'running':processRunning?'unhealthy':managerRunning?'manager-only':'stopped'
  return {packageVersion:readPackageVersion(),bundledStudioVersion:readManifestVersion(),studioVersion,runtimeSource,runtimePath,selectedStudioVersion,selectedRuntimeSource,selectedRuntimePath,nodeVersion:process.version,npmPrefix:path.join(data,'.npm-global'),pid,serverPath:runningProcess?.serverPath||'',processRunning,healthy,webUiRunning:healthy,managerPid,managerRunning,running:healthy,state:stateName,stopping:pathExists(stoppingMarker),updateRecoveryRequired:pathExists(updateRecoveryMarker),log:runtimeLogTail(),paths:{appRoot,lifecycleRoot,manifest,lifecycleScript:path.join(lifecycleRoot,'cmd','main')}}
}
function status(){if(statusPending)return statusPending;statusPending=computeStatus().finally(()=>{statusPending=null});return statusPending}
function readPackageVersion(){ for (const f of [path.join(appRoot,'manifest'),path.join(lifecycleRoot,'manifest'),path.join(appRoot,'..','manifest')]) { try { return fs.readFileSync(f,'utf8').match(/^version\s*=\s*([^\s]+)/m)?.[1] || 'unknown' } catch {} } return 'unknown' }
function metadataFiles(name){ return [manifest,path.join(appRoot,'config',name),path.join(appRoot,'etc',name),path.join(lifecycleRoot,'config',name),path.join(lifecycleRoot,'etc',name),path.join(lifecycleRoot,'bootstrap',name),path.join(appRoot,'bootstrap',name)].filter(Boolean) }
function readManifestVersion(){
  for(const file of metadataFiles('runtime-manifest.json')){ try { const version=JSON.parse(fs.readFileSync(file,'utf8')).studio?.version; if(version) return String(version) } catch {} }
  for(const file of [path.join(lifecycleRoot,'config','bootstrap','hermes-studio-version.env'),path.join(lifecycleRoot,'bootstrap','hermes-studio-version.env'),path.join(appRoot,'config','bootstrap','hermes-studio-version.env'),path.join(appRoot,'bootstrap','hermes-studio-version.env')]){ try { const version=fs.readFileSync(file,'utf8').match(/^HERMES_STUDIO_VERSION\s*=\s*(\S+)/m)?.[1]; if(version) return version } catch {} }
  return 'unknown'
}
function readManifestSize(){ for(const file of metadataFiles('runtime-manifest.json')){ try { const size=Number(JSON.parse(fs.readFileSync(file,'utf8')).studio?.size); if(size) return size } catch {} } return 0 }
function readBootstrapState(){
  let current={status:'not_started'}
  try { current=JSON.parse(fs.readFileSync(bootstrapState,'utf8')) } catch {}
  const version=readManifestVersion()
  const downloadPath=path.join(data,'cache','downloads',`${version}.tar.gz`)
  const partialPath=`${downloadPath}.part`
  const file=fs.existsSync(partialPath) ? partialPath : (fs.existsSync(downloadPath) ? downloadPath : '')
  const downloadedBytes=file ? (fs.statSync(file).size || 0) : 0
  const totalBytes=readManifestSize()
  let percent=totalBytes ? Math.min(100, Math.round(downloadedBytes * 100 / totalBytes)) : null
  if (current.phase==='npm-install') percent=null
  if (current.status==='success') percent=100
  const phase=current.phase || (current.status==='running' ? (file && file.endsWith('.part') ? 'archive-download' : 'preparing') : current.status)
  return {...current, version, phase, downloadedBytes, totalBytes, percent, downloadPath}
}
function bootstrapError(){
  const candidates=[path.join(appRoot,'var','last-error.log'),path.join(appRoot,'install-error.log'),path.join(lifecycleRoot,'var','last-error.log'),path.join(lifecycleRoot,'install-error.log'),path.join(data,'last-error.log'),path.join(appRoot,'var','info.log'),path.join(lifecycleRoot,'var','info.log')]
  for(const file of candidates){ try { const text=fs.readFileSync(file,'utf8').trim(); if(text) return redacted(text).slice(-1000) } catch {} }
  return ''
}
function bootstrapRuntime() {
  const callback=path.join(lifecycleRoot,'cmd','install_callback')
  if(pathExists(stoppingMarker)||pathExists(updateRecoveryMarker)||blockingNpmOperation())return readBootstrapState()
  if (!fs.existsSync(callback)) { atomicWrite(bootstrapState,JSON.stringify({status:'failed',error:'install_callback_missing',updatedAt:new Date().toISOString()})+'\n'); return }
  try { const current=JSON.parse(fs.readFileSync(bootstrapState,'utf8')); if(current.status==='running'&&bootstrapProcessMatches(current,callback))return current } catch {}
  if(bootstrapChild&&bootstrapChild.exitCode===null&&!bootstrapChild.killed)return readBootstrapState()
  const configRoot=process.env.TRIM_PKGETC || (fs.existsSync(path.join(lifecycleRoot,'etc')) ? path.join(lifecycleRoot,'etc') : path.join(lifecycleRoot,'config'))
  const child=spawn('/bin/bash',[callback],{env:{...process.env,DATA_DIR:data,HSTUDIO_RUNTIME_BOOTSTRAP:'1',TRIM_APPDEST:appRoot,TRIM_PKGETC:configRoot,TRIM_PKGHOME:process.env.TRIM_PKGHOME || path.join(lifecycleRoot,'home'),LIFECYCLE_ROOT:lifecycleRoot},stdio:'ignore',detached:true})
  bootstrapChild=child
  let finished=false
  const finish=(code,spawnError='')=>{if(finished)return;finished=true;if(bootstrapChild===child)bootstrapChild=null;let current={};try{current=JSON.parse(fs.readFileSync(bootstrapState,'utf8'))}catch{};if(current.callbackPid&&current.callbackPid!==child.pid)return;const ok=code===0&&!spawnError,result={status:ok?'success':'failed',exitCode:Number.isInteger(code)?code:null,updatedAt:new Date().toISOString()};const error=spawnError||(ok?'':bootstrapError());if(error)result.error=error;atomicWrite(bootstrapState,JSON.stringify(result)+'\n')}
  child.on('error',()=>finish(null,'bootstrap_spawn_failed'))
  child.on('close',code=>finish(code))
  let callbackStartTime=processStartTime(child.pid)
  for(let attempt=0;!callbackStartTime&&attempt<10;attempt++){syncPause(10);callbackStartTime=processStartTime(child.pid)}
  if(!callbackStartTime){terminateCommand(child,{attempts:5});finish(null,'bootstrap_child_identity_unavailable');return readBootstrapState()}
  const running={status:'running',phase:'preparing',callbackPid:child.pid||null,callbackStartTime,callbackDataDir:data,updatedAt:new Date().toISOString()}
  atomicWrite(bootstrapState,JSON.stringify(running)+'\n')
  return running
}
const server = http.createServer((req,res) => {
  const route = req.url.startsWith(gatewayPrefix) ? (req.url.slice(gatewayPrefix.length) || '/') : req.url
  if (req.method==='GET' && (route==='/' || route==='/index.html')) { const f=path.join(appRoot,'manager','frontend','index.html'); try { res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(fs.readFileSync(f)) } catch { return json(res,404,{error:'frontend_missing'}) } }
  if (route.startsWith('/api/')) { const error=apiPermissionError(req,route); if(error) return json(res,403,error) }
  if(req.method==='POST'&&pathExists(stoppingMarker)&&(/^(?:\/api\/npm\/registry|\/api\/runtime\/(?:bootstrap|start|restart|update|switch)|\/api\/agents\/(?:hermes-agent|codex|pi|claude)\/install)$/.test(route)))return json(res,409,{error:'application_stopping'})
  if(req.method==='POST'&&pathExists(updateRecoveryMarker)&&(/^(?:\/api\/runtime\/(?:bootstrap|start|restart|update|switch)|\/api\/agents\/(?:hermes-agent|codex|pi|claude)\/install)$/.test(route)))return json(res,409,{error:'update_recovery_required'})
  if (req.method==='GET' && route==='/api/status') return status().then(value=>json(res,200,value)).catch(()=>json(res,500,{error:'status_failed'}))
  if (req.method==='GET' && route==='/api/auth') return json(res,200,authSnapshot(req))
  if (req.method==='GET' && route==='/api/environment') return json(res,200,{HOME:data,NPM_GLOBAL:path.join(data,'.npm-global'),NPM_REGISTRY:npmRegistry().url,NODE_PATH:process.env.NODE_ROOT || '',PATH:process.env.PATH || ''})
  if (req.method==='GET' && route==='/api/npm/registry') return json(res,200,npmRegistry())
  if (req.method==='POST' && route==='/api/npm/registry') return readJsonBody(req,res,body=>{const result=setNpmRegistry(body.id||'');return json(res,result.error?400:200,result)})
  if (req.method==='GET' && route==='/api/runtime') return status().then(value=>json(res,200,{...value,bootstrap:readBootstrapState()})).catch(()=>json(res,500,{error:'status_failed',bootstrap:readBootstrapState()}))
  if (req.method==='GET' && route==='/api/runtime/bootstrap') return json(res,200,readBootstrapState())
  if (req.method==='POST' && route==='/api/runtime/bootstrap') { const active=blockingNpmOperation();if(active)return json(res,409,{error:'operation_running',operation:operationView(active)});bootstrapRuntime();return json(res,202,readBootstrapState()) }
  if (req.method==='POST' && /^\/api\/runtime\/(start|stop|restart)$/.test(route)) { const result=controlStudio(route.split('/').pop());return json(res,result.error?409:202,result) }
  if (req.method==='GET' && route==='/api/agents') return agentInventory().then(value=>json(res,200,value)).catch(()=>json(res,500,{error:'agent_detection_failed'}))
  if (req.method==='POST' && route==='/api/agents/detect') return agentInventory().then(value=>json(res,200,value)).catch(()=>json(res,500,{error:'agent_detection_failed'}))
  if (req.method==='POST' && route==='/api/agents/hermes-agent/install') { const result=installHermesAgent();return json(res,result.error?(['operation_running','runtime_bootstrap_running','application_stopping','update_recovery_required','python_runtime_missing','git_runtime_missing'].includes(result.error)?409:400):202,result) }
  if (req.method==='POST' && /^\/api\/agents\/(codex|pi|claude)\/install$/.test(route)) { const result=installAgent(route.split('/')[3]); return json(res,result.error?(['operation_running','runtime_bootstrap_running','application_stopping','update_recovery_required'].includes(result.error)?409:400):202,result) }
  if (req.method==='POST' && route==='/api/runtime/update') return updateStudio().then(result=>json(res,result.error?409:202,result)).catch(()=>json(res,500,{error:'update_preflight_failed'}))
  if (req.method==='GET' && route==='/api/runtime/update') return studioUpdateInfo().then(result=>json(res,200,result)).catch(()=>json(res,200,{currentVersion:'unknown',latestVersion:'',updateAvailable:false,reason:'check-failed',error:'npm_latest_unavailable',operations:operationsFor('studio')}))
  if (req.method==='GET' && route==='/api/fpk/update') return fpkUpdate().then(v=>json(res,200,v))
  if (req.method==='POST' && route==='/api/fpk/check') return fpkUpdate(true).then(v=>json(res,200,v))
  if (req.method==='POST' && route==='/api/runtime/switch') { const active=runningStudioOperation();if(active)return json(res,409,{error:'operation_running',operation:operationView(active)});return readJsonBody(req,res,body=>{const p=body.preferredRuntime;if(!['auto','user-global','bundled'].includes(p))return json(res,400,{error:'invalid_runtime'});atomicWrite(state,JSON.stringify({preferredRuntime:p})+'\n');return json(res,200,{ok:true,preferredRuntime:p})}) }
  if (req.method==='GET' && route==='/api/logs') { const f=path.join(data,'manager','manager.log'); let txt=''; try{txt=redacted(fs.readFileSync(f,'utf8')).slice(-20000)}catch{}; res.writeHead(200,{'content-type':'text/plain; charset=utf-8'}); return res.end(txt) }
  json(res,404,{error:'not_found'})
})
if (process.env.HSTUDIO_MANAGER_TEST_ONLY !== '1') {
  try{recoverStudioPublish({stopStudio:stopStudioForRecoverySync});cleanupStudioGarbage().catch(()=>{});cleanupStudioStaging().catch(()=>{})}catch(error){try{atomicWrite(path.join(data,'last-error.log'),redacted(`Hermes Studio update startup recovery failed: ${error?.message||'unknown'}`)+'\n')}catch{}}
  const terminate=()=>{if(shuttingDown)return;shuttingDown=true;const result=drainStudioUpdateForShutdown();if(!result.ok)try{atomicWrite(path.join(data,'last-error.log'),redacted(`Hermes Studio update shutdown recovery failed: ${result.errors.join('; ')}`)+'\n')}catch{};process.exit(result.ok?0:1)}
  process.once('SIGTERM',terminate)
  process.once('SIGINT',terminate)
  fs.mkdirSync(path.dirname(socket),{recursive:true}); try{fs.unlinkSync(socket)}catch{}; server.listen(socket,()=>{ fs.chmodSync(socket,0o660); setTimeout(()=>fpkUpdate().catch(()=>{}),1000).unref() })
  setTimeout(bootstrapRuntime,250).unref()
}

export {apiPermissionError, authSnapshot, beginStudioPublish, bootstrapInProgress, bootstrapProcessMatches, captureCommand, cleanupStudioGarbage, cleanupStudioStaging, commitStudioPublish, compareSemver, controlStudio, csrfOk, drainStudioUpdateForShutdown, fpkCacheForRepository, hermesAgentEnvironment, hermesAgentVersionPolicy, hermesInstallDirectory, npmProcessGroupAlive, npmProcessMatches, parseSemver, persistentNpmOperation, pythonVersionFromText, readStudioRecoveryJournal, recoverStudioPublish, redacted, restoreStudioPublish, rollbackStudioAfterStop, runningNpmOperation, stopStudioForRecoverySync, studioUpdatePolicy, supportedPythonVersion, terminateCommand, trustedHermesAgentOrigin, updateStudio, validateHermesAgentRelease, validateStudioPackage, verifiedStudioPid, verifiedStudioProcess, versionFromText}
