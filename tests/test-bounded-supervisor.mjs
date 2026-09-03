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

const child=new EventEmitter()
child.pid=43210
let scopeAlive=true
const signals=[]
const exits=[]
const timers=[]
const intervals=[]
const handle=(fn,ms)=>({fn,ms,cleared:false})
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
    if(signal==='SIGKILL')scopeAlive=false
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

// The supervised leader exits successfully while a same-PGID grandchild
// remains alive and ignores TERM. Success must not be reported yet.
child.emit('exit',0)
assert.deepEqual(signals,['SIGTERM'])
assert.deepEqual(exits,[])
assert.equal(intervals.length,1)
const killTimer=timers.find(value=>value.ms===2000)
assert.ok(killTimer,'two-second escalation timer not scheduled')

// Escalation kills the lingering process group; only then may the original
// successful exit code be returned.
killTimer.fn()
assert.deepEqual(signals,['SIGTERM','SIGKILL'])
assert.deepEqual(exits,[0])
assert.equal(intervals[0].cleared,true)
console.log('PASS bounded supervisor cleans descendants after leader exit 0')
