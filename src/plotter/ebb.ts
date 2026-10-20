/** Minimal EiBotBoard (AxiDraw controller) driver over WebSerial. */
export class EBB {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = '';
  private lines: string[] = [];
  private waiters: ((line: string) => void)[] = [];
  private enc = new TextEncoder();
  closed = false;

  private constructor(private port: SerialPort) {
    this.writer = port.writable!.getWriter();
    this.reader = port.readable!.getReader();
    this.readLoop();
  }

  static async connect(): Promise<EBB> {
    if (!('serial' in navigator)) throw new Error('WebSerial is not supported in this browser (use Chrome or Edge).');
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04d8, usbProductId: 0xfd92 }] });
    await port.open({ baudRate: 115200 });
    const ebb = new EBB(port);
    await ebb.write('\r'); // flush any partial command
    await new Promise((r) => setTimeout(r, 100));
    ebb.lines = [];
    return ebb;
  }

  private async readLoop() {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = this.buf.search(/[\r\n]/)) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (!line) continue;
          const w = this.waiters.shift();
          if (w) w(line);
          else this.lines.push(line);
        }
      }
    } finally {
      this.closed = true;
    }
  }

  private nextLine(): Promise<string> {
    const l = this.lines.shift();
    if (l !== undefined) return Promise.resolve(l);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private write(s: string) {
    return this.writer.write(this.enc.encode(s));
  }

  /** Send a command and wait for OK. Motion commands return OK once queued. */
  async command(cmd: string): Promise<void> {
    await this.write(cmd + '\r');
    const line = await this.nextLine();
    if (line.startsWith('!')) throw new Error(`EBB error for "${cmd}": ${line}`);
    if (line !== 'OK') {
      // Some firmware echoes data before OK; consume until OK.
      let l = line;
      while (l !== 'OK') {
        l = await this.nextLine();
        if (l.startsWith('!')) throw new Error(`EBB error for "${cmd}": ${l}`);
      }
    }
  }

  /** Send a query whose reply is a single data line (V, QM, …). */
  async query(cmd: string): Promise<string> {
    await this.write(cmd + '\r');
    const line = await this.nextLine();
    // Newer firmware may follow some queries with OK.
    if (this.lines[0] === 'OK') this.lines.shift();
    return line;
  }

  async waitIdle() {
    for (;;) {
      const r = await this.query('QM');
      const parts = r.split(',');
      if (parts[0] === 'QM' && parts.slice(1).every((p) => p.trim() === '0')) return;
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  async close() {
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();
      await this.port.close();
    } catch {
      /* ignore */
    }
    this.closed = true;
  }
}
