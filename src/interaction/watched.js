import Template from './template'
import Timeline from './timeline'
import Timetable from '../utils/timetable'
import TmdbApi from '../utils/api/tmdb'
import Lang from '../utils/lang'
import Utils from '../utils/math'
import Cache from '../utils/cache'
import Storage from '../utils/storage'

// Кэш для избежания множественных одновременных запросов к API
const pendingRequests = new Map()

// Контроллеры для отмены запросов
const abortControllers = new Map()

/**
 * Отменяет все активные запросы
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
 * Отменяет запросы по префиксу ключа
 * @param {string} keyPrefix - Префикс ключа для отмены
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
 * Генерирует ключ для кэширования сезонов в Storage
 * @param {number|string} tvId - ID сериала
 * @param {number|string} season - Номер сезона
 * @returns {string} Ключ для кэша
 */
function buildSeasonCacheKey(tvId, season){
    return `season_episodes_${tvId}_${season}`
}

/**
 * Сохраняет данные эпизодов в кэш
 * @param {string} cacheKey - Ключ кэша
 * @param {Array} episodes - Массив эпизодов
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
        // Игнорируем ошибки записи в кэш
    }
}

/**
 * Проверяет актуальность кэша
 * @param {Object} cached - Кэшированные данные
 * @param {number} maxAge - Максимальный возраст кэша в миллисекундах
 * @returns {boolean} true если кэш актуален
 */
function isCacheValid(cached, maxAge) {
    if (!cached || !cached.cached_at) return false
    const cacheAge = Date.now() - cached.cached_at
    return cacheAge < maxAge
}

/**
 * Очищает кэш сезонов из Storage
 * @param {number|string} [tvId] - ID сериала для частичной очистки, если не указан - очищает весь кэш
 */
