// SPIKE A — listener event-shape capture (PRD §21.4.1, §36.1).
// @sanity/client 7 streams /data/listen over fetch (no EventSource), so this
// taps window.fetch, tees any listen response body, and parses SSE frames
// into window.__SPIKE_ES__ for extraction. Finding in its own right:
// Track B proxies must stream fetch responses, not just proxy EventSource.

interface EsEvent {
  stream: number
  type: string
  data: string | null
  at: number
}

interface EsLog {
  streams: Array<{id: number; url: string; openedAt: number}>
  events: EsEvent[]
}

declare global {
  interface Window {
    __SPIKE_ES__?: EsLog
  }
}

if (typeof window !== 'undefined' && !window.__SPIKE_ES__) {
  const log: EsLog = {streams: [], events: []}
  window.__SPIKE_ES__ = log
  let nextId = 0
  const nativeFetch = window.fetch.bind(window)

  function parseSse(streamId: number, text: string): void {
    // SSE frames are separated by blank lines; fields: event:, data:, id:
    for (const frame of text.split(/\n\n/)) {
      if (!frame.trim()) continue
      let type = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (log.events.length < 500) {
        log.events.push({stream: streamId, type, data: dataLines.join('\n').slice(0, 6000) || null, at: Math.round(performance.now())})
      }
    }
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const res = await nativeFetch(input as RequestInfo, init)
    if (!/\/data\/listen\//.test(url) || !res.body) return res
    const id = nextId++
    log.streams.push({id, url: url.slice(0, 300), openedAt: Math.round(performance.now())})
    const [forStudio, forSpike] = res.body.tee()
    void (async () => {
      const reader = forSpike.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const {done, value} = await reader.read()
          if (done) break
          buffer += decoder.decode(value, {stream: true})
          const lastBreak = buffer.lastIndexOf('\n\n')
          if (lastBreak >= 0) {
            parseSse(id, buffer.slice(0, lastBreak + 2))
            buffer = buffer.slice(lastBreak + 2)
          }
        }
      } catch {
        // stream closed; fine
      }
    })()
    return new Response(forStudio, {status: res.status, statusText: res.statusText, headers: res.headers})
  }
}

export {}
