import Api from '../../interaction/api'
import Lang from '../lang'
import Arrays from '../arrays'
import Status from '../status'

/**
 * Агрегированный поиск по всем доступным источникам
 * @module AggregatedSource
 */
const aggregated_source = {
    title: () => Lang.translate('search_aggregated_all_sources'),
    
    /**
     * Кэш для качественных оценок элементов
     * @private
     */
    _qualityCache: new Map(),
    
    /**
     * Максимальный размер кэша качества
     * @private
     */
    _maxCacheSize: 1000,
    
    /**
     * Выполняет поиск по всем доступным источникам
     * @param {Object} params - Параметры поиска
     * @param {Function} callback - Колбэк с результатами
     */
    search: function(params, callback) {
        // Валидация входных параметров
        if (!params || typeof callback !== 'function') {
            console.error('Aggregated search: Invalid parameters')
            if (typeof callback === 'function') callback([])
            return
        }

        const sources = this._getSearchSources()
        
        if (sources.length === 0) {
            callback([])
            return
        }

        const status = new Status(sources.length)
        status.onComplite = (responses) => {
            const all_results = this._extractResults(responses, sources)
            callback(this._processResults(all_results))
        }
        
        // Поиск по всем источникам
        sources.forEach((source, index) => {
            try {
                source.search(params, 
                    (data) => status.append(`source_${index}`, { source, data: data || [] }),
                    () => {
                        console.log('Aggregated search: source error', source.title)
                        status.append(`source_${index}`, { source, data: [] })
                    }
                )
            } catch (e) {
                console.log('Aggregated search: source exception', source.title, e)
                status.append(`source_${index}`, { source, data: [] })
            }
        })
    },
    
    /**
     * Получает список источников для поиска
     * @private
     * @returns {Array} Список источников
     */
    _getSearchSources: function() {
        return Api.availableDiscovery().filter(source => 
            source.title !== Lang.translate('search_aggregated_all_sources') && 
            source.search && 
            typeof source.search === 'function'
        )
    },
    
    /**
     * Извлекает результаты из ответов источников
     * @private
     * @param {Object} responses - Ответы от источников
     * @param {Array} sources - Список источников
     * @returns {Array} Извлеченные результаты
     */
    _extractResults: function(responses, sources) {
        const results = []
        
        Object.keys(responses).forEach(key => {
            const response = responses[key]
            if (!response || !Arrays.isArray(response.data) || response.data.length === 0) return
            
            response.data.forEach(section => {
                if (!section.results || !Arrays.isArray(section.results)) return
                
                const enrichedSection = {
                    ...section,
                    source_title: response.source.title,
                    source_object: response.source,
                    results: section.results.map(item => {
                        // Проверяем валидность элемента
                        if (!item || typeof item !== 'object') return null
                        
                        return {
                            ...item,
                            source_name: response.source.title,
                            source_object: response.source
                        }
                    }).filter(Boolean) // Удаляем null элементы
                }
                
                // Добавляем секцию только если есть валидные результаты
                if (enrichedSection.results.length > 0) {
                    results.push(enrichedSection)
                }
            })
        })
        
        return results
    },
    
    /**
     * Обрабатывает результаты поиска: дедупликация, группировка, сортировка
     * @param {Array} results - Массив результатов от разных источников
     * @returns {Array} Обработанные и сгруппированные результаты
     */
    _processResults: function(results) {
        if (!Arrays.isArray(results) || results.length === 0) return []
        
        // Собираем все элементы и источники
        const all_items = []
        const all_sources = new Set()
        
        results.forEach(section => {
            if (!section || !section.source_title) return
            
            all_sources.add(section.source_title)
            
            if (!Arrays.isArray(section.results)) return
            
            section.results.forEach(item => {
                if (!item || typeof item !== 'object') return
                
                all_items.push({
                    ...item,
                    source_name: section.source_title,
                    available_sources: [section.source_title],
                    source: this._getSourceId(section.source_object),
                    source_object: section.source_object
                })
            })
        })

        if (all_items.length === 0) return []

        const unique_items = this._deduplicateItems(all_items)
        const grouped_items = this._groupByContentType(unique_items)
        
        return this._formatFinalResults(grouped_items, all_sources)
    },
    
    /**
     * Получает ID источника из объекта источника
     * @private
     * @param {Object} sourceObject - Объект источника
     * @returns {string} ID источника
     */
    _getSourceId: function(sourceObject) {
        if (sourceObject?.params?.object?.source) {
            return sourceObject.params.object.source
        }
        
        if (sourceObject?.title) {
            return sourceObject.title.toLowerCase()
                .replace(/[^a-zA-Z0-9]/g, '')
                .slice(0, 10) || 'unknown'
        }
        
        return 'unknown'
    },
    
    /**
     * Оценивает качество карточки с использованием кэша
     * @private
     * @param {Object} item - Элемент для оценки
     * @returns {number} Оценка качества
     */
    _calculateQuality: function(item) {
        const cacheKey = `${item.id || ''}_${item.title || item.name || ''}`
        
        if (this._qualityCache.has(cacheKey)) {
            return this._qualityCache.get(cacheKey)
        }
        
        // Проверяем размер кэша и очищаем старые записи
        if (this._qualityCache.size >= this._maxCacheSize) {
            const keysToDelete = Array.from(this._qualityCache.keys()).slice(0, Math.floor(this._maxCacheSize / 2))
            keysToDelete.forEach(key => this._qualityCache.delete(key))
        }
        
        let score = 0
        
        // Базовые поля
        if (item.title || item.name) score += 10
        if (item.original_title || item.original_name) score += 5
        if (item.poster_path) score += 10
        if (item.backdrop_path) score += 5
        if (item.release_date || item.first_air_date) score += 8
        
        // Рейтинги и популярность
        if (item.vote_average) score += 5
        if (item.vote_count) score += Math.min(item.vote_count / 100, 10)
        if (item.popularity) score += Math.min(item.popularity / 10, 5)
        
        // Описание
        if (item.overview) score += Math.min(item.overview.length / 10, 15)
        
        // Дополнительные поля
        if (item.genres?.length) score += item.genres.length * 2
        if (item.runtime || item.episode_run_time) score += 5
        if (item.number_of_seasons) score += 5
        if (item.number_of_episodes) score += 3
        
        this._qualityCache.set(cacheKey, score)
        return score
    },
    
    /**
     * Проверяет схожесть двух элементов
     * @private
     * @param {Object} item1 - Первый элемент
     * @param {Object} item2 - Второй элемент
     * @returns {boolean} true если элементы схожи
     */
    _areItemsSimilar: function(item1, item2) {
        if (item1.id && item2.id && item1.id === item2.id) return true
        
        const cleanTitle = str => str.replace(/[\[\](){}]/g, '').replace(/\s+/g, ' ').trim()
        
        const title1 = cleanTitle((item1.title || item1.name || '').toLowerCase())
        const title2 = cleanTitle((item2.title || item2.name || '').toLowerCase())
        const orig1 = cleanTitle((item1.original_title || item1.original_name || '').toLowerCase())
        const orig2 = cleanTitle((item2.original_title || item2.original_name || '').toLowerCase())

        if (title1 && title2 && title1 === title2) {
            const year1 = this._extractYear(item1)
            const year2 = this._extractYear(item2)
            
            return year1 && year2 ? Math.abs(year1 - year2) <= 1 : true
        }

        return (orig1 && orig2 && orig1 === orig2) ||
               (title1 && orig2 && title1 === orig2) ||
               (title2 && orig1 && title2 === orig1)
    },
    
    /**
     * Извлекает год из элемента
     * @private
     * @param {Object} item - Элемент
     * @returns {number|null} Год или null
     */
    _extractYear: function(item) {
        const dateString = item.release_date || item.first_air_date
        if (!dateString) return null
        
        try {
            return new Date(dateString).getFullYear()
        } catch (e) {
            // Попробуем извлечь год из строки как число
            const yearMatch = dateString.match(/(\d{4})/)
            return yearMatch ? parseInt(yearMatch[1], 10) : null
        }
    },
    
    /**
     * Клонирование объекта
     * @private
     * @param {Object} obj - Объект для клонирования
     * @returns {Object} Клонированный объект
     */
    _safeClone: function(obj) {
        try {
            return JSON.parse(JSON.stringify(obj))
        } catch (e) {
            console.warn('Aggregated: Clone failed, using shallow copy', e)
            return { ...obj }
        }
    },
    
    /**
     * Убирает дубликаты из массива элементов
     * @private
     * @param {Array} items - Массив элементов
     * @returns {Array} Массив уникальных элементов
     */
    _deduplicateItems: function(items) {
        const unique_items = []
        
        // Предварительно вычисляем качество для всех элементов
        const processed_items = items.map(item => ({
            ...item,
            quality_score: this._calculateQuality(item)
        }))
        
        // Группируем по возможным дубликатам
        processed_items.forEach(item => {
            const existing_index = unique_items.findIndex(existing => 
                this._areItemsSimilar(existing, item)
            )
            
            if (existing_index === -1) {
                // Новый уникальный элемент
                unique_items.push({
                    ...item,
                    available_sources: [item.source_name]
                })
            } else {
                const existing = unique_items[existing_index]
                
                // Добавляем источник если его еще нет
                if (!existing.available_sources.includes(item.source_name)) {
                    existing.available_sources.push(item.source_name)
                }
                
                // Заменяем на более качественный элемент
                if (item.quality_score > existing.quality_score) {
                    unique_items[existing_index] = {
                        ...item,
                        available_sources: existing.available_sources
                    }
                }
            }
        })
        
        return unique_items
    },
    
    /**
     * Группирует элементы по типу контента используя Arrays.groupBy
     * @private
     * @param {Array} items - Массив элементов
     * @returns {Object} Объект с группированными элементами
     */
    _groupByContentType: function(items) {
        const items_with_type = items.map(item => ({
            ...item,
            content_type: this._getContentType(item)
        }))

        const grouped = Arrays.groupBy(items_with_type, 'content_type')
        const sortByQuality = (a, b) => (b.quality_score || 0) - (a.quality_score || 0)
        
        return {
            movies: (grouped.movie || []).sort(sortByQuality),
            series: (grouped.series || []).sort(sortByQuality),
            mixed: (grouped.mixed || []).sort(sortByQuality)
        }
    },
    
    /**
     * Определяет тип контента
     * @private
     * @param {Object} item - Элемент
     * @returns {string} Тип контента
     */
    _getContentType: function(item) {
        const isMovie = (item.title && !item.name) || 
                       (item.release_date && !item.first_air_date) ||
                       (!item.number_of_seasons && !item.episode_run_time && !item.name)
        
        const isSeries = item.name || item.first_air_date || 
                        item.number_of_seasons || item.episode_run_time || 
                        item.original_name
        
        if (isSeries) return 'series'
        if (isMovie) return 'movie'
        return 'mixed'
    },
    
    /**
     * Форматирует финальные результаты
     * @private
     * @param {Object} grouped_items - Группированные элементы
     * @param {Set} all_sources - Множество всех источников
     * @returns {Array} Финальные результаты
     */
    _formatFinalResults: function(grouped_items, all_sources) {
        const { movies, series, mixed } = grouped_items
        const final_results = []
        const sources_text = Array.from(all_sources).join(', ')
        const formatItems = (items) => items.map(item => {
            const result = this._safeClone(item)
            
            // Удаляем служебные поля
            delete result.quality_score
            delete result.content_type
            
            // Устанавливаем источник если не задан
            if (!result.source) {
                result.source = this._getSourceId(result.source_object) || 'unknown'
            }

            if (result.source_object) {
                result.source_object = {
                    full: result.source_object.full,
                    title: result.source_object.title,
                    params: result.source_object.params
                }
            }
            
            return result
        })
        
        // Добавляем секции с результатами
        const sections = [
            { items: movies, key: 'search_aggregated_movies' },
            { items: series, key: 'search_aggregated_series' },
            { items: mixed, key: 'search_aggregated_mixed' }
        ]
        
        sections.forEach(({ items, key }) => {
            if (items.length > 0) {
                final_results.push({
                    title: `${Lang.translate(key)} (${items.length}) — ${Lang.translate('search_aggregated_from_source')}: ${sources_text}`,
                    results: formatItems(items),
                    noimage: true,
                    total_pages: 1,
                    page: 1
                })
            }
        })
        
        return final_results
    },
    
    /**
     * Получение полной информации о карточке
     * @param {Object} params - Параметры запроса
     * @param {Function} oncomplite - Колбэк успеха
     * @param {Function} onerror - Колбэк ошибки
     */
    full: function(params, oncomplite, onerror) {
        if (params.source_object && params.source_object.full) {
            try {
                params.source_object.full(params, oncomplite, onerror)
            } catch (e) {
                console.log('Aggregated full: source_object error', e)
                this._fallbackToFirstSource(params, oncomplite, onerror)
            }
        } else {
            this._fallbackToFirstSource(params, oncomplite, onerror)
        }
    },
    
    /**
     * Fallback к первому доступному источнику
     * @private
     * @param {Object} params - Параметры запроса
     * @param {Function} oncomplite - Колбэк успеха
     * @param {Function} onerror - Колбэк ошибки
     */
    _fallbackToFirstSource: function(params, oncomplite, onerror) {
        const sources = this._getSearchSources().filter(source => 
            source.full && typeof source.full === 'function'
        )
        
        if (sources.length > 0) {
            try {
                sources[0].full(params, oncomplite, onerror)
            } catch (e) {
                console.log('Aggregated full: fallback error', e)
                onerror && onerror()
            }
        } else {
            console.log('Aggregated full: no sources available')
            onerror && onerror()
        }
    },
    
    /**
     * Очистка ресурсов
     */
    clear: function() {
        this._qualityCache.clear()
    },

    /**
     * Возвращает объект discovery для регистрации источника
     * @returns {Object} Объект discovery
     */
    discovery: function() {
        return {
            title: this.title(),
            search: this.search.bind(this),
            full: this.full.bind(this),
            clear: this.clear.bind(this),
            params: {
                card_view: 6,
                nofound: 'search_nofound',
                start_typing: 'search_start_typing',
                align_left: true,
                object: {
                    source: 'aggregated'
                }
            },
            onMore: (params) => {
                const section_data = params.data
                if (section_data && section_data.results && section_data.results.length > 0) {
                    const first_item = section_data.results[0]
                    
                    // Получаем источник по source_name или source
                    const source_name = first_item.source_name || first_item.source
                    const original_source = this._findOriginalSource(source_name)
                    
                    if (original_source && original_source.onMore) {
                        original_source.onMore({
                            ...params,
                            data: {
                                ...section_data,
                                type: this._getDataTypeFromSection(section_data)
                            }
                        })
                        return
                    }
                }

                this._fallbackMore(params, section_data)
            },
            onCancel: () => {
                // Отменяем все активные поиски в источниках
                const sources = this._getSearchSources()
                sources.forEach(source => {
                    if (source.onCancel) {
                        try {
                            source.onCancel()
                        } catch (e) {
                            console.log('Aggregated cancel error for source', source.title, e)
                        }
                    }
                })
            }
        }
    },
    
    /**
     * Находит оригинальный источник по названию
     * @private
     * @param {string} source_name - Название источника
     * @returns {Object|null} Оригинальный discovery объект
     */
    _findOriginalSource: function(source_name) {
        const sources = this._getSearchSources()
        return sources.find(source => 
            source.title === source_name || 
            this._getSourceId(source) === source_name
        ) || null
    },

    /**
     * Fallback для кнопки "Еще"
     * @private
     * @param {Object} params - Параметры
     * @param {Object} section_data - Данные секции
     */
    _fallbackMore: function(params, section_data) {
        const sources = this._getSearchSources()
        const available_source = sources.find(source => source.onMore)
        
        if (available_source && available_source.onMore) {
            available_source.onMore({
                ...params,
                data: {
                    ...section_data,
                    type: this._getDataTypeFromSection(section_data)
                }
            })
        } else {
            console.log('Aggregated onMore: no sources with onMore available')
        }
    },
    
    /**
     * Определяет тип данных из секции для onMore
     * @private
     * @param {Object} section_data - Данные секции
     * @returns {string} Тип данных
     */
    _getDataTypeFromSection: function(section_data) {
        if (!section_data || !section_data.title) return 'mixed'
        
        const title = section_data.title.toLowerCase()
        
        try {
            const moviesText = Lang.translate('search_aggregated_movies')
            const seriesText = Lang.translate('search_aggregated_series')
            
            if (moviesText && title.includes(moviesText.toLowerCase())) {
                return 'movie'
            }
            if (seriesText && title.includes(seriesText.toLowerCase())) {
                return 'tv'
            }
        } catch (e) {
            console.warn('Aggregated: Error translating text for data type detection', e)
        }
        
        return 'mixed'
    }
}

export default aggregated_source