function clearCache(tvId = null) {
    const seasonEpisodesCache = Storage.cache('season_episodes_cache', 1000, {})
    
    if (tvId === null) {
        // Очищаем все кэши сезонов
        Object.keys(seasonEpisodesCache).forEach(key => {
            if (key.startsWith('season_episodes_')) {
                delete seasonEpisodesCache[key]
            }
        })
    } else {
        // Удаляем все записи для конкретного сериала
        Object.keys(seasonEpisodesCache).forEach(key => {
            if (key.startsWith(`season_episodes_${tvId}_`)) {
                delete seasonEpisodesCache[key]
            }
        })
    }
    
    Storage.set('season_episodes_cache', seasonEpisodesCache)
    
    // Очищаем также кэш метаданных сериалов
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
 * Получает метаданные сериала из кэша
 * @param {Object} data - Данные сериала с id
 * @returns {Promise<Object|null>} Метаданные сериала или null
 */
function getShowMetaFromCache(data) {
    if (!data?.id) return Promise.resolve(null)
    
    const cacheKey = `tv_meta_${data.id}`
    const requestKey = `meta_${data.id}`
    
    // Предотвращаем множественные запросы к одному и тому же сериалу
    if (pendingRequests.has(requestKey)) {
        return pendingRequests.get(requestKey)
    }
    
    // Создаем AbortController для возможности отмены запроса
    const abortController = new AbortController()
    abortControllers.set(requestKey, abortController)
    
    const promise = (async () => {
        try {
            // Проверяем не отменен ли запрос
            if (abortController.signal.aborted) {
                throw new Error('Request aborted')
            }
            
            // Используем кэширование Storage.cache для быстрого доступа
            const metaCache = Storage.cache('tv_meta_cache', 500, {})
            
            // Проверяем кэш в Storage (localStorage)
            if (metaCache[cacheKey] && isCacheValid(metaCache[cacheKey], 30 * 24 * 60 * 60 * 1000)) {
                return metaCache[cacheKey]
            }
            
            // Проверяем IndexedDB
            const cached = await Cache.getData('tv_meta', data.id).catch(() => null)
            if (cached && isCacheValid(cached, 30 * 24 * 60 * 60 * 1000)) {
                // Сохраняем в Storage для быстрого доступа
                metaCache[cacheKey] = cached
                Storage.set('tv_meta_cache', metaCache)
                return cached
            }
            
            // Проверяем снова не отменен ли запрос перед API вызовом
            if (abortController.signal.aborted) {
                throw new Error('Request aborted')
            }
            
            // Запрашиваем из API с поддержкой отмены
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
                
                // Сохраняем в IndexedDB для долгосрочного хранения
                Cache.rewriteData('tv_meta', data.id, metaToCache).catch(() => {})
                
                // Сохраняем в Storage для быстрого доступа
                metaCache[cacheKey] = metaToCache
                Storage.set('tv_meta_cache', metaCache)
                
                return tvShowData
            }
            
            return null
        } catch (error) {
            if (error.message === 'Request aborted') {
                throw error // Пробрасываем ошибку отмены
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
 * Получает эпизоды сезона из кэша или API
 * @param {number|string} tvId - ID сериала в TMDB
 * @param {number|string} season - Номер сезона
 * @returns {Promise<Array>} Массив эпизодов сезона
 */
function fetchSeasonFromCache(tvId, season){
    const cacheKey = buildSeasonCacheKey(tvId, season)
    const requestKey = `season_${tvId}_${season}`
    
    // Предотвращаем множественные запросы к одному и тому же сезону
    if (pendingRequests.has(requestKey)) {
        return pendingRequests.get(requestKey)
    }
    
    // Создаем AbortController для возможности отмены запроса
    const abortController = new AbortController()
    abortControllers.set(requestKey, abortController)
    
    const promise = (async () => {
        try {
            // Проверяем не отменен ли запрос
            if (abortController.signal.aborted) {
                throw new Error('Request aborted')
            }
            
            // Проверяем кэш в Storage (localStorage) для быстрого доступа
            const seasonEpisodesCache = Storage.cache('season_episodes_cache', 1000, {})
            if (seasonEpisodesCache[cacheKey] && isCacheValid(seasonEpisodesCache[cacheKey], 24 * 60 * 60 * 1000)) {
                return seasonEpisodesCache[cacheKey].episodes
            }

            // Пробуем получить из IndexedDB через Timetable (долгосрочное хранение)
            const episodes = await new Promise((resolve, reject) => {
                const onAbort = () => reject(new Error('Request aborted'))
                abortController.signal.addEventListener('abort', onAbort)
                
                Timetable.getSeasonEpisodes({id: parseInt(tvId)}, parseInt(season), (result) => {
                    abortController.signal.removeEventListener('abort', onAbort)
                    resolve(result)
                })
            })
            
            if (episodes && episodes.length > 0) {
                // Сохраняем в Storage для быстрого доступа
                saveEpisodesToCache(cacheKey, episodes)
                return episodes
            }
            
            // Проверяем снова не отменен ли запрос перед API вызовом
            if (abortController.signal.aborted) {
                throw new Error('Request aborted')
            }
            
            // Если нет в IndexedDB - идем в API с поддержкой отмены
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
            
            // Сохраняем результат (даже если пустой) чтобы не запрашивать повторно
            saveEpisodesToCache(cacheKey, apiEpisodes)
            
            return apiEpisodes
            
        } catch (error) {
            if (error.message === 'Request aborted') {
                throw error // Пробрасываем ошибку отмены
            }
            // В случае ошибки сохраняем пустой результат
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
 * Генерирует хэш для эпизода на основе названия, сезона и эпизода
 * @param {string} original_title - Оригинальное название сериала
 * @param {number} season - Номер сезона
 * @param {number} episode - Номер эпизода
 * @returns {string} Хэш для идентификации эпизода
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
 * Получает план просмотра для фильма
 * @param {Object} data - Данные фильма
 * @param {string} data.original_title - Оригинальное название фильма
 * @returns {Object|null} План просмотра или null, если фильм не просматривался
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
 * Получает план просмотра для сериала
 * @param {Object} data - Данные сериала
 * @param {string} data.original_title - Оригинальное название сериала
 * @param {number} data.id - ID сериала в TMDB
 * @returns {Promise<Object|null>} План просмотра или null
 */
function getPlanTv(data){
    return new Promise(resolve => {
        getShowMetaFromCache(data).then(tvShowData => {
            const seasons = (tvShowData?.seasons || [])
                .filter(season => (season.season_number||0) > 0)
                .map(season => ({ season_number: season.season_number, episode_count: season.episode_count || 0 }))
                .sort((seasonA, seasonB) => seasonA.season_number - seasonB.season_number)

            if(!seasons.length){
                resolve(null)
                return
            }

            const findSeasonByNumber = (seasonNumber) => seasons.find(season => season.season_number === seasonNumber)
            const lastSeasonNum = seasons[seasons.length-1].season_number
            
            // Создаём индекс сезонов для поиска следующего сезона
            const seasonIndex = new Map()
            seasons.forEach((season, index) => {
                seasonIndex.set(season.season_number, index)
            })
            
            const getNextSeason = (currentSeasonNum) => {
                const currentIndex = seasonIndex.get(currentSeasonNum)
                if (currentIndex !== undefined && currentIndex < seasons.length - 1) {
                    return seasons[currentIndex + 1]
                }
                return null
            }

            /**
             * Поиск последнего просмотренного эпизода
             * Начинает поиск с последнего сезона и идёт назад
             * @returns {Object|null} Объект с данными последнего просмотренного эпизода
             */
            const findLastViewed = () => {
                // Начинаем с последнего сезона и идём назад
                for(let seasonIndex = seasons.length - 1; seasonIndex >= 0; seasonIndex--){
                    const currentSeason = seasons[seasonIndex]
                    const episodeCount = currentSeason.episode_count || 0
                    if(episodeCount === 0) continue // пропускаем пустые сезоны
                    
                    // В сезоне ищем с конца первый просмотренный эпизод
                    for(let episodeNum = episodeCount; episodeNum >= 1; episodeNum--){
                        const episodeView = Timeline.view(hashEpisode(data.original_title, currentSeason.season_number, episodeNum))
                        if(episodeView.percent > 0){
                            return { current: { season_number: currentSeason.season_number, episode_number: episodeNum }, view: episodeView }
                        }
                    }
                }
                return null
            }

            const found = findLastViewed()

            if(!found){
                resolve(null)
                return
            }

            const { current, view } = found
            const curSeason  = current.season_number
            const curEpisode = current.episode_number

            // Поиск пропущенных эпизодов: непрерывный блок перед текущим, максимум 3
            const missedList = []
            
            // Ищем пропущенные эпизоды в текущем сезоне
            if(curEpisode > 1){
                let gapStart = null
                for(let episodeNum = 1; episodeNum < curEpisode; episodeNum++){
                    const episodeHash = hashEpisode(data.original_title, curSeason, episodeNum)
                    const episodeView = Timeline.view(episodeHash)
                    if(episodeView.percent === 0){
                        if(gapStart === null) gapStart = episodeNum
                    } else if(gapStart !== null){
                        break // Прерываем, если нашли просмотренный эпизод после пропуска
                    }
                }
                if(gapStart !== null){
                    for(let episodeNum = gapStart; episodeNum < curEpisode && missedList.length < 3; episodeNum++){
                        const episodeHash = hashEpisode(data.original_title, curSeason, episodeNum)
                        const episodeView = Timeline.view(episodeHash)
                        if(episodeView.percent === 0){
                            missedList.push({ season_number: curSeason, episode_number: episodeNum })
                        } else break
                    }
                }
            }

            // Основной список: текущий + до двух следующих (с переходом на следующий сезон)
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
        })
    })
}

/**
 * Построить план просмотра (фильм/сериал)
 * @param {Object|null} data - Данные фильма или сериала
 * @param {string} [data.original_title] - Оригинальное название фильма
 * @param {string} [data.original_name] - Оригинальное название сериала
 * @param {number} [data.id] - ID в TMDB
 * @returns {Promise<Object|null>} План просмотра или null, если нет данных или не просматривался
 */
function getPlan(data){
    if(!data) return Promise.resolve(null)
    if(data.original_name){
        return getPlanTv(data)
    }
    return Promise.resolve(getPlanMovie(data))
}

/**
 * Создает DOM-элемент для отображения информации о просмотре
 * @param {string} text - Текст для отображения
 * @param {Array<string>} [classes=[]] - Дополнительные CSS классы
 * @param {boolean} [showTimeline=false] - Показывать ли таймлайн
 * @param {Object|null} [timeline=null] - Данные таймлайна
 * @returns {HTMLElement} DOM-элемент
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
 * Отрисовывает узел для плана просмотра
 * @param {Object|null} plan - План просмотра
 * @param {Object} [opts={}] - Опции рендеринга
 * @param {boolean} [opts.withTimeline=true] - Показывать таймлайн
 * @param {boolean} [opts.fetchNames=true] - Загружать названия эпизодов
 * @param {HTMLElement} [opts.mount=null] - Контейнер для вставки
 * @param {string} [opts.position='prepend'] - Позиция вставки ('prepend' или 'append')
 * @returns {HTMLElement|null} DOM-элемент или null
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

        // Показываем пропущенные эпизоды, если есть
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

        // Показываем, если это последний эпизод
        if(lastOfAll){
            fragment.appendChild(createItem(Lang.translate('last_episode_now'), ['card-watched__final']))
        }

        // Добавляем весь фрагмент за один раз
        body.appendChild(fragment)

        if(options.fetchNames && tvId){
            // Отменяем предыдущие запросы названий для этого ключа
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
                // Используем Promise.allSettled для лучшей обработки ошибок
                Promise.allSettled(seasonsToLoad.map(season => fetchSeasonFromCache(tvId, season)))
                    .then((results) => {
                        // Карта названий эпизодов
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
                        
                        // Обновляем названия эпизодов
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
                        // Игнорируем ошибки загрузки названий эпизодов
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
 * Высокоуровневая функция: получает план и отрисовывает в контейнер
 * @param {Object|null} data - Данные фильма или сериала
 * @param {HTMLElement} mount - Контейнер для вставки
 * @param {Object} [opts={}] - Опции рендеринга
 * @returns {Promise<HTMLElement|null>} Созданный DOM-элемент или null
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
    
    // Новые методы для управления запросами
    abortAllRequests,
    abortRequestsByPrefix,
    
    /**
     * Очищает устаревшие данные из кэша
     * @param {number} [maxAge=7*24*60*60*1000] - Максимальный возраст кэша в миллисекундах (по умолчанию 7 дней)
     */
    cleanupOldCache(maxAge = 7 * 24 * 60 * 60 * 1000) {
        const now = Date.now()
        
        // Очищаем старые эпизоды
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
        
        // Очищаем старые метаданные
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
        
        // Очищаем активные запросы
        abortAllRequests()
    }
}
