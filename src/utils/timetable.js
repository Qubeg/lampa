import Storage from './storage'
import Favorite from './favorite'
import TMDB from './api/tmdb'
import Arrays from './arrays'
import Utils from './math'
import Account from './account'
import Cache from './cache'

let data     = []
let object   = false
let limit    = 300
let started  = Date.now()
let debug    = false

/**
 * Запуск
 */
function init(){
    data = Storage.cache('timetable',limit,[])

    setInterval(extract,1000*60*(debug ? 0.3 : 2))
    setInterval(favorites,1000*60*10)

    Favorite.listener.follow('add,added',(e)=>{
        if(e.card.number_of_seasons && e.where !== 'history') update(e.card)
    })

    Favorite.listener.follow('remove',(e)=>{
        if(e.card.number_of_seasons && e.method == 'id'){
            let find = data.find(a=>a.id == e.card.id)

            if(find){
                Arrays.remove(data,find)

                Storage.set('timetable',data)

                Storage.remove('timetable', find.id)
            }
        }
    })

    Lampa.Listener.follow('worker_storage',(e)=>{
        if(e.type == 'insert' && e.name == 'timetable'){
            data = Storage.get('timetable','[]')
        } 
    })
}

/**
 * Добавить карточки к парсингу
 * @param {[{id:integer,number_of_seasons:integer}]} elems - карточки
 */
function add(elems){
    if(started + 1000*60*2 > Date.now()) return

    let filtred = elems.filter(elem=>elem.number_of_seasons && typeof elem.id == 'number' && (elem.source == 'tmdb' || elem.source == 'cub'))

    console.log('Timetable', 'add:', elems.length, 'filtred:', filtred.length)

    filtred.forEach(elem=>{
        let find = data.find(a=>a.id == elem.id)

        if(!find){
            data.push({
                id: elem.id,
                season: elem.number_of_seasons,
                episodes: []
            })
        }
    })

    Storage.set('timetable',data)
}

/**
 * Добавить из закладок
 */
function favorites(){
    let category = ['like', 'wath', 'book', 'look', 'viewed', 'scheduled', 'continued', 'thrown']

    category.forEach(a=>{
        add(Favorite.get({type: a}))
    })
}

function filter(episodes){
    let filtred = []
    let fileds  = ['air_date','season_number','episode_number','name','still_path']

    episodes.forEach(episode=>{
        let item = {}

        fileds.forEach(field=>{
            if(typeof episode[field] !== 'undefined') item[field] = episode[field]
        })

        filtred.push(item)
    })

    return filtred
}

/**
 * Парсим карточку
 */
function parse(to_database){
    let check = Favorite.check(object)
    let any   = Favorite.checkAnyNotHistory(check)

    console.log('Timetable', 'parse:', object.id, 'any:', any, 'season:', object.season)

    if(any || to_database){
        TMDB.get('tv/'+object.id+'/season/'+object.season,{},(ep)=>{
            if(!ep.episodes) return save()
            
            object.episodes = filter(ep.episodes)

            Cache.getData('timetable',object.id).then(obj=>{
                if(obj) obj.episodes = object.episodes
                else    obj = Arrays.clone(object)

                Cache.rewriteData('timetable', object.id, obj).then(()=>{}).catch(()=>{})
            }).catch(e=>{})

            save()
        },save)
    }
    else{
        Arrays.remove(data, object)

        Storage.remove('timetable', object.id)

        save()
    }
}

/**
 * Получить карточку для парсинга
 */
function extract(){
    let ids = debug ? data.filter(e=>!e.scaned) : data.filter(e=>!e.scaned && (e.scaned_time || 0) + (60 * 60 * 12 * 1000) < Date.now())

    console.log('Timetable', 'extract:', ids.length, 'total:', data.length)

    if(ids.length){
        object = ids[0]

        parse()
    }
    else{
        data.forEach(a=>a.scaned = 0)
    }

    Storage.set('timetable',data)
}

/**
 * Сохранить состояние
 */
function save(){
    if(object){
        object.scaned = 1
        object.scaned_time = Date.now()

        Storage.set('timetable',data)
    }
}

/**
 * Получить эпизоды для карточки если есть
 * @param {{id:integer}} elem - карточка
 * @returns {array}
 */
function get(elem, callback){
    let fid = data.filter(e=>e.id == elem.id)
    let res = (fid.length ? fid[0] : {}).episodes || []

    if(typeof callback == 'function'){
        if(res.length) return callback(res)

        Cache.getData('timetable',elem.id).then(obj=>{
            callback(obj ? (obj.episodes || []) : [])
        }).catch(e=>{
            callback(res)
        })
    }
    else{
        return res
    }
}

