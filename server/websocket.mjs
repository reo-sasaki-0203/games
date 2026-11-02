/** Small RFC6455 text-frame implementation: no runtime dependencies.
 * Supports masked client frames, fragmentation, ping/pong and payload limits.
 * Intended for one Node process; use battle-tested WS package if scaling.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const LIMIT = 64 * 1024;

export class Peer extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentSize = 0;
    this.closed = false;
    socket.on('data', (part) => this.receive(part));
    socket.on('error', () => this.terminate());
    socket.on('close', () => this.terminate());
    socket.setTimeout(120000, () => socket.destroy());
  }
  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
    this.socket.destroy();
  }
  sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || !this.socket.writable) return;
    const len = payload.length;
    const header = Buffer.alloc(len < 126 ? 2 : len <= 65535 ? 4 : 10);
    header[0] = 0x80 | opcode;
    if (len < 126) header[1] = len;
    else if (len <= 65535) { header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { this.terminate(); }
  }
  send(data) { this.sendFrame(1, Buffer.from(JSON.stringify(data))); }
  receive(part) {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, part]);
    if (this.buf.length > LIMIT + 1024) return this.terminate();
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = Boolean(b0 & 128), op = b0 & 15, masked = Boolean(b1 & 128);
      if ((b0 & 0x70) || !masked) return this.terminate();
      let len = b1 & 127, offset = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); offset = 4; }
      if (len === 127) { if (this.buf.length < 10) break; const large = this.buf.readBigUInt64BE(2); if (large > BigInt(LIMIT)) return this.terminate(); len = Number(large); offset = 10; }
      if (len > LIMIT || this.buf.length < offset + 4 + len) break;
      const mask = this.buf.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buf.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(offset + 4 + len);
      if (op === 8) { this.sendFrame(8); return this.terminate(); }
      if (op === 9) { this.sendFrame(10, payload); continue; }
      if (op === 10) continue;
      if (op === 1) {
        if (this.fragments.length) return this.terminate();
        this.fragments = [payload]; this.fragmentSize = len;
      } else if (op === 0) {
        if (!this.fragments.length) return this.terminate();
        this.fragments.push(payload); this.fragmentSize += len;
      } else return this.terminate();
      if (this.fragmentSize > LIMIT) return this.terminate();
      if (fin) {
        const message = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = []; this.fragmentSize = 0;
        try { this.emit('message', JSON.parse(message)); } catch { this.send({ type: 'error', message: '不正なデータ形式です。' }); }
      }
    }
  }
}

export function upgrade(req, socket, head, onPeer) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return;
  }
  const accept = createHash('sha1').update(key + MAGIC).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const peer = new Peer(socket);
  onPeer(peer);
  if (head.length) peer.receive(head);
}
