import Timeline from '../../timeline'
import Timetable from '../../../core/timetable'
import Api from '../../../core/api/api'
import Lang from '../../../core/lang'
import Storage from '../../../core/storage/storage'
import Utils from '../../../utils/utils'
import Template from '../../template'

// Сколько строк помещается в блок на карточке
const LIMIT = 3

// Выше этого номера в таймлайне попадаются только мусорные отметки со сквозной нумерацией серий
const MAX_EPISODE = 100

/**
 * Найти последнюю просмотренную серию: самую позднюю по номеру сезона и серии
 * @param {object} data - данные сериала
 * @return {{season:number, episode:number}|undefined}
 */
function lastEpisode(data){
    // number_of_seasons у сохраненной карточки устаревает, а расписание обновляет число сезонов само
    let record = Timetable.all().find(item=>item.id == data.id)
    let total  = Math.max(data.number_of_seasons || 1, record ? record.season : 0)

    // Таймлайн хранит только хеши серий, поэтому ищем перебором с конца
    for(let season = total; season > 0; season--){
        for(let episode = MAX_EPISODE; episode > 0; episode--){
            if(Timeline.watchedEpisode(data, season, episode)) return {season, episode}
        }
    }
}

/**
 * Показать блок серий на карточке
 * @param {object} card - карточка
 * @param {array} items - серии, первая из них текущая
 * @param {object} view - прогресс текущей серии
 * @param {string} [note] - подпись под прогрессом
 */
function draw(card, items, view, note){
    let wrap = Template.js('card_watched', {})
    let body = wrap.find('.card-watched__body')
    let box  = card.html.find('.card__view')

    items.forEach((ep, i)=>{
        let days = ep.air_date && Utils.countDays(Date.now(), ep.air_date)
        let name = days ? Lang.translate('full_episode_days_left') + ': ' + days : ep.name || Lang.translate('noname')
        let item = Template.elem('div', {class: 'card-watched__item', children: Template.elem('span', {
            text: (ep.episode_number ? 'S' + ep.season_number + ' / E' + ep.episode_number + ' - ' : '') + name
        })})

        if(!i){
            item.append(Timeline.render(view)[0])

            if(note) item.append(Template.elem('div', {class: 'card-watched__note', text: note}))
        }

        body.append(item)
    })

    card.watched_wrap = wrap

    box.insertBefore(wrap, box.firstChild)
}

export default {
    onCreate: function(){
        let timer

        this.html.on('hover:focus hover:touch hover:hover', ()=>{
            clearTimeout(timer)

            timer = setTimeout(()=>{
                this.html.classList.contains('focus') && this.emit('watched')
            },500)
        })

        this.listenerWatched = (e)=>{
            if((e.target == 'timeline' && e.reason == 'read') || (e.target == 'timetable' && e.id == this.data.id)) this.emit('update')
        }

        Lampa.Listener.follow('state:changed', this.listenerWatched)
    },

    onUpdate: function(){
        this.watched_wrap?.remove()

        this.watched_wrap = null
        this.watched_call = null

        this.html.classList.contains('focus') && this.emit('watched')
    },

    onWatched: function(){
        if(!Storage.field('card_episodes') || this.watched_wrap || this.watched_call) return

        let data = this.data

        if(!data.original_name){
            let time = Timeline.watched(data, true)

            if(time.percent) draw(this, [{name: Lang.translate('title_viewed') + ' ' + (time.time ? Utils.secondsToTimeHuman(time.time) : time.percent + '%')}], time)

            return
        }

        let last = lastEpisode(data)

        if(!last) return

        let {season, episode} = last

        // Ответ, пришедший после обновления или удаления карточки, не рисуем
        let call = this.watched_call = {}

        let show = (list)=>{
            this.watched_call = null

            if(!list.length) return

            let current = list[0]
            let rest    = list.slice(1)
            let aired   = rest.filter(ep=>ep.air_date && !Utils.countDays(Date.now(), ep.air_date))
            let soon    = rest.find(ep=>ep.air_date && Utils.countDays(Date.now(), ep.air_date)) || []
            let note    = rest.length ? '' : Lang.translate(data.status == 'Ended' ? 'tv_status_ended' : 'card_episode_last')

            draw(this, [current].concat(aired, soon).slice(0, LIMIT), Timeline.watchedEpisode(data, current.season_number, current.episode_number, true), note)
        }

        // Api.seasons сам разбивает слитый 1-й сезон на настоящие
        Api.seasons(data, [season], (result)=>{
            if(this.watched_call !== call) return

            let episodes = result[season]?.episodes || []
            let index    = episodes.findIndex(ep=>ep.episode_number == episode)
            let list     = index < 0 ? [] : episodes.slice(index)

            if(list.length != 1) return show(list)

            // Досмотрена последняя серия сезона, продолжение ищем в следующем
            Api.seasons(data, [season + 1], (next)=>{
                if(this.watched_call !== call) return

                show(list.concat(next[season + 1]?.episodes || []))
            })
        })
    },

    onDestroy: function(){
        this.watched_call = null

        Lampa.Listener.remove('state:changed', this.listenerWatched)
    }
}
