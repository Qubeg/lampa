import Template from './template'
import Timeline from './timeline'
import Timetable from '../utils/timetable'
import TmdbApi from '../utils/api/tmdb'
import Lang from '../utils/lang'
import Utils from '../utils/math'
import Cache from '../utils/cache'
import Storage from '../utils/storage'

// Лимиты кэшей Storage.cache
const CACHE_LIMIT_SEASON_EPISODES = 1000
const CACHE_LIMIT_TV_META = 500
const CACHE_LIMIT_WATCHED_POSITION = 5000
const CACHE_LIMIT_TIMELINE = 10000

// Время жизни кэшей (в миллисекундах)
const CACHE_TTL_META = 30 * 24 * 60 * 60 * 1000      // 30 дней
const CACHE_TTL_EPISODES = 24 * 60 * 60 * 1000       // 1 день
const CACHE_TTL_CLEANUP = 7 * 24 * 60 * 60 * 1000    // 7 дней

// Лимиты сканирования
const SCAN_BATCH_SIZE = 200          // Эпизодов за итерацию backward scan
const SCAN_MAX_FORWARD_CHECKS = 100  // Макс. эпизодов в forward scan
const DISPLAY_MAX_MISSED = 3         // Макс. пропущенных эпизодов для показа

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
    const viewed = Storage.cache(Timeline.filename(), CACHE_LIMIT_TIMELINE, {})
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
 * @returns {string}
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
        const seasonEpisodesCache = Storage.cache('season_episodes_cache', CACHE_LIMIT_SEASON_EPISODES, {})
        
        // Сохраняем только необходимые поля, чтобы не забивать LocalStorage
        const minified = episodes.map(ep => ({
            season_number: ep.season_number,
            episode_number: ep.episode_number,
            name: ep.name,
            air_date: ep.air_date
        }))

        seasonEpisodesCache[cacheKey] = {
            episodes: minified,
            cached_at: Date.now()
        }
        Storage.set('season_episodes_cache', seasonEpisodesCache)
    } catch (error) {
     // пропускаем ошибки записи
    }
}

/**
 * Проверяет, не устарели ли кэшированные данные
 * @param {Object} cached - объект с полем cached_at
 * @param {number} maxAge - максимальный возраст в миллисекундах
 * @returns {boolean}
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
    const seasonEpisodesCache = Storage.cache('season_episodes_cache', CACHE_LIMIT_SEASON_EPISODES, {})
    const positionCache = Storage.cache('watched_position_cache', CACHE_LIMIT_WATCHED_POSITION, {})
    
    if (tvId === null) {
        Object.keys(seasonEpisodesCache).forEach(key => {
            if (key.startsWith('season_episodes_')) {
                delete seasonEpisodesCache[key]
            }
        })
        Object.keys(positionCache).forEach(key => delete positionCache[key])
    } else {
        Object.keys(seasonEpisodesCache).forEach(key => {
            if (key.startsWith(`season_episodes_${tvId}_`)) {
                delete seasonEpisodesCache[key]
            }
        })
        if(positionCache[tvId]) delete positionCache[tvId]
    }
    
    Storage.set('season_episodes_cache', seasonEpisodesCache)
    Storage.set('watched_position_cache', positionCache)
    
    if (tvId !== null) {
        const metaCache = Storage.cache('tv_meta_cache', CACHE_LIMIT_TV_META, {})
        const metaKey = `tv_meta_${tvId}`
        if (metaCache[metaKey]) {
            delete metaCache[metaKey]
            Storage.set('tv_meta_cache', metaCache)
        }
    }
}

/**
 * Возвращает метаданные сериала (seasons), используя Storage/IndexedDB и TMDB как источник
 * @param {Object} data - карточка сериала с полем id
 * @param {Object} [options={}] - опции
 * @param {string} [options.abortKey] - ключ для отмены запроса
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
            
            const metaCache = Storage.cache('tv_meta_cache', CACHE_LIMIT_TV_META, {})
            
            if (metaCache[cacheKey] && isCacheValid(metaCache[cacheKey], CACHE_TTL_META)) {
                return metaCache[cacheKey]
            }
            
            const cached = await Cache.getData('tv_meta', data.id).catch(() => null)
            if (cached && isCacheValid(cached, CACHE_TTL_META)) {
                metaCache[cacheKey] = cached
                Storage.set('tv_meta_cache', metaCache)
                return cached
            }
            
            if (abortController.signal.aborted) {
                throw new Error('Request aborted')
            }
            
            // Если локально нет метаданных и нет никаких записей таймлайна - пропускаем сетевой запрос
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
 * Возвращает список эпизодов сезона из Storage/IndexedDB, при отсутствии - из TMDB
 * @param {number|string} tvId
 * @param {number|string} season
 * @param {Object} [options={}] - опции
 * @param {string} [options.abortKey] - ключ для отмены запроса
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
            
            const seasonEpisodesCache = Storage.cache('season_episodes_cache', CACHE_LIMIT_SEASON_EPISODES, {})
            if (seasonEpisodesCache[cacheKey] && isCacheValid(seasonEpisodesCache[cacheKey], CACHE_TTL_EPISODES)) {
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
 * @returns {string}
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
 * @param {number} tvId
 * @param {AbortController} controller
 * @returns {Promise<{current:{season_number:number,episode_number:number}, view:object} | null>}
 */