/**
 * Получить полный список эпизодов для сериала, используя только сводные данные TMDB (episode_count по каждому сезону)
 * Это быстро и не требует загружать каждый сезон отдельно.
 * @param {{id:number}} elem
 * @param {(episodes:Array) => void} callback
 */
function getAll(elem, callback){
    if(!elem || typeof elem.id !== 'number'){
        if(typeof callback === 'function') callback([])
        return
    }

    TMDB.get('tv/'+elem.id,{},(tv)=>{
        const episodes = []
        if(tv?.seasons) {
            tv.seasons
                .filter(season => season.season_number > 0)
                .forEach(season => {
                    for(let i = 1; i <= (season.episode_count || 0); i++) {
                        episodes.push({
                            season_number: season.season_number,
                            episode_number: i
                        })
                    }
                })
        }

        // Сортируем по стандартной функции без циклической зависимости
        episodes.sort((a,b) => {
            const ka = (a.season_number||0) * 1000 + (a.episode_number||0)
            const kb = (b.season_number||0) * 1000 + (b.episode_number||0)
            return ka - kb
        })
        
        callback?.(episodes)
    }, () => callback?.([]))
}

/**
 * Добавить карточку в парсинг самостоятельно
 * @param {{id:integer,number_of_seasons:integer}} elem - карточка
 */
function update(elem){
    if(elem.number_of_seasons && typeof elem.id == 'number' && (elem.source == 'tmdb' || elem.source == 'cub')){
        let check = Favorite.check(elem)
        let any   = Favorite.checkAnyNotHistory(check)
        let id    = data.filter(a=>a.id == elem.id)
        let item  = {
            id: elem.id,
            season: Utils.countSeasons(elem),
            episodes: []
        }

        TMDB.clear()

        if(any){
            if(!id.length){
                console.log('Timetable', 'push:', elem.id)

                data.push(item)

                Storage.set('timetable',data)

                object = item
            }
            else{
                object = id[0]
                object.season = Utils.countSeasons(elem)
            }

            parse()
        }
        else{
            object = item

            parse(true)
        }
    }
}

/**
 * Получить все данные
 * @returns {[{id:integer,season:integer,episodes:[]}]}
 */
function all(){
    return data
}

function lately(){
    let fav = Favorite.full().card

    if(Account.working()) fav = Account.all()

    fav = fav.filter(f=>f.number_of_seasons)

    let now_date = new Date()
        now_date.setHours(0,0,0)

    let now_time = now_date.getTime()
    let cards = []

    data.filter(d=>fav.find(c=>c.id == d.id)).forEach(season=>{
        let episodes = season.episodes.filter(ep=>Lampa.Utils.parseToDate(ep.air_date).getTime() >= now_time)
        
        if(episodes.length){
            cards.push({
                card: Arrays.clone(fav.find(c=>c.id == season.id)),
                episode: episodes[0],
                time: Lampa.Utils.parseToDate(episodes[0].air_date).getTime(),
                season
            })
        }
    })

    cards = cards.sort((a,b)=>{
        if(a.time > b.time) return 1
        else if(a.time < b.time) return -1
        else return 0
    })
    
    return cards
}

export default {
    init,
    get,
    getAll,

    /**
     * Получить сводку по сериалу (seasons, episode_count и т.п.)
     * Быстро: один запрос tv/{id}
     * @param {{id:number}} elem
     * @param {(tv:object)=>void} callback
     */
    getShowMeta(elem, callback){
        if(!elem || typeof elem.id !== 'number'){ callback?.(null); return }
        TMDB.get('tv/'+elem.id,{},(tv)=>callback?.(tv),()=>callback?.(null))
    },

    /**
     * Получить эпизоды конкретного сезона с минимальной пост-обработкой
     * Пытается взять из локального кеша timetable, если совпадает сезон
     * @param {{id:number}} elem
     * @param {number} season
     * @param {(episodes:Array)=>void} callback
     */
    getSeasonEpisodes(elem, season, callback){
        if(!elem || typeof elem.id !== 'number' || !season){ callback?.([]); return }

        // Сначала пробуем из кеша timetable
        Cache.getData('timetable', elem.id).then(obj=>{
            if(obj && obj.season === season && Array.isArray(obj.episodes) && obj.episodes.length){
                callback?.(obj.episodes)
            }
            else{
                TMDB.get('tv/'+elem.id+'/season/'+season,{},(ep)=>{
                    const eps = ep?.episodes ? filter(ep.episodes) : []
                    callback?.(eps)
                },()=>callback?.([]))
            }
        }).catch(()=>{
            TMDB.get('tv/'+elem.id+'/season/'+season,{},(ep)=>{
                const eps = ep?.episodes ? filter(ep.episodes) : []
                callback?.(eps)
            },()=>callback?.([]))
        })
    },
    add,
    all,
    update,
    lately
}