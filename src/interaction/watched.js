import Template from './template'
import Timeline from './timeline'
import Timetable from '../utils/timetable'
import TmdbApi from '../utils/api/tmdb'
import Lang from '../utils/lang'
import Utils from '../utils/math'
import Cache from '../utils/cache'
import Storage from '../utils/storage'

// Кэш промисов для исключения параллельных запросов/задач с одинаковым ключом
const pendingRequests = new Map()

// Контроллеры отмены для сетевых и вычислительных операций
const abortControllers = new Map()

/**
 * Прерывает все активные операции и очищает внутренние структуры
 */
function abortAllRequests() {
    for (const [key, controller] of abortControllers.entries()) {
        if (!controller.signal.aborted) {
            controller.abort()
        }
    }
    pendingRequests.clear()
    abortControllers.clear()
}

/**
 * Есть ли какие-либо записи прогресса в таймлайне
 * @returns {boolean}
 */
function hasAnyTimelineData(){
    const viewed = Storage.cache(Timeline.filename(), 10000, {})
    try {
        return Object.keys(viewed).length > 0
    } catch (e) {
        return false
    }
}

/**
 * Прерывает операции, ключ которых начинается с указанного префикса
 * @param {string} keyPrefix
 */
function abortRequestsByPrefix(keyPrefix) {
    for (const [key, controller] of abortControllers.entries()) {
        if (key.startsWith(keyPrefix) && !controller.signal.aborted) {
            controller.abort()
            pendingRequests.delete(key)
            abortControllers.delete(key)
        }
    }
}

/**
 * Ключ для записи эпизодов сезона в Storage
 * @param {number|string} tvId
 * @param {number|string} season
 */
function buildSeasonCacheKey(tvId, season){
    return `season_episodes_${tvId}_${season}`
}

/**
 * Сохраняет список эпизодов сезона в локальный кэш
 * @param {string} cacheKey
 * @param {Array} episodes
 */
function saveEpisodesToCache(cacheKey, episodes) {
    try {
        const seasonEpisodesCache = Storage.cache('season_episodes_cache', 1000, {})
        seasonEpisodesCache[cacheKey] = {
            episodes: episodes,
            cached_at: Date.now()
        }
        Storage.set('season_episodes_cache', seasonEpisodesCache)
    } catch (error) {
     // пропускаем ошибки записи
    }
}

/**
 * Проверяет, не устарели ли кэшированные данные
 * @param {Object} cached
 * @param {number} maxAge
 */
function isCacheValid(cached, maxAge) {
    if (!cached || !cached.cached_at) return false
    const cacheAge = Date.now() - cached.cached_at
    return cacheAge < maxAge
}

/**
 * Удаляет сохранённые эпизоды сезонов и (опционально) метаданные сериала
 * @param {number|string} [tvId]
 */
function clearCache(tvId = null) {
    const seasonEpisodesCache = Storage.cache('season_episodes_cache', 1000, {})
    
    if (tvId === null) {
        Object.keys(seasonEpisodesCache).forEach(key => {
            if (key.startsWith('season_episodes_')) {
                delete seasonEpisodesCache[key]
            }
        })
    } else {
        Object.keys(seasonEpisodesCache).forEach(key => {
            if (key.startsWith(`season_episodes_${tvId}_`)) {
                delete seasonEpisodesCache[key]
            }
        })
    }
    
    Storage.set('season_episodes_cache', seasonEpisodesCache)
    
    if (tvId !== null) {
        const metaCache = Storage.cache('tv_meta_cache', 500, {})
        const metaKey = `tv_meta_${tvId}`
        if (metaCache[metaKey]) {
            delete metaCache[metaKey]
            Storage.set('tv_meta_cache', metaCache)
        }
    }
}

/**
 * Возвращает метаданные сериала (seasons), используя Storage/IndexedDB и TMDB как источник
 * @param {Object} data
 * @returns {Promise<Object|null>}
 */
