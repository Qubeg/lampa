import Arrays from './arrays'

function Progress(){
    let works  = []
    let result = []
    let loaded = 0

    this.append = function(call){
        if(Arrays.isArray(call)) works = works.concat(call)
        else if(typeof call == 'function') works.push(call)
    }

    this.start = function(complite){
        if(works.length === 0) {
            console.log('Progress', 'no works to execute')
            complite(result)
            return
        }

        console.log('Progress', 'starting', works.length, 'secondary tasks')

        works.forEach((fun,i)=>{
            try {
                fun((data)=>{
                    result[i] = data

                    loaded++

                    console.log('Progress', 'task', i, 'completed (', loaded, '/', works.length, ')')

                    if(loaded == works.length) {
                        console.log('Progress', 'all tasks completed')
                        complite(result)
                    }
                })
            } catch(e) {
                console.error('Progress', 'task', i, 'error:', e)
                
                loaded++

                if(loaded == works.length) {
                    console.log('Progress', 'all tasks completed (with errors)')
                    complite(result)
                }
            }
        })
    }
}

export default Progress