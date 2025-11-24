import Manifest from './manifest'
import Request from './reguest'
import Status from './status'
import Storage from './storage'
import Utils from './math'
import Markers from './markers'

let network   = new Request()
let connected = true
let lastWorkingMirror = null

function init(){
    setInterval(()=>{
        task()
    }, 1000 * 60 * 15)
}

function redirect(to){
    if(Manifest.cub_domain == to) return

    Storage.set('cub_domain', to, true)

    console.log('Mirrors', 'redirect to', to)
}

function find(protocol, callback){
    let status = new Status(Manifest.cub_mirrors.length)

    status.onComplite = (data)=>{
        let keys = Object.keys(data)

        if(keys.length == 0) return callback([])

        let keys_true = keys.filter((key)=> data[key] == true)

        if(keys_true.length == 0){
            console.log('Mirrors', protocol + ' all offline')

            return callback([])
        }

        console.log('Mirrors', protocol + ' online', keys_true)

        callback(keys_true)
    }

    Manifest.cub_mirrors.forEach((mirror)=>{
        check(protocol, mirror, (result)=>{
            if(result){
                console.log('Mirrors', protocol + mirror, 'is online')
                
                // Сохраняем первое найденное рабочее зеркало
                if(!lastWorkingMirror) {
                    lastWorkingMirror = mirror
                    Storage.set('last_working_mirror', mirror, true)
                }

                status.append(mirror, result)
            }
            else{
                console.log('Mirrors', protocol + mirror, 'is offline')

                status.error()
            }
        })
    })
}

function check(protocol, mirror, call){
    let random = Math.random() + ''

    network.silent(protocol + mirror + '/api/checker', (str)=>{
        if(str == random) call(true)
        else call(false)
    }, (e)=>{
        call(false)
    }, {
        data: random,
    }, {
        dataType: 'text',
        timeout: 1000 * 4
    })
}

function task(call){
    if(lastWorkingMirror === null) {
        lastWorkingMirror = Storage.get('last_working_mirror', Manifest.cub_domain)
        console.log('Mirrors', 'loaded cached mirror:', lastWorkingMirror)
    }

    let protocols = ['https://', 'http://']
    let status = new Status(protocols.length)
    let quickCheckSuccess = false

    connected = true

    status.onComplite = (data)=>{
        let https = data['https://']
        let http  = data['http://']

        console.log('Mirrors', 'task complete - https:', https, 'http:', http)

        if(Storage.field('protocol') == 'https' && !https.length){
            Storage.set('protocol', 'http', true)

            if(http.length) redirect(http[0])
        }
        else if(Storage.field('protocol') == 'https' && https.length) redirect(https[0])
        else if(Storage.field('protocol') == 'http' && http.length) redirect(http[0])

        if(!https.length && !http.length) connected = false

        if(!connected) Markers.error('mirrors')
        else Markers.normal('mirrors')
        
        if(call && !quickCheckSuccess) call()
    }

    let checkTargets = []
    
    if(lastWorkingMirror) {
        checkTargets.push(lastWorkingMirror)
    }
    
    if(lastWorkingMirror !== Manifest.cub_domain) {
        checkTargets.push(Manifest.cub_domain)
    }

    let checkIndex = 0
    
    let tryNextTarget = () => {
        if(checkIndex >= checkTargets.length) {
            console.log('Mirrors', 'quick check failed, starting full check in background')
            protocols.forEach((protocol)=>{
                find(protocol, (mirrors)=>{
                    status.append(protocol, mirrors)
                })
            })
            if(call && !quickCheckSuccess) {
                quickCheckSuccess = true
                call()
            }
            return
        }

        let target = checkTargets[checkIndex]
        checkIndex++

        check(Utils.protocol(), target, (result)=>{
            console.log('Mirrors', 'quick check:', target, 'status:', result)

            if(result){
                quickCheckSuccess = true
                lastWorkingMirror = target
                Storage.set('last_working_mirror', target, true)
                
                console.log('Mirrors', 'quick check success')
                if(call) call()
                
                protocols.forEach((protocol)=>{
                    find(protocol, (mirrors)=>{
                        status.append(protocol, mirrors)
                    })
                })
            }
            else{
                tryNextTarget()
            }
        })
    }

    tryNextTarget()
}

function test(call){
    let protocols = ['https://', 'http://']

    let status = new Status(protocols.length)

    status.onComplite = (data)=>{
        let https = data['https://']
        let http  = data['http://']

        console.log('Mirrors', 'test complite', 'https:', https, 'http:', http)

        if(call) call()
    }

    console.log('Mirrors', 'start test')

    protocols.forEach((protocol)=>{
        find(protocol, (mirrors)=>{
            status.append(protocol, mirrors)
        })
    })
}

export default {
    init,
    task,
    connected: ()=>connected,
    test
}