function scanLastViewed(seasons, original_title, tvId, controller){
    // Читаем сводку прогресса напрямую, учитывая профиль
    const viewed = Storage.cache(Timeline.filename(), CACHE_LIMIT_TIMELINE, {})
    const positionCache = Storage.cache('watched_position_cache', CACHE_LIMIT_WATCHED_POSITION, {})

    const getPercent = (season, episode) => {
        const h = hashEpisode(original_title, season, episode)
        const v = viewed[h]
        if(typeof v === 'object') return v.percent || 0
        if(typeof v === 'number') return v || 0
        return 0
    }

    const savePosition = (season, episode) => {
        positionCache[tvId] = { season, episode, time: Date.now() }
        Storage.set('watched_position_cache', positionCache)
    }

    // Проверка кэшированной позиции
    const cached = positionCache[tvId]
    if (cached && cached.season && cached.episode) {
        // Если кэшированный эпизод всё ещё просмотрен
        if (getPercent(cached.season, cached.episode) > 0) {
            return new Promise((resolve) => {
                // Попробуем найти более новые просмотренные эпизоды (сканируем вперед)
                let currentSeason = cached.season
                let currentEpisode = cached.episode
                let foundNewer = false
                
                // Находим индекс сезона в массиве seasons
                let sIdx = seasons.findIndex(s => s.season_number === currentSeason)
                
                if (sIdx !== -1) {
                    // Проверяем вперед
                    let checks = 0
                    
                    while(checks < SCAN_MAX_FORWARD_CHECKS && sIdx < seasons.length){
                        const seasonData = seasons[sIdx]
                        if(!seasonData) break
                        
                        const episodeCount = seasonData.episode_count || 0
                        
                        let nextSeason = currentSeason
                        let nextEpisode = currentEpisode + 1
                        let nextSIdx = sIdx

                        if(nextEpisode > episodeCount){
                            nextSIdx++
                            if(nextSIdx < seasons.length && seasons[nextSIdx]){
                                nextSeason = seasons[nextSIdx].season_number
                                nextEpisode = 1
                            } else {
                                break
                            }
                        }
                        
                        if(getPercent(nextSeason, nextEpisode) > 0){
                            currentSeason = nextSeason
                            currentEpisode = nextEpisode
                            sIdx = nextSIdx
                            foundNewer = true
                            checks++
                        } else {
                            break
                        }
                    }
                    
                    // Если мы прервали поиск из-за лимита, а не потому что кончились сезоны или нашли непросмотренный
                    // То запустить полный скан
                    if (checks >= SCAN_MAX_FORWARD_CHECKS) {
                        return runBackwardScan()
                    }
                    
                    const h = hashEpisode(original_title, currentSeason, currentEpisode)
                    const view = Timeline.view(h)
                    
                    if(foundNewer) savePosition(currentSeason, currentEpisode)
                    
                    resolve({ current: { season_number: currentSeason, episode_number: currentEpisode }, view })
                } else {
                    // Если сезон не найден (странно), сбрасываем на обычный поиск
                    resolve(null) 
                }
            }).then(result => {
                if(result) return result
                // Если forward scan не сработал (например, сезон не найден), запускаем обычный
                return runBackwardScan()
            })
        }
    }

    function runBackwardScan() {
        let sIdx = seasons.length - 1
        let eNum = sIdx >= 0 ? (seasons[sIdx].episode_count || 0) : 0

        return new Promise((resolve, reject) => {
            const step = () => {
                if (controller.signal.aborted) return reject(new Error('Request aborted'))

                let processed = 0
                while (processed < SCAN_BATCH_SIZE && sIdx >= 0) {
                    if (eNum < 1) {
                        sIdx--
                        eNum = sIdx >= 0 ? (seasons[sIdx].episode_count || 0) : 0
                        continue
                    }
                    const seasonNum = seasons[sIdx].season_number
                    if (getPercent(seasonNum, eNum) > 0) {
                        const h = hashEpisode(original_title, seasonNum, eNum)
                        const v = Timeline.view(h)
                        
                        savePosition(seasonNum, eNum)

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

    return runBackwardScan()
}

/**
 * План просмотра для сериала
 * @param {Object} data - карточка сериала
 * @param {Object} [options={}] - опции
 * @param {string} [options.abortKey] - ключ для отмены запроса
 * @returns {Promise<Object|null>}
 */
function getPlanTv(data, options = {}){
    return new Promise(resolve => {
    // Если есть ключ отмены фокуса, отменяем старые операции по этому ключу
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
            const doScan = pendingRequests.get(pendingKey) || scanLastViewed(seasons, data.original_title, data.id, controller)
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
                // Читаем сводку прогресса один раз, чтобы не дёргать Timeline.view в цикле
                const viewedMap = Storage.cache(Timeline.filename(), CACHE_LIMIT_TIMELINE, {})
                const getPercent = (season, episode) => {
                    const h = hashEpisode(data.original_title, season, episode)
                    const v = viewedMap[h]
                    if(typeof v === 'object') return v.percent || 0
                    if(typeof v === 'number') return v || 0
                    return 0
                }

                // Сканируем сезоны по возрастанию до текущего
                for (let i = 0; i < seasons.length && missedList.length < DISPLAY_MAX_MISSED; i++) {
                    const seasonInfo = seasons[i]
                    const sNum = seasonInfo.season_number
                    // Для текущего сезона - только до текущего эпизода (не включая его)
                    const lastEpisodeToCheck = sNum === curSeason
                        ? Math.max(1, curEpisode - 1)
                        : (seasonInfo.episode_count || 0)

                    if (sNum > curSeason || lastEpisodeToCheck < 1) continue

                    for (let eNum = 1; eNum <= lastEpisodeToCheck && missedList.length < DISPLAY_MAX_MISSED; eNum++) {
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
 * @param {Object|null} data - карточка
 * @param {Object} [options={}] - опции
 * @param {string} [options.abortKey] - ключ для отмены запроса
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
 * Форматирует текст для отображения эпизода
 * @param {string} badge - Бейдж эпизода (например, "S1E5")
 * @param {string|null} episodeName - Название эпизода
 * @param {Object|null} episodeObj - Объект эпизода с air_date
 * @returns {{text: string}}
 */
function formatEpisodeText(badge, episodeName, episodeObj) {
    if (episodeObj && episodeObj.air_date) {
        const daysLeft = Utils.countDays(Date.now(), episodeObj.air_date)
        if (daysLeft > 0) {
            return { text: `${badge} / ${Lang.translate('full_episode_days_left')}: ${daysLeft}` }
        }
    }
    
    if (episodeName) {
        return { text: `${badge} - ${episodeName}` }
    }
    
    return { text: badge }
}

/**
 * Узел с планом просмотра для карточки
 * @param {Object|null} plan - план просмотра от getPlan
 * @param {Object} [opts={}] - опции рендеринга
 * @param {boolean} [opts.withTimeline=true] - показывать таймлайн
 * @param {boolean} [opts.fetchNames=true] - загружать названия эпизодов
 * @param {HTMLElement|null} [opts.mount=null] - контейнер для вставки
 * @param {string} [opts.position='prepend'] - позиция вставки ('prepend'|'append')
 * @param {string} [opts.abortKey] - ключ для отмены запросов
 * @returns {HTMLElement|null}
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

        // Синхронное чтение кэша
        const nameMap = new Map()
        const episodeMap = new Map()
        const seasonsToLoad = new Set()
        
        if(tvId){
            const seasonEpisodesCache = Storage.cache('season_episodes_cache', CACHE_LIMIT_SEASON_EPISODES, {})
            
            const processSeason = (seasonNum) => {
                if(!seasonNum) return
                const cacheKey = buildSeasonCacheKey(tvId, seasonNum)
                const cached = seasonEpisodesCache[cacheKey]
                
                if(cached && isCacheValid(cached, CACHE_TTL_EPISODES)){
                    cached.episodes.forEach(episode => {
                        const key = `${seasonNum}x${episode.episode_number}`
                        nameMap.set(key, episode.name)
                        episodeMap.set(key, episode)
                    })
                } else {
                    seasonsToLoad.add(seasonNum)
                }
            }

            primaryList.forEach(e => processSeason(e.season_number))
            missedList?.forEach(e => processSeason(e.season_number))
        }

        if(missedList?.length){
            const missedLabel = missedList.map(missedEpisode => `S${missedEpisode.season_number||0}E${missedEpisode.episode_number||0}`).join(', ')
            fragment.appendChild(createItem(Lang.translate('missed_episodes') + ': ' + missedLabel, ['card-watched__missed']))
        }

        const nodes = []
        primaryList.forEach((episodeItem, episodeIndex) => {
            const badge = `S${episodeItem.season_number||0}E${episodeItem.episode_number||0}`
            const isFirst = (episodeItem.season_number === (current?.season_number) && episodeItem.episode_number === (current?.episode_number)) && episodeIndex === 0
            
            // Генерируем текст сразу, если данные есть в кэше
            const key = `${episodeItem.season_number}x${episodeItem.episode_number}`
            const episodeName = nameMap.get(key)
            const episodeObj = episodeMap.get(key)
            
            const { text } = formatEpisodeText(badge, episodeName, episodeObj)

            const node = createItem(text, [], options.withTimeline && isFirst, isFirst ? view : null)
            nodes.push({ key, node, badge })
            fragment.appendChild(node)
        })

        if(lastOfAll){
            fragment.appendChild(createItem(Lang.translate('last_episode_now'), ['card-watched__final']))
        }

        body.appendChild(fragment)

        if(options.fetchNames && tvId && seasonsToLoad.size > 0){
            if(options.abortKey) {
                abortRequestsByPrefix(options.abortKey + '_names')
            }
            
            const seasonsArray = Array.from(seasonsToLoad)
            
            Promise.allSettled(seasonsArray.map(season => fetchSeasonFromCache(tvId, season, { abortKey: options.abortKey })))
                .then((results) => {
                    const newNameMap = new Map()
                    const newEpisodeMap = new Map()
                    
                    results.forEach((result, index) => {
                        if (result.status === 'fulfilled') {
                            const episodes = result.value || []
                            const seasonNumber = seasonsArray[index]
                            
                            episodes.forEach(episode => {
                                const key = `${seasonNumber}x${episode.episode_number}`
                                newNameMap.set(key, episode.name)
                                newEpisodeMap.set(key, episode)
                            })
                        }
                    })
                    
                    nodes.forEach(node => {
                        // Обновляем только если появились новые данные
                        const episodeName = newNameMap.get(node.key)
                        const episodeObj = newEpisodeMap.get(node.key)
                        
                        if(!episodeName && !episodeObj) return

                        const span = node.node.querySelector('span')
                        if(!span) return

                        const { text } = formatEpisodeText(node.badge, episodeName, episodeObj)
                        
                        span.innerText = text
                    })
                })
                .catch(() => {
                    // без изменений при ошибке
                })
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
 * @param {Object|null} data - карточка
 * @param {HTMLElement} mount - контейнер для вставки
 * @param {Object} [opts={}] - опции (передаются в render)
 * @returns {Promise<HTMLElement|null>}
 */
function attach(data, mount, opts = {}){
    return getPlan(data, { abortKey: opts.abortKey }).then(plan => {
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
    * @param {number} [maxAge=CACHE_TTL_CLEANUP]
     */
    cleanupOldCache(maxAge = CACHE_TTL_CLEANUP) {
        const now = Date.now()
        
        const seasonCache = Storage.cache('season_episodes_cache', CACHE_LIMIT_SEASON_EPISODES, {})
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
        
        const metaCache = Storage.cache('tv_meta_cache', CACHE_LIMIT_TV_META, {})
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

        const positionCache = Storage.cache('watched_position_cache', CACHE_LIMIT_WATCHED_POSITION, {})
        let positionChanged = false
        Object.keys(positionCache).forEach(key => {
            const item = positionCache[key]
            if (item && item.time && (now - item.time) > maxAge) {
                delete positionCache[key]
                positionChanged = true
            }
        })
        if (positionChanged) {
            Storage.set('watched_position_cache', positionCache)
        }
        
        abortAllRequests()
    }
}
