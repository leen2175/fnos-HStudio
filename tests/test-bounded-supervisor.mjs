import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {fileURLToPath} from 'node:url'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const source=fs.readFileSync(path.join(root,'cmd/lib/runtime.sh'),'utf8')
const match=source.match(/"\$node" -e '\r?\n([\s\S]*?)\r?\n' "\$mode"/)
assert.ok(match,'embedded bounded supervisor source not found')

const handle=(fn,ms)=>({fn,ms,cleared:false})
function runScenario(killClearsScope){
  const child=new EventEmitter()
  child.pid=43210
  let scopeAlive=true
  const signals=[]
  const exits=[]
  const timers=[]
  const intervals=[]
  const processMock={
    argv:['/node','hstudio-command-bounded','900000','/fake/npm','install'],
    platform:'linux',
    execPath:'/node',
    once(){},
    kill(target,signal){
      assert.equal(target,-child.pid)
      if(signal===0){
        if(scopeAlive)return
        const error=new Error('missing process group')
        error.code='ESRCH'
        throw error
      }
      signals.push(signal)
      if(signal==='SIGKILL'&&killClearsScope)scopeAlive=false
    },
    exit(code){exits.push(code)}
  }
  const context={
    require(name){
      assert.equal(name,'node:child_process')
      return {spawn(){return child}}
    },
    process:processMock,
    setTimeout(fn,ms){const value=handle(fn,ms);timers.push(value);return value},
    clearTimeout(value){value.cleared=true},
    setInterval(fn,ms){const value=handle(fn,ms);intervals.push(value);return value},
    clearInterval(value){value.cleared=true}
  }
  vm.runInNewContext(match[1],context,{filename:'bounded-supervisor-inline.js'})
  return {child,signals,exits,timers,intervals}
}

const cleaned=runScenario(true)

// The supervised leader exits successfully while a same-PGID grandchild
// remains alive and ignores TERM. Success must not be reported yet.
cleaned.child.emit('exit',0)
assert.deepEqual(cleaned.signals,['SIGTERM'])
assert.deepEqual(cleaned.exits,[])
assert.equal(cleaned.intervals.length,1)
const killTimer=cleaned.timers.find(value=>value.ms===2000)
assert.ok(killTimer,'two-second escalation timer not scheduled')

// Escalation kills the lingering process group; only then may the original
// successful exit code be returned.
killTimer.fn()
assert.deepEqual(cleaned.signals,['SIGTERM','SIGKILL'])
assert.deepEqual(cleaned.exits,[0])
assert.equal(cleaned.intervals[0].cleared,true)

// Even a platform/process anomaly that still reports the group after KILL must
// not leave the supervisor alive forever. The final deadline returns failure
// because descendant cleanup could not be confirmed.
const stuck=runScenario(false)
stuck.child.emit('exit',0)
const stuckKillTimer=stuck.timers.find(value=>value.ms===2000)
stuckKillTimer.fn()
assert.deepEqual(stuck.signals,['SIGTERM','SIGKILL'])
assert.deepEqual(stuck.exits,[])
const finalTimer=stuck.timers.filter(value=>value.ms===2000)[1]
assert.ok(finalTimer,'post-SIGKILL final deadline not scheduled')
finalTimer.fn()
assert.deepEqual(stuck.exits,[1])
assert.equal(stuck.intervals[0].cleared,true)
console.log('PASS bounded supervisor cleans descendants and has a final deadline')
