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
const pythonRegistryState = path.join(data, 'manager', 'python-registry.json')
const stoppingMarker = path.join(data,'manager','stopping')
const updateRecoveryMarker = path.join(data,'manager','studio-update-recovery-required')
const npmOperationLock = path.join(data,'manager','npm-operation.json')
const studioJournalSchema = 2
const studioJournalKind = 'hermes-studio-publish'
const studioJournalPhases = new Set(['prepared','bin-backup','package-backup','package-publish','bin-publish','state-publish','verified','rolling-back','files-restored','state-restored','committed'])
const fpkRepository = String(process.env.HSTUDIO_FPK_REPOSITORY || 'leen2175/fnos-HStudio').trim()
const studioPackage = 'hermes-web-ui'
const studioBinNames = Object.freeze(['hermes-web-ui','hermes-web-ui-mcp','hermes-studio-mcp'])
const userGlobalRoot = path.join(data,'.npm-global')
const hermesWebUiHome = process.env.HERMES_WEB_UI_HOME || path.join(data,'hermes-home')
const npmLatestTtlMs = 5 * 60 * 1000
const npmLatestFailureTtlMs = 30 * 1000
const fpkUpdateTtlMs = 12 * 60 * 60 * 1000
const fpkUpdateFailureTtlMs = 5 * 60 * 1000
let npmLatestCache = null
let fpkUpdatePending = null
const json = (res, code, value) => { res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}); res.end(JSON.stringify(value)) }
const authSnapshot = (req) => ({
  useridHeader: Boolean(req.headers['x-trim-userid']),
  isadminHeader: Boolean(req.headers['x-trim-isadmin']),
  isAdmin: ['1','true','yes'].includes(String(req.headers['x-trim-isadmin'] || '').toLowerCase()),
  usernameHeader: Boolean(req.headers['x-trim-username'])
})
function validatedPublicUrl(value){const raw=String(value||'').trim();if(!/^https?:\/\//i.test(raw))return '';try{const url=new URL(raw);return ['http:','https:'].includes(url.protocol)&&url.hostname&&!url.username&&!url.password?url.href:''}catch{return ''}}
function studioServicePort(env=process.env){const configuredPort=Number(env.HERMES_PORT||env.TRIM_SERVICE_PORT||8648);return Number.isInteger(configuredPort)&&configuredPort>0&&configuredPort<=65535?configuredPort:8648}
function managerConfig(env=process.env){return {publicStudioUrl:validatedPublicUrl(env.HSTUDIO_PUBLIC_URL),servicePort:studioServicePort(env)}}
const csrfOk = (req) => {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (!origin) return true
  if (fetchSite === 'same-origin') return true
  if (String(req.headers['x-hstudio-csrf'] || '') === '1') return true
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
function readJsonBody(req,res,callback){let body='',tooLarge=false;req.on('data',chunk=>{if(tooLarge)return;body+=chunk;if(Buffer.byteLength(body)>4096){tooLarge=true;body=''}});req.on('end',()=>{if(tooLarge)return json(res,413,{error:'request_too_large'});try{return callback(JSON.parse(body||'{}'))}catch{return json(res,400,{error:'invalid_json'})}})}
const agentDefinitions = {
  claude: {name:'claude', label:'Claude', provider:'Anthropic', packageName:'@anthropic-ai/claude-code'},
  codex: {name:'codex', label:'Codex', provider:'OpenAI', packageName:'@openai/codex'},
  pi: {name:'pi', label:'Pi', provider:'Pi', packageName:'@earendil-works/pi-coding-agent', adapter:'pi-mcp-adapter'},
  grok: {name:'grok', label:'Grok', provider:'xAI', packageName:'@xai-official/grok'},
}
const agentNames = Object.keys(agentDefinitions)
const npmRegistries = Object.freeze({
  official: {label:'官方 npm',url:'https://registry.npmjs.org/'},
  taobao: {label:'npmmirror',url:'https://registry.npmmirror.com/'},
  tencent: {label:'腾讯云',url:'https://mirrors.cloud.tencent.com/npm/'},
  huawei: {label:'华为云',url:'https://repo.huaweicloud.com/repository/npm/'},
  yarn: {label:'Yarn',url:'https://registry.yarnpkg.com/'},
})
const pythonRegistries = Object.freeze({
  official: {label:'官方 PyPI',url:'https://pypi.org/simple/'},
  tuna: {label:'清华大学 TUNA',url:'https://pypi.tuna.tsinghua.edu.cn/simple/'},
  ustc: {label:'中国科学技术大学',url:'https://mirrors.ustc.edu.cn/pypi/simple/'},
  aliyun: {label:'阿里云',url:'https://mirrors.aliyun.com/pypi/simple/'},
  huawei: {label:'华为云',url:'https://repo.huaweicloud.com/repository/pypi/simple/'},
})
const operations = new Map()
let bootstrapChild = null
const activeOwnedChildren = new Set()
let activeStudioStagingRoot = ''
let activeStudioTransaction = null
let shuttingDown = false
const activeCaptureChildren = new Set()
let selectedStudioPending = null
let statusPending = null
let agentInventoryPending = null
const agentUpdateCache = new Map()
const operationView = (op) => ({id:op.id, kind:op.kind, target:op.target, status:op.status, phase:op.phase||'', message:redacted(op.message||''), output:redacted(op.output||'').slice(-6000), beforeVersion:op.beforeVersion||'', targetVersion:op.targetVersion||'', afterVersion:op.afterVersion||'', startedAt:op.startedAt, finishedAt:op.finishedAt||null})
function createOperation(kind,target){const op={id:randomUUID(),kind,target,status:'running',output:'',startedAt:new Date().toISOString()};operations.set(op.id,op);return op}
function rememberOutput(op,chunk){
  let incoming=String(chunk)
  if(op.outputDiscardingLine){const boundary=incoming.search(/[\r\n]/);if(boundary<0)return;incoming=incoming.slice(boundary+1);op.outputDiscardingLine=false}
  const combined=`${op.output||''}${incoming}`
  if(combined.length<=12000){op.output=combined;return}
  const tail=combined.slice(-12000),boundary=tail.search(/[\r\n]/)
  if(boundary<0){op.output='';op.outputDiscardingLine=true;return}
  op.output=tail.slice(boundary+1)
}
function operationForId(id,values=operations.values()){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id||'')))return null
  pruneOperations()
  const found=[...values].find(op=>op.id===id)
  return found?operationView(found):null
}
const runningStudioOperation=(values=operations.values())=>[...values].find(op=>op.target==='studio'&&op.status==='running')
const runningStudioStartOperation=(values=operations.values())=>[...values].find(op=>op.target==='studio'&&op.status==='running'&&op.kind==='studio-lifecycle'&&['start','restart'].includes(op.action))
const runningNpmOperation=(values=operations.values())=>[...values].find(op=>op.status==='running'&&['agent-install','agent-remove','hermes-agent-install','studio-update'].includes(op.kind))
const blockingNpmOperation=()=>runningNpmOperation()||persistentNpmOperation()
const lifecycleConflict=(action,findOperation=blockingNpmOperation)=>['start','restart'].includes(action)?findOperation()||null:null
function agentReadiness(command,version,{adapterRequired=false,adapterInstalled=true}={}){const present=Boolean(command),ready=Boolean(present&&version&&(!adapterRequired||adapterInstalled));return {present,installed:present,ready}}
function npmBin(){return process.env.NPM_BIN || (process.env.NODE_ROOT ? path.join(process.env.NODE_ROOT,'bin','npm') : 'npm')}
function nodeBin(){return process.env.NODE_BIN || (process.env.NODE_ROOT ? path.join(process.env.NODE_ROOT,'bin','node') : process.execPath)}
function executableFile(file){try{return fs.statSync(file).isFile()&&Boolean(fs.statSync(file).mode&0o111)}catch{return false}}
function pathWithin(candidate,root){const relative=path.relative(path.resolve(root),path.resolve(candidate));return relative===''||Boolean(relative&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative))}
function agentPackageRoot(def,globalRoot=userGlobalRoot){return path.join(globalRoot,'lib','node_modules',...def.packageName.split('/'))}
function agentManaged(def,command='',globalRoot=userGlobalRoot){return Boolean(command&&pathWithin(command,path.join(globalRoot,'bin')))||fs.existsSync(agentPackageRoot(def,globalRoot))}
function desktopRuntimeAgentLayout(directory,managedRuntimeVersion=''){
  const root=path.join(directory,'python'),environmentRoots=[path.join(root,'venv'),root]
  for(const environmentRoot of environmentRoots){const pythonPath=[path.join(environmentRoot,'bin','python3'),path.join(environmentRoot,'bin','python')].find(executableFile),command=path.join(environmentRoot,'bin','hermes');if(pythonPath&&executableFile(command))return {directory,path:command,pythonPath,root,environmentRoot,managedRuntimeVersion}}
  return null
}
function desktopHermesRuntimes({webUiHome=hermesWebUiHome,platform='linux-x64'}={}){
  // Read only upstream's active selection. Never scan, activate, or fall back
  // to another locally installed version on behalf of Hermes Studio.
  try{
    const active=JSON.parse(fs.readFileSync(path.join(webUiHome,'desktop-runtime','active-version.json'),'utf8'))
    if(!active?.runtimeDirectory||active.platform&&active.platform!==platform)return []
    const storageRoot=active.runtimeRootDirectory||path.join(webUiHome,'desktop-runtime'),directory=path.resolve(active.runtimeDirectory)
    if(!pathWithin(directory,path.join(storageRoot,'hermes')))return []
    const managedRuntimeVersion=parseSemver(active.hermesRuntimeVersion)?.value||''
    const layout=desktopRuntimeAgentLayout(directory,managedRuntimeVersion)
    return [{...(layout||{directory,root:path.join(directory,'python'),path:'',pythonPath:'',managedRuntimeVersion}),active:true,activationError:String(active.runtimeActivationError||'')}]
  }catch{return []}
}
const hermesRuntimeVersionProbe="import importlib.util, hermes_cli; assert importlib.util.find_spec('hermes_cli.main'); print(hermes_cli.__version__)"
async function desktopHermesRuntimeVersion(runtime){const env={...process.env,HERMES_HOME:process.env.HERMES_HOME||path.join(data,'hermes-home'),HERMES_BIN:runtime.path,HERMES_AGENT_BRIDGE_PYTHON:runtime.pythonPath,HERMES_AGENT_CLI_PYTHON:runtime.pythonPath,HERMES_AGENT_ROOT:runtime.root,VIRTUAL_ENV:runtime.environmentRoot,UV_PROJECT_ENVIRONMENT:runtime.environmentRoot,UV_PYTHON:runtime.pythonPath,PATH:[path.dirname(runtime.path),process.env.PATH].filter(Boolean).join(path.delimiter)};try{const result=await captureCommand(runtime.pythonPath,['-c',hermesRuntimeVersionProbe],{cwd:runtime.root,env,timeoutMs:8000,detached:process.platform!=='win32'});return versionFromText(result.stdout)}catch{return ''}}
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
function registryChoice(stateFile,choices,legacyId=''){let id='official';try{id=JSON.parse(fs.readFileSync(stateFile,'utf8')).id||id}catch{};if(legacyId&&id===legacyId)id='taobao';if(!choices[id])id='official';return {id,url:choices[id].url,options:Object.entries(choices).map(([key,value])=>({id:key,...value}))}}
function npmRegistry(){return registryChoice(npmRegistryState,npmRegistries,'npmmirror')}
function pythonRegistry(){return registryChoice(pythonRegistryState,pythonRegistries)}
function setNpmRegistry(id){if(id==='npmmirror')id='taobao';if(!Object.prototype.hasOwnProperty.call(npmRegistries,id))return {error:'invalid_npm_registry'};const value={id,url:npmRegistries[id].url,updatedAt:new Date().toISOString()};atomicWrite(npmRegistryState,JSON.stringify(value)+'\n');atomicWrite(path.join(data,'.npmrc'),`prefix=${path.join(data,'.npm-global')}\ncache=${path.join(data,'.npm-cache')}\nregistry=${value.url}\n`);process.env.NPM_REGISTRY=value.url;process.env.npm_config_registry=value.url;process.env.NPM_CONFIG_REGISTRY=value.url;npmLatestCache=null;return npmRegistry()}
function setPythonRegistry(id){if(!Object.prototype.hasOwnProperty.call(pythonRegistries,id))return {error:'invalid_python_registry'};const value={id,url:pythonRegistries[id].url,updatedAt:new Date().toISOString()};atomicWrite(pythonRegistryState,JSON.stringify(value)+'\n');atomicWrite(path.join(data,'.config','pip','pip.conf'),`[global]\nindex-url = ${value.url}\ndisable-pip-version-check = true\n`);process.env.PIP_INDEX_URL=value.url;process.env.UV_DEFAULT_INDEX=value.url;process.env.UV_INDEX_URL=value.url;return pythonRegistry()}
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
async function pythonRuntime(runtime=desktopHermesRuntimes()[0],probe=executableVersion){
  if(!runtime)return {available:false,path:'',version:'未安装或未启用'}
  const command=runtime.pythonPath||''
  if(!command||runtime.activationError)return {available:false,path:command,version:'不可用'}
  const version=pythonVersionFromText(await probe(command))
  return {available:Boolean(version),path:command,version:version||'检测失败'}
}
function hermesBrowserRuntime(runtime){const agentBrowserHome=path.join(runtime.root,'agent-browser'),playwrightBrowsers=path.join(runtime.root,'ms-playwright'),missing=[!fs.existsSync(agentBrowserHome)&&'agent-browser',!fs.existsSync(playwrightBrowsers)&&'Chromium'].filter(Boolean);return {available:missing.length===0,agentBrowserHome,playwrightBrowsers,status:missing.length?`Runtime 缺少 ${missing.join('、')}`:'Hermes Runtime 已内置'}}
function adapterStatus(def){if(!def.adapter)return {};const adapterRoot=path.join(data,'hermes-home','coding-agent','pi-mcp-adapter'),metadata=path.join(adapterRoot,'node_modules',def.adapter,'package.json');try{const value=JSON.parse(fs.readFileSync(metadata,'utf8'));if(value?.name!==def.adapter||!parseSemver(value?.version))throw new Error('invalid_adapter');return {adapter:def.adapter,adapterRoot,adapterInstalled:true,adapterVersion:value.version}}catch{return {adapter:def.adapter,adapterRoot,adapterInstalled:false,adapterVersion:''}}}
async function hermesAgent(){
  const runtime=desktopHermesRuntimes()[0]||null
  const version=runtime?.pythonPath&&!runtime.activationError?await desktopHermesRuntimeVersion(runtime):''
  const readiness=agentReadiness(runtime?.path||'',version),partial=Boolean(runtime&&!readiness.ready)
  return {name:'hermes-agent',label:'Hermes Agent',...readiness,installed:Boolean(runtime),partial,runtimeManaged:Boolean(runtime),source:'studio-runtime',updateMethod:'Hermes Studio 版本管理',path:runtime?.path||'',root:runtime?.root||'',managedRuntimeVersion:runtime?.managedRuntimeVersion||'',version:version||'未检测到版本',browser:runtime?hermesBrowserRuntime(runtime):null,status:readiness.ready?'Runtime 已启用':partial?'当前 Runtime 不可用':'未启用 Runtime',error:runtime?.activationError||'',python:runtime?await pythonRuntime(runtime):null,operation:null}
}
async function codingAgentUpdate(agent,{refresh=false,registry=npmRegistry().url,cache=agentUpdateCache,run=captureCommand}={}){
  const key=`${registry}:${agent.packageName}`,unchecked={updateAvailable:false,reason:'not-checked',registry}
  let latest=cache.get(key)
  if(refresh){
    try{
      const versions=await Promise.all([agent.packageName,agent.adapter].filter(Boolean).map(name=>npmPackageLatest(name,registry,run)))
      latest={latestVersion:versions[0],latestAdapterVersion:versions[1]||'',checkedAt:new Date().toISOString(),registry}
    }catch{latest={latestVersion:'',latestAdapterVersion:'',checkedAt:new Date().toISOString(),registry,error:'npm_latest_unavailable'}}
    cache.set(key,latest)
  }
  if(!latest)return unchecked
  if(latest.error)return {...latest,updateAvailable:false,reason:'check-failed'}
  if(!agent.installed)return {...latest,updateAvailable:false,reason:'not-installed'}
  const main=studioUpdatePolicy(versionFromText(agent.version),latest.latestVersion)
  const adapter=agent.adapter?studioUpdatePolicy(agent.adapterVersion,latest.latestAdapterVersion):null
  const updateAvailable=main.updateAvailable||Boolean(adapter?.updateAvailable)
  return {...latest,updateAvailable,mainUpdateAvailable:main.updateAvailable,adapterUpdateAvailable:Boolean(adapter?.updateAvailable),reason:updateAvailable?'update-available':main.reason==='invalid-version'||adapter?.reason==='invalid-version'?'invalid-version':main.reason==='ahead-of-registry'||adapter?.reason==='ahead-of-registry'?'ahead-of-registry':'current'}
}
async function agents(refresh=false){return Promise.all(agentNames.map(async name=>{const def=agentDefinitions[name],p=safeCommand(name),version=await executableVersion(p),adapter=adapterStatus(def),readiness=agentReadiness(p,version,{adapterRequired:Boolean(def.adapter),adapterInstalled:adapter.adapterInstalled}),agent={name,label:def.label,provider:def.provider,packageName:def.packageName,managed:agentManaged(def,p),...readiness,path:p,version,...adapter,operation:operationsFor(name)[0]||null};return {...agent,update:await codingAgentUpdate(agent,{refresh})}}))}
function agentInventory(refresh=false){if(agentInventoryPending&&!refresh)return agentInventoryPending;const pending=Promise.all([status(),hermesAgent(),agents(refresh)]).then(([statusValue,hermesAgentValue,agentValues])=>({hermesAgent:{...hermesAgentValue,currentStudioVersion:statusValue.studioVersion},agents:agentValues,operations:[...operations.values()].map(operationView)}));agentInventoryPending=pending;return pending.finally(()=>{if(agentInventoryPending===pending)agentInventoryPending=null})}
function agentMutationBlock(){if(pathExists(stoppingMarker))return {error:'application_stopping'};if(pathExists(updateRecoveryMarker))return {error:'update_recovery_required'};if(bootstrapInProgress())return {error:'runtime_bootstrap_running'};const studioOperation=runningStudioStartOperation();if(studioOperation)return {error:'operation_running',operation:operationView(studioOperation)};const existing=blockingNpmOperation();return existing?{error:'operation_running',operation:operationView(existing)}:null}
function installAgent(name,targets={},{detect=agents,run=runCommand}={}){
  const def=agentDefinitions[name]; if(!def) return {error:'unknown_agent'}
  if(!targets||typeof targets!=='object'||Array.isArray(targets)||Object.entries(targets).some(([key,value])=>!['version','adapterVersion'].includes(key)||typeof value!=='string'||!parseSemver(value))||targets.adapterVersion&&!def.adapter)return {error:'invalid_agent_version'}
  const blocked=agentMutationBlock();if(blocked)return blocked
  const op=createOperation('agent-install',name)
  const updating=Boolean(targets.version||targets.adapterVersion)
  op.message=updating?'正在更新…':'正在安装…';op.targetVersion=targets.version||targets.adapterVersion||''
  ;(async()=>{try{
    const registry=npmRegistry().url,env={...process.env,NPM_CONFIG_PREFIX:userGlobalRoot,npm_config_prefix:userGlobalRoot,NPM_CONFIG_REGISTRY:registry,npm_config_registry:registry},repairAdapterOnly=Boolean(def.adapter&&safeCommand(name)&&!adapterStatus(def).adapterInstalled)
    if(updating){const before=(await detect()).find(a=>a.name===name);if(!before?.ready)throw new Error('agent_not_ready');for(const [current,target] of [[versionFromText(before.version),targets.version],[before.adapterVersion,targets.adapterVersion]])if(target&&(!parseSemver(current)||compareSemver(target,current)<=0))throw new Error('update_not_available')}
    if(updating?targets.version:!repairAdapterOnly)await run(op,npmBin(),['install','--global',`${def.packageName}@${targets.version||'latest'}`,`--prefix=${userGlobalRoot}`,`--registry=${registry}`,'--no-audit','--no-fund'],{env,detached:true,timeoutMs:15*60*1000,npmMutation:true})
    if(def.adapter&&(!updating||targets.adapterVersion)){const adapterRoot=path.join(data,'hermes-home','coding-agent','pi-mcp-adapter');fs.mkdirSync(adapterRoot,{recursive:true});await run(op,npmBin(),['install','--prefix',adapterRoot,`--registry=${registry}`,'--save-exact','--no-audit','--no-fund',`${def.adapter}@${targets.adapterVersion||'latest'}`],{env,detached:true,timeoutMs:15*60*1000,npmMutation:true})}
    const installed=(await detect()).find(a=>a.name===name)
    if(targets.version&&versionFromText(installed?.version)!==parseSemver(targets.version).value||targets.adapterVersion&&installed?.adapterVersion!==parseSemver(targets.adapterVersion).value)throw new Error('installed_version_mismatch')
    op.status=installed?.ready?'success':'failed';op.message=installed?.ready?(updating?'更新完成':repairAdapterOnly?'适配器修复完成':'安装完成'):'安装完成但组件状态不完整'
  }catch(e){op.status='failed';op.message=e.message||'install_failed'}finally{op.finishedAt=new Date().toISOString();delete op.pid}})()
  return {ok:true,operation:operationView(op)}
}
function removeAgent(name){
  const def=agentDefinitions[name];if(!def)return {error:'unknown_agent'}
  const command=safeCommand(name);if(!agentManaged(def,command))return {error:'agent_not_managed',hint:'只能删除 HStudio 应用私有目录中的 Coding Agent'}
  const blocked=agentMutationBlock();if(blocked)return blocked
  const op=createOperation('agent-remove',name);op.message=`正在删除 ${def.label}`
  ;(async()=>{try{const registry=npmRegistry().url,env={...process.env,NPM_CONFIG_PREFIX:userGlobalRoot,npm_config_prefix:userGlobalRoot,NPM_CONFIG_REGISTRY:registry,npm_config_registry:registry};await runCommand(op,npmBin(),['uninstall','--global',def.packageName,`--prefix=${userGlobalRoot}`,'--no-audit','--no-fund'],{env,detached:true,timeoutMs:15*60*1000,npmMutation:true});if(def.adapter&&adapterStatus(def).adapterInstalled){const adapterRoot=path.join(data,'hermes-home','coding-agent','pi-mcp-adapter');await runCommand(op,npmBin(),['uninstall','--prefix',adapterRoot,'--no-audit','--no-fund',def.adapter],{env,detached:true,timeoutMs:15*60*1000,npmMutation:true})}op.status=agentManaged(def)?'failed':'success';op.message=op.status==='success'?'删除完成':'删除完成但应用私有包仍存在'}catch(e){op.status='failed';op.message=e.message||'remove_failed'}finally{op.finishedAt=new Date().toISOString();delete op.pid}})()
  return {ok:true,operation:operationView(op)}
}
function versionFromText(value){for(const match of String(value||'').matchAll(/(?:^|[^0-9A-Za-z])((?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=$|[^0-9A-Za-z])/g)){const parsed=parseSemver(match[1]);if(parsed)return parsed.value}return ''}
async function cliStudioVersionAsync(entry){if(!entry)return '';try{const result=await captureCommand(nodeBin(),[entry,'--version'],{cwd:path.join(data,'hermes-home'),env:{...process.env},timeoutMs:8000,detached:process.platform!=='win32'});return versionFromText(`${result.stdout||''}\n${result.stderr||''}`)}catch{return ''}}
async function selectedStudioAsync(){
  if(selectedStudioPending)return selectedStudioPending
  const pending=(async()=>{try{const result=await captureCommand('/bin/bash',[path.join(lifecycleRoot,'cmd','main'),'runtime'],{env:{...process.env,TRIM_APPDEST:appRoot,LIFECYCLE_ROOT:lifecycleRoot},timeoutMs:10000,detached:true}),selected=result.stdout.trim(),separator=selected.indexOf(':');return separator<1?{source:'',entry:''}:{source:selected.slice(0,separator),entry:selected.slice(separator+1)}}catch{return {source:'',entry:''}}})()
  selectedStudioPending=pending
  return pending.finally(()=>{if(selectedStudioPending===pending)selectedStudioPending=null})
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
function packageFile(root,relative,errorCode){
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative))throw new Error(errorCode)
  const file=path.resolve(root,relative)
  if(!pathWithin(file,root))throw new Error(errorCode)
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||!pathWithin(fs.realpathSync(file),fs.realpathSync(root)))throw new Error(errorCode);return file}catch(error){if(error?.message===errorCode)throw error;throw new Error(errorCode)}
}
function validateStudioPackage(packageRoot,targetVersion){
  const target=parseSemver(targetVersion),rootStat=fs.lstatSync(packageRoot)
  if(!target||!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('studio_package_layout_invalid')
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
  return {packageRoot:path.resolve(packageRoot),version:target.value,entry:binTargets['hermes-web-ui'].file,binTargets}
}
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
  return pathWithin(path.resolve(path.dirname(binFile),fs.readlinkSync(binFile)),packageRoot)
}
function createStudioBinLink(relative,binFile,packageRoot){
  const target=path.join(packageRoot,relative)
  try{fs.chmodSync(target,0o755)}catch{}
  fs.symlinkSync(path.relative(path.dirname(binFile),target),binFile,'file')
}
function studioJournalValue(tx,phase=tx.phase){
  const value={schema:tx.schema,kind:studioJournalKind,status:phase==='committed'?'committed':'rollback-required',phase,token:tx.token,operationId:tx.operationId,beforeVersion:tx.beforeVersion||'',targetVersion:tx.targetVersion,packageHadExisting:tx.packageHadExisting,bins:tx.binBackups.map(item=>({name:item.name,hadExisting:item.exists,published:item.published})),...(tx.schema===1?{stateSnapshot:snapshotForJournal(tx.stateSnapshot)}:{}),updatedAt:new Date().toISOString()}
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
  if(![1,studioJournalSchema].includes(value?.schema)||value?.kind!==studioJournalKind||value?.status!==expectedStatus||!studioJournalPhases.has(phase)||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)||!/^[0-9A-Za-z._-]{1,128}$/.test(operationId)||!parseSemver(targetVersion)||(beforeVersion&&!parseSemver(beforeVersion))||typeof value?.packageHadExisting!=='boolean'||!Array.isArray(value?.bins)||value.bins.length!==studioBinNames.length)throw new Error('studio_update_journal_invalid')
  const bins=value.bins.map(item=>({name:String(item?.name||''),hadExisting:item?.hadExisting,published:item?.published}))
  if(new Set(bins.map(item=>item.name)).size!==studioBinNames.length||studioBinNames.some(name=>!bins.some(item=>item.name===name))||bins.some(item=>typeof item.hadExisting!=='boolean'||typeof item.published!=='boolean'))throw new Error('studio_update_journal_invalid')
  return {schema:value.schema,phase,token,operationId,beforeVersion,targetVersion,packageHadExisting:value.packageHadExisting,bins,stateSnapshot:value.schema===1?snapshotFromJournal(value.stateSnapshot):null}
}
function transactionFromStudioJournal(journal,{globalRoot=userGlobalRoot,stateFile=state,journalFile=updateRecoveryMarker}={}){
  const packageParent=path.join(globalRoot,'lib','node_modules'),binDir=path.join(globalRoot,'bin'),packageDestination=path.join(packageParent,studioPackage)
  return {schema:journal.schema,token:journal.token,operationId:journal.operationId,beforeVersion:journal.beforeVersion,targetVersion:journal.targetVersion,phase:journal.phase,journalFile,journalCreated:true,packageHadExisting:journal.packageHadExisting,packageDestination,packageBackup:path.join(packageParent,`.${studioPackage}.backup.${journal.token}`),failedPackage:path.join(packageParent,`.${studioPackage}.failed.${journal.token}`),packagePublished:false,oldPackageMoved:false,binBackups:journal.bins.map(item=>({name:item.name,destination:path.join(binDir,item.name),backup:path.join(binDir,`.${item.name}.backup.${journal.token}`),moved:false,exists:item.hadExisting,published:item.published})),createdBins:[],stateFile,stateSnapshot:journal.stateSnapshot,restored:false,committed:journal.phase==='committed'}
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
  // Only schema-1 journals ever changed the obsolete version preference file.
  if(tx.schema===1){
    try{restoreFileSnapshot(tx.stateFile,tx.stateSnapshot)}catch{throw new Error('rollback_failed:state_restore')}
    persistStudioJournal(tx,'state-restored')
  }
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
  const tx={schema:studioJournalSchema,token,operationId,beforeVersion,targetVersion:packageInfo.version,phase:'prepared',journalFile,journalCreated:false,packageHadExisting,packageDestination,packageBackup,failedPackage:path.join(packageParent,`.${studioPackage}.failed.${token}`),packagePublished:false,oldPackageMoved:false,binBackups:[],createdBins:[],stateFile,restored:false,committed:false}
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
async function npmPackageLatest(packageName,registry,run=captureCommand){
  const env={...process.env,NPM_CONFIG_REGISTRY:registry,npm_config_registry:registry}
  const result=await run(npmBin(),['view',`${packageName}@latest`,'version','--json',`--registry=${registry}`],{env,timeoutMs:15000,detached:true})
  const raw=JSON.parse(result.stdout.trim()),version=typeof raw==='string'?parseSemver(raw)?.value:''
  if(!version)throw new Error('invalid_registry_version')
  return version
}
async function npmLatest(force=false){
  const registry=npmRegistry(),now=Date.now(),ttl=npmLatestCache?.error?npmLatestFailureTtlMs:npmLatestTtlMs
  if(!force&&npmLatestCache?.registry===registry.url&&now-npmLatestCache.checkedAtMs<ttl)return npmLatestCache
  try{
    const version=await npmPackageLatest(studioPackage,npmRegistries.official.url)
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
function studioHealth(){return new Promise(resolve=>{let settled=false;const finish=value=>{if(settled)return;settled=true;resolve(value)};const req=http.get({hostname:'127.0.0.1',port:studioServicePort(),path:'/health',headers:{accept:'application/json'},timeout:2500},res=>{res.resume();finish(res.statusCode>=200&&res.statusCode<300)});req.on('timeout',()=>req.destroy());req.on('error',()=>finish(false));req.on('close',()=>finish(false))})}
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
  const npmOperation=lifecycleConflict(action);if(npmOperation)return {error:'operation_running',operation:operationView(npmOperation)}
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
      const packageInfo=validateStudioPackage(stagedPackage,op.targetVersion)
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
function fpkCacheForCurrent(cached,currentVersion){let updateAvailable=false;try{updateAvailable=compareSemver(cached?.latestVersion,currentVersion)>0}catch{}return {...cached,currentVersion,updateAvailable}}
const fpkCacheTtl=cached=>cached?.error?fpkUpdateFailureTtlMs:fpkUpdateTtlMs
async function performFpkUpdate(force=false,{stateFile=path.join(data,'manager','update-state.json'),repository=fpkRepository,getCurrentVersion=readPackageVersion,requestJson=getJson,now=Date.now}={}) {
  let cached={};try{cached=fpkCacheForRepository(JSON.parse(fs.readFileSync(stateFile,'utf8')),repository)}catch{}
  const current=getCurrentVersion(),nowMs=Number(now()),checkedAtMs=Date.parse(cached.lastCheckedAt||'')
  cached=fpkCacheForCurrent(cached,current)
  if(!repository)return {configured:false,currentVersion:current,latestVersion:'',updateAvailable:false,error:'repository_not_configured',lastCheckedAt:new Date(nowMs).toISOString()}
  if(!force&&Number.isFinite(checkedAtMs)&&nowMs-checkedAtMs<fpkCacheTtl(cached))return cached
  const checkedAt=new Date(nowMs).toISOString(),headers=cached.etag?{'if-none-match':cached.etag}:{}
  try{
    const response=await requestJson(`https://api.github.com/repos/${repository}/releases/latest`,headers)
    if(response.status===304){cached=fpkCacheForCurrent({...cached,repository,error:'',reason:'',lastCheckedAt:checkedAt,lastSuccessAt:cached.lastSuccessAt||checkedAt},current);atomicWrite(stateFile,JSON.stringify(cached)+'\n');return cached}
    if(response.status===404){cached={repository,currentVersion:current,latestVersion:'',updateAvailable:false,releaseUrl:'',releaseDate:'',lastCheckedAt:checkedAt,lastSuccessAt:cached.lastSuccessAt||'',etag:'',error:'',reason:'no-release'};atomicWrite(stateFile,JSON.stringify(cached)+'\n');return cached}
    if(response.status!==200)throw new Error(`HTTP ${response.status}`)
    const release=JSON.parse(response.body),latest=parseSemver(String(release.tag_name||'').replace(/^v/,''))?.value
    if(!latest)throw new Error('invalid_release_version')
    cached=fpkCacheForCurrent({repository,latestVersion:latest,releaseUrl:release.html_url||'',releaseDate:release.published_at||'',lastCheckedAt:checkedAt,lastSuccessAt:checkedAt,etag:response.headers?.etag||'',error:'',reason:''},current)
    atomicWrite(stateFile,JSON.stringify(cached)+'\n');return cached
  }catch{
    cached={...fpkCacheForCurrent(cached,current),repository,error:'update_check_failed',reason:'check-failed',lastCheckedAt:checkedAt}
    try{atomicWrite(stateFile,JSON.stringify(cached)+'\n')}catch{}
    return cached
  }
}
function fpkUpdate(force=false,options={}){
  if(fpkUpdatePending)return fpkUpdatePending
  const pending=performFpkUpdate(force,options),shared=pending.finally(()=>{if(fpkUpdatePending===shared)fpkUpdatePending=null})
  fpkUpdatePending=shared
  return shared
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
  const selected=await selectedStudioAsync()
  const selectedRuntimeSource=selected.source||'unknown'
  const selectedRuntimePath=selected.entry||''
  const runningProcess=verifiedStudioProcess(path.join(data,'hermes-home','server.pid'))
  const pid=runningProcess?.pid||null,processRunning=Boolean(pid)
  const selectedVersionPromise=cliStudioVersionAsync(selectedRuntimePath)
  const runningVersionPromise=runningProcess?.runtimePath===selectedRuntimePath?selectedVersionPromise:cliStudioVersionAsync(runningProcess?.runtimePath||'')
  const [healthy,selectedVersion,runningVersion,python]=await Promise.all([processRunning?studioHealth():false,selectedVersionPromise,runningVersionPromise,pythonRuntime()])
  const selectedStudioVersion=selectedVersion||'unknown'
  const studioVersion=(runningProcess?runningVersion:selectedVersion)||'unknown'
  const runtimeSource=runningProcess?.source||selectedRuntimeSource,runtimePath=runningProcess?.runtimePath||selectedRuntimePath
  const managerPid=verifiedPid(path.join(data,'manager','manager.pid'),/manager\/backend\/server\.mjs/),managerRunning=Boolean(managerPid)
  const stateName=healthy?'running':processRunning?'unhealthy':managerRunning?'manager-only':'stopped'
  return {packageVersion:readPackageVersion(),studioVersion,runtimeSource,runtimePath,selectedStudioVersion,selectedRuntimeSource,selectedRuntimePath,nodeVersion:process.version,pythonVersion:python.version,pythonPath:python.path,npmPrefix:path.join(data,'.npm-global'),pid,serverPath:runningProcess?.serverPath||'',processRunning,healthy,webUiRunning:healthy,managerPid,managerRunning,running:healthy,state:stateName,stopping:pathExists(stoppingMarker),updateRecoveryRequired:pathExists(updateRecoveryMarker),log:runtimeLogTail(),paths:{appRoot,lifecycleRoot,lifecycleScript:path.join(lifecycleRoot,'cmd','main')}}
}
function status(){if(statusPending)return statusPending;statusPending=computeStatus().finally(()=>{statusPending=null});return statusPending}
function readPackageVersion(){ for (const f of [path.join(appRoot,'manifest'),path.join(lifecycleRoot,'manifest'),path.join(appRoot,'..','manifest')]) { try { return fs.readFileSync(f,'utf8').match(/^version\s*=\s*([^\s]+)/m)?.[1] || 'unknown' } catch {} } return 'unknown' }
function readBootstrapState(){
  let current={status:'not_started'}
  try{current=JSON.parse(fs.readFileSync(bootstrapState,'utf8'))}catch{}
  return {...current,version:'npm latest',phase:current.phase||current.status,percent:current.status==='success'?100:null}
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
export {codingAgentUpdate, installAgent, pythonRuntime}

const server = http.createServer((req,res) => {
  const route = req.url.startsWith(gatewayPrefix) ? (req.url.slice(gatewayPrefix.length) || '/') : req.url
  if (req.method==='GET' && (route==='/' || route==='/index.html')) { const f=path.join(appRoot,'manager','frontend','index.html'); try { res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(fs.readFileSync(f)) } catch { return json(res,404,{error:'frontend_missing'}) } }
  if (route.startsWith('/api/')) { const error=apiPermissionError(req,route); if(error) return json(res,403,error) }
  if(req.method==='POST'&&pathExists(stoppingMarker)&&(/^(?:\/api\/(?:npm|python)\/registry|\/api\/runtime\/(?:bootstrap|start|restart|update|switch)|\/api\/agents\/(?:hermes-agent|codex|pi|claude|grok)\/(?:install|remove))$/.test(route)))return json(res,409,{error:'application_stopping'})
  if(req.method==='POST'&&pathExists(updateRecoveryMarker)&&(/^(?:\/api\/runtime\/(?:bootstrap|start|restart|update|switch)|\/api\/agents\/(?:hermes-agent|codex|pi|claude|grok)\/(?:install|remove))$/.test(route)))return json(res,409,{error:'update_recovery_required'})
  if (req.method==='GET' && route==='/api/status') return status().then(value=>json(res,200,value)).catch(()=>json(res,500,{error:'status_failed'}))
  if (req.method==='GET' && route==='/api/auth') return json(res,200,authSnapshot(req))
  if (req.method==='GET' && route==='/api/config') return json(res,200,managerConfig())
  const operationMatch=req.method==='GET'&&route.match(/^\/api\/operations\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)
  if(operationMatch){const active=operationForId(operationMatch[1]),persistent=active?null:persistentNpmOperation(),value=active||(persistent?.id===operationMatch[1]?operationView(persistent):null);return json(res,value?200:404,value||{error:'operation_not_found'})}
  if (req.method==='GET' && route==='/api/environment') return json(res,200,{HOME:data,NPM_GLOBAL:path.join(data,'.npm-global'),NPM_REGISTRY:npmRegistry().url,PYTHON_REGISTRY:pythonRegistry().url,NODE_PATH:process.env.NODE_ROOT || '',PATH:process.env.PATH || ''})
  if (req.method==='GET' && route==='/api/npm/registry') return json(res,200,npmRegistry())
  if (req.method==='POST' && route==='/api/npm/registry') return readJsonBody(req,res,body=>{const result=setNpmRegistry(body.id||'');return json(res,result.error?400:200,result)})
  if (req.method==='GET' && route==='/api/python/registry') return json(res,200,pythonRegistry())
  if (req.method==='POST' && route==='/api/python/registry') return readJsonBody(req,res,body=>{const result=setPythonRegistry(body.id||'');return json(res,result.error?400:200,result)})
  if (req.method==='GET' && route==='/api/runtime') return status().then(value=>json(res,200,{...value,bootstrap:readBootstrapState()})).catch(()=>json(res,500,{error:'status_failed',bootstrap:readBootstrapState()}))
  if (req.method==='GET' && route==='/api/runtime/bootstrap') return json(res,200,readBootstrapState())
  if (req.method==='POST' && route==='/api/runtime/bootstrap') { const active=blockingNpmOperation();if(active)return json(res,409,{error:'operation_running',operation:operationView(active)});bootstrapRuntime();return json(res,202,readBootstrapState()) }
  if (req.method==='POST' && /^\/api\/runtime\/(start|stop|restart)$/.test(route)) { const result=controlStudio(route.split('/').pop());return json(res,result.error?409:202,result) }
  if (req.method==='GET' && route==='/api/agents') return agentInventory().then(value=>json(res,200,value)).catch(()=>json(res,500,{error:'agent_detection_failed'}))
  if (req.method==='POST' && route==='/api/agents/detect') return agentInventory(true).then(value=>json(res,200,value)).catch(()=>json(res,500,{error:'agent_detection_failed'}))
  if (req.method==='POST' && route==='/api/agents/hermes-agent/install') return json(res,409,{error:'runtime_manager_required',hint:'Hermes Agent 首次安装和更新统一使用 Hermes Studio 版本管理；请打开 Hermes Studio 安装并启用 Hermes Runtime'})
  const codingAgentAction=req.method==='POST'&&route.match(/^\/api\/agents\/(codex|pi|claude|grok)\/(install|remove)$/)
  if (codingAgentAction) { const respond=body=>{const result=codingAgentAction[2]==='remove'?removeAgent(codingAgentAction[1]):installAgent(codingAgentAction[1],body);return json(res,result.error?(['operation_running','runtime_bootstrap_running','application_stopping','update_recovery_required','agent_not_managed'].includes(result.error)?409:400):202,result)};return codingAgentAction[2]==='remove'?respond():readJsonBody(req,res,respond) }
  if (req.method==='POST' && route==='/api/runtime/update') return updateStudio().then(result=>json(res,result.error?409:202,result)).catch(()=>json(res,500,{error:'update_preflight_failed'}))
  if (req.method==='GET' && route==='/api/runtime/update') return studioUpdateInfo().then(result=>json(res,200,result)).catch(()=>json(res,200,{currentVersion:'unknown',latestVersion:'',updateAvailable:false,reason:'check-failed',error:'npm_latest_unavailable',operations:operationsFor('studio')}))
  if (req.method==='GET' && route==='/api/fpk/update') return fpkUpdate().then(v=>json(res,200,v))
  if (req.method==='POST' && route==='/api/fpk/check') return fpkUpdate(true).then(v=>json(res,200,v))
  if (req.method==='POST' && route==='/api/runtime/switch') return json(res,410,{error:'runtime_selection_removed',hint:'Studio 仅使用官方 npm 安装，不支持本地版本切换'})
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

export {agentManaged, agentPackageRoot, agentReadiness, apiPermissionError, authSnapshot, beginStudioPublish, bootstrapInProgress, bootstrapProcessMatches, captureCommand, cleanupStudioGarbage, cleanupStudioStaging, commitStudioPublish, compareSemver, controlStudio, csrfOk, desktopHermesRuntimes, desktopRuntimeAgentLayout, drainStudioUpdateForShutdown, fpkCacheForCurrent, fpkCacheForRepository, fpkUpdate, hermesAgent, lifecycleConflict, managerConfig, npmProcessGroupAlive, npmProcessMatches, npmRegistry, operationForId, operationView, parseSemver, persistentNpmOperation, pythonRegistry, pythonVersionFromText, readStudioRecoveryJournal, recoverStudioPublish, redacted, rememberOutput, restoreStudioPublish, rollbackStudioAfterStop, runningNpmOperation, runningStudioStartOperation, setNpmRegistry, setPythonRegistry, stopStudioForRecoverySync, studioServicePort, studioUpdatePolicy, supportedPythonVersion, terminateCommand, updateStudio, validatedPublicUrl, validateStudioPackage, verifiedStudioPid, verifiedStudioProcess, versionFromText}
