import Template from '../../interaction/template'
import Modal from '../../interaction/modal'
import Controller from '../controller'
import Device from './device'
import Permit from './permit'
import Platform from '../platform'
import Lang from '../lang'

function show(template_name){
    let enabled = Controller.enabled().name

    Modal.open({
        title: '',
        html: Template.get(template_name),
        onBack: ()=>{
            Modal.close()

            Controller.toggle(enabled)
        }
    })
}

function account(){
    let enabled = Controller.enabled().name
    let html    = Template.js('account_none')

    if(Platform.tv()) html.addClass('layer--' + (Platform.mouse() ? 'wheight' : 'height'))
    else html.addClass('account-modal-split--mobile')

    Modal.open({
        title: '',
        html: $(html),
        size: Platform.tv() ? 'full' : 'medium',
        scroll: {
            nopadding: true
        },
        onSelect: ()=>{
            Modal.close()

            Device.login(()=>{
                Controller.toggle(enabled)
            })
        },
        onBack: ()=>{
            Modal.close()

            Controller.toggle(enabled)
        }
    })
}

function limited(){
    show('account_limited')
}

function premium(){
    let enabled = Controller.enabled().name
    let html    = Template.js('account_premium')

    if(Platform.tv()) html.addClass('layer--' + (Platform.mouse() ? 'wheight' : 'height'))
    else html.addClass('account-modal-split--mobile')

    if(!Permit.token){
        let button = Template.elem('div', {class: 'simple-button simple-button--inline selector', text: Lang.translate('settings_cub_signin_button')})

        button.on('hover:enter', ()=>{
            Modal.close()

            Controller.toggle(enabled)

            account()
        })

        html.find('.account-modal-split__info').append(button)
    }

    Modal.open({
        title: '',
        html: $(html),
        size: Platform.tv() ? 'full' : 'medium',
        scroll: {
            nopadding: true
        },
        onBack: ()=>{
            Modal.close()

            Controller.toggle(enabled)
        }
    })
}


export default {
    account,
    limited,
    premium
}