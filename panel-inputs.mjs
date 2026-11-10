// Only the selected conversation lives in this controller. Tokens also invalidate A → B → A races.
export class DetailInputs {
  key = null
  generation = 0
  pending = false
  lastRead = 0
  signature = null

  select(agent, paused = false) {
    const section = document.getElementById('recent-inputs')
    const key = agent
      ? JSON.stringify([agent.id, agent.sessionId, agent.provider, agent.providerSessionId])
      : null
    if (key !== this.key) {
      this.key = key
      this.generation++
      this.pending = false
      this.lastRead = 0
      this.signature = null
      document.getElementById('inputs-list').replaceChildren()
    }
    section.hidden = !key
    if (!key || this.pending || (this.lastRead && (paused || Date.now() - this.lastRead < 4000)))
      return
    const generation = this.generation
    this.pending = true
    this.lastRead = Date.now()
    // A slow refresh keeps its loaded text and scroll position; a new selection shows pending text.
    const loading = setTimeout(() => {
      if (this.generation === generation && this.signature === null)
        this.render({ inputs: [], loading: true })
    }, 200)
    Promise.resolve()
      .then(() => window.orca.plugin.request('activity.inputs', { agentId: agent.id }))
      .then(
        (result) => {
          if (this.generation !== generation) return
          this.render(
            result?.agentId === agent.id && Array.isArray(result.inputs)
              ? result
              : { inputs: [], unavailable: true }
          )
        },
        () => {
          if (this.generation === generation) this.render({ inputs: [], unavailable: true })
        }
      )
      .finally(() => {
        clearTimeout(loading)
        if (this.generation === generation) this.pending = false
      })
  }

  render(result) {
    const signature = JSON.stringify(result)
    if (signature === this.signature) return
    this.signature = signature
    const list = document.getElementById('inputs-list')
    const children = []
    for (const input of result.inputs.slice(0, 3)) {
      if (typeof input.text !== 'string') continue
      const item = document.createElement('article')
      item.className = 'user-input'
      const time = document.createElement('time')
      time.textContent = Number.isFinite(input.at)
        ? new Date(input.at).toLocaleString()
        : 'Time unavailable'
      if (Number.isFinite(input.at)) time.dateTime = new Date(input.at).toISOString()
      const text = document.createElement('p')
      text.textContent = input.text.slice(0, 4000)
      item.append(time, text)
      if (input.truncated || input.text.length > 4000) {
        const note = document.createElement('small')
        note.textContent = 'Text truncated'
        item.append(note)
      }
      children.push(item)
    }
    if (!children.length || result.limited) {
      const note = document.createElement('p')
      note.className = 'inputs-note'
      note.textContent = result.loading
        ? 'Loading recent inputs…'
        : result.unavailable
          ? 'Recent user inputs unavailable.'
          : result.limited
            ? 'Only inputs in the bounded source tail are available.'
            : 'No recorded user inputs.'
      children.push(note)
    }
    const detail = document.getElementById('detail')
    const scroll = detail.scrollTop
    list.replaceChildren(...children)
    detail.scrollTop = scroll
  }
}
