import DB from './db'

let Cache = new DB('cache',[
    'screensavers',
    'plugins',
    'backgrounds',
    'images',
    'themes',
    'other',
    'timetable',
    'cards',
    'storage',
    'tv_meta'
],8)

Cache.openDatabase().then(()=>{
    console.log('Cache', 'worked')
}).catch(()=>{
    console.log('Cache', 'error', 'no open database')
})

export default Cache