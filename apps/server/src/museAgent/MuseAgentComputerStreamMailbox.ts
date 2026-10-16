export class MuseAgentComputerStreamMailbox implements AsyncIterable<Uint8Array> {
  private readonly pending: Uint8Array[] = [];
  private bytes = 0;
  private ended = false;
  private failure: Error | undefined;
  private waiter:
    | { resolve: (value: IteratorResult<Uint8Array>) => void; reject: (error: Error) => void }
    | undefined;
  offer(value: Uint8Array): boolean {
    if (this.ended) return false;
    if (
      this.pending.length >= 256 ||
      value.byteLength > 4 * 1024 * 1024 ||
      this.bytes + value.byteLength > 4 * 1024 * 1024
    ) {
      this.close(new Error("Computer stream buffer exceeded."));
      return false;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value, done: false });
    } else {
      this.pending.push(value);
      this.bytes += value.byteLength;
    }
    return true;
  }
  close(error?: Error) {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    if (error) {
      this.pending.length = 0;
      this.bytes = 0;
      this.waiter?.reject(error);
    } else this.waiter?.resolve({ done: true, value: undefined });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        if (this.failure) return Promise.reject(this.failure);
        const value = this.pending.shift();
        if (value) {
          this.bytes -= value.byteLength;
          return Promise.resolve({ value, done: false });
        }
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}
