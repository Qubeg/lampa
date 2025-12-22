import Storage from './storage/storage'
import Favorite from './favorite'
import TMDB from './api/sources/tmdb'
import Arrays from '../utils/arrays'
import Utils from '../utils/utils'
import Account from './account/account'
import Cache from '../utils/cache'
import ContentRows from './content_rows'
import Lang from './lang'
import Episode from '../interaction/episode/episode'
import EpisodeModule from '../interaction/episode/module/module'
import Background from '../interaction/background'
import Router from './router'
import Timer from './timer'
import Timeline from '../interaction/timeline'

let data     = []
let object   = false
let limit    = 300
let time_recent = 1000 * 60 * 60 * 24 * 14 // 14 дней

let time_favorites = 1000 * 60 * 10
let time_extract   = 1000 * 30
let time_season    = 1000 * 60 * 60 * 24 // 1 день

const TRACKED_CATEGORIES = ['like', 'wath', 'book', 'look', 'viewed', 'scheduled', 'continued']

/**
 * Запуск
 */
function init(){
    data = Storage.cache('timetable',limit,[])

    Timer.add(time_favorites, favorites)
    Timer.add(time_extract, extract)

    // Добавляем поле ssn для хранения времени обновления сезонов
    data.forEach(a=>{a.ssn = a.ssn || 0})

    // Обнуляем эпизоды, будем подгружать из db
    data.forEach(a=>{a.episodes = []})

    Lampa.Listener.follow('state:changed', (e)=>{
        if(e.target == 'favorite' && e.reason == 'update' && (e.method == 'add' || e.method == 'added') && e.type !== 'history'){
            console.log('Timetable', 'favorite changed:', e.reason, e.type, e.card.id)

            if((e.card.number_of_seasons || e.card.original_name) && (e.card.source == 'tmdb' || e.card.source == 'cub')) update(e.card)
        }
    })

    Favorite.listener.follow('remove',(e)=>{
        if((e.card.number_of_seasons || e.card.original_name) && e.method == 'id'){
            if(!isCardTracked(e.card)){
                let find = data.find(a=>a.id == e.card.id)

                if(find){
                    Arrays.remove(data,find)

                    saveData()

                    Cache.deleteData('timetable', find.id)
                }
            }
        }
    })

    // Начальный импорт из закладок
    favorites()

    loadEpisodes()

    ContentRows.add({
        name: 'timetable_lately',
        title: Lang.translate('title_upcoming_episodes'),
        index: 1,
        screen: ['main', 'category'],
        call: (params, screen)=>{
            if(screen == 'category' && params.url == 'movie') return

            let results = lately().slice(0,20)

            if(!results.length) return

            return function(call){
                results.forEach(createEpisodeParams)

                call({
                    results,
                    title: Lang.translate('title_upcoming_episodes')
                })
            }
        }
    })

    ContentRows.add({
        name: 'timetable_recently',
        title: Lang.translate('title_recent_episodes'),
        index: 1,
        screen: ['main', 'category'],
        call: (params, screen)=>{
            if(screen == 'category' && params.url == 'movie') return

            let results = recently().slice(0,20)

            if(!results.length) return

            return function(call){
                results.forEach(createEpisodeParams)

                call({
                    results,
                    title: Lang.translate('title_recent_episodes')
                })
            }
        }
    })
}

/**
 * Параметры для эпизода в ленте
 * @param {object} item 
 */
function createEpisodeParams(item){
    item.params = {
        createInstance: (item)=> new Episode(item),
        module: EpisodeModule.only('Card', 'Callback'),
        emit: {
            onlyEnter: Router.call.bind(Router, 'full', item.card),
            onlyFocus: ()=>{
                Background.change(Utils.cardImgBackgroundBlur(item.card))
            }
        }
    }

    Arrays.extend(item, item.episode)
}

/**
 * Загрузить эпизоды из кеша
 * @returns {void}
 */