function getShowMetaFromCache(data, options = {}) {
    if (!data?.id) return Promise.resolve(null)
    
    const cacheKey = `tv_meta_${data.id}`
    const prefix = options.abortKey ? options.abortKey + ':' : ''
    const requestKey = `${prefix}meta_${data.id}`
    
    if (pendingRequests.has(requestKey)) {
        return pendingRequests.get(requestKey)
    }
    
    const abortController = new AbortController()
    abortControllers.set(requestKey, abortController)
    
    const promise = (async () => {
        try {
            if (abortController.signal.aborted) {
                throw new Error('Request aborted')
            }
            
            const metaCache = Storage.cache('tv_meta_cache', 500, {})
            
            if (metaCache[cacheKey] && isCacheValid(metaCache[cacheKey], 30 * 24 * 60 * 60 * 1000)) {
                return metaCache[cacheKey]
            }
            
            const cached = await Cache.getData('tv_meta', data.id).catch(() => null)
            if (cached && isCacheValid(cached, 30 * 24 * 60 * 60 * 1000)) {
                metaCache[cacheKey] = cached
                Storage.set('tv_meta_cache', metaCache)
                return cached
            }
            
            if (abortController.signal.aborted) {
                throw new Error('Request aborted')
            }
            
            // Если локально нет метаданных и нет никаких записей таймлайна — пропускаем сетевой запрос
            if (!hasAnyTimelineData()) {
                return null
            }

            const tvShowData = await new Promise((resolve, reject) => {
                const onAbort = () => reject(new Error('Request aborted'))
                abortController.signal.addEventListener('abort', onAbort)
                
                TmdbApi.get(`tv/${data.id}`, {}, (result) => {
                    abortController.signal.removeEventListener('abort', onAbort)
                    resolve(result)
                }, () => {
                    abortController.signal.removeEventListener('abort', onAbort)
                    resolve(null)
                })
            })
            
            if (tvShowData) {
                const metaToCache = {
                    id: tvShowData.id,
                    seasons: tvShowData.seasons,
                    cached_at: Date.now()
                }
                
                Cache.rewriteData('tv_meta', data.id, metaToCache).catch(() => {})
                
                metaCache[cacheKey] = metaToCache
                Storage.set('tv_meta_cache', metaCache)
                
                return tvShowData
            }
            
            return null
        } catch (error) {
            if (error.message === 'Request aborted') {
                throw error
            }
            return null
        } finally {
            pendingRequests.delete(requestKey)
            abortControllers.delete(requestKey)
        }
    })()
    
    pendingRequests.set(requestKey, promise)
    return promise
}

/**
 * Возвращает список эпизодов сезона из Storage/IndexedDB, при отсутствии — из TMDB
 * @param {number|string} tvId
 * @param {number|string} season
 * @returns {Promise<Array>}
 */
