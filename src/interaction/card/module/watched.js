import Timeline from '../../timeline'
import Timetable from '../../../core/timetable'
import Api from '../../../core/api/api'
import Lang from '../../../core/lang'
import Storage from '../../../core/storage/storage'
import Utils from '../../../utils/utils'
import Template from '../../template'

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
        this.watched_gen = (this.watched_gen || 0) + 1
        this.watched_wait = false

        this.watched_wrap?.remove()

        this.html.classList.contains('focus') && this.emit('watched')
    },

    onWatched: function(){
        if(!Storage.field('card_episodes') || this.watched_wrap || this.watched_wait) return

        let data = this.data
        let self = this
        let gen  = this.watched_gen || 0

        let render = (episodes, current, more, finale)=>{
            if(gen != (self.watched_gen || 0)) return

            let index = episodes.findIndex(ep=>ep.episode_number == current.episode)
            let source = index >= 0 ? episodes.slice(index) : [{
                season_number: current.season,
                episode_number: current.episode,
                name: Lang.translate('full_episode') + ' ' + current.episode
            }]

            if(more && more.length) source = [source[0]].concat(more)

            let soon = []
            let next = source.filter(ep=>{
                if(!ep.air_date) return false

                if(Utils.countDays(Date.now(), ep.air_date)){
                    soon.push(ep)

                    return false
                }

                return true
            }).slice(0,3)

            if(!next.length) next = [source[0]]

            if(soon.length && next.length < 3 && !next.find(item=>item.episode_number == soon[0].episode_number)) next.push(soon[0])

            let note = ''

            if(finale && data.original_name){
                note = data.status == 'Ended' ? Lang.translate('tv_status_ended') : Lang.translate('card_episode_last')
            }

            let wrap = Template.js('card_watched',{})

            next.forEach(ep=>{
                let div  = document.createElement('div')
                let span = document.createElement('span')
                let days = ep.air_date ? Utils.countDays(Date.now(), ep.air_date) : 0
                let line = current.view && (ep.episode_number == current.episode || !ep.episode_number)

                div.addClass('card-watched__item')
                div.append(span)

                span.innerText = (ep.episode_number ? ep.episode_number + ' - ' : '') + (days > 0 ? Lang.translate('full_episode_days_left') + ': ' + days : (ep.name || Lang.translate('noname')))

                if(line){
                    div.append(Timeline.render(current.view)[0])

                    if(note){
                        let mark = document.createElement('div')

                        mark.addClass('card-watched__note')
                        mark.innerText = note
                        div.append(mark)
                    }
                }

                wrap.find('.card-watched__body').append(div)
            })

            if(self.watched_wrap) self.watched_wrap.remove()

            self.watched_wrap = wrap

            let view = self.html.find('.card__view')

            view.insertBefore(wrap, view.firstChild)
        }

        if(!data.original_name){
            let time = Timeline.watched(data, true)

            if(!time.percent && !(time.time > 0)) return

            render([{
                name: Lang.translate('title_viewed') + ' ' + (time.time ? Utils.secondsToTimeHuman(time.time) : time.percent + '%')
            }], {view: time})

            return
        }

        let record = Timetable.all().find(item=>item.id == data.id)
        let filed  = Storage.get('online_watched_last', '{}')[Utils.hash(data.original_name)]
        let total  = Math.max(data.number_of_seasons || 1, record && record.season || 1, filed && filed.season || 1)
        let found

        // В расписании только последний сезон, номер смотрим по уже записанному прогрессу
        for(let season = total; season >= 1 && !found; season--){
            let view
            let episode = 0

            for(let number = 1; number <= 100; number++){
                let time = Timeline.watchedEpisode(data, season, number, true)

                if(time.percent){
                    view = time
                    episode = number
                }
            }

            if(view) found = {season, episode, view}
        }

        if(!found) return

        this.watched_wait = true

        // Список серий режется в Api.seasons
        Api.seasons(data, [found.season], (result)=>{
            if(gen != (self.watched_gen || 0)) return

            self.watched_wait = false

            let episodes = (result[found.season] && result[found.season].episodes) || []
            let last = episodes.reduce((max, ep)=>Math.max(max, ep.episode_number || 0), 0)

            render(episodes, found)

            if(!(last && found.episode >= last)) return

            Api.seasons(data, [found.season + 1], (next)=>{
                if(gen != (self.watched_gen || 0)) return

                let more = (next[found.season + 1] && next[found.season + 1].episodes) || []

                render(episodes, found, more, !more.length)
            })
        })
    },

    onDestroy: function(){
        this.watched_gen = (this.watched_gen || 0) + 1
        this.watched_wait = false

        Lampa.Listener.remove('state:changed', this.listenerWatched)
    }
}
