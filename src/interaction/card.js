import Template from './template'
import Api from './api'
import Arrays from '../utils/arrays'
import Select from './select'
import Favorite from '../utils/favorite'
import Controller from './controller'
import Storage from '../utils/storage'
import Utils from '../utils/math'
import Timetable from '../utils/timetable'
import Timeline from './timeline'
import Lang from '../utils/lang'
import Tmdb from '../utils/tmdb'
import Manifest from '../utils/manifest'
import Search from '../components/search'
import Loading from './loading'
import TmdbApi from '../utils/api/tmdb'
import ImageCache from '../utils/cache/images'
import Account from '../utils/account'

/**
 * Карточка
 * @param {object} data
 * @param {{isparser:boolean, card_small:boolean, card_category:boolean, card_collection:boolean, card_wide:true}} params 
 */
function Card(data, params = {}){
    this.data   = data
    this.params = params

    Arrays.extend(data,{
        title: data.name,
        original_title: data.original_name,
        release_date: data.first_air_date 
    })

    data.release_year = ((data.release_date || data.birthday || '0000') + '').slice(0,4)

    function remove(elem){
        if(elem) elem.remove()
    }

    /**
     * Загрузить шаблон
     */
    this.build = function(){
        this.card    = Template.js(params.isparser ? 'card_parser' : 'card',data)
        this.img     = this.card.querySelector('.card__img') || {}

        this.card.card_data = data

        if(params.isparser){
            let elem_title   = this.card.querySelector('.card-parser__title')
            let elem_size    = this.card.querySelector('.card-parser__size')
            let elem_details = this.card.querySelector('.card-parser__details')
        
            if(elem_title) elem_title.innerText = data.Title
            if(elem_size) elem_size.innerText = data.size

            let seeds = document.createElement('div')
            let grabs = document.createElement('div')

            elem_details.innerHTML = ''

            seeds.innerHTML = Lang.translate('torrent_item_seeds') + ': <span>' + data.Seeders + '</span>'
            grabs.innerHTML = Lang.translate('torrent_item_grabs') + ': <span>' + data.Peers + '</span>'

            elem_details.appendChild(seeds)
            elem_details.appendChild(grabs) 
        }
        else{
            let elem_title = this.card.querySelector('.card__title')
            
            if(elem_title) elem_title.innerText = data.title

            if(data.original_name){
                let type_elem = document.createElement('div')
                    type_elem.classList.add('card__type')
                    type_elem.innerText = data.original_name ? 'TV' : 'MOV'

                this.card.querySelector('.card__view').appendChild(type_elem)
                this.card.classList.add(data.original_name ? 'card--tv' : 'card--movie')
            }

            // Отображение источника для агрегированных результатов
            if(data.source_name && data.source_name !== 'unknown'){
                let source_elem = document.createElement('div')
                    source_elem.classList.add('card__source')
                    source_elem.innerText = data.source_name
                    source_elem.title = `Источник: ${data.source_name}`

                // Если есть тип карточки, размещаем источник под ним
                if(data.original_name){
                    source_elem.classList.add('card__source--with-type')
                }

                this.card.querySelector('.card__view').appendChild(source_elem)
            }
            
            
            if(params.card_small){
                this.card.classList.add('card--small')

                remove(this.card.querySelector('.card__title'))
                remove(this.card.querySelector('.card__age'))
            }

            if(params.card_category){
                this.card.classList.add('card--category')
            }

            if(params.card_explorer){
                this.card.classList.add('card--explorer')
            }

            if(params.card_collection){
                this.card.classList.add('card--collection')

                remove(this.card.querySelector('.card__age'))
            }

            if(params.card_wide){
                this.card.classList.add('card--wide')

                data.poster = data.cover

                if(data.promo || data.promo_title){
                    let promo_wrap = document.createElement('div')
                        promo_wrap.classList.add('card__promo')

                    if(data.promo_title){
                        let promo_title = document.createElement('div')
                            promo_title.classList.add('card__promo-title')
                            promo_title.innerText = data.promo_title

                        promo_wrap.appendChild(promo_title)
                    }

                    if(data.promo){
                        let promo_text = document.createElement('div')
                            promo_text.classList.add('card__promo-text')
                            promo_text.innerText = data.promo.slice(0,110) + (data.promo.length > 110 ? '...' : '')

                        promo_wrap.appendChild(promo_text)
                    }
                    
                    this.card.querySelector('.card__view').appendChild(promo_wrap)
                } 

                if(Storage.field('light_version')) remove(this.card.querySelector('.card__title'))

                remove(this.card.querySelector('.card__age'))
            }

            if(data.release_year == '0000'){
                remove(this.card.querySelector('.card__age'))
            }
            else{
                let year = this.card.querySelector('.card__age')

                if(year) year.innerText = data.release_year
            }

            
            let vote = parseFloat((data.cub_hundred_rating || data.vote_average || 0) + '').toFixed(1)

            if(vote > 0){
                let vote_elem = document.createElement('div')
                    vote_elem.classList.add('card__vote')
                    vote_elem.innerText = data.cub_hundred_fire ? Utils.bigNumberToShort(data.cub_hundred_fire) : vote >= 10 ? 10 : vote

                this.card.querySelector('.card__view').appendChild(vote_elem)
            }

            let qu = data.quality || data.release_quality

            if(qu && Storage.field('card_quality') && !data.original_name){
                let quality = document.createElement('div')
                    quality.classList.add('card__quality')
                
                let quality_inner = document.createElement('div')
                    quality_inner.innerText = qu

                    quality.appendChild(quality_inner)

                this.card.querySelector('.card__view').appendChild(quality)
            }
        }

        this.card.addEventListener('visible',this.visible.bind(this))
        this.card.addEventListener('update',this.update.bind(this))
    }
    
    /**
     * Загрузить картинку
     */
    this.image = function(){
        if(params.isparser) return

        this.img.onload = ()=>{
            this.card.classList.add('card--loaded')

            ImageCache.write(this.img, this.img.src)
        }
    
        this.img.onerror = ()=>{
            Tmdb.broken()

            console.log('Img','noload', this.img.src)

            this.img.src = './img/img_broken.svg'
        }
    }

    /**
     * Добавить иконку
     * @param {string} name 
     */
    this.addicon = function(name){
        let icon = document.createElement('div')
            icon.classList.add('card__icon')
            icon.classList.add('icon--'+name)
        
        this.card.querySelector('.card__icons-inner').appendChild(icon)
    }

    /**
     * Обносить состояние карточки
     */
    this.update = function(){
        if(params.isparser) return

        this.watched_checked = false

        if(this.watched_wrap) remove(this.watched_wrap)

        this.favorite()

        if(this.card.classList.contains('focus')) this.watched()
    }

    /**
     * Какие серии просмотрено
     */
    this.watched = function(){
        if(!Storage.field('card_episodes') || this.watched_checked) return

        const keyOf = Timeline.episodeKey
        
        const getCurrentData = () => {
            if(!data.original_name) {
                // Для фильмов
                let time = Timeline.view(Utils.hash(data.original_title))
                return time.percent ? {
                    current: { name: Lang.translate('title_viewed') + ' ' + (time.time ? Utils.secondsToTimeHuman(time.time) : time.percent + '%') },
                    view: time,
                    primaryList: [],
                    missedList: [],
                    seasons: [],
                    lastOfAll: false
                } : null
            }

            // Для сериалов: минимальные данные
            return new Promise(resolve => {
                Timetable.getShowMeta(data, tv => {
                    const seasons = (tv?.seasons || [])
                        .filter(s => (s.season_number||0) > 0)
                        .map(s => ({ season_number: s.season_number, episode_count: s.episode_count || 0 }))
                        .sort((a,b) => a.season_number - b.season_number)

                    const bySeason = (sn) => seasons.find(s => s.season_number === sn)
                    const lastSeasonNum = seasons.length ? seasons[seasons.length-1].season_number : 1

                    const last = Storage.get('online_watched_last', '{}')
                    const filed = last[Utils.hash(data.original_title)]

                    // Попытка найти последний реально просмотренный эпизод без перечисления всех эпизодов
                    const findLastViewed = () => {
                        for(let i = seasons.length - 1; i >= 0; i--){
                            const s = seasons[i]
                            const count = s.episode_count || 0
                            for(let e = count; e >= 1; e--){
                                const h = Utils.hash([s.season_number, s.season_number > 10 ? ':' : '', e, data.original_title].join(''))
                                const v = Timeline.view(h)
                                if(v.percent > 0){
                                    return { current: { season_number: s.season_number, episode_number: e }, view: v }
                                }
                            }
                        }
                        return null
                    }

                    let found = findLastViewed()
                    if(!found && filed?.episode){
                        const h = Utils.hash([filed.season, filed.season > 10 ? ':' : '', filed.episode, data.original_title].join(''))
                        found = { current: { season_number: filed.season, episode_number: filed.episode }, view: Timeline.view(h) }
                    }

                    if(!found){
                        // Ничего не просмотрено — ничего не отображаем
                        resolve(null)
                        return
                    }

                    let { current, view } = found
                    let curSeason  = current.season_number
                    let curEpisode = current.episode_number

                    // Найти первый пропуск до текущего эпизода в этом сезоне и отдать максимум 3
                    const missedList = []
                    if(curEpisode > 1){
                        let gapStart = null
                        for(let e = 1; e < curEpisode; e++){
                            const h = Utils.hash([curSeason, curSeason > 10 ? ':' : '', e, data.original_title].join(''))
                            const v = Timeline.view(h)
                            if(v.percent === 0){
                                if(gapStart === null) gapStart = e
                            } else if(gapStart !== null){
                                break
                            }
                        }
                        if(gapStart !== null){
                            for(let e = gapStart; e < curEpisode && missedList.length < 3; e++){
                                const h = Utils.hash([curSeason, curSeason > 10 ? ':' : '', e, data.original_title].join(''))
                                if(Timeline.view(h).percent === 0) missedList.push({ season_number: curSeason, episode_number: e })
                                else break
                            }
                        }
                    }

                    // Список для отображения: текущий + 2 следующих (переход через сезон, если надо)
                    const primaryList = [{ season_number: curSeason, episode_number: curEpisode }]
                    let s = curSeason
                    let e = curEpisode + 1
                    while(primaryList.length < 3){
                        const info = bySeason(s)
                        const count = info ? (info.episode_count || 0) : 0
                        if(e <= count && e > 0){
                            primaryList.push({ season_number: s, episode_number: e })
                            e++
                        } else {
                            const nextSeason = seasons.find(x => x.season_number > s)
                            if(nextSeason){
                                s = nextSeason.season_number
                                e = 1
                            } else {
                                break
                            }
                        }
                    }

                    const lastInfo = bySeason(lastSeasonNum) || { episode_count: 0 }
                    const lastOfAll = curSeason === lastSeasonNum && curEpisode >= (lastInfo.episode_count || 0)

                    resolve({ current, view, primaryList, missedList, seasons, lastOfAll })
                })
            })
        }

        const createItem = (text, classes = [], showTimeline = false, timeline = null) => {
            const div = document.createElement('div')
            div.classList.add('card-watched__item', ...classes)
            
            const span = document.createElement('span')
            span.innerText = text
            div.appendChild(span)
            
            if(showTimeline && timeline) {
                div.appendChild(Timeline.render(timeline)[0])
            }
            
            return div
        }

        const renderWatched = (plan) => {
            if(!plan) return

            if(data.original_name) {
                const { current, view, primaryList, missedList, lastOfAll } = plan

                // Сезоны, которые нужно загрузить для названий (только те, что используем)
                const seasonsToLoad = [...new Set([...
                    primaryList.map(ep => ep.season_number),
                    ...missedList.map(ep => ep.season_number)
                ].filter(Boolean))]

                this._seasonCache = this._seasonCache || {}
                const needLoad = seasonsToLoad.filter(s => !this._seasonCache[s])

                const renderWithNames = (episodeNames = new Map()) => {
                    const wrap = Template.js('card_watched', {})
                    const body = wrap.querySelector('.card-watched__body')

                    if(missedList.length) {
                        const missedLabel = missedList.map(m => `S${m.season_number||0}E${m.episode_number||0}`).join(', ')
                        body.appendChild(createItem(Lang.translate('missed_episodes') + ': ' + missedLabel, ['card-watched__missed']))
                    }

                    primaryList.forEach((ep, i) => {
                        const badge = `S${ep.season_number||0}E${ep.episode_number||0}`
                        const episodeName = episodeNames.get(`${ep.season_number}x${ep.episode_number}`) || badge
                        const isFirst = (ep.season_number === current.season_number && ep.episode_number === current.episode_number) && i === 0
                        body.appendChild(createItem(badge + ' - ' + episodeName, [], isFirst, isFirst ? view : null))
                    })

                    if(lastOfAll) {
                        body.appendChild(createItem(Lang.translate('last_episode_now'), ['card-watched__final']))
                    }

                    this.watched_wrap = wrap
                    this.card.querySelector('.card__view').insertBefore(wrap, this.card.querySelector('.card__view').firstChild)
                }

                if(needLoad.length) {
                    let loaded = 0
                    needLoad.forEach(season => {
                        TmdbApi.get(`tv/${data.id}/season/${season}`, {}, (result) => {
                            this._seasonCache[season] = result?.episodes || []
                            loaded++
                            if(loaded === needLoad.length) {
                                const nameMap = new Map()
                                seasonsToLoad.forEach(s => {
                                    (this._seasonCache[s] || []).forEach(ep => {
                                        nameMap.set(`${s}x${ep.episode_number}`, ep.name)
                                    })
                                })
                                renderWithNames(nameMap)
                            }
                        }, () => {
                            this._seasonCache[season] = []
                            loaded++
                            if(loaded === needLoad.length) renderWithNames()
                        })
                    })
                } else {
                    const nameMap = new Map()
                    seasonsToLoad.forEach(s => {
                        (this._seasonCache[s] || []).forEach(ep => {
                            nameMap.set(`${s}x${ep.episode_number}`, ep.name)
                        })
                    })
                    renderWithNames(nameMap)
                }
            } else {
                // Фильм
                const wrap = Template.js('card_watched', {})
                const body = wrap.querySelector('.card-watched__body')
                body.appendChild(createItem(plan.current.name, [], true, plan.view))
                this.watched_wrap = wrap
                this.card.querySelector('.card__view').insertBefore(wrap, this.card.querySelector('.card__view').firstChild)
            }
        }

        const result = getCurrentData()
        
        if(result instanceof Promise) {
            result.then(renderWatched)
        } else {
            renderWatched(result)
        }

        this.watched_checked = true
    }

    /**
     * Обновить иконки на закладки
     */
    this.favorite = function(){
        let status = Favorite.check(data)
        let marker = this.card.querySelector('.card__marker')
        let marks  = ['look', 'viewed', 'scheduled', 'continued', 'thrown']

        this.card.querySelector('.card__icons-inner').innerHTML = ''

        if(status.book) this.addicon('book')
        if(status.like) this.addicon('like')
        if(status.wath) this.addicon('wath')
        if(status.history || Timeline.watched(data)) this.addicon('history')

        let any_marker = marks.find(m=>status[m])

        if(any_marker){
            if(!marker){
                marker = document.createElement('div')
                marker.addClass('card__marker')
                marker.append(document.createElement('span'))

                this.card.querySelector('.card__view').append(marker)
            }

            marker.find('span').text(Lang.translate('title_' + any_marker))
            marker.removeClass(marks.map(m=>'card__marker--' + m).join(' ')).addClass('card__marker--' + any_marker)
        }
        else if(marker) marker.remove()
    }

    /**
     * Вызвали меню
     * @param {object} target 
     * @param {object} data 
     */
    this.onMenu = function(target, data){
        let enabled = Controller.enabled().name
        let status  = Favorite.check(data)

        let menu_plugins = []
        let menu_favorite = [
            {
                title: Lang.translate('title_book'),
                where: 'book',
                checkbox: true,
                checked: status.book,
            },
            {
                title:  Lang.translate('title_like'),
                where: 'like',
                checkbox: true,
                checked: status.like
            },
            {
                title: Lang.translate('title_wath'),
                where: 'wath',
                checkbox: true,
                checked: status.wath
            },
            {
                title: Lang.translate('menu_history'),
                where: 'history',
                checkbox: true,
                checked: status.history
            },
            {
                title: Lang.translate('settings_cub_status'),
                separator: true
            }
        ]

        let marks = ['look', 'viewed', 'scheduled', 'continued', 'thrown']

        marks.forEach(m=>{
            menu_favorite.push({
                title: Lang.translate('title_'+m),
                where: m,
                picked: status[m],
                collect: true,
                noenter: !Account.hasPremium()
            })
        })

        
        Manifest.plugins.forEach(plugin=>{
            if(plugin.type == 'video' && plugin.onContextMenu && plugin.onContextLauch){
                menu_plugins.push({
                    title: plugin.name,
                    subtitle: plugin.subtitle || plugin.description,
                    onSelect: ()=>{
                        if(document.body.classList.contains('search--open')) Search.close()

                        if(!data.imdb_id && data.source == 'tmdb'){
                            Loading.start(()=>{
                                Loading.stop()

                                Controller.toggle(enabled)
                            })

                            TmdbApi.external_imdb_id({
                                type: data.name ? 'tv' : 'movie',
                                id: data.id
                            },(imdb_id)=>{
                                Loading.stop()

                                data.imdb_id = imdb_id

                                plugin.onContextLauch(data)
                            })
                        }
                        else plugin.onContextLauch(data)
                    }
                })
            }
        })

        if(menu_plugins.length) menu_plugins.push({
            title: Lang.translate('more'),
            separator: true
        })
        

        let menu_main = menu_plugins.length ? menu_plugins.concat(menu_favorite) : menu_favorite

        if(this.onMenuShow) this.onMenuShow(menu_main, this.card, data)

        Select.show({
            title: Lang.translate('title_action'),
            items: menu_main,
            onBack: ()=>{
                Controller.toggle(enabled)
            },
            onCheck: (a)=>{
                if(params.object) data.source = params.object.source

                if(a.where){
                    Favorite.toggle(a.where, data)

                    this.favorite()
                }
            },
            onSelect: (a)=>{
                if(params.object) data.source = params.object.source

                if(a.collect){
                    Favorite.toggle(a.where, data)

                    this.favorite()
                }

                if(this.onMenuSelect) this.onMenuSelect(a, this.card, data)

                Controller.toggle(enabled)
            },
            onDraw: (item, elem)=>{
                if(elem.collect){
                    if(!Account.hasPremium()){
                        let wrap = $('<div class="selectbox-item__lock"></div>')
                            wrap.append(Template.js('icon_lock'))

                        item.find('.selectbox-item__checkbox').remove()

                        item.append(wrap)

                        item.on('hover:enter',()=>{
                            Select.close()

                            Account.showCubPremium()
                        })
                    }
                }
            }
        })
    }

    /**
     * Создать
     */
    this.create = function(){
        this.build()

        this.card.addEventListener('hover:focus',()=>{
            this.watched()

            if(this.onFocus) this.onFocus(this.card, data)
        })

        this.card.addEventListener('hover:touch',()=>{
            this.watched()

            if(this.onTouch) this.onTouch(this.card, data)
        })
        
        this.card.addEventListener('hover:hover',()=>{
            this.watched()

            if(this.onHover) this.onHover(this.card, data)
        })

        this.card.addEventListener('hover:enter',()=>{
            if(this.onEnter) this.onEnter(this.card, data)
        })
        
        this.card.addEventListener('hover:long',()=>{
            if(this.onMenu) this.onMenu(this.card, data)
        })

        this.image()
    }

    /**
     * Загружать картинку если видна карточка
     */
    this.visible = function(){
        let src = ''

        if(params.card_wide && data.backdrop_path) src = Api.img(data.backdrop_path, 'w780')
        else if(params.card_collection && data.backdrop_path) src = Api.img(data.backdrop_path, 'w500')
        else if(data.poster_path)  src = Api.img(data.poster_path)
        else if(data.profile_path) src = Api.img(data.profile_path)
        else if(data.poster)       src = data.poster
        else if(data.img)          src = data.img
        else                       src = './img/img_broken.svg'

        ImageCache.read(this.img, src)

        this.update()

        if(this.onVisible) this.onVisible(this.card, data)
    }

    /**
     * Уничтожить
     */
    this.destroy = function(){
        this.img.onerror = ()=>{}
        this.img.onload = ()=>{}

        this.img.src = ''

        remove(this.card)

        this.card = null

        this.img = null
    }

    /**
     * Рендер
     * @returns {object}
     */
    this.render = function(js){
        return js ? this.card : $(this.card)
    }
}

export default Card