function fetchSeasonFromCache(tvId, season, options = {}){
    const cacheKey = buildSeasonCacheKey(tvId, season)
    const prefix = options.abortKey ? options.abortKey + ':' : ''
    const requestKey = `${prefix}season_${tvId}_${season}`
    
    if (pendingRequests.has(requestKey)) {
        return pendingRequests.get(requestKey)
    }
    
    const abortController = new AbortController()
    abortControllers.set(requestKey, abortController)
    
    const promise = (async () => {
        try {
            if (abortController.signal.aborted) {
                throw new Error('Request aborted')
            }
            
            const seasonEpisodesCache = Storage.cache('season_episodes_cache', 1000, {})
            if (seasonEpisodesCache[cacheKey] && isCacheValid(seasonEpisodesCache[cacheKey], 24 * 60 * 60 * 1000)) {
                return seasonEpisodesCache[cacheKey].episodes
            }

            const episodes = await new Promise((resolve, reject) => {
                const onAbort = () => reject(new Error('Request aborted'))
                abortController.signal.addEventListener('abort', onAbort)
                
                Timetable.getSeasonEpisodes({id: parseInt(tvId)}, parseInt(season), (result) => {
                    abortController.signal.removeEventListener('abort', onAbort)
                    resolve(result)
                })
            })
            
            if (episodes && episodes.length > 0) {
                saveEpisodesToCache(cacheKey, episodes)
                return episodes
            }
            
            if (abortController.signal.aborted) {
                throw new Error('Request aborted')
            }
            
            const result = await new Promise((resolve, reject) => {
                const onAbort = () => reject(new Error('Request aborted'))
                abortController.signal.addEventListener('abort', onAbort)
                
                TmdbApi.get(`tv/${tvId}/season/${season}`, {}, (result) => {
                    abortController.signal.removeEventListener('abort', onAbort)
                    resolve(result)
                }, () => {
                    abortController.signal.removeEventListener('abort', onAbort)
                    resolve(null)
                })
            })
            
            const apiEpisodes = (result?.episodes) || []
            
            saveEpisodesToCache(cacheKey, apiEpisodes)
            
            return apiEpisodes
            
        } catch (error) {
            if (error.message === 'Request aborted') {
                throw error
            }
            saveEpisodesToCache(cacheKey, [])
            return []
        } finally {
            pendingRequests.delete(requestKey)
            abortControllers.delete(requestKey)
        }
    })()
    
    pendingRequests.set(requestKey, promise)
    return promise
}

/**
 * Хэш эпизода по названию сериала, сезону и номеру эпизода
 * @param {string} original_title
 * @param {number} season
 * @param {number} episode
 */
function hashEpisode(original_title, season, episode){
    // Валидация входных данных
    if (!original_title || typeof original_title !== 'string') {
        return Utils.hash('unknown')
    }
    if (typeof season !== 'number' || season < 0) {
        season = 0
    }
    if (typeof episode !== 'number' || episode < 0) {
        episode = 0
    }
    
    return Utils.hash([season, season > 10 ? ':' : '', episode, original_title].join(''))
}

/**
 * План просмотра для фильма (если есть прогресс)
 * @param {Object} data
 * @returns {Object|null}
 */
function getPlanMovie(data){
    const time = Timeline.view(Utils.hash(data.original_title))
    if(!time.percent) return null
    return {
        type: 'movie',
        current: { name: Lang.translate('title_viewed') + ' ' + (time.time ? Utils.secondsToTimeHuman(time.time) : time.percent + '%') },
        view: time
    }
}

/**
 * Поиск последнего просмотренного эпизода без блокировки UI
 * Проверяет эпизоды с конца, выполняя работу порциями между кадрами
 * @param {Array<{season_number:number,episode_count:number}>} seasons
 * @param {string} original_title
 * @param {AbortController} controller
 * @returns {Promise<{current:{season_number:number,episode_number:number}, view:object} | null>}
 */
