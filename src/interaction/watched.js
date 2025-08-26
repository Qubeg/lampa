import Template from './template'
import Timeline from './timeline'
import Timetable from '../utils/timetable'
import TmdbApi from '../utils/api/tmdb'
import Lang from '../utils/lang'
import Utils from '../utils/math'
import Cache from '../utils/cache'

// Кэш эпизодов по сезонам, чтобы не дёргать API повторно
/** @type {Map<string, Array>} */
const seasonCache = new Map() // key: `${tvId}:${season}` -> episodes[]
const MAX_CACHE_SIZE = 100 // Максимальный размер кэша

/**
 * Добавляет данные в кэш с ограничением размера
 * @param {string} key - Ключ кэша
 * @param {Array} data - Данные для кэширования
 */
function addToSeasonCache(key, data) {
    // Если кэш переполнен - удаляем самые старые записи
    if (seasonCache.size >= MAX_CACHE_SIZE) {
        const firstKey = seasonCache.keys().next().value
        seasonCache.delete(firstKey)
    }
    seasonCache.set(key, data)
}

/**
 * Очищает кэш сезонов
 * @param {number|string} [tvId] - ID сериала для частичной очистки, если не указан - очищает весь кэш
 */
function clearCache(tvId = null) {
    if (tvId === null) {
        seasonCache.clear()
    } else {
        // Удаляем все записи для конкретного сериала
        for (const [cacheKey] of seasonCache) {
            if (cacheKey.startsWith(`${tvId}:`)) {
                seasonCache.delete(cacheKey)
            }
        }
    }
}

/**
 * Генерирует ключ для кэширования сезонов
 * @param {number|string} tvId - ID сериала
 * @param {number|string} season - Номер сезона
 * @returns {string} Ключ для кэша
 */
function buildCacheKey(tvId, season){
    return `${tvId}:${season}`
}

/**
 * Получает метаданные сериала
 * @param {Object} data - Данные сериала с id
 * @returns {Promise<Object|null>} Метаданные сериала или null
 */
function getShowMetaFromCache(data) {
    if (!data?.id) return Promise.resolve(null)
    
    // Сначала пробуем взять из кэша
    return Cache.getData('tv_meta', data.id).then(cached => {
        // Проверяем актуальность кэша (30 дней)
        const cacheAge = cached?.cached_at ? Date.now() - cached.cached_at : Infinity
        const maxAge = 30 * 24 * 60 * 60 * 1000 // 30 дней
        
        if (cached && cached.seasons && cacheAge < maxAge) {
            return cached
        }
        
        // Если нет в кэше или кэш устарел - запрашиваем из API и сохраняем
        return new Promise(resolve => {
            TmdbApi.get(`tv/${data.id}`, {}, (tvShowData) => {
                if (tvShowData) {
                    // Сохраняем в кэш только нужные данные
                    const metaToCache = {
                        id: tvShowData.id,
                        seasons: tvShowData.seasons,
                        cached_at: Date.now()
                    }
                    Cache.rewriteData('tv_meta', data.id, metaToCache).catch(() => {})
                    resolve(tvShowData)
                } else {
                    resolve(null)
                }
            }, () => resolve(null))
        })
    }).catch(() => {
        // Если ошибка чтения кэша - идем в API
        return new Promise(resolve => {
            TmdbApi.get(`tv/${data.id}`, {}, resolve, () => resolve(null))
        })
    })
}

/**
 * Получаем эпизоды сезона
 * @param {number|string} tvId - ID сериала в TMDB
 * @param {number|string} season - Номер сезона
 * @returns {Promise<Array>} Массив эпизодов сезона
 */
function fetchSeasonFromCache(tvId, season){
    const cacheKey = buildCacheKey(tvId, season)
    
    // Проверяем кэш в памяти
    if(seasonCache.has(cacheKey)) {
        return Promise.resolve(seasonCache.get(cacheKey))
    }

    // Пробуем получить из IndexedDB через Timetable
    return new Promise((resolve) => {
        Timetable.getSeasonEpisodes({id: parseInt(tvId)}, parseInt(season), (episodes) => {
            if (episodes && episodes.length > 0) {
                addToSeasonCache(cacheKey, episodes)
                resolve(episodes)
            } else {
                // Если нет в IndexedDB - идем в API
                TmdbApi.get(`tv/${tvId}/season/${season}`, {}, (result) => {
                    const episodes = (result?.episodes) || []
                    addToSeasonCache(cacheKey, episodes)
                    resolve(episodes)
                }, () => {
                    addToSeasonCache(cacheKey, [])
                    resolve([])
                })
            }
        })
    })
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
            // Собираем уникальные сезоны
            const seasonsToLoad = []
            const seasonsSet = new Set()
            
            primaryList.forEach(episodeData => {
                if(episodeData.season_number && !seasonsSet.has(episodeData.season_number)) {
                    seasonsSet.add(episodeData.season_number)
                    seasonsToLoad.push(episodeData.season_number)
                }
            })
            
            if(missedList?.length) {
                missedList.forEach(episodeData => {
                    if(episodeData.season_number && !seasonsSet.has(episodeData.season_number)) {
                        seasonsSet.add(episodeData.season_number)
                        seasonsToLoad.push(episodeData.season_number)
                    }
                })
            }
            
            if(seasonsToLoad.length){
                Promise.all(seasonsToLoad.map(season => fetchSeasonFromCache(tvId, season))).then(()=>{
                    // Карта названий и сами объекты эпизодов
                    const nameMap = new Map()
                    const episodeMap = new Map()
                    seasonsToLoad.forEach(seasonNumber => {
                        const episodes = seasonCache.get(buildCacheKey(tvId, seasonNumber)) || []
                        episodes.forEach(episode => {
                            const key = `${seasonNumber}x${episode.episode_number}`
                            nameMap.set(key, episode.name)
                            episodeMap.set(key, episode)
                        })
                    })
                    nodes.forEach(node => {
                        const episodeName = nameMap.get(node.key)
                        const episodeObj  = episodeMap.get(node.key)
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

                        futureText ? span.innerText = `${node.badge} / ${futureText}`
                            : span.innerText = episodeName ? `${node.badge} - ${episodeName}` : `${node.badge}`

                    })
                }).catch(() => {
                    // Если не удалось загрузить названия эпизодов - игнорируем
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
    fetchSeasonFromCache
}
