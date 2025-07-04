
import Api from '../../interaction/api'
import Lang from '../lang'

/**
 * Агрегированный поиск по всем доступным источникам
 * @module AggregatedSource
 */
const aggregated_source = {
    title: () => Lang.translate('search_aggregated_all_sources'),
    
    /**
     * Выполняет поиск по всем доступным источникам
     * @param {Object} params - Параметры поиска
     * @param {Function} callback - Колбэк с результатами
     */
    search: function(params, callback) {
        const sources = Api.availableDiscovery().filter(source => 
            source.title !== Lang.translate('search_aggregated_all_sources') && 
            source.search && 
            typeof source.search === 'function'
        )
        
        if (sources.length === 0) {
            callback([])
            return
        }
        
        // Используем Promise.all для управления асинхронными запросами
        const searchPromises = sources.map(source => 
            new Promise((resolve) => {
                try {
                    source.search(params, 
                        (data) => resolve({ source, data: data || [] }),
                        () => resolve({ source, data: [] })
                    )
                } catch (e) {
                    resolve({ source, data: [] })
                }
            })
        )
        
        Promise.all(searchPromises).then(responses => {
            const all_results = responses
                .filter(({ data }) => Array.isArray(data) && data.length > 0)
                .flatMap(({ source, data }) => 
                    data.map(section => ({
                        ...section,
                        source_title: source.title,
                        source_object: source,
                        results: (section.results || []).map(item => ({
                            ...item,
                            source_name: source.title,
                            source_object: source
                        }))
                    }))
                )
            
            callback(this.processResults(all_results))
        })
    },
    
    /**
     * Обрабатывает результаты поиска: дедупликация, группировка, сортировка
     * @param {Array} results - Массив результатов от разных источников
     * @returns {Array} Обработанные и сгруппированные результаты
     */
    processResults: function(results) {
        if (results.length === 0) return []
        
        const all_items = []
        const all_sources = new Set()
        
        // Собираем все элементы
        results.forEach(section => {
            if (!section.results || !Array.isArray(section.results)) return
            
            if (section.source_title) {
                all_sources.add(section.source_title)
            }
            
            section.results.forEach(item => {
                if (!item) return
                
                all_items.push({
                    ...item,
                    source_name: section.source_title,
                    available_sources: [section.source_title],
                    source: this.getSourceId(section.source_object),
                    source_object: section.source_object
                })
            })
        })
        
        const unique_items = this.deduplicateItems(all_items)
        const { movies, series, mixed } = this.groupByContentType(unique_items)
        
        return this.formatFinalResults(movies, series, mixed, all_sources)
    },
    
    /**
     * Получает ID источника из объекта источника
     * @param {Object} sourceObject - Объект источника
     * @returns {string} ID источника
     */
    getSourceId: function(sourceObject) {
        if (sourceObject?.params?.object?.source) {
            return sourceObject.params.object.source
        }
        
        if (sourceObject?.title) {
            const title = sourceObject.title.toLowerCase()
            if (title.includes('tmdb')) return 'tmdb'
            if (title.includes('cub')) return 'cub'
            
            return sourceObject.title.toLowerCase()
                .replace(/[^a-zA-Z0-9]/g, '')
                .slice(0, 10) || 'unknown'
        }
        
        return 'tmdb'
    },
    
    /**
     * Оценивает качество карточки
     * @param {Object} item - Элемент для оценки
     * @returns {number} Оценка качества
     */
    calculateQuality: function(item) {
        let score = 0
        
        if (item.title || item.name) score += 10
        if (item.original_title || item.original_name) score += 5
        if (item.overview) score += Math.min(item.overview.length / 10, 15)
        if (item.poster_path) score += 10
        if (item.backdrop_path) score += 5
        if (item.release_date || item.first_air_date) score += 8
        if (item.vote_average) score += 5
        if (item.vote_count) score += Math.min(item.vote_count / 100, 10)
        if (item.popularity) score += Math.min(item.popularity / 10, 5)
        if (item.genres?.length) score += item.genres.length * 2
        if (item.runtime || item.episode_run_time) score += 5
        if (item.number_of_seasons) score += 5
        if (item.number_of_episodes) score += 3
        
        return score
    },
    
    /**
     * Проверяет схожесть двух элементов
     * @param {Object} item1 - Первый элемент
     * @param {Object} item2 - Второй элемент
     * @returns {boolean} true если элементы схожи
     */
    areItemsSimilar: function(item1, item2) {
        if (item1.id && item2.id && item1.id === item2.id) return true
        
        const cleanTitle = str => str.replace(/[\[\](){}]/g, '').replace(/\s+/g, ' ').trim()
        
        const title1 = cleanTitle((item1.title || item1.name || '').toLowerCase())
        const title2 = cleanTitle((item2.title || item2.name || '').toLowerCase())
        const orig1 = cleanTitle((item1.original_title || item1.original_name || '').toLowerCase())
        const orig2 = cleanTitle((item2.original_title || item2.original_name || '').toLowerCase())
        
        if (title1 && title2 && title1 === title2) {
            const year1 = item1.release_date ? new Date(item1.release_date).getFullYear() : 
                         item1.first_air_date ? new Date(item1.first_air_date).getFullYear() : null
            const year2 = item2.release_date ? new Date(item2.release_date).getFullYear() : 
                         item2.first_air_date ? new Date(item2.first_air_date).getFullYear() : null
            
            return year1 && year2 ? Math.abs(year1 - year2) <= 1 : true
        }
        
        return (orig1 && orig2 && orig1 === orig2) ||
               (title1 && orig2 && title1 === orig2) ||
               (title2 && orig1 && title2 === orig1)
    },
    
    /**
     * Убирает дубликаты из массива элементов
     * @param {Array} items - Массив элементов
     * @returns {Array} Массив уникальных элементов
     */
    deduplicateItems: function(items) {
        const unique_items = []
        
        items.forEach(item => {
            const existing_index = unique_items.findIndex(existing => 
                this.areItemsSimilar(existing, item)
            )
            
            if (existing_index === -1) {
                unique_items.push({
                    ...item,
                    quality_score: this.calculateQuality(item)
                })
            } else {
                const existing = unique_items[existing_index]
                const item_quality = this.calculateQuality(item)
                
                if (!existing.available_sources.includes(item.source_name)) {
                    existing.available_sources.push(item.source_name)
                }
                
                if (item_quality > (existing.quality_score || 0)) {
                    const sources_backup = existing.available_sources
                    unique_items[existing_index] = {
                        ...item,
                        available_sources: sources_backup,
                        quality_score: item_quality,
                        source: item.source,
                        source_object: item.source_object
                    }
                }
            }
        })
        
        return unique_items
    },
    
    /**
     * Группирует элементы по типу контента
     * @param {Array} items - Массив элементов
     * @returns {Object} Объект с группированными элементами
     */
    groupByContentType: function(items) {
        const movies = []
        const series = []
        const mixed = []
        
        items.forEach(item => {
            const isMovie = (item.title && !item.name) || 
                           (item.release_date && !item.first_air_date) ||
                           (!item.number_of_seasons && !item.episode_run_time && !item.name)
            
            const isSeries = item.name || item.first_air_date || 
                           item.number_of_seasons || item.episode_run_time || 
                           item.original_name
            
            if (isSeries) {
                series.push(item)
            } else if (isMovie) {
                movies.push(item)
            } else {
                mixed.push(item)
            }
        })
        
        // Сортируем по качеству
        const sortByQuality = (a, b) => (b.quality_score || 0) - (a.quality_score || 0)
        
        return {
            movies: movies.sort(sortByQuality),
            series: series.sort(sortByQuality),
            mixed: mixed.sort(sortByQuality)
        }
    },
    
    /**
     * Форматирует финальные результаты
     * @param {Array} movies - Массив фильмов
     * @param {Array} series - Массив сериалов
     * @param {Array} mixed - Массив смешанного контента
     * @param {Set} all_sources - Множество всех источников
     * @returns {Array} Финальные результаты
     */
    formatFinalResults: function(movies, series, mixed, all_sources) {
        const final_results = []
        const sources_text = Array.from(all_sources).join(', ')
        
        const formatItems = (items) => items.map(item => {
            const result = { ...item }
            delete result.quality_score
            
            if (result.available_sources?.length > 1) {
                const title = result.title || result.name

                if (result.name) {
                    result.name = title
                }
            }
            
            if (!result.source) {
                result.source = this.getSourceId(result.source_object) || 'tmdb'
            }
            
            return result
        })
        
        if (movies.length > 0) {
            final_results.push({
                title: `${Lang.translate('search_aggregated_movies')} (${movies.length}) — ${Lang.translate('search_aggregated_from_source')}: ${sources_text}`,
                results: formatItems(movies),
                noimage: true
            })
        }
        
        if (series.length > 0) {
            final_results.push({
                title: `${Lang.translate('search_aggregated_series')} (${series.length}) — ${Lang.translate('search_aggregated_from_source')}: ${sources_text}`,
                results: formatItems(series),
                noimage: true
            })
        }
        
        if (mixed.length > 0) {
            final_results.push({
                title: `${Lang.translate('search_aggregated_mixed')} (${mixed.length}) — ${Lang.translate('search_aggregated_from_source')}: ${sources_text}`,
                results: formatItems(mixed),
                noimage: true
            })
        }
        
        return final_results
    },
    
    /**
     * Возвращает объект discovery для регистрации источника
     * @returns {Object} Объект discovery
     */
    discovery: function() {
        return {
            title: this.title(),
            search: this.search.bind(this),
            params: {
                card_view: 6,
                nofound: 'search_nofound',
                start_typing: 'search_start_typing'
            }
        }
    }
}

export default aggregated_source