function scanLastViewed(seasons, original_title, controller){
    const BATCH = 200

    // читаем сводку прогресса напрямую, учитывая профиль
    const viewed = Storage.cache(Timeline.filename(), 10000, {})

    const getPercent = (season, episode) => {
        const h = hashEpisode(original_title, season, episode)
        const v = viewed[h]
        if(typeof v === 'object') return v.percent || 0
        if(typeof v === 'number') return v || 0
        return 0
    }

    let sIdx = seasons.length - 1
    let eNum = sIdx >= 0 ? (seasons[sIdx].episode_count || 0) : 0

    return new Promise((resolve, reject) => {
        const step = () => {
            if (controller.signal.aborted) return reject(new Error('Request aborted'))

            let processed = 0
            while (processed < BATCH && sIdx >= 0) {
                if (eNum < 1) {
                    sIdx--
                    eNum = sIdx >= 0 ? (seasons[sIdx].episode_count || 0) : 0
                    continue
                }
                const seasonNum = seasons[sIdx].season_number
                if (getPercent(seasonNum, eNum) > 0) {
                    const h = hashEpisode(original_title, seasonNum, eNum)
                    const v = Timeline.view(h)
                    return resolve({ current: { season_number: seasonNum, episode_number: eNum }, view: v })
                }
                eNum--
                processed++
            }
            if (sIdx < 0) return resolve(null)
            requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
    })
}

/**
 * План просмотра для сериала
 * @param {Object} data
 * @returns {Promise<Object|null>}
 */
function getPlanTv(data, options = {}){
    return new Promise(resolve => {
    // если есть ключ отмены фокуса, отменяем старые операции по этому ключу
    if (options.abortKey) abortRequestsByPrefix(options.abortKey + ':')

    getShowMetaFromCache(data, { abortKey: options.abortKey }).then(tvShowData => {
            const seasons = (tvShowData?.seasons || [])
                .filter(season => (season.season_number||0) > 0)
                .map(season => ({ season_number: season.season_number, episode_count: season.episode_count || 0 }))
                .sort((a, b) => a.season_number - b.season_number)

            if(!seasons.length){
                resolve(null)
                return
            }

            const findSeasonByNumber = (seasonNumber) => seasons.find(season => season.season_number === seasonNumber)
            const lastSeasonNum = seasons[seasons.length-1].season_number

            const seasonIndex = new Map()
            seasons.forEach((season, index) => seasonIndex.set(season.season_number, index))
            const getNextSeason = (currentSeasonNum) => {
                const currentIndex = seasonIndex.get(currentSeasonNum)
                if (currentIndex !== undefined && currentIndex < seasons.length - 1) {
                    return seasons[currentIndex + 1]
                }
                return null
            }

            const scanKey = (options.abortKey ? options.abortKey + ':' : '') + `scan_${data.id}`
            if (abortControllers.has(scanKey)) {
                const prev = abortControllers.get(scanKey)
                if (prev && !prev.signal.aborted) prev.abort()
            }
            const controller = new AbortController()
            abortControllers.set(scanKey, controller)

            const pendingKey = (options.abortKey ? options.abortKey + ':' : '') + `scan_pending_${data.id}`
            const doScan = pendingRequests.get(pendingKey) || scanLastViewed(seasons, data.original_title, controller)
            pendingRequests.set(pendingKey, doScan)

            doScan.then(found => {
                if(!found){
                    resolve(null)
                    return
                }

                const { current, view } = found
                const curSeason  = current.season_number
                const curEpisode = current.episode_number

                // Ищем пропущенные эпизоды во всех предыдущих сезонах и в текущем сезоне до текущего эпизода
                const missedList = []
                const MAX_MISSED = 3
                // Читаем сводку прогресса один раз, чтобы не дёргать Timeline.view в цикле
                const viewedMap = Storage.cache(Timeline.filename(), 10000, {})
                const getPercent = (season, episode) => {
                    const h = hashEpisode(data.original_title, season, episode)
                    const v = viewedMap[h]
                    if(typeof v === 'object') return v.percent || 0
                    if(typeof v === 'number') return v || 0
                    return 0
                }

                // Сканируем сезоны по возрастанию до текущего
                for (let i = 0; i < seasons.length && missedList.length < MAX_MISSED; i++) {
                    const seasonInfo = seasons[i]
                    const sNum = seasonInfo.season_number
                    // Для текущего сезона — только до текущего эпизода (не включая его)
                    const lastEpisodeToCheck = sNum === curSeason
                        ? Math.max(1, curEpisode - 1)
                        : (seasonInfo.episode_count || 0)

                    if (sNum > curSeason || lastEpisodeToCheck < 1) continue

                    for (let eNum = 1; eNum <= lastEpisodeToCheck && missedList.length < MAX_MISSED; eNum++) {
                        const percent = getPercent(sNum, eNum)
                        if (percent === 0) {
                            missedList.push({ season_number: sNum, episode_number: eNum })
                        }
                    }
                }

                const primaryList = [{ season_number: curSeason, episode_number: curEpisode }]
                let seasonNum = curSeason
                let episodeNum = curEpisode + 1
                while(primaryList.length < 3){
                    const seasonInfo = findSeasonByNumber(seasonNum)
                    const episodeCount = seasonInfo ? (seasonInfo.episode_count || 0) : 0
                    if(episodeNum <= episodeCount && episodeNum > 0){
                        primaryList.push({ season_number: seasonNum, episode_number: episodeNum })
                        episodeNum++
                    } else {
                        const nextSeason = getNextSeason(seasonNum)
                        if(nextSeason){
                            seasonNum = nextSeason.season_number
                            episodeNum = 1
                        } else {
                            break
                        }
                    }
                }

                const lastSeasonInfo = findSeasonByNumber(lastSeasonNum) || { episode_count: 0 }
                const lastOfAll = curSeason === lastSeasonNum && curEpisode >= (lastSeasonInfo.episode_count || 0)

                resolve({ type: 'tv', current, view, primaryList, missedList, seasons, lastOfAll, tvId: data.id })
            }).catch(() => {
                resolve(null)
            }).finally(() => {
                pendingRequests.delete(pendingKey)
                abortControllers.delete(scanKey)
            })
        })
    })
}

/**
 * Универсальный план просмотра для карточки (фильм или сериал)
 * @param {Object|null} data
 * @returns {Promise<Object|null>}
 */
function getPlan(data, options = {}){
    if(!data) return Promise.resolve(null)
    if(data.original_name){
    return getPlanTv(data, options)
    }
    return Promise.resolve(getPlanMovie(data))
}

/**
 * Элемент строки информации о просмотре
 * @param {string} text
 * @param {Array<string>} [classes=[]]
 * @param {boolean} [showTimeline=false]
 * @param {Object|null} [timeline=null]
 */
function createItem(text, classes = [], showTimeline = false, timeline = null){
    const div = document.createElement('div')
    div.classList.add('card-watched__item', ...classes)

    const span = document.createElement('span')
    span.innerText = text
    div.appendChild(span)

    if(showTimeline && timeline){
        div.appendChild(Timeline.render(timeline)[0])
    }

    return div
}

/**
 * Узел с планом просмотра для карточки
 * @param {Object|null} plan
 * @param {Object} [opts={}]
 */
function render(plan, opts = {}){
    if(!plan) return null
    const options = Object.assign({ withTimeline: true, fetchNames: true, mount: null, position: 'prepend' }, opts)

    const wrap = Template.js('card_watched', {})
    const body = wrap.querySelector('.card-watched__body')

    if(plan.type === 'movie'){
        body.appendChild(createItem(plan.current.name, [], options.withTimeline, plan.view))
    } else {
        const { current, view, primaryList, missedList, lastOfAll, tvId } = plan
        const fragment = document.createDocumentFragment()

        if(missedList?.length){
            const missedLabel = missedList.map(missedEpisode => `S${missedEpisode.season_number||0}E${missedEpisode.episode_number||0}`).join(', ')
            fragment.appendChild(createItem(Lang.translate('missed_episodes') + ': ' + missedLabel, ['card-watched__missed']))
        }

        const nodes = []
        primaryList.forEach((episodeItem, episodeIndex) => {
            const badge = `S${episodeItem.season_number||0}E${episodeItem.episode_number||0}`
            const isFirst = (episodeItem.season_number === (current?.season_number) && episodeItem.episode_number === (current?.episode_number)) && episodeIndex === 0
            const node = createItem(badge, [], options.withTimeline && isFirst, isFirst ? view : null)
            nodes.push({ key: `${episodeItem.season_number}x${episodeItem.episode_number}`, node, badge })
            fragment.appendChild(node)
        })

        if(lastOfAll){
            fragment.appendChild(createItem(Lang.translate('last_episode_now'), ['card-watched__final']))
        }

        body.appendChild(fragment)

        if(options.fetchNames && tvId){
            if(options.abortKey) {
                abortRequestsByPrefix(options.abortKey + '_names')
            }
            
            // Собираем уникальные сезоны
            const seasonsSet = new Set()
            
            primaryList.forEach(episodeData => {
                if(episodeData.season_number) {
                    seasonsSet.add(episodeData.season_number)
                }
            })
            
            missedList?.forEach(episodeData => {
                if(episodeData.season_number) {
                    seasonsSet.add(episodeData.season_number)
                }
            })
            
            const seasonsToLoad = Array.from(seasonsSet)
            
            if(seasonsToLoad.length){
                Promise.allSettled(seasonsToLoad.map(season => fetchSeasonFromCache(tvId, season, { abortKey: options.abortKey })))
                    .then((results) => {
                        const nameMap = new Map()
                        const episodeMap = new Map()
                        
                        results.forEach((result, index) => {
                            if (result.status === 'fulfilled') {
                                const episodes = result.value || []
                                const seasonNumber = seasonsToLoad[index]
                                
                                episodes.forEach(episode => {
                                    const key = `${seasonNumber}x${episode.episode_number}`
                                    nameMap.set(key, episode.name)
                                    episodeMap.set(key, episode)
                                })
                            }
                        })
                        
                        nodes.forEach(node => {
                            const episodeName = nameMap.get(node.key)
                            const episodeObj = episodeMap.get(node.key)
                            const span = node.node.querySelector('span')

                            if(!span) return

                            let futureText = ''
                            if(episodeObj && episodeObj.air_date){
                                const daysLeft = Utils.countDays(Date.now(), episodeObj.air_date)
                                if(daysLeft > 0){
                                    futureText = `${Lang.translate('full_episode_days_left')}: ${daysLeft}`
                                    node.node.classList.add('card-watched__item')
                                }
                            }

                            span.innerText = futureText 
                                ? `${node.badge} / ${futureText}`
                                : episodeName 
                                    ? `${node.badge} - ${episodeName}` 
                                    : node.badge
                        })
                    })
                    .catch(() => {
                        // без изменений при ошибке
                    })
            }
        }
    }

    if(options.mount){
        if(options.position === 'append') options.mount.appendChild(wrap)
        else options.mount.insertBefore(wrap, options.mount.firstChild)
    }

    return wrap
}

/**
 * Получает план и сразу рендерит его в контейнер
 * @param {Object|null} data
 * @param {HTMLElement} mount
 * @param {Object} [opts={}]
 */
function attach(data, mount, opts = {}){
    return getPlan(data).then(plan => {
        if(!plan) return null
        return render(plan, Object.assign({}, opts, { mount }))
    })
}

export default {
    getPlan,
    render,
    attach,
    clearCache,
    getShowMetaFromCache,
    fetchSeasonFromCache,
    abortAllRequests,
    abortRequestsByPrefix,
    
    /**
    * Удаляет устаревшие записи из локальных кэшей и прерывает активные операции
    * @param {number} [maxAge=7*24*60*60*1000]
     */
    cleanupOldCache(maxAge = 7 * 24 * 60 * 60 * 1000) {
        const now = Date.now()
        
        const seasonCache = Storage.cache('season_episodes_cache', 1000, {})
        let seasonChanged = false
        Object.keys(seasonCache).forEach(key => {
            const item = seasonCache[key]
            if (item && item.cached_at && (now - item.cached_at) > maxAge) {
                delete seasonCache[key]
                seasonChanged = true
            }
        })
        if (seasonChanged) {
            Storage.set('season_episodes_cache', seasonCache)
        }
        
        const metaCache = Storage.cache('tv_meta_cache', 500, {})
        let metaChanged = false
        Object.keys(metaCache).forEach(key => {
            const item = metaCache[key]
            if (item && item.cached_at && (now - item.cached_at) > maxAge) {
                delete metaCache[key]
                metaChanged = true
            }
        })
        if (metaChanged) {
            Storage.set('tv_meta_cache', metaCache)
        }
        
        abortAllRequests()
    }
}
