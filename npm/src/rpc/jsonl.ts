import { StringDecoder } from "node:string_decoder";

export class JsonlDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk: Buffer | string): string[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    return this.#drain(false);
  }

  end(chunk?: Buffer | string): string[] {
    if (chunk !== undefined) {
      this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    }
    this.#buffer += this.#decoder.end();
    return this.#drain(true);
  }

  #drain(flush: boolean): string[] {
    const lines: string[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      let line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }

    if (flush && this.#buffer.length > 0) {
      let line = this.#buffer;
      this.#buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }
}
