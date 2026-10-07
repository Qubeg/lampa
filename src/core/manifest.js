let object = {
    author: 'Yumata',
    github: 'https://github.com/yumata/lampa-source',
    css_version: '3.3.4',
    app_version: '3.3.5',
    cub_site: 'cub.best',
    apk_link_download: 'https://github.com/lampa-app/LAMPA/releases/download/v1.12.3/app-lite-release.apk'
}

let plugins = []

Object.defineProperty(object, 'app_digital', { get: ()=> parseInt(object.app_version.replace(/\./g,'')) })
Object.defineProperty(object, 'css_digital', { get: ()=> parseInt(object.css_version.replace(/\./g,'')) })

/**
 * Список подключенных плагинов
 */
Object.defineProperty(object, 'plugins', { 
    get: ()=> plugins,
    set: (plugin)=> {
        if(typeof plugin == 'object' && typeof plugin.type == 'string'){
            plugins.push(plugin)
        }
    }
})

/**
 * Ссылка на GitHub с файлами приложения
 */
Object.defineProperty(object, 'github_lampa', { 
    get: ()=> window.lampa_settings.fix_widget ? 'http://lampa.mx/' : 'https://yumata.github.io/lampa/',
    set: ()=> {}
})

/**
 * Старые зеркала, которые не используются больше, но могут быть полезны для обратной совместимости
 */
Object.defineProperty(object, 'old_mirrors', { 
    get: ()=> ['cub.red', 'cub.rip', 'standby.cub.red', 'kurwa-bober.ninja', 'nackhui.com'],
    set: ()=> {}
})

/**
 * Список актуальных зеркал
 */
Object.defineProperty(object, 'cub_mirrors', { 
    get: ()=> {
        let lampa = ['cub.best', 'cub.black', 'durex.monster', 'cubnotrip.top']
        let users = localStorage.getItem('cub_mirrors') || '[]'

        try {
            users = JSON.parse(users)
        } catch (e) {
            users = []
        }

        if(Object.prototype.toString.call( users ) === '[object Array]' && users.length){
            return lampa.concat(users)
        }

        return lampa
    },
    set: ()=> {}
})


/**
 * Список зеркал для сокета, вынесены отдельно, так как могут отличаться от обычных зеркал
 */
Object.defineProperty(object, 'soc_mirrors', { 
    get: ()=> ['cub.best', 'kurwa-bober.ninja', 'nackhui.com'],
    set: ()=> {}
})

/**
 * Текущее доменное имя, которое используется для работы с CUB
 */
Object.defineProperty(object, 'cub_domain', { 
    get: ()=> {
        let use = localStorage.getItem('cub_domain') || ''

        return object.cub_mirrors.indexOf(use) > -1 ? use : object.cub_mirrors[0]
    } 
})

/**
 * Текущее живое зеркало с протоколом http|https
 */
Object.defineProperty(object, 'cub_alive', { 
    get: ()=> {
        return localStorage.getItem('cub_alive') || 'https://' + object.cub_domain
    } 
})

export default object