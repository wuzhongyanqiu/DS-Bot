import { createElement as h, useEffect, useRef, useState } from 'react'
import { useEscape } from './overlay-hooks.js'
import { t } from './i18n.js'

export function IsolationGateDialog({ actions }) {
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  const close = () => actions.closeIsolationGate?.()
  useEscape(close)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (event) => {
    event?.preventDefault()
    if (busy || !passcode) return
    setBusy(true)
    setError('')
    try {
      await actions.unlockIsolationLab(passcode)
    } catch (failure) {
      setError(failure?.message ?? t('Invalid passcode'))
    } finally {
      setBusy(false)
    }
  }

  return h('div', { className: 'bt-modal-scrim bt-iso-gate-layer', onMouseDown: (e) => { if (e.target === e.currentTarget) close() } },
    h('form', { className: 'bt-modal bt-iso-gate', role: 'dialog', 'aria-modal': true, 'aria-label': t('Isolation Lab'), onSubmit: submit },
      h('h3', null, t('Enter Isolation Lab')),
      h('p', { className: 'bt-set-hint' }, t('Isolated Bots and their group chats live here. Enter the passcode to continue.')),
      h('input', {
        ref: inputRef,
        type: 'password',
        className: 'bt-input',
        placeholder: t('Enter passcode'),
        value: passcode,
        onInput: (e) => setPasscode(e.target.value),
        disabled: busy,
      }),
      error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
      h('div', { className: 'bt-modal-actions' },
        h('button', { type: 'button', className: 'bt-btn', onClick: close, disabled: busy }, t('Cancel')),
        h('button', { type: 'submit', className: 'bt-btn bt-btn-primary', disabled: busy || !passcode }, busy ? t('Verifying…') : t('Unlock')))))
}
