import Progress from './progress'
import Task from './task'

let queue_calls = []
let secondary_calls = []
let _started = false

function queue(call){
    if (_started) {
        console.warn('Loading', 'Task already started, ignoring new queue call')
        return
    }
    queue_calls.push(call)
}

function secondary(call){
    secondary_calls.push(call)
}

function start(){
    if (_started) {
        console.warn('Loading', 'Task already started, preventing double start')
        return
    }
    
    _started = true
    
    let task = new Task(queue_calls)

    task.onProgress = (call, next)=>{
        let called = false
        let taskStartTime = Date.now()

        let launch = ()=>{
            if(!called) {
                let elapsed = Date.now() - taskStartTime
                console.log('Loading', 'Task completed or timed out after', elapsed, 'ms')
                next()
            }
            
            called = true
        }

        let timer = setTimeout(() => {
            console.warn('Loading', 'Task timeout reached (30s) - task did not complete')
            launch()
        }, 30000)

        try {
            call(()=>{
                clearTimeout(timer)
                launch()
            })
        } catch(e) {
            console.error('Loading', 'Task execution error:', e)
            clearTimeout(timer)
            launch()
        }
    }

    task.onComplite = ()=>{
        console.log('Loading', 'All queue tasks completed, starting secondary tasks')
        
        let progress = new Progress()

        progress.append(secondary_calls)

        progress.start(()=>{
            console.log('Loading', 'All secondary tasks completed')
        })
    }

    task.start()
}

export default {
    queue,
    secondary,
    start
}