function loadEpisodes(){
    Cache.getData('timetable').then(all_data=>{
        if(all_data && all_data.length){
            let map = new Map()
            data.forEach(d => map.set(d.id, d))

            all_data.forEach(obj=>{
                let find = map.get(obj.id)
                if(find) find.episodes = obj.episodes || []
            })

            console.log('Timetable', 'load episodes from cache:', all_data.length)
        }
    }).catch(e=>{
        console.log('Timetable', 'load episodes from cache error:', e.message)
    })
}

/**
 * Добавить карточки к парсингу
 * @param {[{id:integer,number_of_seasons:integer}]} elems - карточки
 */
function add(elems, log_type){
    let filtred = elems.filter(elem=>(elem.number_of_seasons || elem.original_name) && typeof elem.id == 'number' && (elem.source == 'tmdb' || elem.source == 'cub'))

    console.log('Timetable', 'add:', elems.length, 'filtred:', filtred.length, 'type:', log_type || 'unknown')

    let map = new Map()
    data.forEach(d => map.set(d.id, d))

    filtred.forEach(elem=>{
        if(!map.has(elem.id)){
            let item = {
                id: elem.id,
                season: elem.number_of_seasons || 0,
                episodes: [],
                ssn: 0
            }
            data.push(item)
            map.set(elem.id, item)
        }
    })

    saveData()
}

/**
 * Сохранить данные без эпизодов
 * @returns {void}
 */
function saveData(){
    Storage.set('timetable', data.map(a => ({
        id: a.id,
        season: a.season,
        ssn: a.ssn,
        next: a.next,
        scaned: a.scaned,
        scaned_time: a.scaned_time
    })))
}

/**
 * Добавить из закладок
 */
function favorites(){
    TRACKED_CATEGORIES.forEach(a=>{
        add(Favorite.get({type: a}), a)
    })
}

/**
 * Проверить отслеживается ли карточка
 * @param {object} card 
 * @returns {boolean}
 */
function isCardTracked(card){
    let check = Favorite.check(card)
    return TRACKED_CATEGORIES.some(cat => check[cat])
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
    if(isCardTracked(object) || to_database){
        // Если нет сезонов или давно не обновляли количество сезонов
        if(!object.season || Date.now() - object.ssn > time_season){
            console.log('Timetable', 'parse:', object.id, 'old season:', object.season)

            TMDB.get('tv/'+object.id, {}, (json)=>{
                object.season = Utils.countSeasons(json) || 1
                object.ssn    = Date.now()

                if(json.next_episode_to_air) object.next = filter([json.next_episode_to_air])[0]
                else                         object.next = false

                parse(to_database)
            }, save, {life: 60 * 24})
        }
        else{
            console.log('Timetable', 'parse:', object.id, 'new season:', object.season)

            TMDB.get('tv/'+object.id+'/season/'+object.season,{},(ep)=>{
                if(!ep.episodes) return save()
                
                object.episodes = filter(ep.episodes_original || ep.episodes)
                
                let next = getNextEpisode(object.episodes)
                
                if(next) object.next = next

                Cache.getData('timetable',object.id).then(obj=>{
                    if(obj) obj.episodes = object.episodes
                    else    obj = Arrays.clone(object)

                    Cache.rewriteData('timetable', object.id, obj).then(()=>{}).catch(()=>{})

                    Lampa.Listener.send('state:changed', {
                        target: 'timetable',
                        reason: 'parse',
                        id: object.id
                    })
                }).catch(e=>{})

                save()
            },save, {life: 60 * 24})
        }
    }
    else{
        console.log('Timetable', 'remove:', object.id, 'not in favorites anymore')

        Arrays.remove(data, object)

        Cache.deleteData('timetable', object.id)

        save()
    }
}

/**
 * Получить следующий эпизод из списка
 * @param {[{air_date:string}]} episodes - эпизоды
 * @param {object} card - карточка для проверки просмотра
 * @returns {object|boolean}
 */
function getNextEpisode(episodes, card){
    let now = new Date()
        now.setHours(0,0,0,0)

    let now_time = now.getTime()

    return episodes.find(ep=>{
        if(ep.air_date){
            let air_time = Utils.parseToDate(ep.air_date).getTime()

            if(air_time >= now_time){
                if(card){
                    let viewed = Timeline.watchedEpisode(card, ep.season_number, ep.episode_number)

                    if(viewed >= 60) return false
                }

                return true
            }
        }
    }) || false
}

