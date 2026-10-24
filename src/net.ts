// Downloads over HTTPS.

/** Downloads `url`; a dropped connection is tried again (3 tries in all), an HTTP error isn't. */
export async function fetchBytes(url: string, tries = 3): Promise<Uint8Array> {
  for (let attempt = 1;; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= tries) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
      continue;
    }
    throw new Error(`download ${url}: HTTP ${res.status}`);
  }
}
