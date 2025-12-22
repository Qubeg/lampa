import Watched from '../../watched'
import Storage from '../../../core/storage/storage'

export default {
    onCreate: function(){
        let timer

        this.html.on('hover:focus hover:touch hover:hover', ()=>{
            clearTimeout(timer)

            timer = setTimeout(()=>{
                this.html.hasClass('focus') && this.emit('watched')
            },500)
        })

        this.listenerWatched = (e)=>{
            if((e.target == 'timeline' && e.reason == 'read') || (e.target == 'timetable' && e.id == this.data.id)) this.emit('update')
        }

        Lampa.Listener.follow('state:changed', this.listenerWatched)
    },

    onUpdate: function(){
        this.watched_checked = false

        if(this.watched_wrap) this.watched_wrap.remove()
        
        if(this.watched_abort_key) {
            Watched.abortRequestsByPrefix(this.watched_abort_key)
        }

        this.html.hasClass('focus') && this.emit('watched')
    },

    onWatched: function(){
        if(!Storage.field('card_episodes')) return
        
        if(!this.watched_checked){
            // Отменяем предыдущие запросы для карточки
            if(this.watched_abort_key) {
                Watched.abortRequestsByPrefix(this.watched_abort_key)
            }
            
            // Создаем уникальный ключ для карточки
            this.watched_abort_key = `card_${this.data?.id || 'unknown'}_${Date.now()}`

            const mount = this.html.find('.card__view')
            if(this.watched_wrap) this.watched_wrap.remove()

            Watched.getPlan(this.data, { abortKey: this.watched_abort_key }).then(plan => {
                if(!plan) return
                this.watched_wrap = Watched.render(plan, { 
                    mount, 
                    position: 'prepend', 
                    withTimeline: true, 
                    fetchNames: true,
                    abortKey: this.watched_abort_key
                })
            })

            this.watched_checked = true
        }
    },

    onDestroy: function(){
        if(this.watched_abort_key) {
            Watched.abortRequestsByPrefix(this.watched_abort_key)
        }
        Lampa.Listener.remove('state:changed', this.listenerWatched)
    }
}