import {createHash} from 'node:crypto'

/**
 * A minimal WebSocket endpoint for Studio's Bifur presence channel
 * (`/socket/<dataset>`). Refusing the upgrade makes the client reconnect
 * forever, so the simulator accepts it, answers JSON-RPC requests with a
 * null result, replies to pings, and otherwise stays quiet: presence is
 * single-user here.
 */
export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0)
  const keepalive = setInterval(() => socket.writable && socket.write(frame(0x9, Buffer.alloc(0))), 30_000)
  keepalive.unref?.()
  socket.on('close', () => clearInterval(keepalive))
  socket.on('error', () => clearInterval(keepalive))
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const parsed = parseFrame(buffer)
      if (!parsed) break
      buffer = buffer.subarray(parsed.length)
      if (parsed.opcode === 0x8) {
        socket.end(frame(0x8, Buffer.alloc(0)))
        return
      }
      if (parsed.opcode === 0x9) socket.write(frame(0xa, parsed.payload))
      if (parsed.opcode === 0x1) {
        try {
          const message = JSON.parse(parsed.payload.toString('utf8'))
          if (message && message.id !== undefined) {
            socket.write(frame(0x1, Buffer.from(JSON.stringify({jsonrpc: '2.0', id: message.id, result: null}))))
          }
        } catch {
          /* not JSON-RPC; ignore */
        }
      }
    }
  })
}

function parseFrame(buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskOffset = offset
  if (masked) offset += 4
  if (buffer.length < offset + length) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskOffset + (i % 4)]
  }
  return {opcode, payload, length: offset + length}
}

function frame(opcode, payload) {
  const length = payload.length
  const header = length < 126 ? Buffer.from([0x80 | opcode, length]) : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]) : null
  if (header) return Buffer.concat([header, payload])
  const big = Buffer.alloc(10)
  big[0] = 0x80 | opcode
  big[1] = 127
  big.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([big, payload])
}
