/**
 * Server-sent event framing.
 *
 * A separate, exported, pure function rather than a template literal inlined at
 * the emit site, because the property it has to hold is not observable from the
 * outside: every payload the overlay emits TODAY is newline-free by
 * construction — document IDs, revisions, relative paths, and V8's own JSON
 * parse messages, which carry a position rather than a snippet. So a wire test
 * cannot distinguish an encoder from a naive interpolation, and an encoder that
 * was never checked would sit correct-looking until the first payload that
 * carried a newline forged a frame.
 *
 * SSE ends a FIELD at a newline and a FRAME at a blank line. `JSON.stringify`
 * escapes every newline in the payload, which is the entire reason the data goes
 * through it rather than into the string directly.
 */
export interface SseFrame {
  id: number
  event: string
  data: unknown
}

export function encodeSseFrame(frame: SseFrame): string {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`
}
