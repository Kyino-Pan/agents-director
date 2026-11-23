// Pinned headings can outnumber the capped terminal list. Cache their projection
// separately so a refresh never adds an unbounded list to the timeline reply.
export function createHeadingPages() {
  let signature = '[]'
  let version = null
  let pages = []
  return {
    update(headings) {
      const serialized = JSON.stringify(headings)
      if (serialized === signature) return version
      signature = serialized
      version = headings.length ? crypto.randomUUID() : null
      pages = []
      let page = []
      let bytes = 2
      for (const heading of headings) {
        const size = Buffer.byteLength(JSON.stringify(heading)) + 1
        // Worker replies have a 1 MiB budget. One public project label and ID fit in a page.
        if (page.length && bytes + size > 128 * 1024) {
          pages.push(page)
          page = []
          bytes = 2
        }
        page.push(heading)
        bytes += size
      }
      if (page.length) pages.push(page)
      return version
    },
    get({ version: requested, index } = {}) {
      if (requested !== version || !Number.isInteger(index) || !pages[index]) return { stale: true }
      return { headings: pages[index], more: index + 1 < pages.length }
    }
  }
}