/**
 * Получить карточку для парсинга
 */
function extract(){
    let ids = data.filter(e=>!e.scaned)

    console.log('Timetable', 'extract:', ids.length, 'total:', data.length)

    if(ids.length){
        object = ids[0]

        parse()
    }
    else{
        data.forEach(a=>a.scaned = 0)
    }

    saveData()
}

/**
 * Сохранить состояние
 */
function save(){
    if(object){
        object.scaned = 1
        object.scaned_time = Date.now()

        saveData()
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
            callback(obj ? (obj.episodes || []) : [], true)
        }).catch(e=>{
            callback(res, true)
        })
    }
    else{
        return res
    }
}

/**
 * Добавить карточку в парсинг самостоятельно
 * @param {{id:integer,number_of_seasons:integer}} elem - карточка
 */
function update(elem){
    if((elem.number_of_seasons || elem.original_name) && typeof elem.id == 'number' && (elem.source == 'tmdb' || elem.source == 'cub')){
        let id    = data.filter(a=>a.id == elem.id)
        let item  = {
            id: elem.id,
            season: elem.number_of_seasons ? Utils.countSeasons(elem) : 0,
            episodes: [],
            ssn: Date.now()
        }

        if(isCardTracked(elem)){
            if(!id.length){
                console.log('Timetable', 'push:', elem.id)

                data.push(item)

                saveData()

                object = item
            }
            else{
                object = id[0]
                object.season = elem.number_of_seasons ? Utils.countSeasons(elem) : object.season || 0
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
    let favMap = favoriteCards()
    let now    = new Date()
        now.setHours(0,0,0,0)

    let now_time = now.getTime()
    let cards    = []

    data.filter(d=>favMap.has(d.id)).forEach(season=>{
        let card    = favMap.get(season.id)
        let episode = season.episodes.length ? getNextEpisode(season.episodes, card) : season.next
        
        if(episode){
            let air_time = Utils.parseToDate(episode.air_date).getTime()

            if(air_time >= now_time){
                let viewed = Timeline.watchedEpisode(card, episode.season_number, episode.episode_number)

                if(viewed < 60){
                    cards.push({
                        card: Arrays.clone(card),
                        episode: episode,
                        time: air_time,
                        season
                    })
                }
            }
        }
    })

    cards = cards.sort((a,b)=>{
        if(a.time > b.time) return 1
        else if(a.time < b.time) return -1
        else return 0
    })
    
    return cards
}

function recently(){
    let favMap = favoriteCards()
    let now    = new Date()
        now.setHours(0,0,0,0)

    let now_time = now.getTime()
    let start_time = now_time - time_recent

    let cards = []

    data.filter(d=>favMap.has(d.id)).forEach(season=>{
        if(!season.episodes || !season.episodes.length) return

        let card = favMap.get(season.id)

        season.episodes.forEach(episode=>{
            if(!episode.air_date) return

            let air_time = Utils.parseToDate(episode.air_date).getTime()

            if(air_time >= start_time && air_time < now_time){
                let viewed = Timeline.watchedEpisode(card, episode.season_number, episode.episode_number)

                if(viewed < 60){
                    cards.push({
                        card: Arrays.clone(card),
                        episode: episode,
                        viewed,
                        time: air_time,
                        season
                    })
                }
            }
        })
    })

    cards = cards.sort((a,b)=>{
        if(a.time > b.time) return -1
        else if(a.time < b.time) return 1
        else return 0
    })

    return cards
}

function favoriteCards(){
    let fav = Account.Permit.sync ? Account.Bookmarks.all() : Favorite.full().card
    let map = new Map()

    fav.forEach(f=>{
        if(f && f.id && (f.number_of_seasons || f.original_name) && (f.source == 'tmdb' || f.source == 'cub')){
            if(isCardTracked(f)){
                if(!map.has(f.id)) map.set(f.id, f)
            }
        }
    })

    return map
}

export default {
    init,
    get,
    add,
    all,
    update,
    lately,
    recently
}
